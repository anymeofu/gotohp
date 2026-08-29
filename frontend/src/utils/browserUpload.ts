// Browser-side counterpart of server_upload.go's HTTP endpoint. Used only
// in server mode (see serverMode.ts) -- desktop mode keeps using the native
// files-dropped event exactly as before.
//
// Uses XMLHttpRequest rather than fetch() specifically for
// `xhr.upload.onprogress`, which fetch has no equivalent for. This tracks
// only the browser -> VPS leg of an upload (this request's body finishing
// upload); the second leg (VPS -> Google, i.e. hashing/dedup/commit) is
// reported separately via the existing Wails events (UploadManager.ts),
// which server mode broadcasts to the browser over its own WebSocket
// transport.

export const UPLOAD_ENDPOINT = '/gotohp/api/upload'

export interface BrowserUploadProgress {
  loaded: number
  total: number
}

export function uploadFilesToServer(
  files: File[],
  onProgress?: (progress: BrowserUploadProgress) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (files.length === 0) {
      resolve()
      return
    }

    const formData = new FormData()
    for (const file of files) {
      formData.append('file', file, file.name)
    }

    const xhr = new XMLHttpRequest()
    xhr.open('POST', UPLOAD_ENDPOINT, true)

    xhr.upload.onprogress = (event) => {
      if (!onProgress) return
      onProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : 0 })
    }

    xhr.onerror = () => reject(new Error('Network error while uploading files'))
    xhr.onabort = () => reject(new Error('Upload aborted'))

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
        return
      }
      let message = `Upload failed with status ${xhr.status}`
      try {
        const body = JSON.parse(xhr.responseText) as { error?: string }
        if (body.error) message = body.error
      } catch {
        // Non-JSON error body, fall back to the generic message above.
      }
      reject(new Error(message))
    }

    xhr.send(formData)
  })
}
