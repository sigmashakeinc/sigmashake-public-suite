/*
 * Vibe Coder Sim — standalone paper-doll character builder.
 *
 * Renders the same LPC paperdoll the OBS overlay uses (composeAvatar from
 * sigmashake-chat-elixir, vendored into /assets/js/vibe-coder-sim/). The
 * main canvas shows the live avatar with the user's loadout; each slot
 * cell renders a mini-canvas showing just the equipped item layered on
 * a neutral base body, and the inventory grid renders one thumbnail
 * per owned item the same way.
 *
 * Auth: see resolveViewer / session.ts on the worker side. Page calls
 * /whoami first to confirm identity, then /me for the loadout. If /me
 * 503s (bridge offline), the page shows the streamer-offline state with
 * the user's identity still visible.
 */

import { composeAvatar } from "/assets/js/vibe-coder-sim/lpc-avatar.js";
import { nearestRampName, RAMPS } from "/assets/js/vibe-coder-sim/lpc-recolor.js";

const BASE = ""; // same-origin
const ACCOUNTS_SIGNIN = "https://accounts.sigmashake.com/auth/twitch";
const ACCOUNTS_SIGNIN_KICK = "https://accounts.sigmashake.com/auth/kick";
const ACCOUNTS_SIGNIN_GOOGLE = "https://accounts.sigmashake.com/auth/google";
const ACCOUNTS_SIGNOUT = "https://accounts.sigmashake.com/auth/logout";
const ABYSS_API_BASE = "https://sigmashake-abyss.sigmashake.workers.dev";

const HAIR_STYLES = [
  "short",
  "long",
  "bob",
  "ponytail",
  "spiky",
  "afro",
  "pixie",
  "idol",
  "lob",
  "swoop",
  "curly",
  "bedhead",
  "curtains",
  "buzzcut",
  "halfup",
  "braid",
  "bunches",
  "wavy",
  "cornrows",
  "dreads",
  "dreadslong",
  "halfmessy",
  "bangs",
  "longhawk",
  "balding",
];
const HAT_STYLES = [
  "cap",
  "beanie",
  "tophat",
  "cowboy",
  "wizard",
  "hood",
  "santa",
  "pirate",
  "headband",
  "visor",
  "elf",
  "viking",
  "barbarian",
  "morion",
  "kettle",
  "legion",
  "norman",
  "armet",
  "celestial",
  "magiclarge",
  "bare",
];
const BEARD_STYLES = ["5oclock", "basic", "medium", "trimmed", "mustache", "handlebar", "walrus"];
const GLASSES_STYLES = ["clear", "sun", "shades", "nerd", "round", "monocle", "eyepatch"];
const EYEBROWS_STYLES = ["thick", "thin"];
const SHIRT_STYLES = ["longsleeve", "shortsleeve", "sleeveless", "vest"];
const PANTS_STYLES = [
  "pants",
  "shorts",
  "shortshorts",
  "leggings",
  "pantaloons",
  "formal",
  "skirt",
  "legionskirt",
];
const SHOES_STYLES = ["basic", "boots", "sandals", "slippers"];
const JACKET_STYLES = ["collared", "frock", "trench", "tabard", "santa"];
const SHOULDERS_STYLES = ["pauldrons", "bauldron", "epaulets", "mantal"];
const BRACERS_STYLES = ["basic"];
const NECK_STYLES = ["chain", "beaded", "cross", "star", "scarf"];
const BACKPACK_STYLES = ["basic"];

// Order + display names match the chat-elixir SLOT_ORDER + paperdoll layout.
const SLOTS_LEFT = [
  ["head", "Head"],
  ["hair", "Hair"],
  ["eyes", "Eyes"],
  ["dress", "Dress"],
  ["aura", "Aura"],
];
const SLOTS_RIGHT = [
  ["wings", "Wings"],
  ["accessory", "Accessory"],
  ["companion", "Pet"],
  ["trail", "Trail"],
  ["pose", "Pose"],
];
const ALL_SLOTS = SLOTS_LEFT.concat(SLOTS_RIGHT);

const state = {
  source: "twitch",     // "twitch" | "kick" | "google" — from whoami
  twitchUserId: null,
  userId: null,         // platform user_id (generic)
  login: null,
  xp: 0,
  loadout: {}, // {head, hair, dress, eyes, c_hair, c_skin, body, hair_style, hat_style, hue, ...}
  inventory: [], // [item_key, ...]
  catalog: null, // {items: {head: [{key, rarity, ...}], ...}}
  shop: null, // {items: [...], discount, ...} — featured rotation
  combat: null, // {sigma: {weapon, armor, ring, relic, charm, level, depth, ...}} | {error}
  combatLoadout: null, // {gear:{weapon,...}, inventory:[{index,name,rarity,power,slot,family}]} | {error}
  combatEquipping: false, // true while a /combat-equip POST is in flight (locks the bag)
  weaponCatalog: null, // {ok, tunables, maxSlots, weapons:WeaponDef[], evolutions:Evolution[]} — static; cached after first load
  combatWeapons: null, // {ok, weapons:string[], activeWeapon, available, maxSlots, evolutions, fainted, lostWeapon} | {error}
  abyss: null, // {snapshot, world, fallback}
  abyssLoaded: false,
  abyssRefreshBound: false,
};

// Synthetic pet objects used to drive composeAvatar for each canvas.
// avatarPet renders the full loadout; slotPets[slot] renders a single
// item layered on a neutral base body for the slot-cell thumbnail.
// _motion.vx > 0.02 flips lpc-avatar's pickState() into the walk anim
// loop, so the paper-doll avatar visibly animates instead of holding
// the static 'sit' frame.
const avatarPet = {
  seed: 1,
  sleeping: false,
  cosmetics: {},
  _motion: { facing: 1, vx: 0.1, vz: 0, dir: "right" },
};
const slotPets = new Map(); // slot → pet object
const inventoryPets = new Map(); // item_key → pet object
const shopPets = new Map(); // item_key → pet object (shop previews)

// Module scripts are deferred, so DOMContentLoaded may have fired
// before this line runs. Guard the listener so we never miss the boot.
// Defer with queueMicrotask in the else branch so the rest of this
// module finishes evaluating first — otherwise init() runs while later
// const declarations (RAMP_KEY_INDEX, COLOR_PRESETS, …) are still in TDZ.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  queueMicrotask(init);
}

async function init() {
  wireSignIn();
  wireUiHandlers();
  wireDirControls();
  wireTabs();
  wireSubTabs();
  wireBuildTabInit();
  renderStylePickersStatic();
  renderPalettes();
  startAvatarLoop();
  await bootstrap();
}

/* ── Customize tabs (Looks / Clothes / Colors / Items / Shop) ───────── */

function wireTabs() {
  document.querySelectorAll(".tab-btn[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });
}

function activateTab(name) {
  document.querySelectorAll(".tab-btn[data-tab]").forEach((btn) => {
    const on = btn.dataset.tab === name;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".tab-panel[data-tab]").forEach((panel) => {
    const on = panel.dataset.tab === name;
    panel.classList.toggle("active", on);
    panel.hidden = !on;
  });
  // Combat tab is lazy-loaded — MMO data isn't fetched at boot. Fire once
  // on first activation; refresh on every subsequent activation so a
  // chatter who just got new gear in the MMO sees it within a tab flip.
  if (name === "combat") loadCombatGear();
  // Build tab: lazy-load the passive tree + sigma build data. Re-fetches
  // on every activation so passive allocations, reservations, etc. stay fresh.
  if (name === "build") loadBuildTab();
  if (name === "abyss") loadAbyssTab();
}

function loadAbyssTab() {
  const view = $("abyss-view");
  if (!view) return;
  if (!state.abyssRefreshBound) {
    $("abyss-refresh")?.addEventListener("click", () => refreshAbyss({ force: true }));
    state.abyssRefreshBound = true;
  }
  if (state.abyssLoaded || view.dataset.loaded === "true") return;
  state.abyssLoaded = true;
  view.dataset.loaded = "true";
  refreshAbyss({ force: false });
}

async function refreshAbyss({ force } = { force: false }) {
  setText("abyss-status", force ? "Refreshing public realm..." : "Loading public realm...");
  const refresh = $("abyss-refresh");
  if (refresh) refresh.disabled = true;
  try {
    const [snapshot, world] = await Promise.all([
      fetchAbyssJson("/api/realm/snapshot"),
      fetchAbyssJson("/api/agent/world"),
    ]);
    state.abyss = { snapshot, world, fallback: false };
    setText("abyss-status", `${Number(snapshot.agents || 0)} agents · ${Number(snapshot.openHits || 0)} open HITs`);
  } catch (_err) {
    state.abyss = buildAbyssFallback();
    setText("abyss-status", "Public realm unreachable — showing cached battle formation.");
  } finally {
    if (refresh) refresh.disabled = false;
    renderAbyss();
  }
}

async function fetchAbyssJson(path) {
  const res = await fetch(`${ABYSS_API_BASE}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`abyss_${res.status}`);
  return res.json();
}

function buildAbyssFallback() {
  return {
    fallback: true,
    snapshot: {
      ok: true,
      agents: 4,
      openHits: 0,
      leaderboard: [
        { name: "edgebot", level: 1, gold: 25, taskCoins: 1, reputation: 1, kills: 0 },
        { name: "murderbot", level: 1, gold: 12, taskCoins: 0, reputation: 0, kills: 3 },
        { name: "phase2smoke", level: 1, gold: 0, taskCoins: 0, reputation: 0, kills: 0 },
      ],
      feed: [
        { kind: "join", text: "edgebot entered the abyss" },
        { kind: "join", text: "murderbot entered the abyss" },
        { kind: "oracle", text: "oracle bazaar awaiting the next hit" },
      ],
    },
    world: {
      width: 11,
      height: 11,
      tiles: [
        { x: 5, y: 5, content: { type: "town", code: "spawn" } },
        { x: 5, y: 4, content: { type: "oracle", code: "oracle" } },
        { x: 4, y: 5, content: { type: "bank", code: "bank" } },
        { x: 6, y: 5, content: { type: "workshop", code: "forge" } },
        { x: 5, y: 2, content: { type: "monster", code: "chrome_rat" } },
        { x: 2, y: 4, content: { type: "monster", code: "void_slime" } },
        { x: 9, y: 9, content: { type: "monster", code: "hollow_knight" } },
        { x: 3, y: 2, content: { type: "resource", code: "chrome_vein" } },
        { x: 7, y: 7, content: { type: "resource", code: "void_timber" } },
      ],
      monsters: {
        chrome_rat: { name: "Chrome Rat", level: 1 },
        void_slime: { name: "Void Slime", level: 3 },
        hollow_knight: { name: "Hollow Knight", level: 10 },
      },
    },
  };
}

function renderAbyss() {
  const data = state.abyss || buildAbyssFallback();
  renderAbyssList("abyss-leaderboard", normalizeAbyssLeaders(data.snapshot?.leaderboard));
  renderAbyssList("abyss-feed", normalizeAbyssFeed(data.snapshot?.feed));
  renderAbyssCanvas(data);
}

function normalizeAbyssLeaders(leaders) {
  const list = Array.isArray(leaders) ? leaders : [];
  if (list.length === 0) return [{ main: "No agents yet", meta: "The realm is waiting for combatants." }];
  return list.slice(0, 6).map((agent, i) => ({
    main: `${i + 1}. ${agent?.name || "agent"}`,
    meta: `Lv ${Number(agent?.level || 1)} · gold ${Number(agent?.gold || 0)} · rep ${Number(agent?.reputation || 0)}`,
  }));
}

function normalizeAbyssFeed(feed) {
  const list = Array.isArray(feed) ? feed : [];
  if (list.length === 0) return [{ main: "No realm events yet", meta: "The abyss is quiet." }];
  return list.slice(0, 7).map((event) => ({
    main: event?.text || "realm event",
    meta: event?.kind || "event",
  }));
}

function renderAbyssList(id, rows) {
  const el = $(id);
  if (!el) return;
  el.replaceChildren();
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "abyss-list-row";
    const main = document.createElement("span");
    main.className = "abyss-list-main";
    main.textContent = row.main;
    const meta = document.createElement("span");
    meta.className = "abyss-list-meta";
    meta.textContent = row.meta;
    item.append(main, meta);
    el.appendChild(item);
  }
}

function renderAbyssCanvas(data) {
  const canvas = $("abyss-canvas");
  const ctx = canvas?.getContext?.("2d");
  if (!canvas || !ctx) return;
  const world = data.world || {};
  const width = Number(world.width || 11);
  const height = Number(world.height || 11);
  const tiles = Array.isArray(world.tiles) ? world.tiles : [];
  const tileByCoord = new Map(tiles.map((tile) => [`${tile.x},${tile.y}`, tile.content]));
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  const cssWidth = canvas.clientWidth || 720;
  const cssHeight = canvas.clientHeight || 360;
  if (canvas.width !== cssWidth * dpr || canvas.height !== cssHeight * dpr) {
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  const cell = Math.max(16, Math.floor(Math.min((cssWidth - 220) / width, (cssHeight - 28) / height)));
  const originX = 14;
  const originY = 14;

  ctx.fillStyle = "#0b1118";
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  ctx.strokeStyle = "#2d3748";
  ctx.strokeRect(0.5, 0.5, cssWidth - 1, cssHeight - 1);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const content = tileByCoord.get(`${x},${y}`);
      const px = originX + x * cell;
      const py = originY + y * cell;
      ctx.fillStyle = abyssTileColor(content?.type);
      ctx.fillRect(px, py, cell - 2, cell - 2);
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.strokeRect(px + 0.5, py + 0.5, cell - 3, cell - 3);
      const glyph = abyssTileGlyph(content?.type);
      if (glyph) {
        ctx.fillStyle = "#f4f7fb";
        ctx.font = `${Math.max(10, Math.floor(cell * 0.42))}px ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(glyph, px + cell / 2 - 1, py + cell / 2 - 1);
      }
    }
  }

  const leaders = Array.isArray(data.snapshot?.leaderboard) ? data.snapshot.leaderboard.slice(0, 4) : [];
  leaders.forEach((agent, i) => drawAbyssAgent(ctx, agent, i, originX, originY, cell, width, height));
  drawAbyssHud(ctx, data, cssWidth, cssHeight);
}

