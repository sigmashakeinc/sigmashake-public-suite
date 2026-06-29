import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const indexHtml = readFileSync(join(ROOT, "static", "index.html"), "utf8");
const panelJs = readFileSync(join(ROOT, "static", "panel.js"), "utf8");
const panelCss = readFileSync(join(ROOT, "static", "panel.css"), "utf8");

describe("VCS SIGMA ABYSS tab", () => {
  test("exposes the Abyss tab in the VCS pager", () => {
    expect(indexHtml).toContain('data-tab="abyss"');
    expect(indexHtml).toContain("SIGMA ABYSS auto battle");
  });

  test("lazy-loads the streamer-local SIGMA ABYSS autobattler", () => {
    expect(indexHtml).toContain('data-src="http://127.0.0.1:7777/?embed=vcs"');
    expect(indexHtml).toContain('allow="local-network-access"');
    expect(panelJs).toContain('if (name === "abyss") loadAbyssTab();');
    expect(panelJs).toContain("function loadAbyssTab()");
  });

  test("keeps the embedded realm inside the fixed-height VCS panel", () => {
    expect(panelCss).toContain('.tab-panel[data-tab="abyss"]');
    expect(panelCss).toContain(".abyss-frame");
    expect(panelCss).toContain("min-height: 420px");
  });
});
