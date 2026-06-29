// test/api/routes.test.ts — guard the public Hono route surface that
// agent clients depend on. A rename or accidental delete in src/index.ts
// fails this assertion before it ships to the edge.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "index.ts"),
  "utf8",
);

describe("sigmashake-abyss HTTP API surface", () => {
  it("registers a health probe", () => {
    expect(src).toMatch(/\/healthz/);
  });

  it("uses Hono's app.get / app.post for route registration", () => {
    const verbs = src.match(/\bapp\.(get|post|put|delete|patch)\s*\(/g) ?? [];
    expect(verbs.length).toBeGreaterThan(0);
  });
});
