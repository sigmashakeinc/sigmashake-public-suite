// test/session.test.ts — getSession is the read-only port of the
// sigmashake-accounts session decrypt. Vcs uses it to confirm a session
// cookie is still backed by KV + the current ENCRYPTION_KEY.
//
// Tests cover the two-stage check: KV miss → null, and the encryption-key
// rotation guard that returns null when the AES-GCM token field no longer
// decrypts under the current key.

import { describe, expect, test } from "bun:test";
import { getSession, type VcsSession } from "../src/lib/session";

interface KvGetOpts {
  type?: "json" | "text" | "arrayBuffer" | "stream";
}

class MemoryKV {
  store = new Map<string, unknown>();

  seed(key: string, value: unknown): void {
    this.store.set(key, value);
  }

  reset(): void {
    this.store.clear();
  }

  async get<T = unknown>(key: string, _typeOrOpts?: KvGetOpts | string): Promise<T | null> {
    return (this.store.get(key) ?? null) as T | null;
  }
}

const ALGO = "AES-GCM";
const KDF_SALT = new TextEncoder().encode("sigmashake-accounts/session-token/v1");
const KDF_INFO = new TextEncoder().encode("aes-256-gcm-key");

async function deriveKey(secret: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: KDF_SALT, info: KDF_INFO },
    ikm,
    { name: ALGO, length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Mirror sigmashake-accounts encryption to produce a valid token field. */
async function encryptToken(plaintext: string, secret: string, sessionId: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: ALGO, iv, additionalData: new TextEncoder().encode(`session:${sessionId}`) },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  let bin = "";
  for (const b of combined) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe("getSession", () => {
  const SESSION_ID = "sess-abc-123";
  const KEY = "session-encryption-key-v1";
  const baseSession: VcsSession = {
    userId: "twitch:12345",
    login: "alice",
    avatar: "https://example/a.png",
    authType: "twitch",
    twitchLogin: "alice",
  };

  test("returns null when KV has no row for the session id", async () => {
    const kv = new MemoryKV();
    const got = await getSession(kv as unknown as KVNamespace, SESSION_ID);
    expect(got).toBeNull();
  });

  test("returns the session record when no encryption key is provided", async () => {
    const kv = new MemoryKV();
    kv.seed(`session:${SESSION_ID}`, baseSession);
    const got = await getSession(kv as unknown as KVNamespace, SESSION_ID);
    expect(got).toEqual(baseSession);
  });

  test("returns the session record when token decrypts under the current key", async () => {
    const kv = new MemoryKV();
    const token = await encryptToken("twitch-access-token", KEY, SESSION_ID);
    const withToken = { ...baseSession, token };
    kv.seed(`session:${SESSION_ID}`, withToken);

    const got = await getSession(kv as unknown as KVNamespace, SESSION_ID, KEY);
    expect(got).not.toBeNull();
    expect(got?.login).toBe("alice");
  });

  test("returns null when the token field does not decrypt under the provided key", async () => {
    const kv = new MemoryKV();
    const token = await encryptToken("twitch-access-token", KEY, SESSION_ID);
    kv.seed(`session:${SESSION_ID}`, { ...baseSession, token });

    // Caller passes a different (rotated) key — decrypt fails, session rejected.
    const got = await getSession(kv as unknown as KVNamespace, SESSION_ID, "rotated-new-key");
    expect(got).toBeNull();
  });

  test("returns the session when token field is absent (no decrypt attempted)", async () => {
    const kv = new MemoryKV();
    kv.seed(`session:${SESSION_ID}`, baseSession);
    const got = await getSession(kv as unknown as KVNamespace, SESSION_ID, KEY);
    expect(got).toEqual(baseSession);
  });

  test("returns null when token field is present but the AAD does not match", async () => {
    const kv = new MemoryKV();
    // Encrypt with a different sessionId AAD — decrypt under SESSION_ID will fail.
    const token = await encryptToken("token", KEY, "different-session");
    kv.seed(`session:${SESSION_ID}`, { ...baseSession, token });

    const got = await getSession(kv as unknown as KVNamespace, SESSION_ID, KEY);
    expect(got).toBeNull();
  });

  test("returns null on a structurally invalid token ciphertext", async () => {
    const kv = new MemoryKV();
    // 4 bytes — shorter than the 12-byte IV the decrypt helper requires.
    kv.seed(`session:${SESSION_ID}`, { ...baseSession, token: btoa("abcd") });

    const got = await getSession(kv as unknown as KVNamespace, SESSION_ID, KEY);
    expect(got).toBeNull();
  });

  test("ignores a non-string token field (treated as absent)", async () => {
    const kv = new MemoryKV();
    kv.seed(`session:${SESSION_ID}`, { ...baseSession, token: 12345 });

    const got = await getSession(kv as unknown as KVNamespace, SESSION_ID, KEY);
    expect(got).toEqual({ ...baseSession, token: 12345 } as unknown as VcsSession);
  });
});
