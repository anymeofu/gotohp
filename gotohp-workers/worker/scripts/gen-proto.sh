#!/usr/bin/env bash
# Regenerates src/proto/gen/messages.{js,d.ts} from the repo's .proto/ schema
# sources (the single source of truth — never hand-edit the generated files).
set -euo pipefail

cd "$(dirname "$0")/.."

PROTO_DIR="../../.proto"
OUT_DIR="src/proto/gen"

mkdir -p "$OUT_DIR"

npx pbjs -t static-module -w es6 -o "$OUT_DIR/messages.js" \
  "$PROTO_DIR/GetUploadToken.proto" \
  "$PROTO_DIR/HashCheck.proto" \
  "$PROTO_DIR/RemoteMatches.proto" \
  "$PROTO_DIR/CommitToken.proto" \
  "$PROTO_DIR/CommitUpload.proto" \
  "$PROTO_DIR/CommitUploadResponse.proto" \
  "$PROTO_DIR/CreateAlbum.proto" \
  "$PROTO_DIR/CreateAlbumResponse.proto" \
  "$PROTO_DIR/CreateMediaItems.proto" \
  "$PROTO_DIR/AddMediaToAlbum.proto"

npx pbts -o "$OUT_DIR/messages.d.ts" "$OUT_DIR/messages.js"

echo "Generated $OUT_DIR/messages.js and $OUT_DIR/messages.d.ts"
