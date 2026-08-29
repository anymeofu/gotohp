import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Api } from "../../src/google/apiClient";
import { buildGooglePhotosCredential } from "../../src/google/googleAuth";
import { findRemoteMediaByHash } from "../../src/google/hashCheck";
import { HashCheck, RemoteMatches } from "../../src/proto/gen/messages.js";

const CREDENTIAL = buildGooglePhotosCredential("user@example.com", "master-token", "deadbeefcafef00d");

function mockAuthThenResponse(responseBody: Uint8Array) {
  let call = 0;
  globalThis.fetch = vi.fn(async () => {
    call++;
    if (call === 1) {
      const expiry = Math.floor(Date.now() / 1000) + 3600;
      return new Response(`Auth=bearer-abc\nExpiry=${expiry}\n`, { status: 200 });
    }
    return new Response(responseBody, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("findRemoteMediaByHash", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("encodes the sha1 hash into the HashCheck proto correctly", async () => {
    const sha1 = new Uint8Array(20).fill(7);
    let capturedBody: Uint8Array | null = null;
    let call = 0;
    globalThis.fetch = vi.fn(async (_url, init) => {
      call++;
      if (call === 1) {
        const expiry = Math.floor(Date.now() / 1000) + 3600;
        return new Response(`Auth=bearer-abc\nExpiry=${expiry}\n`, { status: 200 });
      }
      capturedBody = new Uint8Array((init as RequestInit).body as ArrayBuffer);
      const empty = RemoteMatches.encode(RemoteMatches.create({})).finish();
      return new Response(empty, { status: 200 });
    }) as unknown as typeof fetch;

    const api = Api.fromCredential(env as any, CREDENTIAL);
    const mediaKey = await findRemoteMediaByHash(api, sha1);
    expect(mediaKey).toBe("");

    expect(capturedBody).not.toBeNull();
    const decoded = HashCheck.decode(capturedBody!);
    expect(new Uint8Array(decoded.field1!.field1!.sha1Hash!)).toEqual(sha1);
  });

  it("returns the mediaKey on a match", async () => {
    const response = RemoteMatches.encode(
      RemoteMatches.create({
        field1: { field2: { field2: { mediaKey: "ABC123mediaKey" } } },
      }),
    ).finish();
    mockAuthThenResponse(response);

    const api = Api.fromCredential(env as any, CREDENTIAL);
    const mediaKey = await findRemoteMediaByHash(api, new Uint8Array(20));
    expect(mediaKey).toBe("ABC123mediaKey");
  });

  it("throws on non-2xx status", async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      if (call === 1) {
        const expiry = Math.floor(Date.now() / 1000) + 3600;
        return new Response(`Auth=bearer-abc\nExpiry=${expiry}\n`, { status: 200 });
      }
      return new Response("server error", { status: 503 });
    }) as unknown as typeof fetch;

    const api = Api.fromCredential(env as any, CREDENTIAL);
    await expect(findRemoteMediaByHash(api, new Uint8Array(20))).rejects.toThrow(/503/);
  });
});
