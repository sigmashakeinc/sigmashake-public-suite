// Minimal read-only port of accounts session decrypt logic.
// Shares the same SESSIONS KV namespace and ENCRYPTION_KEY secret with
// sigmashake-accounts. Vcs never writes sessions — accounts is the
// single writer; we just decrypt and verify.

const ALGO = "AES-GCM";
const KDF_SALT = new TextEncoder().encode("sigmashake-accounts/session-token/v1");
const KDF_INFO = new TextEncoder().encode("aes-256-gcm-key");
const SESSION_PREFIX = "session:";

export interface VcsSession {
  userId: string; // 'twitch:<id>' | 'kick:<id>' | 'google:<id>' depending on authType
  login: string; // platform login (lowercase): twitch login | kick slug | google email
  avatar: string;
  authType?: "github" | "google" | "saml" | "oidc" | "twitch" | "kick";
  twitchLogin?: string;
}

async function getCryptoKey(secret: string): Promise<CryptoKey> {
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

function aadForSession(sessionId: string): Uint8Array {
  return new TextEncoder().encode(`session:${sessionId}`);
}

async function decryptToken(encrypted: string, secret: string, sessionId: string): Promise<string> {
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  if (combined.byteLength <= 12) throw new Error("ciphertext too short");
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const key = await getCryptoKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: ALGO, iv, additionalData: aadForSession(sessionId) },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(decrypted);
}

export async function getSession(
  kv: KVNamespace,
  sessionId: string,
  encryptionKey?: string,
): Promise<VcsSession | null> {
  const raw = await kv.get<VcsSession>(SESSION_PREFIX + sessionId, "json");
  if (!raw) return null;
  // Token field is encrypted; we don't use it here but we attempt
  // decrypt to confirm the key still matches (rotation guard).
  if (encryptionKey) {
    const tokenField = (raw as unknown as Record<string, unknown>).token;
    if (typeof tokenField === "string") {
      try {
        await decryptToken(tokenField, encryptionKey, sessionId);
      } catch {
        return null;
      }
    }
  }
  return raw;
}
