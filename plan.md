# gotohp → Cloudflare Workers Rewrite Plan

Rewrite the gotohp backend (Go) as a TypeScript Cloudflare Worker with a web
frontend, so uploads can run entirely "in the cloud" with no desktop app.

## Goal

A hosted web app where the user:

1. Adds Google credentials (same credential string formats as gotohp).
2. Drags & drops files in the browser (or picks a folder).
3. Files stream **through** the Worker directly to Google Photos.
4. Uploads use the same private Android-client API as the original app
   (unlimited-storage path preserved).

## Feasibility summary

The Go backend is essentially pure HTTP logic — no native deps:

- Auth: form-POST to Google Android auth endpoints (`backend/googleauth.go`,
  `backend/api.go`) with fields `androidId`, `app`, `client_sig`, etc.
- API: protobuf over HTTPS to `photos.googleapis.com` (`backend/api.go`,
  `generated/*.pb.go`, `.proto/`).
- Upload: single streamed `PUT` to
  `https://photos.googleapis.com/data/upload/uploadmedia/interactive?upload_id=...`
  with a `X-Goog-Hash: sha1=...` header (`backend/api.go:383-464`).
- Dedup: SHA-1 + `HashCheck` proto (`backend/sha1calc.go`).

All of this ports to `fetch` + protobuf encoding in Workers.

## Architecture

```
Browser (Vue SPA, static assets served by Worker)
  │  file stream + sha1 computed client-side (crypto.subtle)
  ▼
Worker (per-file request) ──fetch──► Google Photos API
  │
  ├─ KV          : credentials, settings, token cache
  ├─ D1 (opt)    : upload history / job log
  ├─ Queues      : batch orchestration (optional, phase 3)
  └─ Durable Obj : per-account concurrency limiting (optional)
```

Key design rules:

- **One photo per Worker invocation** — keeps subrequests (<50) and memory
  (<128 MB) safe. Never buffer whole files; stream `request.body` through.
- **SHA-1 computed in the browser** (browsers do it natively via
  `crypto.subtle`; keeps Worker CPU near zero).
- **Credentials & tokens in KV**, encrypted with a Worker secret (AES-GCM via
  WebCrypto), never in plaintext.

## Monorepo layout

