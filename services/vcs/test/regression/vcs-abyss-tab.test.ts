import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const indexHtml = readFileSync(join(ROOT, "static", "index.html"), "utf8");
const panelJs = readFileSync(join(ROOT, "static", "panel.js"), "utf8");
const panelCss = readFileSync(join(ROOT, "static", "panel.css"), "utf8");
const abyssListRenderer = panelJs.slice(
  panelJs.indexOf("function renderAbyssList"),
  panelJs.indexOf("function renderAbyssCanvas"),
);

describe("VCS SIGMA ABYSS tab", () => {
  test("exposes the Abyss tab in the VCS pager", () => {
    expect(indexHtml).toContain('data-tab="abyss"');
    expect(indexHtml).toContain("SIGMA ABYSS auto battle spectator");
  });

  test("renders Abyss as a public VCS-owned component, not a local-network iframe", () => {
    expect(indexHtml).toContain('id="abyss-canvas"');
    expect(indexHtml).toContain('id="abyss-leaderboard"');
    expect(indexHtml).toContain('id="abyss-feed"');
    expect(indexHtml).not.toContain("<iframe");
    expect(indexHtml).not.toContain("data-src=");
    expect(indexHtml).not.toContain('allow="local-network"');
    expect(indexHtml).not.toContain("127.0.0.1:7777");
    expect(indexHtml).not.toContain("localhost");

    expect(panelJs).toContain('if (name === "abyss") loadAbyssTab();');
    expect(panelJs).toContain("function loadAbyssTab()");
    expect(panelJs).toContain('"https://sigmashake-abyss.sigmashake.workers.dev"');
    expect(panelJs).toContain('fetchAbyssJson("/api/realm/snapshot")');
    expect(panelJs).toContain('fetchAbyssJson("/api/agent/world")');
    expect(panelJs).not.toContain("127.0.0.1:7777");
    expect(panelJs).not.toContain("localhost");
    expect(panelJs).not.toContain("local-network");
  });

  test("keeps Abyss lazy-load idempotent and renders remote text safely", () => {
    expect(panelJs).toContain("state.abyssLoaded");
    expect(panelJs).toContain('view.dataset.loaded === "true"');
    expect(abyssListRenderer).toContain("document.createElement");
    expect(abyssListRenderer).toContain("replaceChildren()");
    expect(abyssListRenderer).toContain("main.textContent = row.main");
    expect(abyssListRenderer).toContain("meta.textContent = row.meta");
    expect(abyssListRenderer).not.toContain("innerHTML");
  });

  test("keeps the spectator realm inside a fixed-height VCS panel", () => {
    expect(panelCss).toContain('.tab-panel[data-tab="abyss"]');
    expect(panelCss).toContain(".abyss-shell");
    expect(panelCss).toContain("#abyss-canvas");
    expect(panelCss).toContain("min-height: 420px");
  });
});
