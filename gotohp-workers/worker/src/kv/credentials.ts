// Encrypted credential CRUD + selected-account pointer, backed by KV.
// Mirrors configmanager.go's AppConfig.Credentials/Selected, but each
// credential record is its own KV key `cred:<email>` (AES-GCM encrypted)
// instead of an in-memory slice + YAML file.

import { decrypt, encrypt } from "../crypto/aesgcm";
import type { Env } from "../env";
import { credentialNeedsTokenBinding } from "../google/credential";

interface StoredCredentialRecord {
  credential: string;
  addedAt: number;
}

export interface AccountSummary {
  email: string;
  needsTokenBinding: boolean;
}

export interface AccountsState {
  accounts: AccountSummary[];
  selected: string;
}

const CRED_PREFIX = "cred:";
const SELECTED_KEY = "selected";

function credKey(email: string): string {
  return `${CRED_PREFIX}${email}`;
}

export async function putCredential(env: Env, email: string, credential: string): Promise<void> {
  const record: StoredCredentialRecord = { credential, addedAt: Date.now() };
  const envelope = await encrypt(JSON.stringify(record), env.CRED_ENC_KEY);
  await env.CREDS.put(credKey(email), JSON.stringify(envelope));
}

export async function getCredential(env: Env, email: string): Promise<string | null> {
  const raw = await env.CREDS.get(credKey(email));
  if (!raw) return null;
  const envelope = JSON.parse(raw);
  const decrypted = await decrypt(envelope, env.CRED_ENC_KEY);
  const record: StoredCredentialRecord = JSON.parse(decrypted);
  return record.credential;
}

export async function deleteCredential(env: Env, email: string): Promise<void> {
  await env.CREDS.delete(credKey(email));
}

export async function listAccounts(env: Env): Promise<AccountSummary[]> {
  const accounts: AccountSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.CREDS.list({ prefix: CRED_PREFIX, cursor });
    for (const key of page.keys) {
      const email = key.name.slice(CRED_PREFIX.length);
      const raw = await env.CREDS.get(key.name);
      if (!raw) continue;
      try {
        const envelope = JSON.parse(raw);
        const decrypted = await decrypt(envelope, env.CRED_ENC_KEY);
        const record: StoredCredentialRecord = JSON.parse(decrypted);
        accounts.push({
          email,
          needsTokenBinding: credentialNeedsTokenBinding(record.credential),
        });
      } catch {
        // Skip unreadable/corrupt records rather than failing the whole list.
        continue;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return accounts;
}

export async function getSelected(env: Env): Promise<string> {
  return (await env.CREDS.get(SELECTED_KEY)) ?? "";
}

export async function setSelected(env: Env, email: string): Promise<void> {
  await env.CREDS.put(SELECTED_KEY, email);
}

export async function clearSelectedIfMatches(env: Env, email: string): Promise<void> {
  const current = await getSelected(env);
  if (current === email) {
    await env.CREDS.delete(SELECTED_KEY);
  }
}

export async function getAccountsState(env: Env): Promise<AccountsState> {
  const [accounts, selected] = await Promise.all([listAccounts(env), getSelected(env)]);
  return { accounts, selected };
}

/** Insert-or-replace by email (mirrors upsertCredential/AddCredentials'
 * dedupe-by-email semantics), and mark this account selected. */
export async function upsertCredential(env: Env, email: string, credential: string): Promise<void> {
  await putCredential(env, email, credential);
  await setSelected(env, email);
}
