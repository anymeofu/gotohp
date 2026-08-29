// Port of backend/scotty_token.go: ParseScottyFinalizeToken + legacyCommitToken.
//
// The Scotty finalize-upload response envelope is a two-field protobuf:
//   field 1 (varint) — version, must equal 2
//   field 2 (bytes)  — an opaque, protected payload (the legacy CommitToken
//                       bytes for ordinary single-file uploads)
// The Go code deliberately keeps the raw envelope bytes rather than decoding
// and re-encoding, since field 2's contents must not be normalized. This is
// a hand-rolled protobuf wire-format walk, not a generated-codec decode —
// ported field-for-field to preserve that same tolerance/strictness.

import { CommitToken } from "../proto/gen/messages.js";

const SCOTTY_FINALIZE_TOKEN_VERSION = 2;

export interface ScottyFinalizeToken {
  raw: Uint8Array;
}

// Protobuf wire types.
const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_START_GROUP = 3;
const WIRE_END_GROUP = 4;
const WIRE_FIXED32 = 5;

interface TagResult {
  fieldNumber: number;
  wireType: number;
  nextOffset: number;
}

function readVarint(buf: Uint8Array, offset: number): { value: bigint; nextOffset: number } {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) {
      throw new Error("invalid Scotty finalize token: truncated varint");
    }
    const byte = buf[pos];
    result |= BigInt(byte & 0x7f) << shift;
    pos++;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) {
      throw new Error("invalid Scotty finalize token: varint too long");
    }
  }
  return { value: result, nextOffset: pos };
}

function readTag(buf: Uint8Array, offset: number): TagResult {
  const { value, nextOffset } = readVarint(buf, offset);
  return {
    fieldNumber: Number(value >> 3n),
    wireType: Number(value & 0x7n),
    nextOffset,
  };
}

/** Returns the byte length of a single field value (not including the tag),
 * for skipping/consuming fields of any wire type. */
function fieldValueLength(buf: Uint8Array, wireType: number, offset: number): number {
  switch (wireType) {
    case WIRE_VARINT: {
      const { nextOffset } = readVarint(buf, offset);
      return nextOffset - offset;
    }
    case WIRE_FIXED64:
      return 8;
    case WIRE_BYTES: {
      const { value: length, nextOffset } = readVarint(buf, offset);
      return nextOffset - offset + Number(length);
    }
    case WIRE_FIXED32:
      return 4;
    case WIRE_START_GROUP:
    case WIRE_END_GROUP:
      throw new Error(`invalid Scotty finalize token: unsupported group wire type ${wireType}`);
    default:
      throw new Error(`invalid Scotty finalize token: unknown wire type ${wireType}`);
  }
}

export function parseScottyFinalizeToken(raw: Uint8Array): ScottyFinalizeToken {
  let field1Count = 0;
  let field2Count = 0;
  let offset = 0;

  while (offset < raw.length) {
    const tag = readTag(raw, offset);
    const valueStart = tag.nextOffset;
    const valueLength = fieldValueLength(raw, tag.wireType, valueStart);

    if (tag.fieldNumber === 1) {
      if (tag.wireType !== WIRE_VARINT) {
        throw new Error(`Scotty finalize token field 1 has wire type ${tag.wireType}`);
      }
      const { value: version, nextOffset } = readVarint(raw, valueStart);
      if (nextOffset - valueStart !== valueLength || version !== BigInt(SCOTTY_FINALIZE_TOKEN_VERSION)) {
        throw new Error(`unsupported Scotty finalize token version ${version}`);
      }
      field1Count++;
    } else if (tag.fieldNumber === 2) {
      if (tag.wireType !== WIRE_BYTES) {
        throw new Error(`Scotty finalize token field 2 has wire type ${tag.wireType}`);
      }
      const { value: length, nextOffset: lengthEnd } = readVarint(raw, valueStart);
      const bytesLength = Number(length);
      if (lengthEnd - valueStart + bytesLength !== valueLength || bytesLength === 0) {
        throw new Error("Scotty finalize token field 2 is empty or incomplete");
      }
      field2Count++;
    }

    offset = valueStart + valueLength;
  }

  if (field1Count !== 1) {
    throw new Error(`Scotty finalize token contains ${field1Count} field-1 values, want 1`);
  }
  if (field2Count !== 1) {
    throw new Error(`Scotty finalize token contains ${field2Count} field-2 values, want 1`);
  }

  return { raw: raw.slice() };
}

/** Port of ScottyFinalizeToken.legacyCommitToken(): re-validates and decodes
 * the envelope as a CommitToken proto for the single-file upload path. */
export function legacyCommitToken(token: ScottyFinalizeToken): CommitToken {
  const validated = parseScottyFinalizeToken(token.raw);
  return CommitToken.decode(validated.raw);
}
