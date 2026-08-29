import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Api } from "../../src/google/apiClient";
import { addToAlbum, isAlbumKey } from "../../src/google/albums";
import { buildGooglePhotosCredential } from "../../src/google/googleAuth";
import { AddMediaToAlbum, CreateAlbum, CreateAlbumResponse } from "../../src/proto/gen/messages.js";

const CREDENTIAL = buildGooglePhotosCredential("user@example.com", "master-token", "deadbeefcafef00d");

function authResponse() {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  return new Response(`Auth=bearer-abc\nExpiry=${expiry}\n`, { status: 200 });
}

describe("isAlbumKey", () => {
  it("recognizes the AF1Qip prefix", () => {
    expect(isAlbumKey("AF1QipMdeadbeef")).toBe(true);
    expect(isAlbumKey("My Album Name")).toBe(false);
    expect(isAlbumKey("AF1Qip")).toBe(false); // exactly the prefix, no more chars
  });
});

describe("addToAlbum batching", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("adding to an existing album batches AddMediaToAlbum calls at 500 items", async () => {
    const mediaKeys = Array.from({ length: 1200 }, (_, i) => `media-${i}`);
    let authCalls = 0;
    const addCalls: number[] = [];

    globalThis.fetch = vi.fn(async (_url, init) => {
      const urlStr = String(_url);
      if (urlStr.includes("android.googleapis.com/auth")) {
        authCalls++;
        return authResponse();
      }
      // AddMediaToAlbum call
      const body = new Uint8Array((init as RequestInit).body as ArrayBuffer);
      const decoded = AddMediaToAlbum.decode(body);
      addCalls.push(decoded.mediaKeys?.length ?? 0);
      return new Response(new Uint8Array(), { status: 200 });
    }) as unknown as typeof fetch;

    const api = Api.fromCredential(env as any, CREDENTIAL);
    const albumKeys = await addToAlbum(api, mediaKeys, "AF1QipExistingAlbumKey123");

    expect(albumKeys).toEqual(["AF1QipExistingAlbumKey123"]);
    // 1200 items / 500 per batch = 3 batches (500, 500, 200)
    expect(addCalls).toEqual([500, 500, 200]);
  });

  it("creating a new album under the 20000 limit issues one create + N-1 add batches", async () => {
    const mediaKeys = Array.from({ length: 1100 }, (_, i) => `media-${i}`);
    const createCalls: number[] = [];
    const addCalls: number[] = [];

    globalThis.fetch = vi.fn(async (_url, init) => {
      const urlStr = String(_url);
      if (urlStr.includes("android.googleapis.com/auth")) {
        return authResponse();
      }
      if (urlStr.includes("8386163679468898444")) {
        // CreateAlbum
        const body = new Uint8Array((init as RequestInit).body as ArrayBuffer);
        const decoded = CreateAlbum.decode(body);
        createCalls.push(decoded.mediaKeys?.length ?? 0);
        const resp = CreateAlbumResponse.encode(
          CreateAlbumResponse.create({ field1: { albumMediaKey: "AF1QipNewAlbum" } }),
        ).finish();
        return new Response(resp, { status: 200 });
      }
      // AddMediaToAlbum
      const body = new Uint8Array((init as RequestInit).body as ArrayBuffer);
      const decoded = AddMediaToAlbum.decode(body);
      addCalls.push(decoded.mediaKeys?.length ?? 0);
      return new Response(new Uint8Array(), { status: 200 });
    }) as unknown as typeof fetch;

    const api = Api.fromCredential(env as any, CREDENTIAL);
    const albumKeys = await addToAlbum(api, mediaKeys, "My New Album");

    expect(albumKeys).toEqual(["AF1QipNewAlbum"]);
    expect(createCalls).toEqual([500]); // first batch creates the album
    expect(addCalls).toEqual([500, 100]); // remaining batches add to it
  });

  it("rejects empty mediaKeys or empty album name", async () => {
    const api = Api.fromCredential(env as any, CREDENTIAL);
    await expect(addToAlbum(api, [], "Some Album")).rejects.toThrow(/no media keys/);
    await expect(addToAlbum(api, ["a"], "   ")).rejects.toThrow(/cannot be empty/);
  });
});
