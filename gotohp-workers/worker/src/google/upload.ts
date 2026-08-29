// Port of backend/api.go's GetUploadToken and the streamed-PUT upload
// request builder (doUploadRequest). The actual streaming pass-through lives
// in routes/upload.ts (Worker proxies request.body straight to Google); this
// module builds the protobuf body / URL / headers Go used for the same calls.

import { GetUploadToken } from "../proto/gen/messages.js";
import type { Api } from "./apiClient";
import { UPLOAD_INTERACTIVE_ENDPOINT } from "./constants";

/** Port of Api.GetUploadToken: obtains an upload token for a not-yet-uploaded
 * file, identified by the response's X-GUploader-UploadID header. */
export async function getUploadToken(
  api: Api,
  sha1B64: string,
  fileSize: number,
): Promise<string> {
  const message = GetUploadToken.create({
    f1: 2,
    f2: 2,
    f3: 1,
    f4: 3,
    fileSizeBytes: fileSize,
  });
  const serialized = GetUploadToken.encode(message).finish();

  const bearerToken = await api.bearerToken();

  const response = await fetch(UPLOAD_INTERACTIVE_ENDPOINT, {
    method: "POST",
    headers: {
      "Accept-Encoding": "gzip",
      "Accept-Language": api.language,
      "Content-Type": "application/x-protobuf",
      "User-Agent": api.userAgent,
      Authorization: `Bearer ${bearerToken}`,
      "X-Goog-Hash": `sha1=${sha1B64}`,
      "X-Upload-Content-Length": String(fileSize),
    },
    body: serialized as unknown as BodyInit,
  });

  if (response.status < 200 || response.status >= 300) {
    const body = await response.text();
    throw new Error(`request failed with status ${response.status}: ${body}`);
  }

  const uploadToken = response.headers.get("X-GUploader-UploadID");
  if (!uploadToken) {
    throw new Error("response missing X-GUploader-UploadID header");
  }
  return uploadToken;
}

/** Builds the URL for the streamed PUT, mirroring
 * UploadFileWithProgress's uploadURL. */
export function uploadStreamUrl(uploadToken: string): string {
  return `${UPLOAD_INTERACTIVE_ENDPOINT}?upload_id=${encodeURIComponent(uploadToken)}`;
}

/** Headers for the streamed PUT, mirroring doUploadRequest (chunked transfer
 * — no Content-Length is set; the Worker's fetch to Google streams the body
 * without materializing it). */
export function uploadStreamHeaders(api: Api, bearerToken: string): HeadersInit {
  return {
    "Accept-Encoding": "gzip",
    "Accept-Language": api.language,
    "User-Agent": api.userAgent,
    Authorization: `Bearer ${bearerToken}`,
  };
}
