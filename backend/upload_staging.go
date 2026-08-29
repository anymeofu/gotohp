package backend

import "time"

// Server mode's browser-upload endpoint (see the repo root's
// server_upload.go, build tag "server") stages uploaded files to a
// dedicated temp subdirectory before handing them to UploadManager.Upload.
// These constants/types are shared (no build tag) so both the server-mode
// implementation (upload_staging_server.go) and ConfigManager's manual
// cleanup binding below can agree on naming without a build-tag-specific
// import cycle.

// UploadStagingDirName is the dedicated subdirectory name under the OS temp
// dir that all browser-upload staging lives under. Sweeping only ever
// walks entries inside this directory -- never the shared OS temp root --
// so it can never touch files unrelated to this feature.
const UploadStagingDirName = "gotohp-server-uploads"

// UploadStagingBatchPrefix names each individual upload request's staging
// directory (one per HTTP request to the browser-upload endpoint).
const UploadStagingBatchPrefix = "batch-"

// StaleUploadStagingAge is the safety-net threshold: a staging directory
// older than this is considered abandoned (the owning request's own
// completion-triggered cleanup should already have removed it long before
// this age is ever reached -- see server_upload.go's post-Upload() cleanup
// goroutine). Used by both the periodic sweep and the manual "clean up
// leftover upload files" Settings action, so neither can ever delete a
// batch that's still genuinely in flight.
const StaleUploadStagingAge = 6 * time.Hour

// UploadStagingSweepInterval is how often the automatic background sweep
// runs.
const UploadStagingSweepInterval = 48 * time.Hour

// UploadCleanupResult reports what a sweep removed, returned to the
// frontend so the Settings action can show a concrete toast ("freed 3
// files, 128MB" vs "nothing to clean up").
type UploadCleanupResult struct {
	RemovedDirs  int   `json:"removedDirs"`
	RemovedBytes int64 `json:"removedBytes"`
}

// CleanupServerUploads removes leftover browser-upload staging directories
// older than StaleUploadStagingAge. It's the same sweep the automatic
// background job runs every UploadStagingSweepInterval, exposed here as a
// manual trigger for the Settings panel's "Clean up leftover upload files"
// action. In desktop builds (which never create these staging files -- see
// upload_staging_desktop.go) it always reports zero.
func (g *ConfigManager) CleanupServerUploads() (UploadCleanupResult, error) {
	return SweepStaleUploadStaging(StaleUploadStagingAge)
}
