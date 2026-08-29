import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Api } from "../../src/google/apiClient";
import { commitUpload, parseCreateMediaItemsResponse } from "../../src/google/commit";
import { buildGooglePhotosCredential } from "../../src/google/googleAuth";
import { CommitToken, CommitUpload, CreateMediaItemsResponse } from "../../src/proto/gen/messages.js";

const CREDENTIAL = buildGooglePhotosCredential("user@example.com", "master-token", "deadbeefcafef00d");

function authResponse() {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  return new Response(`Auth=bearer-abc\nExpiry=${expiry}\n`, { status: 200 });
}

describe("parseCreateMediaItemsResponse", () => {
  it("returns the first non-empty media key", () => {
    const resp = CreateMediaItemsResponse.encode(
      CreateMediaItemsResponse.create({
        item: [{ resultItem: { mediaKey: "" } }, { resultItem: { mediaKey: "AAAmediaKey" } }],
      }),
    ).finish();
    expect(parseCreateMediaItemsResponse(resp)).toBe("AAAmediaKey");
  });

  it("throws when no item has a media key", () => {
    const resp = CreateMediaItemsResponse.encode(CreateMediaItemsResponse.create({ item: [] })).finish();
    expect(() => parseCreateMediaItemsResponse(resp)).toThrow(/media key is empty or missing/);
  });
});

describe("commitUpload", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("builds the exact CommitUpload field paths and headers, quality=3 by default", async () => {
    let commitBody: Uint8Array | null = null;
    let capturedHeaders: Headers | null = null;

    globalThis.fetch = vi.fn(async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes("android.googleapis.com/auth")) return authResponse();
      commitBody = new Uint8Array((init as RequestInit).body as ArrayBuffer);
      capturedHeaders = new Headers((init as RequestInit).headers);
      const resp = CreateMediaItemsResponse.encode(
        CreateMediaItemsResponse.create({ item: [{ resultItem: { mediaKey: "final-media-key" } }] }),
      ).finish();
      return new Response(resp, { status: 200 });
    }) as unknown as typeof fetch;

    const api = Api.fromCredential(env as any, CREDENTIAL);
    const token = CommitToken.create({ field1: 2, field2: new Uint8Array([9, 9, 9]) });
    const sha1 = new Uint8Array(20).fill(5);

    const mediaKey = await commitUpload(api, token, "photo.jpg", sha1, { saver: false, useQuota: false }, 1700000000);
    expect(mediaKey).toBe("final-media-key");

    expect(capturedHeaders!.get("x-goog-ext-173412678-bin")).toBe("CgcIAhClARgC");
    expect(capturedHeaders!.get("x-goog-ext-174067345-bin")).toBe("CgIIAg==");
    expect(capturedHeaders!.get("content-type")).toBe("application/x-protobuf");

    const decoded = CommitUpload.decode(commitBody!);
    expect(Number(decoded.field1!.field1!.field1)).toBe(2);
    expect(new Uint8Array(decoded.field1!.field1!.field2 as Uint8Array)).toEqual(new Uint8Array([9, 9, 9]));
    expect(decoded.field1!.fileName).toBe("photo.jpg");
    expect(new Uint8Array(decoded.field1!.sha1Hash as Uint8Array)).toEqual(sha1);
    expect(Number(decoded.field1!.field4!.fileLastModifiedTimestamp)).toBe(1700000000);
    expect(Number(decoded.field1!.field4!.field2)).toBe(46000000);
    expect(Number(decoded.field1!.quality)).toBe(3);
    expect(Number(decoded.field1!.field10)).toBe(1);
    expect(decoded.field2!.model).toBe("Pixel XL");
    expect(decoded.field2!.make).toBe("Google");
    expect(Number(decoded.field2!.androidApiVersion)).toBe(28);
    expect(new Uint8Array(decoded.field3 as Uint8Array)).toEqual(new Uint8Array([1, 3]));
  });

  it("saver mode sets quality=1 and model=Pixel 2", async () => {
    let commitBody: Uint8Array | null = null;
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).includes("android.googleapis.com/auth")) return authResponse();
      commitBody = new Uint8Array((init as RequestInit).body as ArrayBuffer);
      const resp = CreateMediaItemsResponse.encode(
        CreateMediaItemsResponse.create({ item: [{ resultItem: { mediaKey: "k" } }] }),
      ).finish();
      return new Response(resp, { status: 200 });
    }) as unknown as typeof fetch;

    const api = Api.fromCredential(env as any, CREDENTIAL);
    const token = CommitToken.create({ field1: 2, field2: new Uint8Array([1]) });
    await commitUpload(api, token, "a.jpg", new Uint8Array(20), { saver: true, useQuota: false });

    const decoded = CommitUpload.decode(commitBody!);
    expect(Number(decoded.field1!.quality)).toBe(1);
    expect(decoded.field2!.model).toBe("Pixel 2");
  });

  it("useQuota mode sets model=Pixel 8 (and overrides saver's model)", async () => {
    let commitBody: Uint8Array | null = null;
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).includes("android.googleapis.com/auth")) return authResponse();
      commitBody = new Uint8Array((init as RequestInit).body as ArrayBuffer);
      const resp = CreateMediaItemsResponse.encode(
        CreateMediaItemsResponse.create({ item: [{ resultItem: { mediaKey: "k" } }] }),
      ).finish();
      return new Response(resp, { status: 200 });
    }) as unknown as typeof fetch;

    const api = Api.fromCredential(env as any, CREDENTIAL);
    const token = CommitToken.create({ field1: 2, field2: new Uint8Array([1]) });
    await commitUpload(api, token, "a.jpg", new Uint8Array(20), { saver: true, useQuota: true });

    const decoded = CommitUpload.decode(commitBody!);
    expect(decoded.field2!.model).toBe("Pixel 8");
  });

  it("does not retry once Google has accepted the HTTP request, even on parse failure", async () => {
    let commitCalls = 0;
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("android.googleapis.com/auth")) return authResponse();
      commitCalls++;
      // 2xx but an empty/garbage body that fails to parse a media key.
      return new Response(new Uint8Array([0xff]), { status: 200 });
    }) as unknown as typeof fetch;

    const api = Api.fromCredential(env as any, CREDENTIAL);
    const token = CommitToken.create({ field1: 2, field2: new Uint8Array([1]) });
    await expect(
      commitUpload(api, token, "a.jpg", new Uint8Array(20), { saver: false, useQuota: false }),
    ).rejects.toThrow();
    expect(commitCalls).toBe(1);
  });

  it("retries on a 503 and eventually succeeds", async () => {
    let commitCalls = 0;
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("android.googleapis.com/auth")) return authResponse();
      commitCalls++;
      if (commitCalls < 2) {
        return new Response("server error", { status: 503 });
      }
      const resp = CreateMediaItemsResponse.encode(
        CreateMediaItemsResponse.create({ item: [{ resultItem: { mediaKey: "ok-key" } }] }),
      ).finish();
      return new Response(resp, { status: 200 });
    }) as unknown as typeof fetch;

    const api = Api.fromCredential(env as any, CREDENTIAL);
    const token = CommitToken.create({ field1: 2, field2: new Uint8Array([1]) });
    const mediaKey = await commitUpload(api, token, "a.jpg", new Uint8Array(20), {
      saver: false,
      useQuota: false,
    });
    expect(mediaKey).toBe("ok-key");
    expect(commitCalls).toBe(2);
  }, 10000);
});
