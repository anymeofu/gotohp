// Fetch-based client for the Worker API, replacing the Wails-generated
// ConfigManager bindings. All /api/* routes require an Authorization: Bearer
// <APP_ACCESS_TOKEN> header — see gotohp-workers/worker/src/middleware/session.ts.

const TOKEN_STORAGE_KEY = "gotohp:accessToken";

export function getAccessToken(): string {
  return localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
}

export function setAccessToken(token: string): void {
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

export function hasAccessToken(): boolean {
  return getAccessToken().length > 0;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.error === "string") return body.error;
    return JSON.stringify(body);
  } catch {
    try {
      return await res.text();
    } catch {
      return res.statusText;
    }
  }
}

/** Generic JSON fetch wrapper. Adds the access-token header and throws
 * ApiError on non-2xx responses. */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorBody(res));
  }
  if (res.status === 204) {
    return undefined as T;
  }
  const contentType = res.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    return (await res.json()) as T;
  }
  return undefined as T;
}

// ---- Accounts / credentials -----------------------------------------

export interface AccountSummary {
  email: string;
  needsTokenBinding: boolean;
}

export interface AccountsState {
  accounts: AccountSummary[];
  selected: string;
}

export const credsApi = {
  list(): Promise<AccountsState> {
    return apiFetch<AccountsState>("/api/creds");
  },
  select(email: string): Promise<void> {
    return apiFetch<void>("/api/creds/select", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  },
  remove(email: string): Promise<void> {
    return apiFetch<void>(`/api/creds/${encodeURIComponent(email)}`, {
      method: "DELETE",
    });
  },
};

export const authApi = {
  addAccount(oauthToken: string): Promise<{ email: string }> {
    return apiFetch<{ email: string }>("/api/auth/add-account", {
      method: "POST",
      body: JSON.stringify({ oauthToken }),
    });
  },
  addRaw(credential: string): Promise<{ email: string }> {
    return apiFetch<{ email: string }>("/api/auth/add-raw", {
      method: "POST",
      body: JSON.stringify({ credential }),
    });
  },
};

// ---- Settings ----------------------------------------------------------

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

export const settingsApi = {
  get(): Promise<Settings> {
    return apiFetch<Settings>("/api/settings");
  },
  patch(patch: Partial<Settings>): Promise<Settings> {
    return apiFetch<Settings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },
};

// ---- Upload / dedup / albums --------------------------------------------

export const dedupApi = {
  check(sha1B64: string): Promise<{ mediaKey: string }> {
    return apiFetch<{ mediaKey: string }>("/api/dedup", {
      method: "POST",
      body: JSON.stringify({ sha1B64 }),
    });
  },
};

export const uploadApi = {
  init(sha1B64: string, fileSize: number): Promise<{ uploadToken: string }> {
    return apiFetch<{ uploadToken: string }>("/api/upload/init", {
      method: "POST",
      body: JSON.stringify({ sha1B64, fileSize }),
    });
  },
  commit(
    commitToken: { raw: string },
    fileName: string,
    sha1B64: string,
    uploadTimestamp?: number,
  ): Promise<{ mediaKey: string }> {
    return apiFetch<{ mediaKey: string }>("/api/upload/commit", {
      method: "POST",
      body: JSON.stringify({ commitToken, fileName, sha1B64, uploadTimestamp }),
    });
  },
};

export interface CommitTokenPayload {
  raw: string;
}

/** PUT the raw file bytes to /api/upload/stream via XMLHttpRequest — fetch()
 * exposes no upload-progress event, so XHR is used here specifically to
 * drive the existing per-file progress UI. */
export function uploadStream(
  uploadToken: string,
  file: File,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ commitToken: CommitTokenPayload }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/upload/stream?upload_id=${encodeURIComponent(uploadToken)}`, true);
    const token = getAccessToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.responseType = "json";

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const body = xhr.response ?? (xhr.responseText ? JSON.parse(xhr.responseText) : null);
        if (!body?.commitToken?.raw) {
          reject(new ApiError(xhr.status, "upload/stream response missing commitToken"));
          return;
        }
        resolve(body);
      } else {
        let message = xhr.statusText;
        try {
          const body = xhr.response ?? (xhr.responseText ? JSON.parse(xhr.responseText) : null);
          if (body?.error) message = body.error;
        } catch {
          // ignore parse failure, fall back to statusText
        }
        reject(new ApiError(xhr.status, message));
      }
    };

    xhr.onerror = () => reject(new ApiError(0, "network error during upload"));
    xhr.onabort = () => reject(new DOMException("upload aborted", "AbortError"));

    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.send(file);
  });
}

export const albumsApi = {
  addToAlbum(mediaKeys: string[], albumNameOrKey: string): Promise<{ albumKeys: string[] }> {
    return apiFetch<{ albumKeys: string[] }>("/api/albums", {
      method: "POST",
      body: JSON.stringify({ mediaKeys, albumNameOrKey }),
    });
  },
};
