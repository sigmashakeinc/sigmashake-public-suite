import type { Context } from "hono";
import type { HonoEnv } from "../index";

/**
 * Public-API bearer-key auth. Keys are issued out-of-band and stored in the
 * VCS_API_KEYS KV namespace as  sha256(token) -> ApiKeyRecord. Only the hash
 * is persisted — the raw `sk_vcs_…` token is shown once at issue time and is
 * not recoverable. See wrangler.toml for the namespace + issue procedure.
 */

export interface ApiKeyRecord {
  /** Human label for the key holder — appears in logs, not enforced. */
  owner: string;
  /** Granted scopes, e.g. ["read"]. "*" is a wildcard. */
  scopes: string[];
  /** ISO date the key was issued. */
  created: string;
}

export type ApiKeyResult =
  | { ok: true; key: ApiKeyRecord }
  | { ok: false; status: 401 | 403 | 503; error: string };

/** Lowercase hex SHA-256 of `input`. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function extractBearer(c: Context<HonoEnv>): string | null {
  const header = c.req.header("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function hasScope(key: ApiKeyRecord, scope: string): boolean {
  return key.scopes.includes(scope) || key.scopes.includes("*");
}

/**
 * Resolve `Authorization: Bearer <token>` to an ApiKeyRecord and check it
 * carries `scope`. Every failure mode is returned, never thrown:
 *   503 api_not_configured  — VCS_API_KEYS namespace not bound yet
 *   401 missing_api_key     — no bearer Authorization header
 *   401 invalid_api_key     — token hash absent / record malformed
 *   403 insufficient_scope  — key lacks the required scope
 */
export async function requireApiKey(c: Context<HonoEnv>, scope: string): Promise<ApiKeyResult> {
  const kv = c.env.VCS_API_KEYS;
  if (!kv) return { ok: false, status: 503, error: "api_not_configured" };

  const token = extractBearer(c);
  if (!token) return { ok: false, status: 401, error: "missing_api_key" };

  const record = await kv.get<ApiKeyRecord>(await sha256Hex(token), "json");
  if (!record || !Array.isArray(record.scopes)) {
    return { ok: false, status: 401, error: "invalid_api_key" };
  }

  if (!hasScope(record, scope)) {
    return { ok: false, status: 403, error: "insufficient_scope" };
  }

  return { ok: true, key: record };
}