function abyssTileColor(type) {
  return {
    town: "#16314a",
    oracle: "#322052",
    monster: "#4a1f29",
    resource: "#183f2d",
    workshop: "#40361c",
    bank: "#173645",
  }[type] || "#111827";
}

function abyssTileGlyph(type) {
  return {
    town: "T",
    oracle: "O",
    monster: "M",
    resource: "R",
    workshop: "W",
    bank: "B",
  }[type] || "";
}

function drawAbyssAgent(ctx, agent, i, originX, originY, cell, width, height) {
  const spots = [
    [5, 5],
    [5, 2],
    [2, 4],
    [8, 6],
  ];
  const [x, y] = spots[i] || [Math.min(width - 1, i + 1), Math.min(height - 1, i + 1)];
  const px = originX + x * cell + cell / 2;
  const py = originY + y * cell + cell / 2;
  ctx.fillStyle = ["#7dd3fc", "#fbbf24", "#c084fc", "#34d399"][i % 4];
  ctx.beginPath();
  ctx.arc(px, py, Math.max(5, cell * 0.2), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#07111b";
  ctx.font = `${Math.max(9, Math.floor(cell * 0.28))}px ui-monospace, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(agent?.name || "A").slice(0, 1).toUpperCase(), px, py + 0.5);
}

function drawAbyssHud(ctx, data, width, height) {
  const x = Math.max(420, width - 194);
  ctx.fillStyle = "rgba(8, 13, 20, 0.86)";
  ctx.fillRect(x, 16, width - x - 14, height - 32);
  ctx.strokeStyle = "#2d3748";
  ctx.strokeRect(x + 0.5, 16.5, width - x - 15, height - 33);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#bf94ff";
  ctx.font = "700 13px ui-monospace, monospace";
  ctx.fillText("AUTO BATTLE", x + 14, 30);
  ctx.fillStyle = "#efeff1";
  ctx.font = "12px ui-monospace, monospace";
  ctx.fillText(`${Number(data.snapshot?.agents || 0)} agents online`, x + 14, 58);
  ctx.fillText(`${Number(data.snapshot?.openHits || 0)} oracle hits open`, x + 14, 78);
  ctx.fillStyle = "#adadb8";
  ctx.fillText(data.fallback ? "fallback formation" : "public edge realm", x + 14, 104);
  ctx.fillStyle = "#ffc857";
  ctx.fillText("T town  O oracle", x + 14, height - 84);
  ctx.fillStyle = "#f87171";
  ctx.fillText("M monster", x + 14, height - 64);
  ctx.fillStyle = "#34d399";
  ctx.fillText("R resource", x + 14, height - 44);
}

function wireSubTabs() {
  document.querySelectorAll(".subtab-btn[data-subtab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      // Resolve to the parent .tab-panel so each main tab's sub-tab state
      // is scoped independently — switching a sub-tab in "Looks" doesn't
      // disturb the active sub-tab in "Clothes".
      const panel = btn.closest(".tab-panel");
      if (!panel) return;
      activateSubTab(panel, btn.dataset.subtab);
    });
  });
}

function activateSubTab(tabPanel, name) {
  tabPanel.querySelectorAll(":scope > .subtab-bar > .subtab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.subtab === name);
  });
  tabPanel.querySelectorAll(":scope > .subtab-body > .subtab-panel").forEach((panel) => {
    const on = panel.dataset.subtab === name;
    panel.classList.toggle("active", on);
    panel.hidden = !on;
  });
}

/* ── Direction controls ─────────────────────────────────────────────── */

function wireDirControls() {
  document.querySelectorAll(".dir-btn[data-dir]").forEach((btn) => {
    btn.addEventListener("click", () => setDir(btn.dataset.dir));
  });
  const walkBtn = $("dir-walk");
  if (walkBtn) walkBtn.addEventListener("click", toggleWalk);
  paintDirButtons();
}

function setDir(dir) {
  const m = avatarPet._motion;
  m.dir = dir;
  if (dir === "left") m.facing = -1;
  else if (dir === "right") m.facing = 1;
  paintDirButtons();
}

function toggleWalk() {
  const m = avatarPet._motion;
  m.vx = Math.abs(m.vx) > 0.02 ? 0 : 0.1;
  paintDirButtons();
}

function paintDirButtons() {
  const m = avatarPet._motion;
  document.querySelectorAll(".dir-btn[data-dir]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.dir === m.dir);
  });
  const walkBtn = $("dir-walk");
  if (walkBtn) walkBtn.textContent = Math.abs(m.vx) > 0.02 ? "■" : "▶";
}

/* ── Sign-in handling ───────────────────────────────────────────────── */

function wireSignIn() {
  const ret = encodeURIComponent(`${window.location.origin}/`);
  const set = (id, base) => {
    const el = $(id);
    if (el) el.href = `${base}?return_to=${ret}`;
  };
  set("signin-btn", ACCOUNTS_SIGNIN);
  set("signin-kick", ACCOUNTS_SIGNIN_KICK);
  set("signin-google", ACCOUNTS_SIGNIN_GOOGLE);
  const signoutUrl = `${ACCOUNTS_SIGNOUT}?return_to=${ret}`;
  for (const id of ["signout-link", "offline-signout"]) {
    const el = $(id);
    if (el) el.href = signoutUrl;
  }
}

/* ── UI wiring ──────────────────────────────────────────────────────── */

function wireUiHandlers() {
  // Body radios — explicit body slot
  document.querySelectorAll("input[name=body]").forEach((r) => {
    r.addEventListener("change", () => postBody(r.value));
  });

  // Hue slider — debounced
  let hueTimer = null;
  $("hue-slider").addEventListener("input", (ev) => {
    const v = parseInt(ev.target.value, 10) || 0;
    $("hue-value").textContent = `${v}°`;
    state.loadout = { ...state.loadout, hue: v };
    clearTimeout(hueTimer);
    hueTimer = setTimeout(() => postHue(v), 220);
  });
  $("hue-clear").addEventListener("click", () => {
    $("hue-slider").value = 0;
    $("hue-value").textContent = "0°";
    state.loadout = { ...state.loadout };
    delete state.loadout.hue;
    postClearRawSlot("hue");
  });

  // Slot clear (unequip) buttons — stopPropagation so they don't also
  // trigger the cell's empty-cell click handler.
  document.querySelectorAll("button.slot-clear[data-slot]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      postUnequip(btn.dataset.slot);
    });
  });

  // Slot cells — clicking an empty cell scrolls to that slot's section
  // in the catalog browser so the user can see what's available.
  document.querySelectorAll(".slot-cell[data-slot]").forEach((cell) => {
    cell.addEventListener("click", () => {
      if (cell.classList.contains("empty")) {
        focusSlotInCatalog(cell.dataset.slot);
      }
    });
  });
}

function focusSlotInCatalog(slot) {
  const section = document.querySelector(`[data-slot-section="${slot}"]`);
  if (!section) return;
  section.scrollIntoView({ behavior: "smooth", block: "center" });
  section.classList.add("flash");
  setTimeout(() => section.classList.remove("flash"), 1200);
}

/* ── Bootstrap ──────────────────────────────────────────────────────── */

async function bootstrap() {
  hide("signin-prompt");
  hide("streamer-offline");
  hide("vcs-ui");
  show("loading");

  try {
    // Step 1: who-are-you check (bridge-free).
    const who = await fetchJson("/api/v1/vcs/whoami", { method: "GET" });
    if (who.unauthenticated) {
      hide("loading");
      show("signin-prompt");
      return;
    }
    // Use generic identity fields; fall back to back-compat twitch_* fields
    // so the page works regardless of Worker rollout order.
    state.source = who.source || "twitch";
    state.login = who.login || who.twitch_login;
    state.userId = who.user_id || who.twitch_user_id;
    state.twitchUserId = who.twitch_user_id || who.user_id; // back-compat
    avatarPet.seed = stableSeed(state.login);

    // Combat + Build tabs are Twitch-only: hide them for kick/google sources.
    // The Build tab surfaces MMO passive tree / spirit reservations / position —
    // all of which key off a Twitch login in the MMO. Non-Twitch viewers see a
    // friendly "combat_twitch_only" message on the server, but hiding the tab
    // is cleaner UX.
    const combatTabBtn = document.querySelector('.tab-btn[data-tab="combat"]');
    const combatTabPanel = document.querySelector('.tab-panel[data-tab="combat"]');
    const buildTabBtn = document.querySelector('.tab-btn[data-tab="build"]');
    const buildTabPanel = document.querySelector('.tab-panel[data-tab="build"]');
    if (state.source !== "twitch") {
      if (combatTabBtn) combatTabBtn.hidden = true;
      if (combatTabPanel) combatTabPanel.hidden = true;
      if (buildTabBtn) buildTabBtn.hidden = true;
      if (buildTabPanel) buildTabPanel.hidden = true;
    } else {
      if (combatTabBtn) combatTabBtn.hidden = false;
      if (buildTabBtn) buildTabBtn.hidden = false;
    }

    // Step 2: full loadout via /me. Bridge-gated; on 503 show the offline state.
    const me = await fetchJson("/api/v1/vcs/me", { method: "GET" });
    if (me.ok === false && me.error === "bridge_offline") {
      hide("loading");
      $("offline-login").textContent = `@${state.login}`;
      show("streamer-offline");
      return;
    }
    if (me.ok !== false) {
      state.xp = me.xp ?? 0;
      state.loadout = me.loadout ?? {};
      state.inventory = me.inventory ?? [];
      state.shop = me.shop ?? null;
    }

    // Catalog (bridge-gated too — used to look up slot + rarity per item).
    const cat = await fetchJson("/api/v1/vcs/catalog", { method: "GET" });
    if (cat.ok !== false) state.catalog = cat;

    hide("loading");
    show("vcs-ui");
    renderAll();
  } catch (e) {
    console.error("[vcs] bootstrap failed", e);
    hide("loading");
    showError("Could not load the page. Try again in a moment.");
  }
}

/* ── Network ────────────────────────────────────────────────────────── */

async function postBody(body) {
  return commitMutation("/api/v1/vcs/body", { body });
}
async function postColor(slot, hex) {
  return commitMutation("/api/v1/vcs/color", { slot, hex });
}
async function postHue(hue) {
  return commitMutation("/api/v1/vcs/hue", { hue });
}
async function postRawSlot(slot, value) {
  return commitMutation("/api/v1/vcs/raw_slot", { slot, value });
}
async function postClearRawSlot(slot) {
  return commitMutation("/api/v1/vcs/clear_raw_slot", { slot });
}
async function postEquip(slot, item_key) {
  return commitMutation("/api/v1/vcs/equip", { slot, item_key });
}
async function postUnequip(slot) {
  return commitMutation("/api/v1/vcs/unequip", { slot });
}
async function postBuy(item_key) {
  return commitMutation("/api/v1/vcs/buy", { item_key });
}

async function commitMutation(path, body) {
  const r = await fetchJson(path, { method: "POST", body });
  if (r.ok === false) return false;
  // The backend returns the fresh loadout on every mutation — re-render.
  if (r.loadout) state.loadout = r.loadout;
  if (typeof r.xp === "number") state.xp = r.xp;
  if (Array.isArray(r.inventory)) state.inventory = r.inventory;
  // Buy responses don't include `shop` but we keep what /me gave us;
  // it rotates by week so a stale view between buys is harmless.
  renderAll();
  return true;
}

async function fetchJson(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || "GET",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) return { unauthenticated: true, ok: false };
  const data = await res.json().catch(() => ({ ok: false, error: "bad_json" }));
  if (data.ok === false && data.error !== "bridge_offline") {
    showError(humanizeError(data.error, path));
  } else if (res.ok) {
    hideError();
  }
  return data;
}

/* ── Rendering ──────────────────────────────────────────────────────── */

function renderAll() {
  renderTopbar();
  renderBody();
  renderStylePickers();
  renderPaletteSelection();
  renderHue();
  renderSlotCells();
  renderInventory();
  renderShopFeatured();
  renderCatalogBrowser();
  $("footer-login").textContent = state.login ? `@${state.login}` : "—";
  syncAvatarPet();
}

function renderTopbar() {
  const loginEl = $("who-login");
  if (loginEl) {
    // Render login with a source badge for non-twitch providers.
    const badge = state.source && state.source !== "twitch"
      ? ` <span class="source-badge source-badge-${state.source}">${state.source}</span>`
      : "";
    loginEl.innerHTML = `@${state.login || ""}${badge}`;
  }
  $("who-xp").textContent = (state.xp || 0).toLocaleString();
}

function renderBody() {
  const v = state.loadout.body || "auto";
  document.querySelectorAll("input[name=body]").forEach((r) => {
    r.checked = r.value === v;
  });
}

// (containerId, choices, raw-slot name)
const STYLE_PICKERS = [
  ["hair-style-picker", HAIR_STYLES, "hair_style"],
  ["hat-style-picker", HAT_STYLES, "hat_style"],
  ["beard-picker", BEARD_STYLES, "beard"],
  ["glasses-picker", GLASSES_STYLES, "glasses"],
  ["eyebrows-picker", EYEBROWS_STYLES, "eyebrows"],
  ["shirt-style-picker", SHIRT_STYLES, "shirt_style"],
  ["pants-style-picker", PANTS_STYLES, "pants_style"],
  ["shoes-style-picker", SHOES_STYLES, "shoes_style"],
  ["jacket-picker", JACKET_STYLES, "jacket"],
  ["shoulders-picker", SHOULDERS_STYLES, "shoulders"],
  ["bracers-picker", BRACERS_STYLES, "bracers"],
  ["neck-picker", NECK_STYLES, "neck"],
  ["backpack-picker", BACKPACK_STYLES, "backpack"],
];

function renderStylePickersStatic() {
  for (const [id, choices, slot] of STYLE_PICKERS) {
    const el = $(id);
    if (el) renderChipRow(el, choices, slot);
  }
}

function renderStylePickers() {
  // Update which chips are .active based on current loadout values
  for (const [containerId, , slot] of STYLE_PICKERS) {
    const container = $(containerId);
    if (!container) continue;
    const current = state.loadout[slot];
    container.querySelectorAll(".chip").forEach((c) => {
      c.classList.toggle("active", c.dataset.value === current);
    });
  }
}

function renderChipRow(container, choices, slot) {
  container.dataset.slot = slot;
  container.innerHTML = "";
  for (const choice of choices) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = choice;
    chip.dataset.value = choice;
    chip.addEventListener("click", () => postRawSlot(slot, choice));
    container.appendChild(chip);
  }
  const clear = document.createElement("span");
  clear.className = "chip chip-clear";
  clear.textContent = "✕ none";
  clear.addEventListener("click", () => postClearRawSlot(slot));
  container.appendChild(clear);
}

/* ── Palette swatches (LPC ramps) ───────────────────────────────────── */

const RAMP_KEY_INDEX = 4; // index 4 = the "main" key shade of each ramp (per lpc-recolor.js)

function renderPalettes() {
  renderPaletteFor("palette-skin", "body", "c_skin");
  renderPaletteFor("palette-hair", "hair", "c_hair");
  renderPaletteFor("palette-shirt", "cloth", "c_shirt");
  renderPaletteFor("palette-pants", "cloth", "c_pants");
  renderPaletteFor("palette-jacket", "cloth", "c_jacket");
  renderPaletteFor("palette-shoulders", "cloth", "c_shoulders");
  renderPaletteFor("palette-shoes", "cloth", "c_shoes");
  renderPaletteFor("palette-bracers", "cloth", "c_bracers");
  renderPaletteFor("palette-neck", "cloth", "c_neck");
}

function renderPaletteFor(containerId, material, slot) {
  const container = $(containerId);
  if (!container) return;
  const ramps = RAMPS[material] || {};
  container.innerHTML = "";
  for (const [name, hexes] of Object.entries(ramps)) {
    const sw = document.createElement("button");
    sw.className = "swatch";
    sw.title = name;
    sw.dataset.ramp = name;
    sw.dataset.slot = slot;
    // Use the bright key shade (#4) as the visible color; show a small dark→light
    // strip across the bottom to convey it's a ramp not a single tone.
    const key = hexes[RAMP_KEY_INDEX] || hexes[hexes.length - 1];
    sw.style.background =
      "linear-gradient(180deg," +
      key +
      " 0%," +
      key +
      " 70%," +
      hexes[0] +
      " 70%," +
      hexes[Math.floor(hexes.length / 2)] +
      " 85%," +
      hexes[hexes.length - 1] +
      " 100%)";
    sw.addEventListener("click", () => {
      // Send the key-shade hex; the backend resolveColor + nearestRampName will
      // snap it back to this exact ramp on the renderer side.
      postColor(slot, key);
    });
    container.appendChild(sw);
  }
}

function renderPaletteSelection() {
  // Mark the active swatch for each material based on the loadout value.
  for (const [containerId, slot, material] of [
    ["palette-skin", "c_skin", "body"],
    ["palette-hair", "c_hair", "hair"],
    ["palette-shirt", "c_shirt", "cloth"],
    ["palette-pants", "c_pants", "cloth"],
    ["palette-jacket", "c_jacket", "cloth"],
    ["palette-shoulders", "c_shoulders", "cloth"],
    ["palette-shoes", "c_shoes", "cloth"],
    ["palette-bracers", "c_bracers", "cloth"],
    ["palette-neck", "c_neck", "cloth"],
  ]) {
    const cur = state.loadout[slot];
    const rampName = cur ? nearestRampName(resolveColorMaybe(cur) || "#888888", material) : null;
    const container = $(containerId);
    if (!container) continue;
    container.querySelectorAll(".swatch").forEach((s) => {
      s.classList.toggle("active", s.dataset.ramp === rampName);
    });
    // ramp-name element id is the slot minus its `c_` prefix (ramp-name-skin …).
    const nameEl = $("ramp-name-" + slot.replace(/^c_/, ""));
    if (nameEl) nameEl.textContent = rampName || "—";
  }
}

// Mirror of cosmetics.js COLOR_PRESETS for client-side ramp matching.
const COLOR_PRESETS = {
  pale: "#f8d7b6",
  fair: "#f0c8a0",
  tan: "#d4a368",
  olive: "#b08560",
  brown: "#8b5a3c",
  deep: "#5a3a26",
  black: "#1a1a1a",
  blonde: "#e8c994",
  auburn: "#a04a1e",
  ginger: "#cc6633",
  silver: "#c8c8c8",
  white: "#f5f5f5",
  red: "#e74c3c",
  blue: "#3498db",
  green: "#2ecc71",
  yellow: "#f1c40f",
  orange: "#e67e22",
  purple: "#9b59b6",
  pink: "#ff66cc",
  cyan: "#1abc9c",
  navy: "#2c3e50",
  mint: "#a3e4d7",
  gray: "#7f8c8d",
  maroon: "#800000",
  teal: "#16a085",
  gold: "#d4af37",
  lime: "#a3ff00",
  magenta: "#d63384",
};
function resolveColorMaybe(value) {
  if (!value) return null;
  const s = String(value).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s) || /^#[0-9a-f]{3}$/.test(s)) return s;
  return COLOR_PRESETS[s] || null;
}

function renderHue() {
  const v = typeof state.loadout.hue === "number" ? state.loadout.hue : 0;
  $("hue-slider").value = v;
  $("hue-value").textContent = `${v}°`;
}

/* ── Paper-doll slot cells (mini-canvas thumbnails per equipped slot) ── */

function renderSlotCells() {
  for (const [slot, _label] of ALL_SLOTS) {
    const cell = document.querySelector(`.slot-cell[data-slot="${slot}"]`);
    if (!cell) continue;
    const equipped = state.loadout[slot];
    // Fallback preview: the Hair cell mirrors the hair_style chip, the Head
    // cell mirrors hat_style. So switching a style chip immediately shows up
    // in the paperdoll cell without buying a slot-item first.
    const fallbackCosmetics = slotFallbackPreview(slot);
    const filled = !!equipped || !!fallbackCosmetics;
    cell.classList.toggle("empty", !filled);
    const clearBtn = cell.querySelector(".slot-clear");
    if (clearBtn) clearBtn.style.display = equipped ? "" : "none";

    if (equipped) {
      // Synthetic pet that wears ONLY this slot's item.
      slotPets.set(slot, {
        seed: 7, // fixed seed so palette is stable across cells
        sleeping: false,
        cosmetics: cosmeticsForSinglePreview(slot, equipped),
      });
    } else if (fallbackCosmetics) {
      slotPets.set(slot, { seed: 7, sleeping: false, cosmetics: fallbackCosmetics });
    } else {
      slotPets.delete(slot);
    }
  }
}

function slotFallbackPreview(slot) {
  // The Hair slot has no catalog items — preview reflects the hair_style
  // chip. The Head slot's items overlay hats; if no head item is equipped
  // but a hat_style is set, show that hat instead.
  if (slot === "hair" && state.loadout.hair_style) {
    return { hair_style: state.loadout.hair_style };
  }
  if (slot === "head" && state.loadout.hat_style && state.loadout.hat_style !== "bare") {
    return { hat_style: state.loadout.hat_style };
  }
  return null;
}

function cosmeticsForSinglePreview(slot, key) {
  // For slot thumbnails, equip just this item on top of a neutral body.
  // Some slots (hair/dress/wings) need supporting context for the layer to
  // actually be visible — e.g. previewing a dress on a fem body.
  const c = { [slot]: key };
  if (slot === "dress") c.body = "fem";
  if (slot === "hair") c.hair_style = "short";
  if (slot === "eyes") c.hair_style = "short";
  return c;
}

/* ── Inventory (owned items only) ───────────────────────────────────── */

function renderInventory() {
  const container = $("inventory-by-slot");
  const _empty = $("inventory-empty");
  const count = $("inventory-count");
  container.innerHTML = "";

  if (!state.inventory || state.inventory.length === 0) {
    show("inventory-empty");
    count.textContent = "(0)";
    return;
  }
  hide("inventory-empty");
  count.textContent = `(${state.inventory.length})`;

  const groups = groupInventoryBySlot();
  for (const [slot, items] of groups) {
    const slotHeader = document.createElement("h3");
    slotHeader.className = "inv-slot-header";
    slotHeader.textContent = labelForSlot(slot);
    container.appendChild(slotHeader);

    const grid = document.createElement("div");
    grid.className = "inv-grid";
    for (const item of items) {
      grid.appendChild(renderInventoryCell(item));
    }
    container.appendChild(grid);
  }
}

function renderInventoryCell(item) {
  const cell = document.createElement("div");
  cell.className = `inv-cell rarity-${item.rarity || "common"}`;
  const equipped = state.loadout[item.slot] === item.key;
  if (equipped) cell.classList.add("equipped");

  const canvas = document.createElement("canvas");
  canvas.className = "inv-canvas";
  canvas.width = 64;
  canvas.height = 64;
  canvas.dataset.itemKey = item.key;
  cell.appendChild(canvas);

  const label = document.createElement("div");
  label.className = "inv-label";
  label.textContent = item.key;
  cell.appendChild(label);

  const rar = document.createElement("div");
  rar.className = "inv-rarity";
  rar.textContent = item.rarity || "common";
  cell.appendChild(rar);

  cell.addEventListener("click", () => {
    if (equipped) {
      postUnequip(item.slot);
    } else {
      postEquip(item.slot, item.key);
    }
  });

  inventoryPets.set(item.key, {
    seed: 7,
    sleeping: false,
    cosmetics: cosmeticsForSinglePreview(item.slot, item.key),
  });
  return cell;
}

function groupInventoryBySlot() {
  // Returns Map<slot, item[]> with items resolved from the catalog.
  const groups = new Map();
  for (const itemKey of state.inventory) {
    const item = lookupCatalogItem(itemKey);
    if (!item) continue;
    if (!groups.has(item.slot)) groups.set(item.slot, []);
    groups.get(item.slot).push(item);
  }
  // Stable display order: equippable slots first
  const ordered = new Map();
  for (const [slotKey] of ALL_SLOTS) {
    if (groups.has(slotKey)) ordered.set(slotKey, groups.get(slotKey));
  }
  // Any extras (defensive)
  for (const [k, v] of groups) if (!ordered.has(k)) ordered.set(k, v);
  return ordered;
}

function lookupCatalogItem(itemKey) {
  if (!state.catalog?.items) {
    return { key: itemKey, slot: "misc", rarity: "common" };
  }
  for (const slot of Object.keys(state.catalog.items)) {
    const found = state.catalog.items[slot].find((it) => it.key === itemKey);
    if (found) return { ...found, slot };
  }
  return { key: itemKey, slot: "misc", rarity: "common" };
}

function labelForSlot(slot) {
  const match = ALL_SLOTS.find(([s]) => s === slot);
  return match ? match[1] : slot;
}

/* ── Shop + catalog (browse / buy with XP) ──────────────────────────── */

function renderShopFeatured() {
  const block = $("shop-featured-block");
  const grid = $("shop-featured");
  const endEl = $("shop-featured-end");
  if (!block || !grid || !endEl) return;
  const items = state.shop && Array.isArray(state.shop.items) ? state.shop.items : [];
  if (items.length === 0) {
    hide("shop-featured-block");
    return;
  }
  show("shop-featured-block");
  endEl.textContent = formatShopWindow(state.shop);
  grid.innerHTML = "";
  for (const item of items) grid.appendChild(renderShopCell(item, "featured"));
}

function renderCatalogBrowser() {
  const container = $("catalog-by-slot");
  const count = $("catalog-count");
  if (!container || !count) return;
  container.innerHTML = "";
  if (!state.catalog?.items) {
    count.textContent = "";
    return;
  }
  let total = 0;
  for (const [slotKey] of ALL_SLOTS) {
    if (slotKey === "aura") continue;
    const items = state.catalog.items[slotKey];
    if (!items || items.length === 0) continue;
    total += items.length;
    const section = document.createElement("div");
    section.dataset.slotSection = slotKey;
    const header = document.createElement("h3");
    header.className = "inv-slot-header";
    header.textContent = labelForSlot(slotKey);
    section.appendChild(header);
    const grid = document.createElement("div");
    grid.className = "inv-grid";
    for (const item of items) {
      grid.appendChild(renderShopCell({ ...item, slot: slotKey }, "catalog"));
    }
    section.appendChild(grid);
    container.appendChild(section);
  }
  count.textContent = total ? `(${total})` : "";
}

function renderShopCell(item, kind) {
  const owned = state.inventory.includes(item.key);
  const equipped = state.loadout[item.slot] === item.key;
  const cost = priceFor(item, kind);
  const affordable = state.xp >= cost;

  const cell = document.createElement("div");
  cell.className = `inv-cell shop-cell rarity-${item.rarity || "common"}`;
  if (owned) cell.classList.add("owned");
  if (equipped) cell.classList.add("equipped");
  if (!owned && !affordable) cell.classList.add("locked");

  const canvas = document.createElement("canvas");
  canvas.className = "inv-canvas";
  canvas.width = 64;
  canvas.height = 64;
  canvas.dataset.itemKey = item.key;
  cell.appendChild(canvas);

  const label = document.createElement("div");
  label.className = "inv-label";
  label.textContent = item.key;
  cell.appendChild(label);

  const rar = document.createElement("div");
  rar.className = "inv-rarity";
  rar.textContent = item.rarity || "common";
  cell.appendChild(rar);

  const priceLine = document.createElement("div");
  priceLine.className = "shop-price";
  if (owned) {
    priceLine.textContent = equipped ? "✓ Equipped" : "Owned · click to equip";
  } else {
    priceLine.textContent = `${cost.toLocaleString()} XP`;
    if (!affordable) priceLine.classList.add("locked");
  }
  cell.appendChild(priceLine);

  cell.addEventListener("click", () => {
    if (owned) {
      if (equipped) postUnequip(item.slot);
      else postEquip(item.slot, item.key);
    } else if (affordable) {
      postBuy(item.key);
    } else {
      showError(
        "Not enough XP — you have " +
          state.xp.toLocaleString() +
          ", need " +
          cost.toLocaleString() +
          ".",
      );
    }
  });

  shopPets.set(item.key, {
    seed: 7,
    sleeping: false,
    cosmetics: cosmeticsForSinglePreview(item.slot, item.key),
  });
  return cell;
}

function priceFor(item, kind) {
  if (kind === "featured" && typeof item.cost === "number") return item.cost;
  if (typeof item.cost_xp === "number") return item.cost_xp;
  if (typeof item.base_cost === "number") return item.base_cost;
  return 0;
}

function formatShopWindow(shop) {
  if (!shop?.ends_ms) return "";
  const remainingMs = shop.ends_ms - Date.now();
  if (remainingMs <= 0) return "· ended";
  const hours = Math.floor(remainingMs / 3600000);
  if (hours >= 24) return `· ${Math.floor(hours / 24)}d left`;
  return `· ${hours}h left`;
}

/* ── Combat gear (read-only MMO sigma loadout) ───────────────────────── */

const COMBAT_SLOTS = [
  ["weapon", "Weapon"],
  ["armor", "Armor"],
  ["ring", "Ring"],
  ["relic", "Relic"],
  ["charm", "Charm"],
];

async function loadCombatGear() {
  const loading = $("combat-loading");
  const empty = $("combat-empty");
  const error = $("combat-error");
  const summary = $("combat-summary");
  if (loading) loading.hidden = false;
  if (empty) empty.hidden = true;
  if (error) error.hidden = true;
  if (summary) summary.hidden = true;

  try {
    // combat-gear → the sigma summary (level/depth/zone/hp + equipped gear +
    // the weapon that drives the avatar preview). combat-loadout → the gear bag
    // (equippable inventory) for the change-gear UI. Fetch both in parallel.
    const [gear, loadout] = await Promise.all([
      fetchJson("/api/v1/vcs/combat-gear", { method: "GET" }),
      fetchJson("/api/v1/vcs/combat-loadout", { method: "GET" }),
    ]);
    state.combat = gear;
    state.combatLoadout = loadout;
  } catch (_err) {
    state.combat = { ok: false, error: "network" };
    state.combatLoadout = { ok: false, error: "network" };
  }
  renderCombatGear();
  renderCombatInventory();
  // Push the live sigma weapon + level into the avatar preview so the equipped
  // blade and "Lv N" label reflect the viewer's real MMO gear.
  syncAvatarPet();
}

function renderCombatGear() {
  const loading = $("combat-loading");
  const empty = $("combat-empty");
  const error = $("combat-error");
  const summary = $("combat-summary");
  const grid = $("combat-gear");
  if (!grid) return;
  grid.innerHTML = "";
  if (loading) loading.hidden = true;

  const data = state.combat;
  if (!data || data.ok === false) {
    if (error) {
      error.hidden = false;
      error.textContent = `Couldn't reach the MMO server${data?.error ? ` (${data.error})` : ""}.`;
    }
    return;
  }
  const sigma = data.sigma;
  if (!sigma) {
    if (empty) empty.hidden = false;
    return;
  }

  if (summary) {
    summary.hidden = false;
    setText("combat-level", sigma.level);
    setText("combat-depth", sigma.depth);
    setText("combat-zone", sigma.zone || "—");
    setText("combat-hp", sigma.hp);

    // Spirit pool — present when the MMO exposes it (Project Ascendant+).
    const spiritRow = $("combat-spirit-row");
    const maxSpirit = typeof sigma.spirit === "number" ? sigma.spirit : null;
    const usedSpirit = typeof sigma.spiritUsed === "number" ? sigma.spiritUsed : 0;
    if (spiritRow && maxSpirit !== null) {
      spiritRow.hidden = false;
      const free = Math.max(0, maxSpirit - usedSpirit);
      setText("combat-spirit-text", `${free}/${maxSpirit}`);
      const fill = $("combat-spirit-bar");
      if (fill) {
        const pct = maxSpirit > 0 ? Math.round((free / maxSpirit) * 100) : 0;
        fill.style.width = `${pct}%`;
      }
    } else if (spiritRow) {
      spiritRow.hidden = true;
    }
  }
  for (const [slotKey, label] of COMBAT_SLOTS) {
    grid.appendChild(renderCombatCell(slotKey, label, sigma[slotKey]));
  }
}

