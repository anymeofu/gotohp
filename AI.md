# gotohp — AI-Assisted Changes Log & Manual

This document covers everything built in one extended session on top of the
original gotohp desktop app: a Cloudflare Workers rewrite, a self-hosted VPS
deployment of the original app, password protection for both, and a
credential export/import bridge between them. It's a changelog, a user
manual, a troubleshooting guide, and a Q&A in one file.

Two deployments now exist side by side:

| | Cloudflare Worker | VPS (Docker) |
|---|---|---|
| Branch | `cf-workers-rewrite` | `main` |
| What it is | New TypeScript rewrite of the upload backend + ported Vue frontend | The **original** Go/Wails app, run headless via its existing "server mode" |
| Where | `https://gotohp-worker.anyme.workers.dev` | `https://gphotos.moomoopoi.eu.org` |
| File size limit | **100 MB** (Cloudflare Workers request-body cap, platform-wide) | **None** (own server, own bandwidth) |
| Auth | Bearer token (`APP_ACCESS_TOKEN`), entered once via a login screen, stored in browser localStorage | HTTP Basic Auth (`GOTOHP_ACCESS_TOKEN`), browser's native login popup — leave username blank, token as password |
| Live-video/large-file uploads | Will fail with a generic "network error" past 100MB | Works, no cap |

---

## 1. Cloudflare Worker rewrite (`cf-workers-rewrite`)

### What it is

A from-scratch TypeScript port of the Go backend's upload pipeline (Hono
router on Cloudflare Workers), plus the existing Vue 3 frontend with all
Wails-specific code stripped and replaced with `fetch`/`XHR` calls to the
Worker's own REST API. Deployed as one Worker that serves both the API and
the static frontend from the same origin.

### Scope decisions (deliberate, not oversights)

- **Only two of the three credential types are supported**: Option 1
  (embedded-setup, Google-generated) and Option 2 (ReVanced pasted
  credential). **Option 3 (rooted-device/token-binding) is explicitly out of
  scope** — it depends on Google's Tink hybrid-encryption library
  (ECIES-HKDF-AES-128-GCM), which has no Workers/WebCrypto equivalent and
  would need to be reimplemented from scratch against a live endpoint with no
  reference library. Any credential requiring token binding is rejected with
  a clear error, both at storage time and shown as "upcoming" in the UI.
- **Single-tenant**: one Worker deployment = one user, gated by one shared
  `APP_ACCESS_TOKEN`. Multiple *Google accounts* are still supported within
  that one tenant (KV keyed by email, no per-user namespacing).

### Architecture

- **Upload streaming**: browser → Worker → Google. The Worker proxies the
  PUT request body straight through to Google's upload endpoint
  (`fetch(url, { method: "PUT", body: request.body })`), never buffering the
  file in memory — this is what keeps it within Workers' 128MB memory / 10ms
  CPU limits regardless of file size. It's also why Google's bearer token
  never has to be exposed to the browser (it's broadly scoped, equivalent to
  a password for the account — never send it client-side).
- **The 100MB ceiling** (see Troubleshooting §6.1) comes from Cloudflare's
  platform-level request-body size limit, not from anything in this app's
  code — it applies to *any* Worker/Pages Function, on any plan short of
  Enterprise.
- **Credentials in KV**: `cred:<email>` → AES-256-GCM (WebCrypto) encrypted
  `{credential, addedAt}`, key material from the `CRED_ENC_KEY` Worker
  secret. `selected` and `settings` stored plaintext (no secrets in them).
  Optional bearer-token cache in `token:<email>` with native KV TTL.
- **Protobuf**: generated as static TS modules from the repo's existing
  `.proto/` sources via `protobufjs-cli` (`pbjs`/`pbts`), checked in at
  `gotohp-workers/worker/src/proto/gen/`.

### Setup / redeploy

```bash
cd gotohp-workers/worker
npx wrangler kv namespace create CREDS          # once, id goes in wrangler.toml
npx wrangler secret put APP_ACCESS_TOKEN        # shared login token
npx wrangler secret put CRED_ENC_KEY             # base64 of 32 random bytes
cd ../web && npm run build                      # build the frontend first
cd ../worker && npx wrangler deploy
```

