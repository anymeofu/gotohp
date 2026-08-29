// Optional bearer-token cache: `token:<email>` -> { auth, expiry } with KV's
// native TTL matching Google's Expiry. Purely a perf optimization (saves one
// /auth subrequest per file once warm) — correctness never depends on this
// being populated; a cache miss just re-derives a fresh token.

import type { Env } from "../env";

interface CachedToken {
  auth: string;
  expiry: number; // unix seconds
}

function tokenKey(email: string): string {
  return `token:${email}`;
}

export async function getCachedToken(env: Env, email: string): Promise<CachedToken | null> {
  const raw = await env.CREDS.get(tokenKey(email));
  if (!raw) return null;
  try {
    const cached = JSON.parse(raw) as CachedToken;
    if (cached.expiry <= Math.floor(Date.now() / 1000)) return null;
    return cached;
  } catch {
    return null;
  }
}

export async function setCachedToken(env: Env, email: string, auth: string, expiry: number): Promise<void> {
  const ttl = expiry - Math.floor(Date.now() / 1000);
  // KV requires expirationTtl >= 60 seconds; skip caching tokens that are
  // already near expiry rather than erroring.
  if (ttl < 60) return;
  await env.CREDS.put(tokenKey(email), JSON.stringify({ auth, expiry }), {
    expirationTtl: ttl,
  });
}