function renderCombatCell(slotKey, label, item) {
  const cell = document.createElement("div");
  const rarity = item?.rarity || "common";
  cell.className = `combat-cell rarity-${rarity}`;
  if (!item) cell.classList.add("empty");
  if (item?.starter) cell.classList.add("starter");

  const slot = document.createElement("div");
  slot.className = "combat-slot";
  slot.textContent = label;
  cell.appendChild(slot);

  const name = document.createElement("div");
  name.className = "combat-name";
  name.textContent = item ? item.name : "— empty —";
  cell.appendChild(name);

  if (item) {
    const meta = document.createElement("div");
    meta.className = "combat-meta";
    const rar = document.createElement("span");
    rar.className = "combat-rarity";
    rar.textContent = rarity;
    meta.appendChild(rar);
    // Weapon family tag — shown for the weapon slot so axe/spear/wand/sword/etc.
    // are identifiable at a glance. family comes from the mmo sigma.weapon.family.
    if (slotKey === "weapon" && item.family) {
      const fam = document.createElement("span");
      fam.className = "combat-family";
      fam.textContent = item.family;
      meta.appendChild(fam);
    }
    if (typeof item.power === "number" && item.power > 0) {
      const pwr = document.createElement("span");
      pwr.className = "combat-power";
      pwr.innerHTML = `⚔ <b>${item.power}</b>`;
      meta.appendChild(pwr);
    }
    cell.appendChild(meta);
  }
  return cell;
}

