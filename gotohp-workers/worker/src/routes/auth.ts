// POST /api/auth/add-account (Option 1: embedded-setup) and
// POST /api/auth/add-raw (Option 2: ReVanced pasted credential).
// Port of googleauth.go's AddGoogleAccount/addGoogleAccount and
// configmanager.go's AddCredentials.

import { Hono } from "hono";
import type { Env } from "../env";
import { Api } from "../google/apiClient";
import { validateRawCredential, requiresTokenBindingCrypto } from "../google/credential";
import {
  buildGooglePhotosCredential,
  exchangeEmbeddedSetupToken,
  generateAndroidId,
  normalizeOAuthToken,
} from "../google/googleAuth";
import { findRemoteMediaByHash } from "../google/hashCheck";
import { getCredential, upsertCredential } from "../kv/credentials";

export const authRoute = new Hono<{ Bindings: Env }>();

/** Port of validateGooglePhotosCredential: proves the freshly-exchanged
 * credential actually works by issuing a HashCheck against 20 zero bytes and
 * expecting no match. */
async function validateGooglePhotosCredential(env: Env, credential: string): Promise<void> {
  const api = Api.fromCredential(env, credential);
  await api.bearerToken();
  const mediaKey = await findRemoteMediaByHash(api, new Uint8Array(20));
  if (mediaKey) {
    throw new Error("unexpected media match for validation hash");
  }
}

authRoute.post("/add-account", async (c) => {
  const body = await c.req.json<{ oauthToken?: string }>().catch(() => null);
  if (!body?.oauthToken) {
    return c.json({ error: "oauthToken is required" }, 400);
  }

  let oauthToken: string;
  try {
    oauthToken = normalizeOAuthToken(body.oauthToken);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }

  const androidId = generateAndroidId();

  try {
    const exchange = await exchangeEmbeddedSetupToken(oauthToken, androidId);
    const credential = buildGooglePhotosCredential(exchange.email, exchange.masterToken, androidId);
    try {
      await validateGooglePhotosCredential(c.env, credential);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Google Photos rejected the new credential: ${msg}` }, 502);
    }
    await upsertCredential(c.env, exchange.email, credential);
    return c.json({ email: exchange.email });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

authRoute.post("/add-raw", async (c) => {
  const body = await c.req.json<{ credential?: string }>().catch(() => null);
  if (!body?.credential) {
    return c.json({ error: "credential is required" }, 400);
  }

  if (requiresTokenBindingCrypto(body.credential)) {
    return c.json(
      {
        error:
          "This credential requires token-binding (rooted-device) authentication, which is not supported by this app.",
      },
      400,
    );
  }

  let parsed;
  try {
    parsed = validateRawCredential(body.credential);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }

  const existing = await getCredential(c.env, parsed.email);
  if (existing) {
    return c.json({ error: `auth string with email ${parsed.email} already exists` }, 409);
  }

  await upsertCredential(c.env, parsed.email, body.credential);
  return c.json({ email: parsed.email });
});
