// Config-minus-credentials CRUD, backed by a single flat KV record. Mirrors
// configmanager.go's GetSettings()/Set* setters, collapsed into one GET/PUT.

import type { Env } from "../env";

export interface Settings {
  proxy: string;
  useQuota: boolean;
  saver: boolean;
  recursive: boolean;
  forceUpload: boolean;
  pairLivePhotos: boolean;
  skipIncompleteLivePhotos: boolean;
  updateExistingPhotosToLive: boolean;
  uploadThreads: number;
  deleteFromHost: boolean;
  disableUnsupportedFilesFilter: boolean;
  albumName: string;
  albumAutoMode: boolean;
  setDateFromFilename: boolean;
  excludePattern: string;
}

// Matches Go's DefaultConfig (backend/configmanager.go).
export const DEFAULT_SETTINGS: Settings = {
  proxy: "",
  useQuota: false,
  saver: false,
  recursive: false,
  forceUpload: false,
  pairLivePhotos: false,
  skipIncompleteLivePhotos: true,
  updateExistingPhotosToLive: false,
  uploadThreads: 3,
  deleteFromHost: false,
  disableUnsupportedFilesFilter: false,
  albumName: "",
  albumAutoMode: false,
  setDateFromFilename: false,
  excludePattern: "",
};

const SETTINGS_KEY = "settings";

export async function getSettings(env: Env): Promise<Settings> {
  const raw = await env.CREDS.get(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const stored = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Shallow-merges a partial patch onto current settings, matching Go's
 * per-field setters. `uploadThreads < 1` is ignored (mirrors SetUploadThreads). */
export async function patchSettings(env: Env, patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings(env);
  const next: Settings = { ...current, ...patch };
  if (patch.uploadThreads !== undefined && patch.uploadThreads < 1) {
    next.uploadThreads = current.uploadThreads;
  }
  if (patch.albumName !== undefined) {
    next.albumName = patch.albumName.trim();
  }
  await env.CREDS.put(SETTINGS_KEY, JSON.stringify(next));
  return next;
}