// Render the gear bag: the chatter's equippable inventory from /combat-loadout.
// Each cell is clickable to equip that item into its slot (a real MMO swap).
// Hidden entirely unless we have a usable sigma loadout — the empty-state /
// error UI is shared with the gear summary above.
function renderCombatInventory() {
  const block = $("combat-inv-block");
  const emptyEl = $("combat-inv-empty");
  const grid = $("combat-inv");
  if (!block || !grid) return;
  grid.innerHTML = "";

  const data = state.combatLoadout;
  // No loadout (error / network / unauthenticated) → hide the whole bag; the
  // combat-error line from the gear summary already explains the failure.
  if (!data || data.ok === false || !Array.isArray(data.inventory)) {
    block.hidden = true;
    return;
  }
  block.hidden = false;

  const inv = data.inventory;
  if (inv.length === 0) {
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  for (const item of inv) {
    grid.appendChild(renderCombatInvCell(item));
  }
}

function renderCombatInvCell(item) {
  const cell = document.createElement("button");
  cell.type = "button";
  const rarity = item.rarity || "common";
  cell.className = `combat-inv-cell rarity-${rarity}`;
  if (state.combatEquipping) cell.classList.add("busy");
  cell.disabled = !!state.combatEquipping;

  const slot = document.createElement("div");
  slot.className = "combat-slot";
  slot.textContent = item.slot;
  cell.appendChild(slot);

  const name = document.createElement("div");
  name.className = "combat-name";
  name.textContent = item.name;
  cell.appendChild(name);

  const meta = document.createElement("div");
  meta.className = "combat-meta";
  const rar = document.createElement("span");
  rar.className = "combat-rarity";
  rar.textContent = rarity;
  meta.appendChild(rar);
  if (typeof item.power === "number" && item.power > 0) {
    const pwr = document.createElement("span");
    pwr.className = "combat-power";
    pwr.innerHTML = `⚔ <b>${item.power}</b>`;
    meta.appendChild(pwr);
  }
  cell.appendChild(meta);

  const hint = document.createElement("div");
  hint.className = "combat-equip-hint";
  hint.textContent = state.combatEquipping ? "Equipping…" : "Tap to equip";
  cell.appendChild(hint);

  cell.addEventListener("click", () => equipCombatItem(item.slot, item.index));
  return cell;
}

// Real MMO gear swap: POST {slot, index} to /combat-equip, then re-fetch the
// loadout so the bag + equipped gear cells + the avatar weapon all reflect the
// new state. Locks the bag (disabled + "Equipping…") during the request.
async function equipCombatItem(slot, index) {
  if (state.combatEquipping) return;
  state.combatEquipping = true;
  renderCombatInventory(); // paint the disabled/loading state immediately

  let ok = false;
  try {
    const r = await fetchJson("/api/v1/vcs/combat-equip", {
      method: "POST",
      body: { slot, index },
    });
    ok = r && r.ok !== false;
  } catch (_err) {
    ok = false;
  }
  state.combatEquipping = false;

  if (ok) {
    hideError();
    // Re-fetch combat-gear + combat-loadout: refreshes the equipped gear cells,
    // the gear bag, and (via syncAvatarPet in loadCombatGear) the previewed
    // avatar's blade so it shows the newly-equipped weapon family.
    await loadCombatGear();
  } else {
    // fetchJson already surfaced a friendly message for non-bridge errors;
    // just re-enable the bag so the viewer can retry.
    renderCombatInventory();
  }
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value == null ? "—" : String(value);
}

/* ── Project Ascendant — Build tab ──────────────────────────────────────
 * Inc 4: Passive Tree (SVG interactive graph)
 * Inc 5: Position selector (front / mid / back)
 * Inc 6: Dual-Spec (Set A / Set B tabs + swap)
 * Inc 7: Spirit Reservation (aura toggle list)
 * ─────────────────────────────────────────────────────────────────────── */

// Build-tab state — kept separate from combat state so the two tabs don't
// interfere. Refreshed on every build tab activation.
const buildState = {
  // Which spec tab the user is looking at (may differ from activeSet).
  viewingSet: "A",
  // Data from /api/v1/vcs/combat-sigma — the full sigma summary.
  sigma: null,
  // Data from /api/v1/vcs/combat-passive-tree — the static tree definition.
  passiveTree: null,
  // Mutation lock — one POST at a time to avoid races.
  mutating: false,
};

// Passive tree canvas pan/zoom state.
const ptView = {
  offsetX: 0,
  offsetY: 0,
  scale: 1.0,
  dragging: false,
  dragStartX: 0,
  dragStartY: 0,
  dragStartOX: 0,
  dragStartOY: 0,
};

// Precomputed {id → {x, y}} SVG positions for the passive tree nodes.
// Built once from the tree definition when it first loads.
let ptPositions = null; // Map<id, {x,y}>

/* ── Build tab lifecycle ─────────────────────────────────────────────── */

async function loadBuildTab() {
  // Show loading, hide content/error.
  show("build-loading");
  hide("build-content");
  hide("build-error");
  hide("build-offline");

  try {
    // Fetch sigma + passive tree + weapon catalog (static, cached) + viewer weapons — all in parallel.
    const [sigmaRes, treeRes, catalogRes, weaponsRes] = await Promise.all([
      fetchJson("/api/v1/vcs/combat-sigma", { method: "GET" }),
      buildState.passiveTree
        ? Promise.resolve(buildState.passiveTree) // cache — tree is static
        : fetchJson("/api/v1/vcs/combat-passive-tree", { method: "GET" }),
      // Weapon catalog is static per-server boot; cache after first load.
      state.weaponCatalog
        ? Promise.resolve(state.weaponCatalog)
        : fetchJson("/api/v1/vcs/combat-weapon-catalog", { method: "GET" }),
      // Weapon loadout refreshes on every tab activation.
      fetchJson("/api/v1/vcs/combat-weapons", { method: "GET" }),
    ]);

    buildState.sigma = sigmaRes;

    // Tree is static per-server; cache it after first load.
    if (!buildState.passiveTree && treeRes && treeRes.ok !== false) {
      buildState.passiveTree = treeRes;
      ptPositions = computePtPositions(treeRes);
      wirePtCanvas();
    }

    // Weapon catalog — static, cache after first load.
    if (!state.weaponCatalog && catalogRes && catalogRes.ok !== false) {
      state.weaponCatalog = catalogRes;
    }
    // Weapon loadout — always fresh.
    state.combatWeapons = weaponsRes;
  } catch (_err) {
    buildState.sigma = { ok: false, error: "network" };
  }

  hide("build-loading");
  renderBuildTab();
}

function renderBuildTab() {
  const sigma = buildState.sigma;

  // Twitch-only gate.
  if (sigma && sigma.unavailable && sigma.reason === "combat_twitch_only") {
    const errEl = $("build-error");
    if (errEl) {
      errEl.textContent = "Build config is only available for Twitch viewers.";
      errEl.hidden = false;
    }
    return;
  }

  // Network / bridge error.
  if (!sigma || sigma.ok === false) {
    const code = sigma?.error || "network";
    if (code === "bridge_offline" || code === "mmo_unreachable") {
      show("build-offline");
    } else if (code === "no character" || code === "no_character") {
      const errEl = $("build-error");
      if (errEl) {
        errEl.textContent = "No active sigma — type !sigma in chat to mint one first.";
        errEl.hidden = false;
      }
    } else {
      const errEl = $("build-error");
      if (errEl) {
        errEl.textContent = `Couldn't load build data (${code}).`;
        errEl.hidden = false;
      }
    }
    return;
  }

  show("build-content");

  // Spec tabs: ensure viewingSet default matches activeSet.
  if (!buildState.viewingSet) buildState.viewingSet = sigma.activeSet || "A";
  renderSpecTabs(sigma);
  renderPosition(sigma);
  renderSpiritReservation(sigma);
  renderWeaponsSection();
  renderPtCanvas();
}

/* ── Inc 6: Dual-Spec tabs ───────────────────────────────────────────── */

// Wire the spec tab bar + swap button. Called once from wireBuildTab().
function wireBuildTab() {
  // Spec tab buttons.
  document.querySelectorAll(".spec-tab-btn[data-spec]").forEach((btn) => {
    btn.addEventListener("click", () => {
      buildState.viewingSet = btn.dataset.spec;
      const sigma = buildState.sigma;
      if (sigma) {
        renderSpecTabs(sigma);
        renderPosition(sigma);
        renderSpiritReservation(sigma);
        renderPtCanvas();
      }
    });
  });

  // Swap active set button.
  const swapBtn = $("build-swap-btn");
  if (swapBtn) {
    swapBtn.addEventListener("click", () => postSwapSet());
  }
}

function renderSpecTabs(sigma) {
  const activeSet = sigma.activeSet || "A";
  const viewing = buildState.viewingSet;
  const hasB = !!sigma.setB || !!sigma.hasSetB;

  // Highlight the viewed spec tab.
  document.querySelectorAll(".spec-tab-btn[data-spec]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.spec === viewing);
  });

  // "active" badge shows which set is currently live in the MMO.
  const badge = $("build-active-badge");
  if (badge) badge.textContent = `Set ${activeSet} active`;

  // Set B label: show "(empty)" when setB hasn't been materialized yet.
  const btnB = document.querySelector(".spec-tab-btn[data-spec='B']");
  if (btnB) {
    btnB.textContent = hasB ? "Set B" : "Set B (empty)";
  }

  // Swap button: reflect what swapping would do.
  const swapBtn = $("build-swap-btn");
  if (swapBtn) {
    if (viewing === activeSet) {
      swapBtn.textContent = "Swap active set";
      swapBtn.title = `Switch the MMO to use Set ${activeSet === "A" ? "B" : "A"}`;
    } else {
      swapBtn.textContent = `Make Set ${viewing} active`;
      swapBtn.title = `Switch the MMO to use Set ${viewing}`;
    }
    swapBtn.disabled = buildState.mutating;
  }
}

