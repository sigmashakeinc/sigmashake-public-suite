// test/sast/no-eval.test.ts — penetration-style static audit. Fails the
// moment a dynamic code-execution primitive enters the codebase.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function collect(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "test" || e === "dist" || e.startsWith(".")) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(full)) out.push(full);
  }
  return out;
}

// Patterns assembled from fragments so this audit file is not itself flagged
// by the very scanner it embodies.
const FORBIDDEN = [
  { label: "dynamic source evaluation", re: new RegExp("\\b" + "ev" + "al" + "\\s*\\(") },
  {
    label: "runtime function construction",
    re: new RegExp("\\bnew\\s+" + "Func" + "tion" + "\\s*\\("),
  },
];

describe("sigmashake-abyss sast — code-injection surface", () => {
  const files = collect(ROOT);

  it("source tree is present", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const p of FORBIDDEN) {
    it(`source contains no ${p.label}`, () => {
      const hits = files.filter((f) => p.re.test(readFileSync(f, "utf8")));
      expect(hits).toEqual([]);
    });
  }
});
