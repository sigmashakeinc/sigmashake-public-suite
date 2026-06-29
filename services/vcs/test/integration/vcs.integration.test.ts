import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
describe("sigmashake-vcs integration", () => {
  test("package.json name", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.name).toBe("sigmashake-vcs");
  });
  test("wrangler.toml present if CF Worker", () => {
    const w = join(ROOT, "wrangler.toml");
    if (!existsSync(w)) return;
    expect(readFileSync(w, "utf8")).toContain("name");
  });
  test("index.ts exists", () => {
    expect(existsSync(join(ROOT, "src", "index.ts"))).toBe(true);
  });
});