async function postSwapSet() {
  if (buildState.mutating) return;
  buildState.mutating = true;
  updateBuildMutateUI();
  try {
    // Swap to the currently viewed set (may be a no-op if it's already active).
    const target = buildState.viewingSet;
    const r = await fetchJson("/api/v1/vcs/combat-swap-set", {
      method: "POST",
      body: { set: target },
    });
    if (r && r.ok !== false) {
      buildState.sigma = r;
    }
  } catch (_err) { /* network error — keep existing state */ }
  buildState.mutating = false;
  renderBuildTab();
}

/* ── Inc 5: Position selector ────────────────────────────────────────── */

// Wire position buttons. Called once from wireBuildTab().
function wirePositionBtns() {
  document.querySelectorAll(".pos-btn[data-pos]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (buildState.mutating) return;
      postPosition(btn.dataset.pos);
    });
  });
}

function renderPosition(sigma) {
  // Active set: read from sigma top-level; inactive set: read from setB.
  const viewing = buildState.viewingSet;
  const activeSet = sigma.activeSet || "A";
  let pos;
  if (viewing === activeSet) {
    pos = sigma.position || "mid";
  } else {
    pos = sigma.setB?.position || "mid";
  }

  document.querySelectorAll(".pos-btn[data-pos]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.pos === pos);
    btn.disabled = buildState.mutating;
  });
}

