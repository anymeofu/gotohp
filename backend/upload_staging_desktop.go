//go:build !server

package backend

import (
	"errors"
	"time"
)

// Desktop builds never create browser-upload staging files in the first
// place (see main.go's native WindowFilesDropped handler and
// server_upload.go, both server-mode only), so every operation here is a
// harmless no-op/zero-result. Kept so ConfigManager.CleanupServerUploads
// and shared callers compile identically in both builds without their own
// build tags.

func UploadStagingBaseDir() string { return "" }

func NewUploadStagingDir() (string, error) {
	return "", errors.New("browser-upload staging is only available in server mode")
}

func SweepStaleUploadStaging(time.Duration) (UploadCleanupResult, error) {
	return UploadCleanupResult{}, nil
}

func StartUploadStagingSweeper() {}
