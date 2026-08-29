// Single-tenant access gate: one shared-secret env var (APP_ACCESS_TOKEN)
// checked on all /api/* routes. Accepts either an `Authorization: Bearer
// <token>` header or an `X-App-Access-Token` header for flexibility from the
// frontend fetch layer.

import type { Context, Next } from "hono";
import type { Env } from "../env";

export async function requireAppAccessToken(c: Context<{ Bindings: Env }>, next: Next) {
  const expected = c.env.APP_ACCESS_TOKEN;
  if (!expected) {
    return c.json({ error: "server misconfigured: APP_ACCESS_TOKEN is not set" }, 500);
  }

  const authHeader = c.req.header("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
  const headerToken = c.req.header("X-App-Access-Token");
  const provided = bearerToken ?? headerToken;

  if (!provided || provided !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }

  await next();
}