async function postPosition(position) {
  if (buildState.mutating) return;
  buildState.mutating = true;
  updateBuildMutateUI();
  try {
    const r = await fetchJson("/api/v1/vcs/combat-position", {
      method: "POST",
      body: { position, set: buildState.viewingSet },
    });
    if (r && r.ok !== false) buildState.sigma = r;
  } catch (_err) { /* keep existing state */ }
  buildState.mutating = false;
  renderBuildTab();
}

/* ── Inc 7: Spirit reservation ───────────────────────────────────────── */

function renderSpiritReservation(sigma) {
  const viewing = buildState.viewingSet;
  const activeSet = sigma.activeSet || "A";

  // Spirit pool lives on the active set's sigma top-level.
  // auraBuffs: { [id]: {name, kind, spiritCost, buff} } — all reservable skills.
  const auraBuffs = sigma.auraBuffs || {};
  const spiritMax = typeof sigma.spirit === "number" ? sigma.spirit : 0;

  // Derive reserved list and spiritUsed for the viewed set.
  let reserved, spiritUsed;
  if (viewing === activeSet) {
    reserved = Array.isArray(sigma.reserved) ? sigma.reserved : [];
    spiritUsed = typeof sigma.spiritUsed === "number" ? sigma.spiritUsed : 0;
  } else {
    const setB = sigma.setB;
    reserved = setB && Array.isArray(setB.reserved) ? setB.reserved : [];
    // Compute spiritUsed for the inactive set ourselves from its reserved list.
    spiritUsed = reserved.reduce((sum, id) => {
      return sum + (auraBuffs[id]?.spiritCost || 0);
    }, 0);
  }

  // Spirit bar.
  const usedEl = $("build-spirit-used");
  if (usedEl) usedEl.textContent = `${spiritUsed} / ${spiritMax}`;
  const barEl = $("build-spirit-bar");
  if (barEl) {
    const pct = spiritMax > 0 ? Math.min(100, Math.round((spiritUsed / spiritMax) * 100)) : 0;
    barEl.style.width = `${pct}%`;
  }

  // Aura list.
  const listEl = $("build-aura-list");
  if (!listEl) return;
  listEl.innerHTML = "";

  const ids = Object.keys(auraBuffs);
  if (ids.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.fontSize = "12px";
    empty.textContent = "No reservable skills available yet.";
    listEl.appendChild(empty);
    return;
  }

  for (const id of ids) {
    const skill = auraBuffs[id];
    if (!skill) continue;
    const isActive = reserved.includes(id);
    // Would toggling this on overflow the spirit pool?
    const wouldOverflow = !isActive && (spiritUsed + skill.spiritCost) > spiritMax && spiritMax > 0;

    const row = document.createElement("div");
    row.className = "aura-row" + (isActive ? " active" : "") + (wouldOverflow ? " locked" : "");
    row.title = wouldOverflow ? `Not enough spirit (need ${skill.spiritCost}, have ${spiritMax - spiritUsed})` : "";

    const check = document.createElement("div");
    check.className = "aura-check";
    if (isActive) check.textContent = "✓";
    row.appendChild(check);

    const info = document.createElement("div");
    info.className = "aura-info";

    const name = document.createElement("div");
    name.className = "aura-name";
    name.textContent = skill.name;
    info.appendChild(name);

    const desc = document.createElement("div");
    desc.className = "aura-desc";
    desc.textContent = skill.desc || formatBuffDesc(skill.buff);
    info.appendChild(desc);

    row.appendChild(info);

    const kind = document.createElement("span");
    kind.className = "aura-kind";
    kind.textContent = skill.kind || "aura";
    row.appendChild(kind);

    const cost = document.createElement("span");
    cost.className = "aura-cost";
    cost.textContent = `${skill.spiritCost}`;
    row.appendChild(cost);

    if (!wouldOverflow) {
      row.addEventListener("click", () => {
        if (buildState.mutating) return;
        const newReserved = isActive
          ? reserved.filter((r) => r !== id)
          : [...reserved, id];
        postReserve(newReserved);
      });
    }

    listEl.appendChild(row);
  }
}

function formatBuffDesc(buff) {
  if (!buff || typeof buff !== "object") return "";
  return Object.entries(buff)
    .map(([k, v]) => {
      if (k === "atkMul") return `+${Math.round((v - 1) * 100)}% ATK`;
      if (k === "defMul") return `+${Math.round((v - 1) * 100)}% DEF`;
      if (k === "hpMul")  return `+${Math.round((v - 1) * 100)}% HP`;
      if (k === "critAdd") return `+${Math.round(v * 100)}% CRIT`;
      if (k === "dodgeAdd") return `+${Math.round(v * 100)}% DODGE`;
      return `${k}: ${v}`;
    })
    .join(", ");
}

async function postReserve(reserved) {
  if (buildState.mutating) return;
  buildState.mutating = true;
  updateBuildMutateUI();
  try {
    const r = await fetchJson("/api/v1/vcs/combat-reserve", {
      method: "POST",
      body: { reserved, set: buildState.viewingSet },
    });
    if (r && r.ok !== false) buildState.sigma = r;
  } catch (_err) { /* keep existing state */ }
  buildState.mutating = false;
  renderBuildTab();
}

/* ── Vampire Survivors weapon layer ─────────────────────────────────── */

// Render the weapon selection section inside #build-content.
// Uses state.weaponCatalog (static) and state.combatWeapons (per-load).
function renderWeaponsSection() {
  const loadEl    = $("build-weapons-loading");
  const grid      = $("build-weapons-grid");
  const slotsEl   = $("build-weapons-slots-used");
  const evolutEl  = $("build-weapons-evolutions");
  const faintEl   = $("build-weapons-faint");
  if (!grid) return;

  grid.innerHTML = "";
  if (evolutEl) { evolutEl.hidden = true; evolutEl.innerHTML = ""; }
  if (faintEl)  { faintEl.hidden  = true; faintEl.innerHTML  = ""; }
  if (loadEl)   loadEl.hidden = true;

  const catalog = state.weaponCatalog;
  const data    = state.combatWeapons;

  // Both must succeed for the section to be useful.
  if (!catalog || catalog.ok === false || !data || data.ok === false) {
    const code = data?.error || catalog?.error || "unavailable";
    grid.innerHTML = `<div class="muted" style="font-size:12px">Weapons unavailable${code !== "unavailable" ? ` (${code})` : ""} — check bridge.</div>`;
    if (slotsEl) slotsEl.textContent = "— / 6 slots";
    return;
  }

  const loadout      = Array.isArray(data.weapons)    ? data.weapons    : [];
  const maxSlots     = typeof data.maxSlots === "number" ? data.maxSlots : 6;
  const activeWeapon = data.activeWeapon || null;
  const evolutions   = Array.isArray(data.evolutions) ? data.evolutions : [];
  const fainted      = typeof data.fainted === "number" ? data.fainted  : 0;
  const lostWeapon   = data.lostWeapon  || null;

  if (slotsEl) slotsEl.textContent = `${loadout.length} / ${maxSlots} slots`;

  // Faint state — show when the viewer has lost a weapon to a faint.
  if (fainted > 0 && faintEl) {
    faintEl.hidden = false;
    let msg = `⚠ Fainted ${fainted} time${fainted !== 1 ? "s" : ""}`;
    if (lostWeapon)   msg += ` · last lost: <b>${lostWeapon}</b>`;
    if (activeWeapon) msg += ` · active slot: <b>${activeWeapon}</b>`;
    faintEl.innerHTML = msg;
  }

  // Active evolutions triggered by the current loadout.
  if (evolutions.length > 0 && evolutEl) {
    evolutEl.hidden = false;
    evolutEl.innerHTML =
      '<span class="weapons-evol-label">Active evolutions</span>' +
      evolutions.map((ev) =>
        `<span class="weapons-evol-pill">${ev.name || ev.id}</span>`
      ).join("");
  }

  // Weapon cards from the static catalog — one per weapon def.
  const weaponDefs = Array.isArray(catalog.weapons) ? catalog.weapons : [];
  for (const wdef of weaponDefs) {
    grid.appendChild(renderWeaponCell(wdef, loadout, maxSlots, activeWeapon));
  }
}

function renderWeaponCell(wdef, loadout, maxSlots, activeWeapon) {
  const equipped = loadout.includes(wdef.id);
  const isActive = wdef.id === activeWeapon;
  const full     = loadout.length >= maxSlots && !equipped;

  const cell = document.createElement("div");
  cell.className = "weapon-cell" +
    (equipped ? " weapon-equipped" : "") +
    (isActive  ? " weapon-active"   : "") +
    (full      ? " weapon-locked"   : "") +
    (buildState.mutating ? " busy" : "");

  const nameEl = document.createElement("div");
  nameEl.className = "weapon-name";
  nameEl.textContent = wdef.name || wdef.id;
  cell.appendChild(nameEl);

  const kindEl = document.createElement("div");
  kindEl.className = "weapon-kind";
  kindEl.textContent = wdef.kind || "";
  cell.appendChild(kindEl);

  // Rough DPS = fireRate * damage for a quick at-a-glance stat.
  if (typeof wdef.fireRate === "number" && typeof wdef.damage === "number") {
    const statsEl = document.createElement("div");
    statsEl.className = "weapon-stats";
    statsEl.textContent = `${Math.round(wdef.fireRate * wdef.damage * 100) / 100} dps`;
    cell.appendChild(statsEl);
  }

  // Active-slot star / equipped checkmark.
  if (equipped) {
    const mark = document.createElement("div");
    mark.className = "weapon-check";
    mark.textContent = isActive ? "★" : "✓"; // ★ : ✓
    cell.appendChild(mark);
  }

  if (!full && !buildState.mutating) {
    cell.addEventListener("click", () => toggleWeapon(wdef.id, loadout, maxSlots));
  }

  return cell;
}

// Toggle a weapon in/out of the viewer's loadout and POST the new list.
async function toggleWeapon(weaponId, currentLoadout, maxSlots) {
  if (buildState.mutating) return;
  let newWeapons;
  if (currentLoadout.includes(weaponId)) {
    newWeapons = currentLoadout.filter((id) => id !== weaponId);
  } else if (currentLoadout.length < maxSlots) {
    newWeapons = [...currentLoadout, weaponId];
  } else {
    return; // slots full — cell was locked, should not reach here
  }

  buildState.mutating = true;
  updateBuildMutateUI();
  try {
    const r = await fetchJson("/api/v1/vcs/combat-weapons", {
      method: "POST",
      body: { weapons: newWeapons },
    });
    if (r && r.ok !== false) state.combatWeapons = r;
  } catch (_err) { /* keep existing state */ }
  buildState.mutating = false;
  renderWeaponsSection();
}

/* ── Inc 4: Passive Tree canvas ─────────────────────────────────────── */

