// POST /api/albums — port of album.go's AddToAlbum. Returns the final
// batched result synchronously (no Wails-event progress equivalent; see
// plan doc §2 for the Phase-1 rationale).

import { Hono } from "hono";
import type { Env } from "../env";
import { Api } from "../google/apiClient";
import { addToAlbum } from "../google/albums";
import { getCredential, getSelected } from "../kv/credentials";

export const albumsRoute = new Hono<{ Bindings: Env }>();

albumsRoute.post("/", async (c) => {
  const body = await c.req.json<{ mediaKeys?: string[]; albumNameOrKey?: string }>().catch(() => null);
  if (!body?.mediaKeys?.length || !body.albumNameOrKey) {
    return c.json({ error: "mediaKeys and albumNameOrKey are required" }, 400);
  }

  const selected = await getSelected(c.env);
  if (!selected) {
    return c.json({ error: "no account is selected" }, 400);
  }
  const credential = await getCredential(c.env, selected);
  if (!credential) {
    return c.json({ error: "no credentials with matching selected email found" }, 400);
  }

  try {
    const api = Api.fromCredential(c.env, credential);
    const albumKeys = await addToAlbum(api, body.mediaKeys, body.albumNameOrKey);
    return c.json({ albumKeys });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});