To redeploy after any code change: rebuild `web/` then `wrangler deploy`
again from `worker/` — both steps, every time (the deploy bundles whatever's
currently in `web/dist`).

### API surface (all under `/api/*`, all require `Authorization: Bearer <APP_ACCESS_TOKEN>` except `/api/health`)

| Route | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Unauthenticated liveness check |
| `/api/auth/add-account` | POST | Option 1: exchange pasted `oauth_token` cookie value |
| `/api/auth/add-raw` | POST | Option 2: store a pasted raw credential string |
| `/api/creds` | GET | List accounts + which is selected |
| `/api/creds/select` | POST | Change selected account |
| `/api/creds/:email` | DELETE | Remove an account |
| `/api/creds/:email/export` | GET | **Export** — needs `?confirm=true` too, see §3 |
| `/api/settings` | GET/PUT | Upload settings (Saver, UseQuota, album mode, etc.) |
| `/api/dedup` | POST | SHA1 → existing mediaKey or empty |
| `/api/upload/init` | POST | SHA1+size → upload token |
| `/api/upload/stream` | PUT | Proxies file bytes → Google |
| `/api/upload/commit` | POST | Finalizes upload → mediaKey |
| `/api/albums` | POST | Create/add-to album (batched) |

---

## 2. VPS deployment of the original app (`main`)

### What it is

The **original** Go/Wails app already ships a "server mode" build
(`-tags server,production`) that runs the exact same app headless, serving
its UI over HTTP instead of a native desktop window — this already existed
in the repo before this session, we didn't build it. What this session added
was: a working Docker image for it, nginx+SSL in front, a password gate
(server mode had none), and an export feature (import already existed).

### Setup (from scratch, on a fresh VPS)

```bash
git clone https://github.com/anymeofu/gotohp.git
cd gotohp
docker compose up -d --build
```

Then nginx + SSL (see §2.2), then set an access token (see §4.2).

### 2.1 Dockerfile fix: self-contained frontend build

**Problem hit**: `frontend/dist` is gitignored (build output, not source),
and `main.go` has `//go:embed all:frontend/dist` — a fresh clone has nothing
to embed, so a plain `docker compose up --build` failed with
`pattern all:frontend/dist: no matching files found`.

**Fix**: `build/docker/Dockerfile.server` now has its own `node:24-alpine`
build stage that builds the frontend *inside* the image before the Go build
runs — no local Node/Task needed on the host at all.

### 2.2 nginx + SSL

Config lives on the VPS, not in the repo (host-specific). Two approaches
were used depending on whether the domain is Cloudflare-proxied:

- **If proxied (orange cloud)**: certbot's HTTP-01 challenge still works —
  Cloudflare passes `/.well-known/acme-challenge/` straight through to the
  origin even while proxied.
- Install: `apt install -y certbot python3-certbot-nginx`, then
  `certbot --nginx -d yourdomain` — it edits the nginx config itself and
  sets up a `certbot.timer` for auto-renewal.
- nginx must have `client_max_body_size 0;` (unlimited) and long
  `proxy_read_timeout`/`proxy_send_timeout` (3600s) — the whole point of this
  deployment is large uploads with no cap, the nginx defaults would silently
  reintroduce a smaller one.
