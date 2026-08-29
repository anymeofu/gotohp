import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../../src/crypto/aesgcm";

const KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

describe("aesgcm", () => {
  it("round-trips plaintext", async () => {
    const plaintext = "androidId=abc123&Token=super-secret&Email=a@b.com";
    const envelope = await encrypt(plaintext, KEY);
    expect(envelope.iv).toBeTruthy();
    expect(envelope.ct).toBeTruthy();
    const decrypted = await decrypt(envelope, KEY);
    expect(decrypted).toBe(plaintext);
  });

  it("uses a fresh IV per call", async () => {
    const a = await encrypt("same plaintext", KEY);
    const b = await encrypt("same plaintext", KEY);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("fails to decrypt with the wrong key", async () => {
    const otherKey = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
    const envelope = await encrypt("secret", KEY);
    await expect(decrypt(envelope, otherKey)).rejects.toThrow();
  });

  it("rejects a key that is not 32 bytes", async () => {
    await expect(encrypt("x", "AAAA")).rejects.toThrow(/32 bytes/);
  });
});
