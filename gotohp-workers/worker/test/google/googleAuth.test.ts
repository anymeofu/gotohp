import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGooglePhotosCredential,
  exchangeEmbeddedSetupToken,
  generateAndroidId,
  googleAuthError,
  normalizeOAuthToken,
} from "../../src/google/googleAuth";

describe("normalizeOAuthToken", () => {
  it("strips an oauth_token= prefix", () => {
    expect(normalizeOAuthToken("oauth_token=abcdefgh12345678")).toBe("abcdefgh12345678");
  });

  it("trims whitespace", () => {
    expect(normalizeOAuthToken("  abcdefgh12345678  ")).toBe("abcdefgh12345678");
  });

  it("rejects tokens that are too short", () => {
    expect(() => normalizeOAuthToken("short")).toThrow();
  });

  it("rejects tokens containing newlines", () => {
    expect(() => normalizeOAuthToken("abcdefgh1234\n5678")).toThrow();
  });

  it("rejects tokens over 8192 chars", () => {
    expect(() => normalizeOAuthToken("a".repeat(8193))).toThrow();
  });
});

describe("generateAndroidId", () => {
  it("produces a 16-char lowercase hex string", () => {
    const id = generateAndroidId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is randomized across calls", () => {
    expect(generateAndroidId()).not.toBe(generateAndroidId());
  });
});

describe("googleAuthError", () => {
  it("maps known error codes to specific messages", () => {
    expect(googleAuthError("BadAuthentication").message).toMatch(/oauth_token/);
    expect(googleAuthError("NeedsBrowser").message).toMatch(/Embedded Setup/);
    expect(googleAuthError("MissingDroidguard").message).toMatch(/device verification/);
  });

  it("falls back to a generic message for unknown codes", () => {
    expect(googleAuthError("SomethingElse").message).toBe(
      "Google authentication failed with SomethingElse",
    );
  });
});

describe("buildGooglePhotosCredential", () => {
  it("includes all required fields and round-trips via URLSearchParams", () => {
    const credential = buildGooglePhotosCredential("user@example.com", "master-token-123", "deadbeefcafef00d");
    const params = new URLSearchParams(credential);
    expect(params.get("Email")).toBe("user@example.com");
    expect(params.get("Token")).toBe("master-token-123");
    expect(params.get("androidId")).toBe("deadbeefcafef00d");
    expect(params.get("app")).toBe("com.google.android.apps.photos");
    expect(params.get("service")).toContain("photos.native");
  });
});

describe("exchangeEmbeddedSetupToken", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("parses a successful key=value response", async () => {
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = String((init as RequestInit).body);
      const form = new URLSearchParams(body);
      expect(form.get("Token")).toBe("oauth-token-value");
      expect(form.get("androidId")).toBe("androididvalue1");
      expect(form.get("service")).toBe("ac2dm");
      return new Response("Auth=ignored\nToken=master-token-xyz\nEmail=someone@gmail.com\n", {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const result = await exchangeEmbeddedSetupToken(
      "oauth-token-value",
      "androididvalue1",
      "https://example.invalid/auth",
    );
    expect(result.email).toBe("someone@gmail.com");
    expect(result.masterToken).toBe("master-token-xyz");
  });

  it("throws a mapped error when the response contains Error=", async () => {
    globalThis.fetch = vi.fn(async () => new Response("Error=BadAuthentication\n", { status: 200 })) as unknown as typeof fetch;

    await expect(
      exchangeEmbeddedSetupToken("oauth-token-value", "androididvalue1", "https://example.invalid/auth"),
    ).rejects.toThrow(/oauth_token/);
  });

  it("throws when the response is missing a master token", async () => {
    globalThis.fetch = vi.fn(async () => new Response("Email=someone@gmail.com\n", { status: 200 })) as unknown as typeof fetch;

    await expect(
      exchangeEmbeddedSetupToken("oauth-token-value", "androididvalue1", "https://example.invalid/auth"),
    ).rejects.toThrow(/master token/);
  });

  it("throws on non-2xx HTTP status", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;

    await expect(
      exchangeEmbeddedSetupToken("oauth-token-value", "androididvalue1", "https://example.invalid/auth"),
    ).rejects.toThrow(/HTTP 500/);
  });
});
