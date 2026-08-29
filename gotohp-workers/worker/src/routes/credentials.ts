// GET /api/creds, POST /api/creds/select, DELETE /api/creds/:email.
// Port of configmanager.go's GetAccounts/SetSelected/RemoveCredentials.

import { Hono } from "hono";
import type { Env } from "../env";
import {
  clearSelectedIfMatches,
  deleteCredential,
  getAccountsState,
  getCredential,
  setSelected,
} from "../kv/credentials";

export const credentialsRoute = new Hono<{ Bindings: Env }>();

credentialsRoute.get("/", async (c) => {
  const state = await getAccountsState(c.env);
  return c.json(state);
});

credentialsRoute.post("/select", async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => null);
  if (!body?.email) {
    return c.json({ error: "email is required" }, 400);
  }
  const existing = await getCredential(c.env, body.email);
  if (!existing) {
    return c.json({ error: `no credentials found for email ${body.email}` }, 404);
  }
  await setSelected(c.env, body.email);
  return c.body(null, 204);
});

credentialsRoute.delete("/:email", async (c) => {
  const email = decodeURIComponent(c.req.param("email"));
  if (!email) {
    return c.json({ error: "email cannot be empty" }, 400);
  }
  const existing = await getCredential(c.env, email);
  if (!existing) {
    return c.json({ error: `no credentials found for email ${email}` }, 404);
  }
  await deleteCredential(c.env, email);
  await clearSelectedIfMatches(c.env, email);
  return c.body(null, 204);
});
