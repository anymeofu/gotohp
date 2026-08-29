//go:build server

package backend

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// UploadStagingBaseDir returns the dedicated subdirectory all browser-upload
// staging lives under (see upload_staging.go's UploadStagingDirName).
func UploadStagingBaseDir() string {
	return filepath.Join(os.TempDir(), UploadStagingDirName)
}

// NewUploadStagingDir creates a fresh per-request staging directory (one
// per HTTP request to the browser-upload endpoint) inside the dedicated
// base dir, creating the base dir itself first if needed.
func NewUploadStagingDir() (string, error) {
	if err := os.MkdirAll(UploadStagingBaseDir(), 0o700); err != nil {
		return "", err
	}
	return os.MkdirTemp(UploadStagingBaseDir(), UploadStagingBatchPrefix)
}

// SweepStaleUploadStaging removes batch directories under
// UploadStagingBaseDir() whose modification time is older than maxAge. It
// only ever inspects immediate children of that dedicated directory whose
// name carries UploadStagingBatchPrefix -- it never touches the shared OS
// temp root or any other unrelated files, even ones sitting right next to
// it in os.TempDir().
func SweepStaleUploadStaging(maxAge time.Duration) (UploadCleanupResult, error) {
	base := UploadStagingBaseDir()
	entries, err := os.ReadDir(base)
	if err != nil {
		if os.IsNotExist(err) {
			return UploadCleanupResult{}, nil
		}
		return UploadCleanupResult{}, err
	}

	cutoff := time.Now().Add(-maxAge)
	var result UploadCleanupResult
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), UploadStagingBatchPrefix) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if info.ModTime().After(cutoff) {
			continue // still fresh enough that it might be a genuinely in-flight upload
		}

		dirPath := filepath.Join(base, entry.Name())
		size := dirSize(dirPath)
		if err := os.RemoveAll(dirPath); err != nil {
			continue
		}
		result.RemovedDirs++
		result.RemovedBytes += size
	}
	return result, nil
}

func dirSize(path string) int64 {
	var total int64
	_ = filepath.WalkDir(path, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}

// StartUploadStagingSweeper launches the periodic safety-net cleanup
// goroutine (see StaleUploadStagingAge/UploadStagingSweepInterval). It's a
// backstop for staging directories left behind by a crash, a killed
// process, or any other path that skipped the per-request cleanup that
// normally runs right after UploadManager.Upload finishes with a batch --
// under normal operation this sweep should almost always find nothing to
// do. Meant to be called once from server-mode startup.
func StartUploadStagingSweeper() {
	go func() {
		// Sweep shortly after startup too, not just after the first
		// interval elapses, so leftovers from a crash before this process
		// started don't sit around for up to another full interval.
		_, _ = SweepStaleUploadStaging(StaleUploadStagingAge)

		ticker := time.NewTicker(UploadStagingSweepInterval)
		defer ticker.Stop()
		for range ticker.C {
			_, _ = SweepStaleUploadStaging(StaleUploadStagingAge)
		}
	}()
}
