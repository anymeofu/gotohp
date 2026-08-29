import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Api } from "../../src/google/apiClient";
import { buildGooglePhotosCredential } from "../../src/google/googleAuth";

const CREDENTIAL = buildGooglePhotosCredential("user@example.com", "master-token", "deadbeefcafef00d");

describe("Api", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("computes the userAgent from the fixed device profile", () => {
    const api = Api.fromCredential(env as any, CREDENTIAL);
    expect(api.userAgent).toContain("com.google.android.apps.photos/49029607");
    expect(api.userAgent).toContain("Pixel XL");
    expect(api.userAgent).toContain("en_US");
  });

  it("rejects credentials requiring token binding", () => {
    const bound = CREDENTIAL + "&token_binding_alias=some-alias";
    expect(() => Api.fromCredential(env as any, bound)).toThrow(/token-binding/);
  });

  it("fetches and caches a bearer token", async () => {
    let calls = 0;
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    globalThis.fetch = vi.fn(async (_url, init) => {
      calls++;
      const body = String((init as RequestInit).body);
      const form = new URLSearchParams(body);
      expect(form.get("app")).toBe("com.google.android.apps.photos");
      expect(form.get("assertion_jwt")).toBeNull();
      return new Response(`Auth=bearer-abc\nExpiry=${futureExpiry}\n`, { status: 200 });
    }) as unknown as typeof fetch;

    const api = Api.fromCredential(env as any, CREDENTIAL);
    const token1 = await api.bearerToken();
    expect(token1).toBe("bearer-abc");
    const token2 = await api.bearerToken();
    expect(token2).toBe("bearer-abc");
    // Second call should hit the in-memory cache, not fetch again.
    expect(calls).toBe(1);
  });

  it("throws when the auth response is missing Auth", async () => {
    globalThis.fetch = vi.fn(async () => new Response("Expiry=9999999999\n", { status: 200 })) as unknown as typeof fetch;
    const api = Api.fromCredential(env as any, CREDENTIAL);
    await expect(api.bearerToken()).rejects.toThrow(/missing Auth/);
  });
});