```
gotohp-workers/
├─ worker/
│  ├─ src/
│  │  ├─ index.ts            # Hono router
│  │  ├─ auth/
│  │  │  ├─ googleAuth.ts    # port of backend/googleauth.go
│  │  │  ├─ credential.ts    # parse/validate credential string (configmanager.go)
│  │  │  └─ tokenBinding.ts  # port of backend/tokenbinding.go
│  │  ├─ api/
│  │  │  ├─ client.ts        # headers/UA spoofing (api.go:92-156)
│  │  │  ├─ upload.ts        # scotty upload PUT (api.go:369-464)
│  │  │  ├─ scottyToken.ts   # port of scotty_token.go
│  │  │  ├─ mediaItems.ts    # create media items (create_media_items.go)
│  │  │  ├─ albums.ts        # album ops (album.go)
│  │  │  └─ hashCheck.ts     # dedup check (HashCheck.proto)
│  │  ├─ proto/              # TS protobuf encoders (see below)
│  │  ├─ kv.ts               # KV wrappers: creds, settings, hash index
│  │  └─ crypto.ts           # AES-GCM encrypt/decrypt for KV secrets
│  ├─ wrangler.toml
│  └─ package.json
└─ web/                      # port of frontend/ (Vue 3) — drop Wails bridges

## Protobuf strategy

The `.proto/` files exist (AddMediaToAlbum, CommitUpload, CommitToken,
CreateMediaItems, GetUploadToken, HashCheck, ...). Options:

1. **@bufbuild/protobuf or protobufjs** — generate TS from the existing
   `.proto` files (preferred; keeps schemas in sync with upstream).
2. Hand-rolled encoders for the few small messages if bundle size matters.

Note: the generated Go code uses generic `field1/field2` names — regenerate
from `.proto/` sources, don't try to translate the Go structs.

## API surface (Worker routes)

| Route | Purpose | Go reference |
|---|---|---|
| `POST /api/creds` | add/validate credential string | googleauth.go |
| `GET /api/creds` | list accounts | configmanager.go |
| `DELETE /api/creds/:id` | remove account | configmanager.go |
| `POST /api/upload/init` | get upload token for a file | GetUploadToken.proto |
| `PUT /api/upload/stream` | stream file body → Google, returns finalize token | api.go UploadFile |
| `POST /api/upload/commit` | commit + create media item(s), assign album | create_media_items.go |
| `POST /api/dedup` | hash-check batch | HashCheck.proto |
| `GET/PUT /api/settings` | upload settings | configmanager.go |
| `GET /api/albums` | list/create albums | album.go |
| `/*` | static SPA | — |

## Phases

### Phase 1 — Core upload path (MVP)
- [ ] Scaffold Worker + Hono + wrangler, KV namespaces
- [ ] Port credential parsing/validation (`credential.ts`) — **scope to
      Option 1 (embedded setup) and Option 2 (ReVanced) credentials only**;
      defer Option 3 (rooted-device/token-binding) credentials, see risk #1
- [ ] Port auth/token refresh (`googleAuth.ts`) — bearer token per account,
      cached in KV with expiry; reject/flag credentials that require token
      binding until risk #1 is resolved
- [ ] Protobuf encoders for GetUploadToken / CommitUpload /
      CreateMediaItems / HashCheck
- [ ] End-to-end single-file upload from browser → Worker → Google
- [ ] Secret-encrypt credentials in KV

### Phase 2 — App features
- [ ] Drag-and-drop SPA (reuse `frontend/` Vue components minus Wails)
- [ ] Folder picker (`webkitdirectory`) replacing local recursive scan
- [ ] Client-side SHA-1 + dedup check before upload
- [ ] Album selection/creation
- [ ] Progress UI (per-file XHR progress)
- [ ] Settings persistence in KV

### Phase 3 — Scale & polish
- [ ] Cloudflare Queues for large batches (1 file = 1 message)
- [ ] D1 upload history / retry tracking
- [ ] Live Photo support (port `livephoto_metadata.go` MP4 box parsing to TS)
- [ ] Durable Object for per-account concurrency limiting
- [ ] Rate limiting + backoff (port retry config from api.go)
- [ ] (Optional, high-risk) Tink hybrid-crypto reimplementation in WebCrypto
      to support rooted-device/token-binding credentials, if there's
      demonstrated user demand — see risk #1

## Workers limits vs. workload (1000 photos/day)

| Limit | Free tier | Need | OK? |
|---|---|---|---|
| Requests | 100k/day | ~6k/day (≈5 subreq per photo) | ✅ |
| Subrequests/req | 50 | ≤6 (one file per request) | ✅ |
| Memory | 128 MB | streaming pass-through, ~0 buffering | ✅ |
| CPU | 10 ms/req | I/O only, SHA-1 done client-side | ✅ |
| KV writes | 1k/day free | creds + tokens only, cached | ⚠️ upload history → D1 |
| R2 | — | not used (stream through) | ✅ |

## Risks / open questions

1. **Token binding** (`tokenbinding.go`) — this is the single biggest port risk,
   not a minor detail. It's not just "needs ADB/root-derived key material":
   - It builds a Tink hybrid-encryption keypair (ECIES-HKDF-AES-128-GCM),
     signs an ES256 JWT assertion with the account's bound ECDSA key, and
     decrypts Google's response with Tink's `HybridDecrypt`.
   - Tink has no drop-in Cloudflare Workers/WebCrypto equivalent. Porting it
     means hand-implementing ECDH + HKDF + AES-GCM with WebCrypto primitives
     and matching Tink's exact keyset wire format (`TinkKeysetPublicKeyInfo`)
     and ECIES construction byte-for-byte — there's no reference JS lib to
     lean on, this would be built and validated against Google's real
     endpoint from scratch.
   - It also depends on a small hand-rolled protobuf varint/length-delimited
     parser to unpack the alias blob — trivial to port on its own, but only
     matters if the Tink piece is ported too.
   - **Decision needed before Phase 1**: either (a) budget real time to
     reimplement Tink hybrid crypto in TS/WebCrypto and validate it against
     live Google endpoints, or (b) drop the **Option 3 (official APK, rooted
     device)** credential path from the rewrite's scope and support only
     Option 1 (embedded setup) and Option 2 (ReVanced) credentials, which
     per the README do *not* require token binding. Recommend (b) for an
     MVP — revisit (a) in Phase 3 only if users need it.
2. **Chunked transfer encoding** (`req.ContentLength = -1` in api.go) — confirm
   Google accepts fixed-length streamed bodies from `fetch` (likely yes).
3. **Egress IP** — Workers egress is cloud IPs; same ToS-gray-area risk as the
   desktop app, volume itself looks identical to normal app behavior.
4. **Request body reuse** — never `clone()` the body server-side; keep SHA-1
   computation in the browser so the body is streamed exactly once.
5. **Bundle size** — protobuf lib + Vue SPA under the 1 MB gzipped free-tier
   worker limit; code-split if needed.

## Non-goals

- CLI mode, local directory scanning, config-file persistence (no local FS)
- Wails desktop app
- Uploading files from server storage (browser is always the source)

```
