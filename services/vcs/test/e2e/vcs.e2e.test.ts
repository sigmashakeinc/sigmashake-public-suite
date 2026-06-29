import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
describe("sigmashake-vcs e2e smoke", () => {
  test("index.ts exists", () => {
    expect(existsSync(join(ROOT, "src", "index.ts"))).toBe(true);
  });
  test("src/routes exists", () => {
    expect(existsSync(join(ROOT, "src/routes"))).toBe(true);
  });
});
