// test/dependencies/pinning.test.ts — guard the supply-chain shape. The
// monorepo policy is: bun.lock present + no banned package-lock.json + a
// matching package.json runtime dep set.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("sigmashake-abyss dependencies", () => {
  it("bun.lock is present (monorepo pin policy)", () => {
    expect(existsSync(join(ROOT, "bun.lock"))).toBe(true);
  });

  it("npm package-lock.json is NOT present (banned in this monorepo)", () => {
    expect(existsSync(join(ROOT, "package-lock.json"))).toBe(false);
  });

  it("hono is pinned to a 4.x runtime dep", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.dependencies?.hono).toMatch(/^\^?4\./);
  });
});
