// Port of backend/api.go's Api struct: device profile, userAgent
// computation, and BearerToken()/getAuthToken() (token acquisition +
// KV-backed cache/refresh). Fetch in Workers transparently decompresses
// gzip responses, so there is no equivalent of Go's manual ReadResponseBody
// gzip handling needed here.

import type { Env } from "../env";
import { requiresTokenBindingCrypto } from "./credential";
import { getCachedToken, setCachedToken } from "../kv/tokenCache";
import {
  ANDROID_AUTH_ENDPOINT,
  DEFAULT_ANDROID_API_VERSION,
  DEFAULT_CLIENT_VERSION_CODE,
  DEFAULT_MAKE,
  DEFAULT_MODEL,
} from "./constants";

export class Api {
  readonly androidApiVersion = DEFAULT_ANDROID_API_VERSION;
  model = DEFAULT_MODEL;
  readonly make = DEFAULT_MAKE;
  readonly clientVersionCode = DEFAULT_CLIENT_VERSION_CODE;
  readonly userAgent: string;
  readonly language: string;
  readonly authData: string;
  readonly email: string;

  private cachedAuth: { auth: string; expiry: number } | null = null;

  private constructor(
    private readonly env: Env,
    authData: string,
    email: string,
    language: string,
  ) {
    this.authData = authData;
    this.email = email;
    this.language = language;
    this.userAgent = `com.google.android.apps.photos/${this.clientVersionCode} (Linux; U; Android 9; ${this.language}; ${this.model}; Build/PQ2A.190205.001; Cronet/127.0.6510.5) (gzip)`;
  }

  /** Port of newAPIFromCredential. Throws if the credential requires the
   * out-of-scope Tink token-binding path (Option 3). */
  static fromCredential(env: Env, credential: string): Api {
    if (requiresTokenBindingCrypto(credential)) {
      throw new Error(
        "This credential requires token-binding (rooted-device) authentication, which is not supported.",
      );
    }
    const params = new URLSearchParams(credential.trim());
    const email = params.get("Email") ?? "";
    const language = params.get("lang") ?? "";
    return new Api(env, credential.trim(), email, language);
  }

  /** Port of Api.BearerToken(): returns a cached token if still valid,
   * otherwise refreshes via getAuthToken(). */
  async bearerToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (!this.cachedAuth || this.cachedAuth.expiry <= now) {
      if (this.email) {
        const cached = await getCachedToken(this.env, this.email);
        if (cached) {
          this.cachedAuth = cached;
        }
      }
    }
    if (!this.cachedAuth || this.cachedAuth.expiry <= now) {
      const resp = await this.getAuthToken();
      this.cachedAuth = resp;
      if (this.email) {
        await setCachedToken(this.env, this.email, resp.auth, resp.expiry);
      }
    }
    if (!this.cachedAuth.auth) {
      throw new Error("auth response does not contain bearer token");
    }
    return this.cachedAuth.auth;
  }

  /** Port of Api.getAuthToken(). Token-binding (`token_binding_alias`) is
   * rejected up front in fromCredential(), so this never needs to build a
   * Tink assertion JWT. */
  private async getAuthToken(): Promise<{ auth: string; expiry: number }> {
    const authDataValues = new URLSearchParams(this.authData);

    const requestData = new URLSearchParams();
    for (const [key, value] of authDataValues.entries()) {
      requestData.append(key, value);
    }
    requestData.set("app", "com.google.android.apps.photos");
    requestData.set("callerPkg", "com.google.android.apps.photos");
    requestData.delete("it_caveat_types");
    requestData.delete("assertion_jwt");
    requestData.delete("token_binding_alias");

    const response = await fetch(ANDROID_AUTH_ENDPOINT, {
      method: "POST",
      headers: {
        "Accept-Encoding": "gzip",
        app: "com.google.android.apps.photos",
        Connection: "Keep-Alive",
        "Content-Type": "application/x-www-form-urlencoded",
        device: authDataValues.get("androidId") ?? "",
        "User-Agent": "GoogleAuth/1.4 (Pixel XL PQ2A.190205.001); gzip",
      },
      body: requestData.toString(),
    });

    if (response.status < 200 || response.status >= 300) {
      const body = await response.text();
      throw new Error(`request failed with status ${response.status}: ${body}`);
    }

    const bodyText = await response.text();
    const parsed: Record<string, string> = {};
    for (const rawLine of bodyText.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      parsed[line.slice(0, idx)] = line.slice(idx + 1);
    }

    if (!parsed["Auth"]) {
      throw new Error("auth response missing Auth token");
    }
    if (!parsed["Expiry"]) {
      throw new Error("auth response missing Expiry");
    }

    const expiry = Number.parseInt(parsed["Expiry"], 10);
    if (!Number.isFinite(expiry)) {
      throw new Error("invalid expiry time");
    }

    return { auth: parsed["Auth"], expiry };
  }
}