// Compute {id → {x, y}} pixel positions for all 101 passive tree nodes.
// Layout: 8 class arms at 45° intervals (warrior=270°=top, clockwise),
// each arm's secondary nodes at increasing radii. Ring nodes at r≈310,
// gateways just outside the ring, keystones at r≈160, inner nodes at r≈220,
// core nodes clustered at center.
function computePtPositions(tree) {
  const CX = 440; // canvas centre x
  const CY = 440; // canvas centre y

  // Zone → angle map. warrior=top (270°), going clockwise at 45° each.
  const ZONE_ANGLES = {
    warrior:  270,
    ranger:   315,
    mage:       0,
    monk:      45,
    templar:   90,
    rogue:    135,
    duelist:  180,
    warden:   225,
  };

  // Arm node radii for secondary arm nodes (_a through _f) + _side.
  const ARM_RADII = { a: 100, b: 155, c: 205, d: 250, e: 290, f: 325, side: 190 };

  // Gateway and ring radii.
  const GW_R    = 370;
  const RING_R  = 330;
  const INNER_R = 230;
  const KS_R    = 130;
  const CORE_R  = 55;

  // Gateway angles (align with zone mid-points, i.e. between adjacent zones).
  const GW_ANGLES = {
    gw_north:  270,
    gw_ne:     315,
    gw_east:     0,
    gw_se:      45,
    gw_south:   90,
    gw_sw:     135,
    gw_west:   180,
    gw_nw:     225,
  };

  const RING_ANGLES = {
    ring_n:  270,
    ring_ne: 315,
    ring_e:    0,
    ring_se:  45,
    ring_s:   90,
    ring_sw: 135,
    ring_w:  180,
    ring_nw: 225,
  };

  const INNER_ANGLES = {
    inner_might:   270,
    inner_focus:   315,
    inner_clarity:   0,
    inner_ember:    45,
    inner_resolve:  90,
    inner_shadow:  135,
    inner_iron:    180,
    inner_stone:   225,
  };

  // Keystone hub angles (midpoints between zones — offset slightly toward center).
  const KS_HUB_ANGLES = {
    hub_glass:   292.5,
    hub_avatar:   22.5,
    hub_necro:   112.5,
    hub_blood:   202.5,
    hub_iron:    247.5,
  };

  const KEYSTONE_ANGLES = {
    ks_glass_cannon:   292.5,
    ks_avatar_of_fire:  22.5,
    ks_necromantic_bond:112.5,
    ks_blood_magic:    202.5,
    ks_iron_reflexes:  247.5,
  };

  const CORE_ANGLES = {
    core_vitality: 270,
    core_power:     30,
    core_essence:  150,
  };

  const pos = new Map();

  function polar(r, deg) {
    const rad = (deg * Math.PI) / 180;
    return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) };
  }

  if (!tree.nodes || !Array.isArray(tree.nodes)) return pos;

  for (const node of tree.nodes) {
    const id = node.id;

    // Class start nodes.
    if (ZONE_ANGLES[id] !== undefined) {
      pos.set(id, polar(80, ZONE_ANGLES[id]));
      continue;
    }

    // Gateway nodes.
    if (GW_ANGLES[id] !== undefined) {
      pos.set(id, polar(GW_R, GW_ANGLES[id]));
      continue;
    }

    // Ring nodes.
    if (RING_ANGLES[id] !== undefined) {
      pos.set(id, polar(RING_R, RING_ANGLES[id]));
      continue;
    }

    // Inner attribute nodes.
    if (INNER_ANGLES[id] !== undefined) {
      pos.set(id, polar(INNER_R, INNER_ANGLES[id]));
      continue;
    }

    // Keystone hubs.
    if (KS_HUB_ANGLES[id] !== undefined) {
      pos.set(id, polar(KS_R + 32, KS_HUB_ANGLES[id]));
      continue;
    }

    // Keystones (sit just inside the hub).
    if (KEYSTONE_ANGLES[id] !== undefined) {
      pos.set(id, polar(KS_R - 8, KEYSTONE_ANGLES[id]));
      continue;
    }

    // Core nodes.
    if (CORE_ANGLES[id] !== undefined) {
      pos.set(id, polar(CORE_R, CORE_ANGLES[id]));
      continue;
    }

    // Secondary arm nodes — id format: <zone>_<suffix> where suffix ∈ a-f, side.
    let placed = false;
    for (const [zone, baseAngle] of Object.entries(ZONE_ANGLES)) {
      const prefix = zone + "_";
      if (!id.startsWith(prefix)) continue;
      const suffix = id.slice(prefix.length);
      const r = ARM_RADII[suffix];
      if (r !== undefined) {
        // Side nodes offset 22° from the arm's main angle.
        const angle = suffix === "side" ? baseAngle + 22 : baseAngle;
        pos.set(id, polar(r, angle));
        placed = true;
      }
      break;
    }
    if (!placed) {
      // Fallback: place at centre (should not happen with complete node list).
      pos.set(id, { x: CX, y: CY });
    }
  }

  return pos;
}

// Wire canvas pan/zoom + click interaction. Called once when the tree loads.
function wirePtCanvas() {
  const canvas = $("passive-tree-canvas");
  if (!canvas) return;

  // Pan: mouse drag.
  canvas.addEventListener("mousedown", (e) => {
    ptView.dragging = true;
    ptView.dragStartX = e.clientX;
    ptView.dragStartY = e.clientY;
    ptView.dragStartOX = ptView.offsetX;
    ptView.dragStartOY = ptView.offsetY;
  });
  window.addEventListener("mousemove", (e) => {
    if (!ptView.dragging) return;
    ptView.offsetX = ptView.dragStartOX + (e.clientX - ptView.dragStartX);
    ptView.offsetY = ptView.dragStartOY + (e.clientY - ptView.dragStartY);
    renderPtCanvas();
  });
  window.addEventListener("mouseup", () => { ptView.dragging = false; });

  // Zoom: wheel.
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const newScale = Math.min(3.0, Math.max(0.25, ptView.scale * factor));
    // Zoom toward cursor position.
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    ptView.offsetX = mx - (mx - ptView.offsetX) * (newScale / ptView.scale);
    ptView.offsetY = my - (my - ptView.offsetY) * (newScale / ptView.scale);
    ptView.scale = newScale;
    renderPtCanvas();
  }, { passive: false });

  // Touch pan.
  let lastTouch = null;
  canvas.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) {
      lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY, ox: ptView.offsetX, oy: ptView.offsetY };
    }
  }, { passive: true });
  canvas.addEventListener("touchmove", (e) => {
    if (e.touches.length === 1 && lastTouch) {
      ptView.offsetX = lastTouch.ox + (e.touches[0].clientX - lastTouch.x);
      ptView.offsetY = lastTouch.oy + (e.touches[0].clientY - lastTouch.y);
      renderPtCanvas();
    }
  }, { passive: true });
  canvas.addEventListener("touchend", () => { lastTouch = null; });

  // Click / tap: node interaction.
  canvas.addEventListener("click", (e) => {
    const node = ptHitTest(e);
    if (node) handlePtNodeClick(node);
  });

  // Hover: show tooltip.
  canvas.addEventListener("mousemove", (e) => {
    const node = ptHitTest(e);
    showPtTooltip(node, e.clientX, e.clientY);
  });
  canvas.addEventListener("mouseleave", () => { hidePtTooltip(); });
}

// Hit-test: find the tree node under the given mouse event (canvas space).
function ptHitTest(e) {
  const canvas = $("passive-tree-canvas");
  if (!canvas || !ptPositions || !buildState.passiveTree) return null;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const cx = (mx * scaleX - ptView.offsetX) / ptView.scale;
  const cy = (my * scaleY - ptView.offsetY) / ptView.scale;

  let best = null, bestDist = Infinity;
  for (const node of buildState.passiveTree.nodes) {
    const p = ptPositions.get(node.id);
    if (!p) continue;
    const r = ptNodeRadius(node);
    const d = Math.hypot(cx - p.x, cy - p.y);
    if (d <= r + 4 && d < bestDist) {
      best = node;
      bestDist = d;
    }
  }
  return best;
}

function ptNodeRadius(node) {
  if (node.kind === "keystone") return 22;
  if (node.id.includes("start")) return 16;
  if (node.id.includes("hub_")) return 12;
  return 10;
}

function showPtTooltip(node, cx, cy) {
  const tip = $("passive-tooltip");
  if (!tip) return;
  if (!node) { tip.hidden = true; return; }

  tip.hidden = false;
  let html = "";
  if (node.kind === "keystone") html += `<div class="tt-keystone">KEYSTONE</div>`;
  html += `<div class="tt-name">${node.name || node.id}</div>`;
  html += `<div class="tt-kind">${node.kind || "passive"}</div>`;
  if (Array.isArray(node.mods) && node.mods.length) {
    html += `<div class="tt-mods">${node.mods.map((m) => `• ${m}`).join("<br>")}</div>`;
  }
  if (node.tradeoff) {
    html += `<div class="tt-desc">Tradeoff: ${node.tradeoff}</div>`;
  } else if (node.desc) {
    html += `<div class="tt-desc">${node.desc}</div>`;
  }
  tip.innerHTML = html;

  // Position tooltip near cursor but keep it on-screen.
  const tw = tip.offsetWidth || 200;
  const th = tip.offsetHeight || 80;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let tx = cx + 14, ty = cy - th / 2;
  if (tx + tw > vw - 8) tx = cx - tw - 14;
  if (ty < 8) ty = 8;
  if (ty + th > vh - 8) ty = vh - th - 8;
  tip.style.left = `${tx}px`;
  tip.style.top  = `${ty}px`;
}

function hidePtTooltip() {
  const tip = $("passive-tooltip");
  if (tip) tip.hidden = true;
}

// Handle clicking a passive tree node — allocate or deallocate.
function handlePtNodeClick(node) {
  if (buildState.mutating) return;
  const sigma = buildState.sigma;
  if (!sigma) return;

  const viewing = buildState.viewingSet;
  const activeSet = sigma.activeSet || "A";
  const currentPassives = viewing === activeSet
    ? (Array.isArray(sigma.passives) ? sigma.passives : [])
    : (Array.isArray(sigma.setB?.passives) ? sigma.setB.passives : []);
  const passiveStart = viewing === activeSet ? sigma.passiveStart : (sigma.setB?.passiveStart || sigma.passiveStart);

  const nodeId = node.id;
  const isAllocated = currentPassives.includes(nodeId);
  const nodeStatus = ptNodeStatus(nodeId, currentPassives, passiveStart);

  if (isAllocated) {
    // Can only deallocate if it's a leaf (no allocated node depends on it).
    if (!isPtLeaf(nodeId, currentPassives)) return; // not a leaf — ignore click
    const newPassives = currentPassives.filter((id) => id !== nodeId);
    postPassives(newPassives);
  } else if (nodeStatus === "available") {
    // Allocate — check point budget.
    const ptsUsed = currentPassives.length;
    const ptsMax = typeof sigma.passivePoints === "number" ? sigma.passivePoints : 0;
    if (ptsUsed >= ptsMax) {
      showError("No passive points remaining.");
      return;
    }
    postPassives([...currentPassives, nodeId]);
  }
  // locked status — ignore click
}

// Returns "allocated" | "available" | "locked" for a given node id.
function ptNodeStatus(id, allocated, startId) {
  if (allocated.includes(id)) return "allocated";
  // Available if adjacent to any allocated node (or the start node).
  const tree = buildState.passiveTree;
  if (!tree) return "locked";
  const adjacentToAllocated = tree.nodes.some((n) => {
    if (n.id !== id) return false;
    return Array.isArray(n.adj) && n.adj.some((adjId) => allocated.includes(adjId) || adjId === startId);
  });
  // Also make start node itself always available.
  if (id === startId && !allocated.includes(id)) return "available";
  return adjacentToAllocated ? "available" : "locked";
}

// A node is a leaf if no other allocated node has it as a required connector.
// BFS from start: removing the candidate must not disconnect any other allocated node.
function isPtLeaf(candidateId, allocated) {
  const tree = buildState.passiveTree;
  if (!tree) return true;
  const sigma = buildState.sigma;
  if (!sigma) return true;
  const viewing = buildState.viewingSet;
  const activeSet = sigma.activeSet || "A";
  const passiveStart = viewing === activeSet ? sigma.passiveStart : (sigma.setB?.passiveStart || sigma.passiveStart);

  const remaining = allocated.filter((id) => id !== candidateId);
  // Build adjacency map.
  const adj = new Map();
  for (const n of tree.nodes) {
    if (!Array.isArray(n.adj)) continue;
    if (!adj.has(n.id)) adj.set(n.id, []);
    for (const a of n.adj) {
      adj.get(n.id).push(a);
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push(n.id);
    }
  }
  // BFS from passiveStart; can we reach all remaining allocated nodes?
  const visited = new Set();
  const queue = [passiveStart];
  visited.add(passiveStart);
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of (adj.get(cur) || [])) {
      if (visited.has(nb)) continue;
      if (nb === candidateId) continue; // pretend it's gone
      if (!remaining.includes(nb) && nb !== passiveStart) continue; // only traverse allocated
      visited.add(nb);
      queue.push(nb);
    }
  }
  // All remaining allocated nodes reachable?
  return remaining.every((id) => visited.has(id));
}

