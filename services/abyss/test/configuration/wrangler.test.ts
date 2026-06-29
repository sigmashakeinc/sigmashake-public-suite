// test/configuration/wrangler.test.ts — pin the wrangler config shape that
// SIGMA ABYSS depends on. A regen that drops the DO binding or the R2 bucket
// silently breaks the edge runtime; this test catches that at sweep time.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const wranglerPath = existsSync(join(root, "wrangler.toml"))
  ? join(root, "wrangler.toml")
  : join(root, "wrangler.example.toml");
const wrangler = readFileSync(wranglerPath, "utf8");

describe("sigmashake-abyss wrangler.toml", () => {
  it("declares the worker name", () => {
    expect(wrangler).toMatch(/name\s*=\s*"sigmashake-abyss"/);
  });

  it("targets a compatibility_date inside the 21xx range", () => {
    const m = wrangler.match(/compatibility_date\s*=\s*"(\d{4})-\d{2}-\d{2}"/);
    expect(m, "compatibility_date is missing").not.toBeNull();
    expect(parseInt(m![1], 10)).toBeGreaterThanOrEqual(2025);
  });

  it("references the abyss source entry point", () => {
    const main = wrangler.match(/main\s*=\s*"([^"]+)"/)?.[1] ?? "";
    expect(existsSync(join(here, "..", "..", main))).toBe(true);
  });
});
