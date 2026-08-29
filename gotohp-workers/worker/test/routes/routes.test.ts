import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGooglePhotosCredential } from "../../src/google/googleAuth";
import {
  CreateMediaItemsResponse,
  GetUploadToken,
  RemoteMatches,
} from "../../src/proto/gen/messages.js";

const ACCESS_TOKEN = "test-access-token"; // matches vitest.config.ts binding

function authHeaders(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${ACCESS_TOKEN}`, ...extra };
}

function futureExpiry() {
  return Math.floor(Date.now() / 1000) + 3600;
}

describe("session middleware", () => {
  it("rejects requests without the access token", async () => {
    const res = await SELF.fetch("https://worker.test/api/creds");
    expect(res.status).toBe(401);
  });

  it("allows /api/health without a token", async () => {
    const res = await SELF.fetch("https://worker.test/api/health");
    expect(res.status).toBe(200);
  });
});

describe("routes/auth", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("add-account: full happy path (exchange + validation + store)", async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes("android.clients.google.com/auth")) {
        return new Response("Token=master-tok-1\nEmail=newuser@example.com\n", { status: 200 });
      }
      if (urlStr.includes("android.googleapis.com/auth")) {
        return new Response(`Auth=bearer-xyz\nExpiry=${futureExpiry()}\n`, { status: 200 });
      }
      // HashCheck validation call — must return an empty RemoteMatches (no match).
      const resp = RemoteMatches.encode(RemoteMatches.create({})).finish();
      return new Response(resp, { status: 200 });
    }) as unknown as typeof fetch;

    const res = await SELF.fetch("https://worker.test/api/auth/add-account", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ oauthToken: "oauth_token=abcdefghij1234567890" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json<{ email: string }>();
    expect(json.email).toBe("newuser@example.com");

    // Confirm it's now the selected/listed account.
    const listRes = await SELF.fetch("https://worker.test/api/creds", { headers: authHeaders() });
    const list = await listRes.json<{ accounts: { email: string }[]; selected: string }>();
    expect(list.selected).toBe("newuser@example.com");
    expect(list.accounts.map((a) => a.email)).toContain("newuser@example.com");
  });

  it("add-account: rejects a too-short oauthToken before any network call", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const res = await SELF.fetch("https://worker.test/api/auth/add-account", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ oauthToken: "short" }),
    });
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("add-raw: rejects a credential missing required fields", async () => {
    const res = await SELF.fetch("https://worker.test/api/auth/add-raw", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ credential: "androidId=abc&Email=x@example.com" }), // missing app, client_sig, Token, lang, service
    });
    expect(res.status).toBe(400);
    const json = await res.json<{ error: string }>();
    expect(json.error).toMatch(/missing required fields/);
  });

  it("add-raw: rejects a token-binding-shaped credential", async () => {
    const credential = buildGooglePhotosCredential("bound@example.com", "tok", "androidid1") + "&token_binding_alias=alias123";
    const res = await SELF.fetch("https://worker.test/api/auth/add-raw", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ credential }),
    });
    expect(res.status).toBe(400);
    const json = await res.json<{ error: string }>();
    expect(json.error).toMatch(/token-binding/);
  });

  it("add-raw: accepts a valid Option 2 credential and stores it", async () => {
    const credential = buildGooglePhotosCredential("raw@example.com", "tok", "androidid2");
    const res = await SELF.fetch("https://worker.test/api/auth/add-raw", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ credential }),
    });
    expect(res.status).toBe(200);
    const json = await res.json<{ email: string }>();
    expect(json.email).toBe("raw@example.com");
  });

  it("add-raw: rejects a duplicate email", async () => {
    const credential = buildGooglePhotosCredential("dup@example.com", "tok", "androidid3");
    const first = await SELF.fetch("https://worker.test/api/auth/add-raw", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ credential }),
    });
    expect(first.status).toBe(200);

    const second = await SELF.fetch("https://worker.test/api/auth/add-raw", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ credential }),
    });
    expect(second.status).toBe(409);
  });
});

describe("routes/dedup", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(async () => {
    const credential = buildGooglePhotosCredential("dedup@example.com", "tok", "androidid4");
    await SELF.fetch("https://worker.test/api/auth/add-raw", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ credential }),
    });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns an empty mediaKey on no match", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("android.googleapis.com/auth")) {
        return new Response(`Auth=bearer-abc\nExpiry=${futureExpiry()}\n`, { status: 200 });
      }
      return new Response(RemoteMatches.encode(RemoteMatches.create({})).finish(), { status: 200 });
    }) as unknown as typeof fetch;

    const sha1B64 = btoa(String.fromCharCode(...new Uint8Array(20)));
    const res = await SELF.fetch("https://worker.test/api/dedup", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ sha1B64 }),
    });
    expect(res.status).toBe(200);
    const json = await res.json<{ mediaKey: string }>();
    expect(json.mediaKey).toBe("");
  });

  it("returns the mediaKey on a match", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("android.googleapis.com/auth")) {
        return new Response(`Auth=bearer-abc\nExpiry=${futureExpiry()}\n`, { status: 200 });
      }
      const resp = RemoteMatches.encode(
        RemoteMatches.create({ field1: { field2: { field2: { mediaKey: "existing-key" } } } }),
      ).finish();
      return new Response(resp, { status: 200 });
    }) as unknown as typeof fetch;

    const sha1B64 = btoa(String.fromCharCode(...new Uint8Array(20)));
    const res = await SELF.fetch("https://worker.test/api/dedup", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ sha1B64 }),
    });
    const json = await res.json<{ mediaKey: string }>();
    expect(json.mediaKey).toBe("existing-key");
  });
});

describe("upload happy path (init -> stream -> commit)", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(async () => {
    const credential = buildGooglePhotosCredential("uploader@example.com", "tok", "androidid5");
    await SELF.fetch("https://worker.test/api/auth/add-raw", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ credential }),
    });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uploads a file end to end and returns a mediaKey", async () => {
    // Build a well-formed Scotty finalize envelope: field1=2 (version),
    // field2=CommitToken-shaped opaque bytes.
    const innerCommitToken = new Uint8Array([0x08, 7, 0x12, 2, 1, 2]); // field1=7, field2=[1,2]
    const finalizeEnvelope = new Uint8Array([
      0x08,
      2, // field1 = version 2
      0x12,
      innerCommitToken.length,
      ...innerCommitToken,
    ]);

    globalThis.fetch = vi.fn(async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes("android.googleapis.com/auth")) {
        return new Response(`Auth=bearer-abc\nExpiry=${futureExpiry()}\n`, { status: 200 });
      }
      if (urlStr.includes("uploadmedia/interactive") && (init as RequestInit).method === "POST") {
        // /api/upload/init -> GetUploadToken
        const body = new Uint8Array(await new Response((init as RequestInit).body as any).arrayBuffer());
        const decoded = GetUploadToken.decode(body);
        expect(Number(decoded.fileSizeBytes)).toBe(11);
        return new Response(null, { status: 200, headers: { "X-GUploader-UploadID": "upload-token-abc" } });
      }
      if (urlStr.includes("uploadmedia/interactive") && (init as RequestInit).method === "PUT") {
        // /api/upload/stream proxy PUT
        expect(urlStr).toContain("upload_id=upload-token-abc");
        return new Response(finalizeEnvelope, { status: 200 });
      }
      if (urlStr.includes("16538846908252377752")) {
        // commit
        const resp = CreateMediaItemsResponse.encode(
          CreateMediaItemsResponse.create({ item: [{ resultItem: { mediaKey: "uploaded-media-key" } }] }),
        ).finish();
        return new Response(resp, { status: 200 });
      }
      throw new Error(`unexpected fetch to ${urlStr}`);
    }) as unknown as typeof fetch;

    const fileBytes = new TextEncoder().encode("hello world"); // 11 bytes
    const sha1B64 = btoa(String.fromCharCode(...new Uint8Array(20).fill(3)));

    const initRes = await SELF.fetch("https://worker.test/api/upload/init", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ sha1B64, fileSize: fileBytes.length }),
    });
    expect(initRes.status).toBe(200);
    const { uploadToken } = await initRes.json<{ uploadToken: string }>();
    expect(uploadToken).toBe("upload-token-abc");

    const streamRes = await SELF.fetch(
      `https://worker.test/api/upload/stream?upload_id=${uploadToken}`,
      {
        method: "PUT",
        headers: authHeaders(),
        body: fileBytes,
      },
    );
    expect(streamRes.status).toBe(200);
    const { commitToken } = await streamRes.json<{ commitToken: { raw: string } }>();
    expect(commitToken.raw).toBeTruthy();

    const commitRes = await SELF.fetch("https://worker.test/api/upload/commit", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ commitToken, fileName: "hello.txt", sha1B64, uploadTimestamp: 1700000000 }),
    });
    expect(commitRes.status).toBe(200);
    const { mediaKey } = await commitRes.json<{ mediaKey: string }>();
    expect(mediaKey).toBe("uploaded-media-key");
  });
});

describe("routes/settings", () => {
  it("GET returns defaults, PUT patches and persists", async () => {
    const getRes = await SELF.fetch("https://worker.test/api/settings", { headers: authHeaders() });
    const initial = await getRes.json<{ uploadThreads: number; skipIncompleteLivePhotos: boolean }>();
    expect(initial.uploadThreads).toBe(3);
    expect(initial.skipIncompleteLivePhotos).toBe(true);

    const putRes = await SELF.fetch("https://worker.test/api/settings", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ saver: true, albumName: "  Trip 2026  " }),
    });
    const patched = await putRes.json<{ saver: boolean; albumName: string }>();
    expect(patched.saver).toBe(true);
    expect(patched.albumName).toBe("Trip 2026");

    const getRes2 = await SELF.fetch("https://worker.test/api/settings", { headers: authHeaders() });
    const after = await getRes2.json<{ saver: boolean }>();
    expect(after.saver).toBe(true);
  });

  it("ignores an uploadThreads patch below 1", async () => {
    const putRes = await SELF.fetch("https://worker.test/api/settings", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ uploadThreads: 0 }),
    });
    const patched = await putRes.json<{ uploadThreads: number }>();
    expect(patched.uploadThreads).toBe(3);
  });
});
