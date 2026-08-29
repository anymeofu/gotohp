// SHA-1 (base64) of a File via SubtleCrypto. Whole-file arrayBuffer() read —
// streamed/chunked hashing for very large files is explicitly deferred per
// the porting plan (Phase 1 scope).

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function sha1Base64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-1", buffer);
  return bytesToBase64(new Uint8Array(digest));
}
