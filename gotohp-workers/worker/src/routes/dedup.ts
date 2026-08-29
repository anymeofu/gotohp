// POST /api/dedup — port of api.go FindRemoteMediaByHash, wired to the
// selected account's credential.

import { Hono } from "hono";
import type { Env } from "../env";
import { Api } from "../google/apiClient";
import { findRemoteMediaByHash } from "../google/hashCheck";
import { getCredential, getSelected } from "../kv/credentials";
import { base64ToBytes } from "../util/base64";

export const dedupRoute = new Hono<{ Bindings: Env }>();

dedupRoute.post("/", async (c) => {
  const body = await c.req.json<{ sha1B64?: string }>().catch(() => null);
  if (!body?.sha1B64) {
    return c.json({ error: "sha1B64 is required" }, 400);
  }

  const selected = await getSelected(c.env);
  if (!selected) {
    return c.json({ error: "no account is selected" }, 400);
  }
  const credential = await getCredential(c.env, selected);
  if (!credential) {
    return c.json({ error: "no credentials with matching selected email found" }, 400);
  }

  let sha1: Uint8Array;
  try {
    sha1 = base64ToBytes(body.sha1B64);
  } catch {
    return c.json({ error: "sha1B64 is not valid base64" }, 400);
  }
  if (sha1.length !== 20) {
    return c.json({ error: "sha1B64 must decode to 20 bytes" }, 400);
  }

  try {
    const api = Api.fromCredential(c.env, credential);
    const mediaKey = await findRemoteMediaByHash(api, sha1);
    return c.json({ mediaKey });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});