async function postPassives(passives) {
  if (buildState.mutating) return;
  buildState.mutating = true;
  updateBuildMutateUI();
  try {
    const r = await fetchJson("/api/v1/vcs/combat-passives", {
      method: "POST",
      body: { passives, set: buildState.viewingSet },
    });
    if (r && r.ok !== false) buildState.sigma = r;
  } catch (_err) { /* keep existing state */ }
  buildState.mutating = false;
  renderBuildTab();
}

// Disable position/aura controls while a mutation is in flight.
function updateBuildMutateUI() {
  document.querySelectorAll(".pos-btn, .aura-row, #build-swap-btn").forEach((el) => {
    if (el.tagName === "BUTTON") el.disabled = buildState.mutating;
  });
}

// Draw the passive tree onto the canvas element.
function renderPtCanvas() {
  const canvas = $("passive-tree-canvas");
  if (!canvas || !buildState.passiveTree || !ptPositions) return;

  const tree = buildState.passiveTree;
  const sigma = buildState.sigma;
  const viewing = buildState.viewingSet;
  const activeSet = sigma?.activeSet || "A";
  const allocated = viewing === activeSet
    ? (Array.isArray(sigma?.passives) ? sigma.passives : [])
    : (Array.isArray(sigma?.setB?.passives) ? sigma.setB.passives : []);
  const passiveStart = viewing === activeSet
    ? (sigma?.passiveStart || "warrior_start")
    : (sigma?.setB?.passiveStart || sigma?.passiveStart || "warrior_start");

  // Size canvas to its CSS container (CSS pixel-exact, 880×880 logical).
  const dpr = window.devicePixelRatio || 1;
  const w = 880, h = 880;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width  = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width  = `${w}px`;
    canvas.style.height = `${h}px`;
  }

  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  // Background.
  ctx.fillStyle = "#0a0a0c";
  ctx.fillRect(0, 0, w, h);

  // Apply pan/zoom.
  ctx.save();
  ctx.translate(ptView.offsetX, ptView.offsetY);
  ctx.scale(ptView.scale, ptView.scale);

  // Draw edges first.
  ctx.lineWidth = 1.5;
  for (const node of tree.nodes) {
    const p = ptPositions.get(node.id);
    if (!p || !Array.isArray(node.adj)) continue;
    for (const adjId of node.adj) {
      const q = ptPositions.get(adjId);
      if (!q) continue;
      const bothAllocated = allocated.includes(node.id) && allocated.includes(adjId);
      ctx.strokeStyle = bothAllocated ? "#8860d0" : "#2a2a32";
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }
  }

  // Draw nodes.
  for (const node of tree.nodes) {
    const p = ptPositions.get(node.id);
    if (!p) continue;

    const status = ptNodeStatus(node.id, allocated, passiveStart);
    const r = ptNodeRadius(node);
    const isKeystone = node.kind === "keystone";
    const isStart = node.id === passiveStart;

    // Outer glow for allocated keystones.
    if (isKeystone && status === "allocated") {
      ctx.shadowColor = "#ffc857";
      ctx.shadowBlur  = 14;
    } else if (status === "available") {
      ctx.shadowColor = "#bf94ff";
      ctx.shadowBlur  = 6;
    } else {
      ctx.shadowBlur = 0;
    }

    // Fill.
    if (status === "allocated") {
      ctx.fillStyle = isKeystone ? "#ffc857" : "#8860d0";
    } else if (status === "available") {
      ctx.fillStyle = isKeystone ? "rgba(255,200,87,0.35)" : "rgba(136,96,208,0.35)";
    } else {
      ctx.fillStyle = "#1a1a22";
    }

    // Keystone: diamond; start: star-ish (larger circle); others: circle.
    ctx.beginPath();
    if (isKeystone) {
      // Diamond shape.
      ctx.moveTo(p.x,     p.y - r);
      ctx.lineTo(p.x + r, p.y    );
      ctx.lineTo(p.x,     p.y + r);
      ctx.lineTo(p.x - r, p.y    );
      ctx.closePath();
    } else if (isStart) {
      // Octagon for class start.
      const ra = (Math.PI * 2) / 8;
      ctx.moveTo(p.x + r * Math.cos(-ra / 2), p.y + r * Math.sin(-ra / 2));
      for (let i = 1; i <= 8; i++) {
        ctx.lineTo(p.x + r * Math.cos(ra * i - ra / 2), p.y + r * Math.sin(ra * i - ra / 2));
      }
    } else {
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.shadowBlur = 0;

    // Stroke.
    ctx.lineWidth = isKeystone ? 2 : 1.5;
    ctx.strokeStyle = status === "allocated"
      ? (isKeystone ? "#ffd97a" : "#a070e8")
      : status === "available"
      ? (isKeystone ? "#ffc857" : "#bf94ff")
      : "#333340";
    ctx.stroke();

    // Center dot for non-keystone allocated nodes.
    if (status === "allocated" && !isKeystone) {
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore(); // end pan/zoom
  ctx.restore(); // end dpr scale

  // Points counter.
  if (sigma) {
    const used = allocated.length;
    const max  = typeof sigma.passivePoints === "number" ? sigma.passivePoints : "?";
    setText("build-pts-used", `${used} / ${max} points`);
  }
}

/* ── Build tab init (wired once at startup) ─────────────────────────── */

// Pan/zoom state: center on the class start node when tree first loads.
function resetPtView() {
  // Centre offset so the 880×880 logical canvas is centred in the CSS box.
  // The wrap div sets overflow:hidden; our canvas is 880px wide.
  ptView.scale = 0.65;
  // Centre on the class start (warrior_start ≈ top-centre of the 880×880 logical).
  // 440 is CX; 440 - 80*sin(270°)=440+80=520 is CY for warrior_start. We want
  // that point visible in the upper portion of the canvas.
  ptView.offsetX = 0;
  ptView.offsetY = 0;
}

// Wire all build-tab interactive elements. Called once from init().
function wireBuildTabInit() {
  wireBuildTab();
  wirePositionBtns();
  resetPtView();
}

/* ── Avatar render loop ─────────────────────────────────────────────── */

// A representative weapon for the preview when the viewer's live MMO sigma
// hasn't been fetched yet (the combat tab loads /api/v1/vcs/combat-gear lazily).
// As soon as real combat gear lands, the live weapon + rarity replace this.
const PREVIEW_WEAPON = { family: "sword", rarity: "rare" };

function syncAvatarPet() {
  avatarPet.cosmetics = state.loadout;
  // Live MMO sigma weapon (family drives which blade; rarity drives the gold
  // tint) when the combat tab has loaded it; otherwise a representative sword
  // so the operator can always see an equipped, swinging blade in the preview.
  const sigma = state.combat?.sigma;
  avatarPet.weapon = sigma?.weapon || PREVIEW_WEAPON;
  // Best-effort level label — only from real sigma data, never invented.
  const lvlEl = $("avatar-level");
  if (lvlEl) {
    if (typeof sigma?.level === "number") {
      lvlEl.textContent = `Lv ${sigma.level}`;
      lvlEl.hidden = false;
    } else {
      lvlEl.hidden = true;
    }
  }
}

let lastFrame = 0;
const FRAME_MS = 1000 / 24;

function startAvatarLoop() {
  function frame(now) {
    requestAnimationFrame(frame);
    if (now - lastFrame < FRAME_MS) return;
    lastFrame = now;

    // Main avatar. When a weapon is equipped, periodically play a slash so the
    // blade visibly swings: ~700ms slash burst every ~3s, idle walk otherwise.
    const slashing = avatarPet.weapon ? now % 3000 < 700 : false;
    drawAvatarTo($("avatar-canvas"), avatarPet, now, 2.5, slashing ? "slash" : null);

    // Slot cells — only the ones that have an equipped item
    document.querySelectorAll("canvas.slot-canvas").forEach((c) => {
      const slot = c.dataset.slot;
      const pet = slotPets.get(slot);
      if (pet) {
        drawAvatarTo(c, pet, now, 0.75);
      } else {
        const ctx = c.getContext("2d");
        ctx.clearRect(0, 0, c.width, c.height);
      }
    });

    // Inventory + shop + catalog thumbnails — only the visible ones
    document.querySelectorAll("canvas.inv-canvas").forEach((c) => {
      if (!onScreen(c)) return;
      const key = c.dataset.itemKey;
      const pet = inventoryPets.get(key) || shopPets.get(key);
      if (pet) drawAvatarTo(c, pet, now, 0.75);
    });
  }
  requestAnimationFrame(frame);
}

function drawAvatarTo(canvas, pet, now, scale, animOverride = null) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  try {
    const cx = pet.cosmetics?.companion ? w * 0.42 : w * 0.5;
    const groundY = h - 8;
    composeAvatar(ctx, cx, groundY, pet, now, scale, animOverride);
  } catch (e) {
    // Don't kill the loop on one bad frame.
    console.warn("[vcs] composeAvatar threw", e);
  }
}

function onScreen(el) {
  const r = el.getBoundingClientRect();
  return r.bottom > -80 && r.top < window.innerHeight + 80;
}

/* ── UI helpers ─────────────────────────────────────────────────────── */

function $(id) {
  return document.getElementById(id);
}
function show(id) {
  const el = $(id);
  if (el) el.hidden = false;
}
function hide(id) {
  const el = $(id);
  if (el) el.hidden = true;
}
function showError(msg) {
  const e = $("error");
  if (!e) return;
  e.textContent = msg;
  e.hidden = false;
}
function hideError() {
  const e = $("error");
  if (e) e.hidden = true;
}
function stableSeed(s) {
  // FNV-1a 32-bit — deterministic seed from the login so default-ramp choices
  // are stable across page loads.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}
function humanizeError(code, _path) {
  switch (code) {
    case "unauthenticated":
      return "Please sign in to use the character builder.";
    case "bridge_offline":
      return ""; // surfaced via the streamer-offline state instead
    case "bridge_timeout":
      return "Slow response from the streamer. Try again.";
    case "insufficient_xp":
      return "Not enough XP for this item.";
    case "tier_required":
      return "You need to reach a higher tier to buy this.";
    case "mythic_not_featured":
      return "Mythic items are only for sale while featured.";
    case "already_owned":
      return "You already own this item.";
    case "not_owned":
      return "You need to own this item before equipping it.";
    case "invalid_color":
      return "Invalid colour value.";
    case "invalid_body":
      return "Invalid body type.";
    case "out_of_range":
      return "Hue must be 0–359.";
    case "shadow_mode":
      return "Backend is in shadow mode — character changes are paused.";
    case "mmo_unreachable":
      return "The MMO server is offline — can't change gear right now.";
    case "mmo_timeout":
      return "The MMO server was slow to respond. Try again.";
    case "no character":
    case "no_character":
      return "No active sigma — type !sigma in chat to mint one first.";
    case "invalid_slot":
    case "slot_mismatch":
      return "That item can't go in that slot.";
    case "invalid_index":
    case "index_out_of_range":
      return "That item is no longer in your bag — refreshing.";
    // Vampire Survivors weapon layer.
    case "bad_weapons":
      return "Invalid weapon selection.";
    case "bad_weapon_id":
      return "Unknown weapon id — check your loadout.";
    // Project Ascendant — build config errors.
    case "bad_position":
      return "Invalid position — choose front, mid, or back.";
    case "bad_passives":
      return "Invalid passive selection — tree connectivity violated.";
    case "no_points":
      return "No passive points available.";
    case "over_spirit":
      return "Not enough spirit for those reservations.";
    case "bad_set":
      return "Invalid build set — use A or B.";
    case "set_b_null":
      return "Set B hasn't been created yet — swap once to initialize it.";
    default:
      return `Something went wrong (${code || "unknown"}).`;
  }
}
