// Port of backend/api.go's FindRemoteMediaByHash: builds a HashCheck proto
// from a raw SHA-1 digest, POSTs it, and decodes the RemoteMatches response
// down to a single mediaKey (or "" for no match).

import { HashCheck, RemoteMatches } from "../proto/gen/messages.js";
import type { Api } from "./apiClient";
import { HASH_CHECK_ENDPOINT } from "./constants";

export async function findRemoteMediaByHash(api: Api, sha1Hash: Uint8Array): Promise<string> {
  const message = HashCheck.create({
    field1: {
      field1: { sha1Hash },
      field2: {},
    },
  });
  const serialized = HashCheck.encode(message).finish();

  const bearerToken = await api.bearerToken();

  const response = await fetch(HASH_CHECK_ENDPOINT, {
    method: "POST",
    headers: {
      "Accept-Encoding": "gzip",
      "Accept-Language": api.language,
      "Content-Type": "application/x-protobuf",
      "User-Agent": api.userAgent,
      Authorization: `Bearer ${bearerToken}`,
    },
    body: serialized as unknown as BodyInit,
  });

  if (response.status < 200 || response.status >= 300) {
    const body = await response.text();
    throw new Error(`request failed with status ${response.status}: ${body}`);
  }

  const bodyBytes = new Uint8Array(await response.arrayBuffer());
  const decoded = RemoteMatches.decode(bodyBytes);

  return decoded.field1?.field2?.field2?.mediaKey ?? "";
}
