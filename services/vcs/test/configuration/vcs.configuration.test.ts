import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
describe("sigmashake-vcs configuration", () => {
  test("tsconfig.json parseable", () => {
    const p = join(ROOT, "tsconfig.json");
    if (!existsSync(p)) return;
    expect(JSON.parse(readFileSync(p, "utf8")).compilerOptions).toBeDefined();
  });
  test("wrangler.toml has compatibility_date if present", () => {
    const w = join(ROOT, "wrangler.toml");
    if (!existsSync(w)) return;
    expect(readFileSync(w, "utf8")).toContain("compatibility_date");
  });
  test("package.json has test script", () => {
    expect(
      JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts?.test,
    ).toBeDefined();
  });
});
