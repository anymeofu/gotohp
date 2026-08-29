// AES-256-GCM encrypt/decrypt for KV-stored credential secrets, via WebCrypto.
//
// Key material comes from the `CRED_ENC_KEY` Worker secret: base64-encoded,
// exactly 32 random bytes, imported directly as an AES-GCM key (no
// PBKDF2/HKDF derivation — the secret is already high-entropy).
//
// Each record gets a fresh random 12-byte IV; IV + ciphertext are both
// base64-encoded into the stored JSON envelope. Never reuse an IV with the
// same key.

export interface EncryptedEnvelope {
  iv: string; // base64
  ct: string; // base64
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBytes(base64Key);
  if (raw.length !== 32) {
    throw new Error(
      `CRED_ENC_KEY must decode to exactly 32 bytes, got ${raw.length}`,
    );
  }
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encrypt(
  plaintext: string,
  base64Key: string,
): Promise<EncryptedEnvelope> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    encoded as BufferSource,
  );
  return {
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ctBuf)),
  };
}

export async function decrypt(
  envelope: EncryptedEnvelope,
  base64Key: string,
): Promise<string> {
  const key = await importKey(base64Key);
  const iv = base64ToBytes(envelope.iv);
  const ct = base64ToBytes(envelope.ct);
  const ptBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return new TextDecoder().decode(ptBuf);
}
