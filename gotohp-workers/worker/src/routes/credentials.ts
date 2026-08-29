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

// GET /api/creds/:email/export?confirm=true
//
// Returns the raw, decrypted credential string for `email`, in the same
// format `POST /api/auth/add-raw` accepts — so it can be round-tripped into
// the sibling Go/VPS app's own import flow.
//
// This is already behind the global `requireAppAccessToken` bearer-token
// gate applied to all of `/api/*` in index.ts (no separate check needed
// here). Because this route reveals what's effectively a master credential
// for the Google account — broader in scope than any of the app's own
// scoped upload/album actions — it additionally requires an explicit
// `?confirm=true` query param as a second, deliberate layer of
// intent-confirmation beyond the bearer token. Missing/false confirm
// returns 400 rather than silently proceeding.
//
// The decrypted credential is never logged: it is read from KV, decrypted,
// and returned directly in the JSON response with no console.log of the
// plaintext value anywhere in this path.
credentialsRoute.get("/:email/export", async (c) => {
  if (c.req.query("confirm") !== "true") {
    return c.json(
      { error: "export requires explicit confirmation: add ?confirm=true to this request" },
      400,
    );
  }

  const email = decodeURIComponent(c.req.param("email"));
  if (!email) {
    return c.json({ error: "email cannot be empty" }, 400);
  }

  const credential = await getCredential(c.env, email);
  if (!credential) {
    return c.json({ error: `no credentials found for email ${email}` }, 404);
  }

  return c.json({ credential });
});
