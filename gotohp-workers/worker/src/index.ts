import { Hono } from "hono";
import type { Env } from "./env";
import { requireAppAccessToken } from "./middleware/session";
import { albumsRoute } from "./routes/albums";
import { authRoute } from "./routes/auth";
import { credentialsRoute } from "./routes/credentials";
import { dedupRoute } from "./routes/dedup";
import { settingsRoute } from "./routes/settings";
import { uploadRoute } from "./routes/upload";

const app = new Hono<{ Bindings: Env }>();

// Unauthenticated health check.
app.get("/api/health", (c) => c.json({ ok: true }));

// Every other /api/* route is gated behind the single shared-secret token.
app.use("/api/*", requireAppAccessToken);

app.route("/api/auth", authRoute);
app.route("/api/creds", credentialsRoute);
app.route("/api/settings", settingsRoute);
app.route("/api/dedup", dedupRoute);
app.route("/api/upload", uploadRoute);
app.route("/api/albums", albumsRoute);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});

export default app;
