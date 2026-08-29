// POST /api/upload/init, PUT /api/upload/stream, POST /api/upload/commit.
// Port of api.go's GetUploadToken/UploadFile*/doUploadRequest/CommitUpload,
// per the streaming-architecture writeup: the Worker proxies the raw PUT
// body straight through to Google (never buffering the whole file), and
// never hands Google's bearer token to the browser.

import { Hono } from "hono";
import type { Env } from "../env";
import { Api } from "../google/apiClient";
import { commitUpload } from "../google/commit";
import { legacyCommitToken, parseScottyFinalizeToken } from "../google/scottyToken";
import { getUploadToken, uploadStreamHeaders, uploadStreamUrl } from "../google/upload";
import { getCredential, getSelected } from "../kv/credentials";
import { getSettings } from "../kv/settings";
import { CommitToken } from "../proto/gen/messages.js";
import { base64ToBytes, bytesToBase64 } from "../util/base64";

export const uploadRoute = new Hono<{ Bindings: Env }>();

async function selectedApi(env: Env): Promise<Api> {
  const selected = await getSelected(env);
  if (!selected) {
    throw new Error("no account is selected");
  }
  const credential = await getCredential(env, selected);
  if (!credential) {
    throw new Error("no credentials with matching selected email found");
  }
  return Api.fromCredential(env, credential);
}

uploadRoute.post("/init", async (c) => {
  const body = await c.req.json<{ sha1B64?: string; fileSize?: number }>().catch(() => null);
  if (!body?.sha1B64 || typeof body.fileSize !== "number") {
    return c.json({ error: "sha1B64 and fileSize are required" }, 400);
  }

  try {
    const api = await selectedApi(c.env);
    const uploadToken = await getUploadToken(api, body.sha1B64, body.fileSize);
    return c.json({ uploadToken });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

uploadRoute.put("/stream", async (c) => {
  const uploadToken = c.req.query("upload_id");
  if (!uploadToken) {
    return c.json({ error: "upload_id query parameter is required" }, 400);
  }
  if (!c.req.raw.body) {
    return c.json({ error: "request body is required" }, 400);
  }

  let api: Api;
  try {
    api = await selectedApi(c.env);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }

  let bearerToken: string;
  try {
    bearerToken = await api.bearerToken();
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }

  // Stream the incoming request body straight through to Google — never
  // buffer the whole file in Worker memory. Chunked transfer (no explicit
  // Content-Length), mirroring Go's req.ContentLength = -1.
  const upstream = await fetch(uploadStreamUrl(uploadToken), {
    method: "PUT",
    headers: uploadStreamHeaders(api, bearerToken),
    body: c.req.raw.body,
    // @ts-expect-error Workers-specific fetch option required to stream a
    // request body of unknown length through to an upstream fetch.
    duplex: "half",
  });

  if (upstream.status < 200 || upstream.status >= 300) {
    const errBody = await upstream.text();
    return c.json(
      { error: `request failed with status ${upstream.status}: ${errBody}` },
      502,
    );
  }

  const bodyBytes = new Uint8Array(await upstream.arrayBuffer());
  try {
    const token = parseScottyFinalizeToken(bodyBytes);
    return c.json({
      commitToken: {
        raw: bytesToBase64(token.raw),
      },
    });
  } catch (err) {
    return c.json(
      { error: `invalid upload finalize response: ${err instanceof Error ? err.message : String(err)}` },
      502,
    );
  }
});

interface CommitBody {
  commitToken?: { raw?: string };
  fileName?: string;
  sha1B64?: string;
  uploadTimestamp?: number;
}

uploadRoute.post("/commit", async (c) => {
  const body = await c.req.json<CommitBody>().catch(() => null);
  if (!body?.commitToken?.raw || !body.fileName || !body.sha1B64) {
    return c.json({ error: "commitToken, fileName, and sha1B64 are required" }, 400);
  }

  let api: Api;
  let settings;
  try {
    api = await selectedApi(c.env);
    settings = await getSettings(c.env);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }

  let sha1: Uint8Array;
  let rawToken: Uint8Array;
  try {
    sha1 = base64ToBytes(body.sha1B64);
    rawToken = base64ToBytes(body.commitToken.raw);
  } catch {
    return c.json({ error: "commitToken.raw and sha1B64 must be valid base64" }, 400);
  }

  let token: CommitToken;
  try {
    token = legacyCommitToken({ raw: rawToken });
  } catch (err) {
    return c.json(
      { error: `invalid upload finalize response: ${err instanceof Error ? err.message : String(err)}` },
      400,
    );
  }

  try {
    const mediaKey = await commitUpload(
      api,
      token,
      body.fileName,
      sha1,
      { saver: settings.saver, useQuota: settings.useQuota },
      body.uploadTimestamp,
    );
    return c.json({ mediaKey });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});
