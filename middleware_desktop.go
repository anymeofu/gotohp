//go:build !server

package main

import (
	"net/http"

	"app/backend"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// serverAuthMiddleware is a no-op outside of server mode (desktop GUI and
// default/dev builds). Desktop mode is already implicitly trusted (a single
// local user), so it must never show a login prompt.
func serverAuthMiddleware() func(http.Handler) http.Handler {
	return nil
}

// appRouteBinder is a no-op outside of server mode. Desktop mode keeps
// using its native OS-level file-drop path (main.go's WindowFilesDropped
// handler) unchanged -- the browser-upload HTTP route (server_upload.go)
// only exists in server-mode builds.
type appRouteBinder struct{}

func (appRouteBinder) Attach(backend.AppInterface, *backend.UploadManager) {}

// newAssetMiddleware mirrors middleware_server.go's signature so main.go
// doesn't need its own build tags to call it.
func newAssetMiddleware() (application.Middleware, appRouteBinder) {
	return application.Middleware(serverAuthMiddleware()), appRouteBinder{}
}
