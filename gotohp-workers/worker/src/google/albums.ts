// Port of backend/api.go's CreateAlbum/AddMediaToAlbum and backend/album.go's
// AlbumManager batching logic (500 items/API call, 20000 items/album,
// AF1Qip album-key detection). No progress events (no Wails-event
// equivalent) — routes/albums.ts returns the final batched result
// synchronously.

import { AddMediaToAlbum, CreateAlbum, CreateAlbumResponse } from "../proto/gen/messages.js";
import { calculateBackoff, defaultRetryConfig, shouldRetry, sleep } from "../http/retry";
import type { Api } from "./apiClient";
import {
  ADD_MEDIA_TO_ALBUM_ENDPOINT,
  ALBUM_BATCH_SIZE,
  ALBUM_KEY_PREFIX,
  ALBUM_LIMIT,
  CREATE_ALBUM_ENDPOINT,
  GOOG_EXT_173412678_BIN,
  GOOG_EXT_174067345_BIN,
} from "./constants";

export function isAlbumKey(input: string): boolean {
  return input.length > 6 && input.slice(0, 6) === ALBUM_KEY_PREFIX;
}

function albumHeaders(api: Api, bearerToken: string): HeadersInit {
  return {
    "Accept-Encoding": "gzip",
    "Accept-Language": api.language,
    "Content-Type": "application/x-protobuf",
    "User-Agent": api.userAgent,
    Authorization: `Bearer ${bearerToken}`,
    "x-goog-ext-173412678-bin": GOOG_EXT_173412678_BIN,
    "x-goog-ext-174067345-bin": GOOG_EXT_174067345_BIN,
  };
}

/** Port of Api.CreateAlbum. */
export async function createAlbum(api: Api, albumName: string, mediaKeys: string[]): Promise<string> {
  const message = CreateAlbum.create({
    albumName,
    timestamp: Math.floor(Date.now() / 1000),
    field3: 1,
    mediaKeys: mediaKeys.map((key) => ({ field1: { mediaKey: key } })),
    field6: {},
    field7: { field1: 3 },
    deviceInfo: {
      model: api.model,
      make: api.make,
      androidApiVersion: api.androidApiVersion,
    },
  });
  const serialized = CreateAlbum.encode(message).finish();
  const bearerToken = await api.bearerToken();

  const response = await fetch(CREATE_ALBUM_ENDPOINT, {
    method: "POST",
    headers: albumHeaders(api, bearerToken),
    body: serialized as unknown as BodyInit,
  });

  if (response.status < 200 || response.status >= 300) {
    const body = await response.text();
    throw new Error(`request failed with status ${response.status}: ${body}`);
  }

  const bodyBytes = new Uint8Array(await response.arrayBuffer());
  const decoded = CreateAlbumResponse.decode(bodyBytes);

  if (!decoded.field1) {
    throw new Error("create album failed: invalid response structure");
  }
  const albumMediaKey = decoded.field1.albumMediaKey;
  if (!albumMediaKey) {
    throw new Error("create album failed: no album media key returned");
  }
  return albumMediaKey;
}

/** Port of Api.AddMediaToAlbum. */
export async function addMediaToAlbum(api: Api, albumMediaKey: string, mediaKeys: string[]): Promise<void> {
  const message = AddMediaToAlbum.create({
    mediaKeys,
    albumMediaKey,
    field5: { field1: 2 },
    deviceInfo: {
      model: api.model,
      make: api.make,
      androidApiVersion: api.androidApiVersion,
    },
    timestamp: Math.floor(Date.now() / 1000),
  });
  const serialized = AddMediaToAlbum.encode(message).finish();
  const bearerToken = await api.bearerToken();

  const response = await fetch(ADD_MEDIA_TO_ALBUM_ENDPOINT, {
    method: "POST",
    headers: albumHeaders(api, bearerToken),
    body: serialized as unknown as BodyInit,
  });

  if (response.status < 200 || response.status >= 300) {
    const body = await response.text();
    throw new Error(`request failed with status ${response.status}: ${body}`);
  }
}

/** Port of isRetryableAlbumError: retry on 5xx/429 or network errors. */
function isRetryableAlbumError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/status 5\d\d/.test(message) || message.includes("status 429")) return true;
  if (message.includes("connection") || message.includes("timeout")) return true;
  return false;
}

async function withAlbumRetry<T>(fn: () => Promise<T>): Promise<T> {
  const retryConfig = defaultRetryConfig();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(calculateBackoff(attempt - 1, retryConfig));
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableAlbumError(err)) {
        throw err;
      }
    }
  }
  throw new Error(
    `failed after ${retryConfig.maxRetries + 1} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

function addMediaWithRetry(api: Api, albumKey: string, mediaKeys: string[]): Promise<void> {
  return withAlbumRetry(() => addMediaToAlbum(api, albumKey, mediaKeys));
}

function createAlbumWithRetry(api: Api, albumName: string, mediaKeys: string[]): Promise<string> {
  return withAlbumRetry(() => createAlbum(api, albumName, mediaKeys));
}

/** Port of AlbumManager.addToExistingAlbum: chunks mediaKeys into
 * ALBUM_BATCH_SIZE (500) calls to AddMediaToAlbum. */
async function addToExistingAlbum(api: Api, mediaKeys: string[], albumKey: string): Promise<string[]> {
  for (let i = 0; i < mediaKeys.length; i += ALBUM_BATCH_SIZE) {
    const batch = mediaKeys.slice(i, i + ALBUM_BATCH_SIZE);
    await addMediaWithRetry(api, albumKey, batch);
  }
  return [albumKey];
}

/** Port of AlbumManager.createNewAlbum: chunks mediaKeys into ALBUM_LIMIT
 * (20000)-item albums, each populated via ALBUM_BATCH_SIZE (500)-item calls;
 * the first batch of each album creates it, subsequent batches add to it. */
async function createNewAlbum(api: Api, mediaKeys: string[], albumName: string): Promise<string[]> {
  const albumKeys: string[] = [];
  let albumCounter = 1;

  for (let i = 0; i < mediaKeys.length; i += ALBUM_LIMIT) {
    const albumBatch = mediaKeys.slice(i, i + ALBUM_LIMIT);
    const currentAlbumName =
      mediaKeys.length > ALBUM_LIMIT ? `${albumName} (${albumCounter})` : albumName;

    let currentAlbumKey = "";
    for (let j = 0; j < albumBatch.length; j += ALBUM_BATCH_SIZE) {
      const batch = albumBatch.slice(j, j + ALBUM_BATCH_SIZE);
      if (!currentAlbumKey) {
        currentAlbumKey = await createAlbumWithRetry(api, currentAlbumName, batch);
        albumKeys.push(currentAlbumKey);
      } else {
        await addMediaWithRetry(api, currentAlbumKey, batch);
      }
    }
    albumCounter++;
  }

  return albumKeys;
}

/** Port of AlbumManager.AddToAlbum: dispatches to add-to-existing (album key
 * input) or create-new (album name input). */
export async function addToAlbum(api: Api, mediaKeys: string[], albumNameOrKey: string): Promise<string[]> {
  if (mediaKeys.length === 0) {
    throw new Error("no media keys provided");
  }
  const trimmed = albumNameOrKey.trim();
  if (!trimmed) {
    throw new Error("album name or key cannot be empty");
  }

  if (isAlbumKey(trimmed)) {
    return addToExistingAlbum(api, mediaKeys, trimmed);
  }
  return createNewAlbum(api, mediaKeys, trimmed);
}
