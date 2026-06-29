// test/hmac.test.ts — verifyHmac is the only auth the streamer-side
// vcs-bridge has, so its negative paths matter. These tests focus on
// the failure modes hexToBytes guards against (odd length, non-hex)
// since a relaxed parser would let attackers brute-force shorter sigs.

import { describe, expect, test } from "bun:test";
import { verifyHmac } from "../src/lib/hmac";

const KEY = "test-key-vcs-bridge";

async function signHex(body: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("verifyHmac", () => {
  test("returns true when signature matches body+key", async () => {
    const body = "timestamp:1715000000";
    const sig = await signHex(body, KEY);
    expect(await verifyHmac(body, sig, KEY)).toBe(true);
  });

  test("returns false when body is tampered", async () => {
    const body = "timestamp:1715000000";
    const sig = await signHex(body, KEY);
    expect(await verifyHmac("timestamp:1715000001", sig, KEY)).toBe(false);
  });

  test("returns false when key is wrong", async () => {
    const body = "timestamp:1715000000";
    const sig = await signHex(body, KEY);
    expect(await verifyHmac(body, sig, "wrong-key")).toBe(false);
  });

  test("returns false on odd-length hex string", async () => {
    expect(await verifyHmac("hello", "abc", KEY)).toBe(false);
  });

  test("returns false on hex string with non-hex characters", async () => {
    expect(await verifyHmac("hello", `zzqq${"0".repeat(60)}`, KEY)).toBe(false);
  });

  test("returns false on empty signature string", async () => {
    // empty length is even — but the resulting empty byte array does not match.
    expect(await verifyHmac("hello", "", KEY)).toBe(false);
  });

  test("returns false when one nibble of the signature is flipped", async () => {
    const body = "timestamp:1715000000";
    const sig = await signHex(body, KEY);
    const flipped = sig.slice(0, -1) + (sig[sig.length - 1] === "a" ? "b" : "a");
    expect(await verifyHmac(body, flipped, KEY)).toBe(false);
  });

  test("returns false on truncated signature (one char shorter)", async () => {
    const body = "hello world";
    const sig = await signHex(body, KEY);
    // 63 chars — odd length, hexToBytes rejects.
    expect(await verifyHmac(body, sig.slice(0, -1), KEY)).toBe(false);
  });

  test("handles unicode body bytes correctly", async () => {
    const body = "timestamp:1715000000:user=日本語";
    const sig = await signHex(body, KEY);
    expect(await verifyHmac(body, sig, KEY)).toBe(true);
    // And reject when the unicode is mangled.
    expect(await verifyHmac(`${body} `, sig, KEY)).toBe(false);
  });
});
