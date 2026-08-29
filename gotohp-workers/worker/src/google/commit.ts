// Port of backend/api.go's CommitUpload/commitSerialized/doCommitRequest and
// parseCreateMediaItemsResponse.

import { CommitToken, CommitUpload, CreateMediaItemsResponse } from "../proto/gen/messages.js";
import { calculateBackoff, defaultRetryConfig, shouldRetry, sleep } from "../http/retry";
import type { Api } from "./apiClient";
import {
  GOOG_EXT_173412678_BIN,
  GOOG_EXT_174067345_BIN,
  PHOTOS_CREATE_MEDIA_ITEMS_ENDPOINT,
  SAVER_MODEL,
  USE_QUOTA_MODEL,
} from "./constants";

export interface CommitOptions {
  saver: boolean;
  useQuota: boolean;
}

/** Port of Api.CommitUpload: builds the CommitUpload proto with the exact
 * field paths/constants Go's api.go uses, then commits it. */
export async function commitUpload(
  api: Api,
  commitToken: CommitToken,
  fileName: string,
  sha1Hash: Uint8Array,
  options: CommitOptions,
  uploadTimestamp?: number,
): Promise<string> {
  const timestamp = uploadTimestamp && uploadTimestamp !== 0 ? uploadTimestamp : Math.floor(Date.now() / 1000);

  let quality = 3;
  let model = api.model;
  if (options.saver) {
    quality = 1;
    model = SAVER_MODEL;
  }
  if (options.useQuota) {
    model = USE_QUOTA_MODEL;
  }

  const unknownInt = 46000000;

  const message = CommitUpload.create({
    field1: {
      field1: {
        field1: commitToken.field1,
        field2: commitToken.field2,
      },
      fileName,
      sha1Hash,
      field4: {
        fileLastModifiedTimestamp: timestamp,
        field2: unknownInt,
      },
      quality,
      field10: 1,
    },
    field2: {
      model,
      make: api.make,
      androidApiVersion: api.androidApiVersion,
    },
    field3: new Uint8Array([1, 3]),
  });

  const serialized = CommitUpload.encode(message).finish();
  return commitSerialized(api, serialized);
}

/** Port of Api.commitSerialized: retries on retryable failures, but never
 * retries once Google has already accepted the HTTP request (mirrors Go's
 * comment about avoiding duplicate commits on ambiguous parse failures). */
export async function commitSerialized(api: Api, serializedData: Uint8Array): Promise<string> {
  const retryConfig = defaultRetryConfig();
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(calculateBackoff(attempt - 1, retryConfig));
    }
    try {
      return await doCommitRequest(api, serializedData);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof RetryableCommitError)) {
        throw new Error(
          `commit failed after ${attempt + 1} attempt(s): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  throw new Error(
    `commit failed after ${retryConfig.maxRetries + 1} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

class RetryableCommitError extends Error {}

async function doCommitRequest(api: Api, serializedData: Uint8Array): Promise<string> {
  const bearerToken = await api.bearerToken();

  const headers: HeadersInit = {
    "accept-Encoding": "gzip",
    "accept-Language": api.language,
    "content-Type": "application/x-protobuf",
    "user-Agent": api.userAgent,
    authorization: `Bearer ${bearerToken}`,
    "x-goog-ext-173412678-bin": GOOG_EXT_173412678_BIN,
    "x-goog-ext-174067345-bin": GOOG_EXT_174067345_BIN,
  };

  const response = await fetch(PHOTOS_CREATE_MEDIA_ITEMS_ENDPOINT, {
    method: "POST",
    headers,
    body: serializedData as unknown as BodyInit,
  });

  if (response.status < 200 || response.status >= 300) {
    const body = await response.text();
    const message = `request failed with status ${response.status}: ${body}`;
    if (shouldRetry(response.status)) {
      throw new RetryableCommitError(message);
    }
    throw new Error(message);
  }

  const bodyBytes = new Uint8Array(await response.arrayBuffer());

  // HTTP success may mean the media item already exists even when the
  // minimal response schema cannot validate it. Do not retry and risk a
  // duplicate commit — a parse failure here is always non-retryable.
  return parseCreateMediaItemsResponse(bodyBytes);
}

/** Port of parseCreateMediaItemsResponse: decodes only the verified
 * media-key path (first non-empty Item[].ResultItem.MediaKey wins),
 * preserving forward compatibility on everything else. */
export function parseCreateMediaItemsResponse(responseBytes: Uint8Array): string {
  const response = CreateMediaItemsResponse.decode(responseBytes);
  for (const item of response.item ?? []) {
    const mediaKey = item.resultItem?.mediaKey;
    if (mediaKey) return mediaKey;
  }
  throw new Error("upload rejected by API: media key is empty or missing");
}
