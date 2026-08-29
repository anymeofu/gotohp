import { describe, expect, it } from "vitest";
import { legacyCommitToken, parseScottyFinalizeToken } from "../../src/google/scottyToken";
import { CommitToken } from "../../src/proto/gen/messages.js";

function buildEnvelope(version: number, opaque: Uint8Array): Uint8Array {
  // field1 varint tag (1<<3|0=0x08) + version varint
  // field2 bytes tag (2<<3|2=0x12) + length varint + bytes
  const tag1 = 0x08;
  const tag2 = 0x12;
  const parts: number[] = [tag1, version, tag2, opaque.length, ...opaque];
  return new Uint8Array(parts);
}

describe("parseScottyFinalizeToken", () => {
  it("accepts a well-formed version-2 envelope with non-empty field 2", () => {
    const opaque = new Uint8Array([1, 2, 3, 4]);
    const raw = buildEnvelope(2, opaque);
    const token = parseScottyFinalizeToken(raw);
    expect(token.raw).toEqual(raw);
  });

  it("rejects a version other than 2", () => {
    const raw = buildEnvelope(1, new Uint8Array([1]));
    expect(() => parseScottyFinalizeToken(raw)).toThrow(/unsupported Scotty finalize token version/);
  });

  it("rejects an empty field 2", () => {
    const raw = buildEnvelope(2, new Uint8Array([]));
    expect(() => parseScottyFinalizeToken(raw)).toThrow(/empty or incomplete/);
  });

  it("rejects a missing field 1", () => {
    // Only field 2 present.
    const tag2 = 0x12;
    const opaque = new Uint8Array([9, 9]);
    const raw = new Uint8Array([tag2, opaque.length, ...opaque]);
    expect(() => parseScottyFinalizeToken(raw)).toThrow(/field-1 values, want 1/);
  });

  it("rejects a duplicate field 1", () => {
    const single = buildEnvelope(2, new Uint8Array([1]));
    const doubled = new Uint8Array([...single, 0x08, 2]);
    expect(() => parseScottyFinalizeToken(doubled)).toThrow(/field-1 values, want 1/);
  });
});

describe("legacyCommitToken", () => {
  it("decodes the envelope directly as a CommitToken (field1=version, field2=opaque payload)", () => {
    const opaque = new Uint8Array([10, 20, 30]);
    const raw = buildEnvelope(2, opaque);
    const decoded = legacyCommitToken({ raw });
    expect(Number(decoded.field1)).toBe(2);
    expect(new Uint8Array(decoded.field2 as Uint8Array)).toEqual(opaque);
  });

  it("round-trips through CommitToken re-encoding for sanity", () => {
    const opaque = new Uint8Array([1, 2, 3]);
    const raw = buildEnvelope(2, opaque);
    const decoded = legacyCommitToken({ raw });
    const reencoded = CommitToken.encode(decoded).finish();
    expect(new Uint8Array(reencoded)).toEqual(raw);
  });
});