- Cloudflare SSL/TLS mode should be **Full (strict)** once a real cert
  (Let's Encrypt, publicly trusted) is on the origin.

### 2.3 Port collision

Default `8080` was already taken on the VPS. `docker-compose.yml` now maps
host port `48080` by default (container-internal port is still `8080`,
unaffected), overridable via `GOTOHP_PORT=<port> docker compose up -d`.

### 2.4 `Browser.OpenURL` fails in server mode

**Problem hit**: clicking "Open sign-in" errored with
`Invalid browser call: OpenURL failed: exec: "xdg-open": executable file
not found in $PATH`. Wails' `Browser.OpenURL()` shells out to the OS's
`xdg-open` to launch a system browser — makes sense in the desktop app, but
a headless distroless container has no `xdg-open` and no display.

**Fix**: `frontend/src/components/GoogleAuthSetup.vue` now tries
`Browser.OpenURL` first (still correct for desktop mode — Google's sign-in
blocks embedded-webview user-agents, so desktop mode *needs* the real OS
browser), and falls back to `window.open(url, '_blank')` on failure — since
in server mode the user is already sitting in a real browser tab, opening a
new tab client-side is the correct equivalent.

### 2.5 Config not persisting across redeploys

**Problem hit**: added a Google account, ran `docker compose up -d --build`
again, account was gone.

**Root cause, confirmed in code** (`backend/configmanager.go`,
`updateAppConfig`): the disk-write error is silently discarded
(`_ = saveAppConfigLocked()`). The in-memory config updates fine — so the
current session *looks* like it worked — but if the actual file write to
`/data/gotohp/gotohp.config` fails, nothing is ever persisted, and a fresh
container starts from zero with no error ever surfacing to the user.

**Why the write was failing**: Docker creates a brand-new named volume's
mount point owned by `root:root`. The container runs as the distroless
image's non-root UID `65532`, which has no write permission there.

**Fixed automatically now** — `docker-compose.yml` has an `init-permissions`
service (a throwaway `alpine` container, since the distroless app image has
no shell to `chown` from inside itself) that runs `chown -R 65532:65532
/data` on the shared volume before the app starts, every single `docker
compose up`. It's a `depends_on: condition: service_completed_successfully`
step, so the app container always waits for it to finish first. Chowning
already-correct ownership is a fast no-op, so this runs every time
harmlessly rather than being a first-run-only manual step — you never need
to think about this again, just `docker compose up -d --build` as normal.

If you're on an older checkout that predates this fix, the manual one-time
version was:
```bash
docker run --rm -v gotohp-data:/data alpine chown -R 65532:65532 /data
docker compose up -d --build
```
`git pull` to get the automatic version instead.

If you hit this *before* the automatic fix was in place: **re-add any
account added at that time** — it was never actually saved. Verify
persistence works now: add an account, `docker compose restart`, reload the
page, confirm it's still there.

*(The underlying silently-swallowed-error bug in `configmanager.go` itself
is still unpatched as of this doc — worth fixing so future save failures,
whatever the cause, actually surface to the user instead of failing silent.)*

### 2.6 Distroless config-path crash risk

Separate from §2.5: `os.UserConfigDir()` (which `determineConfigPath()`
relies on) hard-fails via `log.Fatal` if neither `$HOME` nor
`$XDG_CONFIG_HOME` is set — and distroless's UID `65532` has no `$HOME` by
default. `docker-compose.yml` pins `XDG_CONFIG_HOME: "/data"` explicitly so
this never triggers; if you ever strip that env var out, the container will
crash on startup, not just lose data.

---

## 3. Export / Import (credential bridge between the two apps)

Both apps store the exact same credential string format
(`androidId=...&Token=...&Email=...`), so the same string works in either
one — the "shared database" the two apps don't otherwise have.

**Import already existed in both apps before this session** — it's the
"paste raw credential" flow (Option 2). What was missing, and what was
added, is **export**:

- **Worker**: `GET /api/creds/:email/export?confirm=true` (the `?confirm=true`
  is deliberate friction, not a bug — this reveals a genuine master
  credential, broader in scope than the app's own upload/album actions, so
  it needs more than just the bearer token to trigger). In the UI: a copy
  icon next to each account, copies straight to clipboard with a warning
  tooltip.
- **VPS app**: `ConfigManager.ExportCredential(email)` (backend method) +
  `gotohp-cli creds export <email>` (CLI) + a copy button in the account
  list (same clipboard-fallback pattern as §2.4's OpenURL fix — tries the
  Wails clipboard binding, falls back to `navigator.clipboard.writeText` in
  server mode).

**To move an account from one deployment to the other**: export from one,
paste into the other's raw-credential/import field. Confirmed working
end-to-end by live test.

**Why there's no automatic sync**: Cloudflare KV isn't a network-reachable
database — it's a Workers-only storage primitive, only touchable from inside
a Worker or via Cloudflare's REST API. True one-click sync would mean
rewriting the Go app's credential storage to call that REST API instead of
its local YAML file — a real feature, not built, not currently planned
unless it becomes a real pain point.

---

## 4. Password protection

Neither app is safe to expose publicly without this — do this before
logging in for the first time on a fresh deployment.

### 4.1 Worker

Already existed in the original build of this rewrite (not new). One shared
secret, `APP_ACCESS_TOKEN`, set via `wrangler secret put`. On first visit,
the frontend shows a login screen (`AccessTokenGate.vue`) — the token is
stored in the browser's `localStorage` and attached as a bearer header to
every API call from then on.

### 4.2 VPS app

Added this session. **Single access token**, not a username+password pair
(collapsed from an initial two-env-var Basic Auth design after feedback that
it was more setup than needed) — same shape as the Worker's
`APP_ACCESS_TOKEN`, just delivered via HTTP Basic Auth transport (so the
browser shows its own native login popup, no custom login screen needed).

Set in `docker-compose.yml`:
```yaml
environment:
  GOTOHP_ACCESS_TOKEN: "your-token-here"
```
Redeploy (`docker compose up -d --build`), then on next visit the browser
prompts for login — **leave the username field blank**, put the token in
the password field.

Leaving `GOTOHP_ACCESS_TOKEN` unset disables auth entirely (backward
compatible default — matters if you're running this somewhere already
firewalled off, e.g. only reachable over a VPN).

Implementation: `middleware_server.go` (`//go:build server`, so this never
affects desktop-mode builds), wired into Wails v3's
`application.Options.Assets.Middleware` hook — this wraps the *entire*
request chain (static frontend AND the Wails RPC binding calls the frontend
makes internally), so it protects the whole app, not just the initial page
load.

**Recommendation, not enforced by the code**: use two *different* tokens for
the Worker and the VPS app, not the same value. They're separate trust
boundaries — a leak of one shouldn't compromise both.

---

## 5. Known limitations / deliberately deferred

- **Option 3 (rooted-device/token-binding) credentials** — Worker only, see
  §1. Not supported, not planned unless the Tink-crypto port becomes worth
  the effort.
- **Large files (>100MB) on the Worker** — hard platform limit, see §6.1.
  The VPS deployment exists specifically to route around this.
- **No automatic credential sync between the two apps** — manual
  export/import bridge only, see §3.
- **No true concurrent upload thread-pool tuning on the Worker frontend** —
  `uploadThreads` setting is stored/rendered but capped to simple small
  fixed concurrency, not full parity with the desktop app's thread pool.
- **Folder picker / recursive scan** — not built on the Worker frontend
  (browser file APIs differ from a desktop filesystem walk); `webkitdirectory`
  drag-drop grouping exists, full parity does not.
- **The silently-swallowed config-save error** (§2.5) is worked around via
  the volume permission fix, but the underlying `_ = saveAppConfigLocked()`
  bug in `configmanager.go` is not yet patched.

---

## 6. Troubleshooting

### 6.1 "network error during upload" on the Worker, for one specific large file

**Cause**: Cloudflare enforces a **100MB max request-body size** on Workers
(and Pages Functions — same runtime, same limit, moving to Pages doesn't
help). This is checked at Cloudflare's edge, before the request ever reaches
Worker code — so the browser sees a bare connection failure (`xhr.onerror`),
not a proper HTTP error.

**Fix**: use the VPS deployment for anything over ~80-90MB (no cap there).
A free-tier architectural fix *within* Cloudflare (direct-to-R2 upload,
bypassing the Worker's body limit) was discussed but not built — ask if you
want it designed and built properly.

### 6.2 `pattern all:frontend/dist: no matching files found` during `docker build`

See §2.1 — fixed already (frontend now builds inside the Docker image). If
you see this again, you're likely building from an older Dockerfile — `git
pull` and rebuild.

### 6.3 `Bind for 0.0.0.0:8080 failed: port is already allocated`

See §2.3 — the compose file now uses `48080` by default. If that's also
taken: `GOTOHP_PORT=<free port> docker compose up -d`.

### 6.4 "Could not open the system browser" / `xdg-open` error on "Open sign-in"

See §2.4 — fixed already (falls back to `window.open`). If you see this,
you're on an old build — `git pull && docker compose up -d --build`.

### 6.5 Added an account, it's gone after redeploy

See §2.5 — this is now fixed automatically by `docker-compose.yml`'s
`init-permissions` step, no manual action needed on current checkouts. If
you're still seeing this, `git pull` to get the fix, then re-add the
account once and verify with `docker compose restart` (not a full rebuild)
that it survives from now on.

### 6.6 Container crashes on startup with no useful log

Likely the `$HOME`/`$XDG_CONFIG_HOME` issue from §2.6 — check
`docker-compose.yml` still has `XDG_CONFIG_HOME: "/data"` set; don't remove
it.

### 6.7 Export/import between apps isn't working

- Worker export needs **both** the bearer token *and* `?confirm=true` on the
  URL — a plain GET without the confirm param returns `400`, not the
  credential.
- The VPS app's export copy button falls back to `navigator.clipboard`, which
  browsers may block outside a secure context (`https://`) or without a
  recent user gesture — click the button directly, don't script around it.
- Make sure you're pasting into the *other* app's raw-credential/Option-2
  field specifically, not the Option-1 OAuth-token field — they're different
  inputs.

### 6.8 Cloudflare KV values look like encrypted gibberish when inspected directly

That's expected — `wrangler kv key get` returns the raw `{iv, ct}` AES-GCM
blob. There's no way to decrypt it outside the Worker's own runtime (the
encryption key is a write-only Cloudflare secret) — use the export API
(§3), not direct KV inspection, to get a usable credential string back out.

---

## 7. Q&A

**Q: Which deployment should I actually use day to day?**
A: VPS for anything that might be a large video file; Worker for everything
else, or if you just want zero server-maintenance burden. Both work off the
same Google accounts via export/import.

**Q: Is the "unlimited storage" trick still intact in both?**
A: Yes — both spoof the same Google Photos Android app identity (User-Agent,
`androidId`, `client_sig`) that makes the trick work in the first place. The
Worker's traffic originates from Cloudflare's cloud IP ranges rather than a
residential/mobile IP, which is a network-origin difference from the
original desktop app, worth knowing about even though request shape is
identical.

**Q: Can I add a third AI tool (beyond Claude Code / Gemini Antigravity) to
manage the VPS?**
A: Yes — give it its own SSH key added to the same shared low-privilege
`automation` user's `authorized_keys` (not a separate Linux user — keeps
file ownership consistent across tools). See the chat history around VPS
access sharing for the full reasoning.

**Q: Do I need to keep both `APP_ACCESS_TOKEN` (Worker) and
`GOTOHP_ACCESS_TOKEN` (VPS) the same?**
A: No, and it's actively recommended not to — separate trust boundaries,
separate secrets.

**Q: What happens if I lose an access token?**
A: Worker: `wrangler secret put APP_ACCESS_TOKEN` again with a new value,
redeploy. VPS: edit `docker-compose.yml`'s `GOTOHP_ACCESS_TOKEN`,
`docker compose up -d --build`. Neither is recoverable — they're not stored
anywhere retrievable, by design.

**Q: Why does the Worker reject some ReVanced credentials outright?**
A: If a pasted credential carries a `token_binding_alias` (Option 3 shape),
`/api/auth/add-raw` rejects it — there's no code path that could ever use it
correctly (see §1), so storing it would just be a silent dead end later.

**Q: Is there a risk in the `?confirm=true` export design being "security
theater"?**
A: It's not meant to replace the access-token gate, it's an extra explicit
step so a credential export can't happen from a single accidental/automated
GET the way every other authenticated route can — same bearer-token
requirement underneath either way.
