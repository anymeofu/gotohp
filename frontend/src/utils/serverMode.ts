// Detects at runtime whether this frontend build is currently running
// against a server-mode backend (see the repo's `-tags server` build) or a
// desktop build. Both share the exact same frontend/dist bundle -- there is
// no build-time distinction -- so detection is a cheap runtime probe
// instead: server mode registers GET /gotohp/api/mode (see
// server_upload.go); desktop mode never registers it at all, so the
// request 404s (or otherwise fails, e.g. dev-server proxying oddities),
// which we treat the same as "not server mode".
//
// This matters because server mode has no native OS-level file-drop
// mechanism to receive dropped files through (see App.vue's onDrop) and
// needs the browser-based multipart upload fallback instead.

let cached: Promise<boolean> | null = null

async function probeServerMode(): Promise<boolean> {
  try {
    const response = await fetch('/gotohp/api/mode', { method: 'GET' })
    if (!response.ok) return false
    const data = await response.json() as { mode?: string }
    return data.mode === 'server'
  } catch {
    return false
  }
}

/** Resolves once, cached for the lifetime of the page. */
export function isServerMode(): Promise<boolean> {
  if (!cached) {
    cached = probeServerMode()
  }
  return cached
}
