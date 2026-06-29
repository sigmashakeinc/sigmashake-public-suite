// test/integration/worker-handler.test.ts — cross-file integration sanity:
// the worker entry point, its Durable Object module, and the Hono dep all
// have to line up shape-wise for the bundle to even reach the edge. This
// test reads them as text (no `cloudflare:workers` runtime needed) and
// asserts the contract.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const ROOT = join(SRC, "..");
const WRANGLER_PATH = existsSync(join(ROOT, "wrangler.toml"))
  ? join(ROOT, "wrangler.toml")
  : join(ROOT, "wrangler.example.toml");

describe("sigmashake-abyss integration — module wiring", () => {
  it("entry point src/index.ts exists and ships a default export", () => {
    const main = readFileSync(join(SRC, "index.ts"), "utf8");
    expect(main).toMatch(/export\s+default/);
  });

  it("the entry point installs at least one Hono route handler", () => {
    const main = readFileSync(join(SRC, "index.ts"), "utf8");
    expect(main).toMatch(/\bapp\.(get|post|put|delete|patch)\s*\(/);
  });

  it("any Durable Object class referenced in wrangler.toml is exported from its file", () => {
    const wrangler = readFileSync(WRANGLER_PATH, "utf8");
    const classes = [...wrangler.matchAll(/class_name\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    if (classes.length === 0) return; // no DO bindings — nothing to verify
    const main = readFileSync(join(SRC, "index.ts"), "utf8");
    // Either the class is exported from the entry, or re-exported from a
    // sibling module that the entry pulls in. Accept either shape.
    for (const cls of classes) {
      const exported = new RegExp(
        `export\\s+(class|\\{[^}]*\\b${cls}\\b[^}]*\\})\\s+\\b${cls}?\\b`,
      );
      const reexports = main.match(/from\s+["']([^"']+)["']/g) ?? [];
      const directHit = exported.test(main);
      const sibling = reexports.some((r) => {
        const path = r.match(/["']([^"']+)["']/)?.[1] ?? "";
        const sib = join(SRC, path.replace(/^\.\//, "") + ".ts");
        if (!existsSync(sib)) return false;
        return new RegExp(`export\\s+class\\s+${cls}\\b`).test(readFileSync(sib, "utf8"));
      });
      expect(directHit || sibling, `DO class ${cls} is not exported from any imported module`).toBe(
        true,
      );
    }
  });
});
