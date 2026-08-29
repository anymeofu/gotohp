//go:build server

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"app/backend"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Server mode has no native OS-level file-drop mechanism to hook into --
// main.go's WindowFilesDropped handler only ever fires from a real desktop
// webview window, which server mode never opens (see Wails v3's
// application_server.go: serverApp has no native window at all). And
// UploadManager.Upload assumes its paths already exist on the local
// filesystem, true in desktop mode (app and files share a machine), false
// in server mode (files live on a remote visitor's browser).
//
// serverUploadRoute bridges that gap: it accepts real file bytes over HTTP
// (multipart/form-data), streams them to temp files on disk, and hands
// those paths to the existing UploadManager.Upload pipeline unchanged --
// this only replaces the *trigger* mechanism. 100% of the existing
// dedup/protobuf/commit/album/Live-Photo logic is reused as-is.
const (
	uploadModePath     = "/gotohp/api/mode"
	uploadEndpointPath = "/gotohp/api/upload"
)

type serverUploadRoute struct {
	mu            sync.RWMutex
	app           backend.AppInterface
	uploadManager *backend.UploadManager
}

func newServerUploadRoute() *serverUploadRoute {
	return &serverUploadRoute{}
}

// attach wires the real app/uploadManager into the route once they exist.
// This has to happen after application.New() returns, because
// AssetOptions.Middleware must be supplied to New() itself, but the
// AppInterface passed to UploadManager.Upload can only be built by wrapping
// the *application.App that New() returns -- an unavoidable ordering
// circularity. Before attach is called, the route responds 503.
func (rt *serverUploadRoute) attach(app backend.AppInterface, uploadManager *backend.UploadManager) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	rt.app = app
	rt.uploadManager = uploadManager
}

func (rt *serverUploadRoute) ready() (backend.AppInterface, *backend.UploadManager, bool) {
	rt.mu.RLock()
	defer rt.mu.RUnlock()
	return rt.app, rt.uploadManager, rt.app != nil && rt.uploadManager != nil
}

// middleware intercepts this route's two paths and delegates everything
// else to the normal asset server chain, completely untouched. It's meant
// to be chained together with serverAuthMiddleware via
// application.ChainMiddleware so both routes stay behind the same
// access-token gate as the rest of server mode.
func (rt *serverUploadRoute) middleware() application.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.URL.Path == uploadModePath && r.Method == http.MethodGet:
				rt.handleMode(w, r)
			case r.URL.Path == uploadEndpointPath && r.Method == http.MethodPost:
				rt.handleUpload(w, r)
			default:
				next.ServeHTTP(w, r)
			}
		})
	}
}

