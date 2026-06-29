/** Verify an HMAC-SHA-256 hex signature over `body` using `key`. */
export async function verifyHmac(body: string, signature: string, key: string): Promise<boolean> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const sigBytes = hexToBytes(signature);
  if (!sigBytes) return false;
  return crypto.subtle.verify("HMAC", cryptoKey, sigBytes, enc.encode(body));
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) return null;
    bytes[i / 2] = byte;
  }
  return bytes;
}
