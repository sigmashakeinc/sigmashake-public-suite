import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
describe("sigmashake-vcs dependencies", () => {
  test("no package-lock.json", () => {
    expect(existsSync(join(ROOT, "package-lock.json"))).toBe(false);
  });
  test('no "latest" in runtime deps', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(Object.values(pkg.dependencies ?? {}).filter((v) => v === "latest")).toEqual([]);
  });
});
