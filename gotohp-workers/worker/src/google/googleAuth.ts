// Port of backend/googleauth.go's Option 1 (embedded-setup) exchange:
// normalizeOAuthToken, exchangeEmbeddedSetupToken, buildGooglePhotosCredential,
// googleAuthError.

import {
  EMBEDDED_SETUP_AUTH_ENDPOINT,
  GOOGLE_AUTH_EMAIL_HINT,
  GOOGLE_PHOTOS_PACKAGE,
  GOOGLE_PHOTOS_SERVICE,
  GOOGLE_PHOTOS_SIG,
  GOOGLE_PLAY_SERVICES_SIG,
} from "./constants";

export interface GoogleAuthExchange {
  email: string;
  masterToken: string;
}

/** Port of normalizeOAuthToken. Strips an optional "oauth_token=" prefix and
 * validates length/no-newlines. */
export function normalizeOAuthToken(raw: string): string {
  let value = raw.trim();
  if (value.startsWith("oauth_token=")) {
    value = value.slice("oauth_token=".length);
  }
  if (value.length < 16 || value.length > 8192 || /[\r\n]/.test(value)) {
    throw new Error("enter the oauth_token cookie value from Google Embedded Setup");
  }
  return value;
}

/** Port of generateAndroidID: 8 random bytes, hex-encoded. */
export function generateAndroidId(): string {
  const raw = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(raw)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Basic RFC 5322-ish single-address validation, port of normalizeGoogleEmail's
 * effective check via net/mail.ParseAddress: single bare address, no display name. */
function normalizeGoogleEmail(value: string): string {
  const trimmed = value.trim();
  // A single bare address like "user@example.com" — reject anything with
  // extra structure (angle brackets, commas, display names) since
  // net/mail.ParseAddress would only accept it if address.Address === value.
  const simpleEmailRe = /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/;
  if (!simpleEmailRe.test(trimmed)) {
    throw new Error("enter a valid Google account email address");
  }
  return trimmed;
}

function parseGoogleAuthResponse(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    result[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return result;
}

export function googleAuthError(code: string): Error {
  switch (code) {
    case "BadAuthentication":
      return new Error("Google rejected the oauth_token; obtain a fresh cookie and try again");
    case "NeedsBrowser":
      return new Error("Google requires a fresh Embedded Setup sign-in");
    case "MissingDroidguard":
      return new Error("Google rejected the device verification data");
    default:
      return new Error(`Google authentication failed with ${code}`);
  }
}

/** Port of exchangeEmbeddedSetupToken. Form-POSTs the pasted oauth_token to
 * Google's embedded-setup auth endpoint and parses the key=value\n response. */
export async function exchangeEmbeddedSetupToken(
  oauthToken: string,
  androidId: string,
  endpoint: string = EMBEDDED_SETUP_AUTH_ENDPOINT,
): Promise<GoogleAuthExchange> {
  const form = new URLSearchParams({
    accountType: "HOSTED_OR_GOOGLE",
    Email: GOOGLE_AUTH_EMAIL_HINT,
    has_permission: "1",
    add_account: "1",
    ACCESS_TOKEN: "1",
    Token: oauthToken,
    service: "ac2dm",
    source: "android",
    androidId,
    device_country: "us",
    operatorCountry: "us",
    lang: "en",
    sdk_version: "17",
    google_play_services_version: "240913000",
    client_sig: GOOGLE_PLAY_SERVICES_SIG,
    callerSig: GOOGLE_PLAY_SERVICES_SIG,
    droidguard_results: "dummy123",
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Accept-Encoding": "identity",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "GoogleAuth/1.4",
    },
    body: form.toString(),
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Google authentication returned HTTP ${response.status}`);
  }

  const body = (await response.text()).slice(0, 64 * 1024);
  const values = parseGoogleAuthResponse(body);
  if (values["Error"]) {
    throw googleAuthError(values["Error"]);
  }

  const masterToken = values["Token"];
  if (!masterToken) {
    throw new Error("Google authentication response did not contain a master token");
  }
  let email: string;
  try {
    email = normalizeGoogleEmail(values["Email"] ?? "");
  } catch {
    throw new Error("Google authentication response did not contain a valid account email");
  }

  return { email, masterToken };
}

/** Port of buildGooglePhotosCredential: builds the url-encoded "androidId=...&..."
 * credential string that Google Photos' Android-client API expects. */
export function buildGooglePhotosCredential(
  email: string,
  masterToken: string,
  androidId: string,
): string {
  // Match Go's url.Values.Encode() ordering: keys sorted lexicographically.
  const values: Record<string, string> = {
    androidId,
    app: GOOGLE_PHOTOS_PACKAGE,
    callerPkg: GOOGLE_PHOTOS_PACKAGE,
    callerSig: GOOGLE_PHOTOS_SIG,
    client_sig: GOOGLE_PHOTOS_SIG,
    device_country: "us",
    Email: email,
    google_play_services_version: "240913000",
    lang: "en_US",
    oauth2_foreground: "1",
    operatorCountry: "us",
    sdk_version: "33",
    service: GOOGLE_PHOTOS_SERVICE,
    source: "android",
    Token: masterToken,
  };
  return encodeSortedForm(values);
}

/** Encodes key/value pairs into a `k=v&k2=v2...` string, keys sorted
 * lexicographically for determinism (order is not semantically meaningful —
 * both our writer and reader parse by key, like Go's url.Values). Uses
 * URLSearchParams's encoder (spaces as "+"), matching Go's url.Values.Encode(). */
export function encodeSortedForm(values: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(values).sort()) {
    params.set(key, values[key]);
  }
  return params.toString();
}