// handleMode lets the frontend detect at runtime whether it's running
// against a server-mode build (this route exists) or a desktop build (this
// route was never registered at all, so the request 404s/network-fails --
// see middleware_desktop.go). No build-time frontend flag needed since the
// exact same frontend/dist bundle is embedded into both binaries.
func (rt *serverUploadRoute) handleMode(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"mode":"server"}`))
}

type uploadResponse struct {
	OK    bool   `json:"ok"`
	Files int    `json:"files,omitempty"`
	Error string `json:"error,omitempty"`
}

func writeUploadJSON(w http.ResponseWriter, status int, resp uploadResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(resp)
}

func (rt *serverUploadRoute) handleUpload(w http.ResponseWriter, r *http.Request) {
	app, uploadManager, ok := rt.ready()
	if !ok {
		writeUploadJSON(w, http.StatusServiceUnavailable, uploadResponse{Error: "server starting up, try again shortly"})
		return
	}

	// UploadManager.Upload is single-flight (same as desktop's native
	// drop-to-upload flow) -- it silently no-ops if already running. Check
	// up front so a concurrent request gets a real error instead of a
	// silent no-op; Upload() itself still re-checks atomically, so this is
	// a best-effort early exit, not the authoritative guard.
	if uploadManager.IsRunning() {
		writeUploadJSON(w, http.StatusConflict, uploadResponse{Error: "an upload is already in progress"})
		return
	}

	mr, err := r.MultipartReader()
	if err != nil {
		writeUploadJSON(w, http.StatusBadRequest, uploadResponse{Error: fmt.Sprintf("expected multipart/form-data: %v", err)})
		return
	}

	stagingDir, err := backend.NewUploadStagingDir()
	if err != nil {
		writeUploadJSON(w, http.StatusInternalServerError, uploadResponse{Error: fmt.Sprintf("failed to create staging directory: %v", err)})
		return
	}
	cleanupStaging := func() { _ = os.RemoveAll(stagingDir) }

	var tempPaths []string
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			cleanupStaging()
			writeUploadJSON(w, http.StatusBadRequest, uploadResponse{Error: fmt.Sprintf("error reading multipart body: %v", err)})
			return
		}

		if part.FormName() != "file" || part.FileName() == "" {
			_ = part.Close()
			continue
		}

		destPath, err := savePartToStaging(stagingDir, part)
		_ = part.Close()
		if err != nil {
			cleanupStaging()
			writeUploadJSON(w, http.StatusInternalServerError, uploadResponse{Error: fmt.Sprintf("failed to save uploaded file: %v", err)})
			return
		}
		tempPaths = append(tempPaths, destPath)
	}

	if len(tempPaths) == 0 {
		cleanupStaging()
		writeUploadJSON(w, http.StatusBadRequest, uploadResponse{Error: `no files found in request (expected multipart field "file")`})
		return
	}

	// Hand off to the existing pipeline, unmodified. Upload() is
	// fire-and-forget (progress/completion surface via the existing
	// wailsApp.Event.Emit calls, which server mode broadcasts to the
	// browser over its own WebSocket transport -- see
	// application_server.go's WebSocketBroadcaster), so this endpoint
	// responds as soon as the batch has been kicked off, mirroring how the
	// native "startUpload" event flow already behaves in desktop mode.
	uploadManager.Upload(app, tempPaths)

	// Upload() never owned temp files before (native mode's paths are the
	// caller's own files, nothing to clean up) -- this is the new owner, so
	// clean up staging once the pipeline is done with these paths, success
	// or failure alike. Upload() sets its internal "running" flag
	// synchronously before returning, so polling IsRunning() is a reliable
	// way to detect completion without changing Upload's signature.
	go func() {
		for uploadManager.IsRunning() {
			time.Sleep(500 * time.Millisecond)
		}
		cleanupStaging()
	}()

	writeUploadJSON(w, http.StatusAccepted, uploadResponse{OK: true, Files: len(tempPaths)})
}

// savePartToStaging streams one multipart part straight to disk (never
// buffers the whole file in memory, mirroring backend/sha1calc.go's
// streaming style) under its original filename, so extension-based
// filtering (backend/upload.go's isSupportedByGooglePhotos) and progress
// UI (which display filepath.Base of the upload path) both see the real
// name instead of a random temp name.
func savePartToStaging(dir string, part *multipart.Part) (string, error) {
	name := sanitizeUploadFilename(part.FileName())
	destPath := uniqueDestPath(dir, name)

	f, err := os.OpenFile(destPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()

	if _, err := io.Copy(f, part); err != nil {
		return "", err
	}
	return destPath, nil
}

// sanitizeUploadFilename strips any directory components from a
// client-supplied filename so it can't escape the staging directory (e.g.
// "../../etc/passwd") and falls back to a generated name if what's left is
// empty.
func sanitizeUploadFilename(name string) string {
	name = filepath.Base(filepath.Clean(name))
	if name == "" || name == "." || name == string(filepath.Separator) {
		name = fmt.Sprintf("upload-%d", time.Now().UnixNano())
	}
	return name
}

// uniqueDestPath avoids collisions between same-named files within one
// upload batch (e.g. two "IMG_0001.jpg" from different source folders)
// while keeping the original extension intact for filtering purposes.
func uniqueDestPath(dir, name string) string {
	destPath := filepath.Join(dir, name)
	ext := filepath.Ext(name)
	base := name[:len(name)-len(ext)]
	for i := 1; ; i++ {
		if _, err := os.Stat(destPath); os.IsNotExist(err) {
			return destPath
		}
		destPath = filepath.Join(dir, fmt.Sprintf("%s-%d%s", base, i, ext))
	}
}
