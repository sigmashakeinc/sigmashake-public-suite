// SAST: scan source for obvious credential patterns. Public mirror safety is
// additionally pinned by regression tests against the mirror script allowlist.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SECRET_PATTERNS = [
  /api[_-]?key\s*=\s*["'][a-zA-Z0-9_-]{16,}["']/i,
  /password\s*=\s*["'][^"']{8,}["']/i,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----\s*\n[A-Za-z0-9+/=\s]{64,}\n-----END/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

function collectSource(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectSource(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(full) && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("sigmashake-abyss sast — credentials", () => {
  const files = [...collectSource(join(ROOT, "src")), ...collectSource(join(ROOT, "public"))];

  test("source tree is present", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("no obvious hardcoded credentials", () => {
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(text)) violations.push(`${file}: ${pattern}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
