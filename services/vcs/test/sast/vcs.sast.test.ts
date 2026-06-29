import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SRC = join(ROOT, "src");
const SECRET_PATTERNS = [
  /api[_-]?key\s*=\s*["'][a-zA-Z0-9_-]{16,}/i,
  /password\s*=\s*["'][^"']{8,}/i,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
];
function collectTs(dir: string): string[] {
  const out: string[] = [];
  let e: string[];
  try {
    e = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of e) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectTs(full));
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}
describe("sigmashake-vcs sast", () => {
  const files = collectTs(SRC);
  test("src has TS files", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  test("no hardcoded credentials", () => {
    const v: string[] = [];
    for (const f of files) {
      const c = readFileSync(f, "utf8");
      for (const p of SECRET_PATTERNS) if (p.test(c)) v.push(`${f}: ${p}`);
    }
    expect(v).toEqual([]);
  });
});
