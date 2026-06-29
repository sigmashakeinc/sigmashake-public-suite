import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
describe("sigmashake-vcs api", () => {
  test("index.ts has export default or handler", () => {
    const src = readFileSync(join(ROOT, "src", "index.ts"), "utf8");
    expect(
      src.includes("export default") ||
        src.includes("export const") ||
        src.includes("export function"),
    ).toBe(true);
  });
  test("src/routes exists", () => {
    expect(existsSync(join(ROOT, "src/routes"))).toBe(true);
  });
});
