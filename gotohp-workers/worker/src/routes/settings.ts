// GET/PUT /api/settings — Config minus Credentials. Port of
// configmanager.go's GetSettings()/the collapsed Set* setters.

import { Hono } from "hono";
import type { Env } from "../env";
import { getSettings, patchSettings, type Settings } from "../kv/settings";

export const settingsRoute = new Hono<{ Bindings: Env }>();

settingsRoute.get("/", async (c) => {
  const settings = await getSettings(c.env);
  return c.json(settings);
});

settingsRoute.put("/", async (c) => {
  const patch = await c.req.json<Partial<Settings>>().catch(() => null);
  if (!patch) {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const next = await patchSettings(c.env, patch);
  return c.json(next);
});
