// Port of backend/configmanager.go's Option 2 (ReVanced pasted credential)
// validation: AddCredentials' required-fields check, and
// credentialNeedsTokenBinding's token-binding-shape detection (used to reject
// Option 3 credentials, which are out of scope for this rewrite).

const REQUIRED_FIELDS = ["androidId", "app", "client_sig", "Email", "Token", "lang", "service"];

export interface ParsedCredential {
  email: string;
  raw: string;
}

/** Port of AddCredentials' required-fields validation for a raw pasted
 * credential string. Throws with the same "missing fields" shape as Go. */
export function validateRawCredential(rawCredential: string): ParsedCredential {
  const params = new URLSearchParams(rawCredential);

  const missing = REQUIRED_FIELDS.filter((field) => !params.get(field));
  if (missing.length > 0) {
    throw new Error(`auth string missing required fields: [${missing.join(" ")}]`);
  }

  const email = params.get("Email") ?? "";
  if (!email) {
    throw new Error("email cannot be empty");
  }

  return { email, raw: rawCredential };
}

/** Port of credentialNeedsTokenBinding: detects the Option 3 (rooted-device
 * token-binding) credential shape so it can be rejected — Option 3 is out of
 * scope for this rewrite (no Tink/WebCrypto hybrid-encryption path exists). */
export function credentialNeedsTokenBinding(rawCredential: string): boolean {
  const params = new URLSearchParams(rawCredential);
  if (params.get("token_binding_alias")) {
    // Already has a bound alias attached; Go treats this as *not* needing
    // binding (it's already been done) — but Phase 1 still can't exercise
    // the binding-assertion path (Tink), so callers should still reject if
    // they can't use it. Kept identical to Go's boolean semantics here;
    // routes/auth.ts makes the final accept/reject decision.
    return false;
  }
  return Boolean(params.get("assertion_jwt")) || Boolean(params.get("check_tb_upgrade_eligible"));
}

/** True if this credential would hit the Tink hybrid-encryption token-binding
 * assertion path in getAuthToken() (a `token_binding_alias` value present).
 * That path (backend/tokenbinding.go) is Option 3 / out of scope for this
 * rewrite — such credentials must be rejected at /api/auth/add-raw rather
 * than silently stored and failing (or worse, being accepted) later. */
export function requiresTokenBindingCrypto(rawCredential: string): boolean {
  const params = new URLSearchParams(rawCredential);
  return Boolean(params.get("token_binding_alias"));
}

/** Extracts the email from a stored/pasted credential string, or "" if absent
 * or unparseable — mirrors url.ParseQuery(...).Get("Email") call sites. */
export function credentialEmail(rawCredential: string): string {
  try {
    return new URLSearchParams(rawCredential).get("Email") ?? "";
  } catch {
    return "";
  }
}
