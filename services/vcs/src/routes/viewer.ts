import { Hono } from "hono";
import type { HonoEnv } from "../index";
import { resolveViewer } from "../lib/auth";
import { dispatchToBridge } from "../lib/dispatch";

const viewer = new Hono<HonoEnv>();

/**
 * Every viewer-facing route follows the same shape:
 *   1. Resolve the sigmashake-accounts session cookie → ViewerContext
 *      (login + display). 401 if absent — the panel UI shows the
 *      "Sign in with Twitch" prompt.
 *   2. Validate the request body / query params, then call the DO's
 *      /dispatch with an RPC describing the chat-elixir endpoint.
 *   3. The DO sends it over WS to the streamer-side `vcs-bridge.ts`,
 *      awaits the reply, and returns it verbatim to the viewer.
 */

// /whoami is the auth-only probe. It returns the resolved session identity
// without touching the bridge — so the page can distinguish "not signed in"
// (401) from "signed in but streamer offline" (bridge_offline only affects
// /me + mutations). Keeps the post-login UI from showing "internal server
// error" when the streamer hasn't started the bridge yet.
viewer.get("/api/v1/vcs/whoami", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  return c.json({ ok: true, ...viewerFields(ctx) });
});

viewer.get("/api/v1/vcs/me", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  return await dispatchToBridge(c, "GET", "/api/v1/vcs/me", viewerFields(ctx));
});

viewer.post("/api/v1/vcs/brains/tick", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  const body = await safeJson(c.req.raw);
  return await dispatchToBridge(c, "POST", "/api/v1/vcs/brains/tick", {
    ...viewerFields(ctx),
    ...brainsTickFields(body),
  });
});

viewer.get("/api/v1/vcs/catalog", async (c) => {
  // Catalog is read-only and identical for every viewer; no auth needed
  // — but we still go through the bridge so chat-elixir owns the data.
  return await dispatchToBridge(c, "GET", "/api/v1/vcs/catalog", {});
});

// Project Ascendant: full sigma summary including Ascendant fields
// (passives, reserved, position, activeSet, setB, spirit, spiritUsed, auraBuffs,
// passivePoints). Bridge intercepts and proxies to /api/sigma/:login.
viewer.get("/api/v1/vcs/combat-sigma", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  return await dispatchToBridge(c, "GET", "/api/v1/vcs/combat-sigma", viewerFields(ctx));
});

// Project Ascendant: static passive tree — no auth required; bridge proxies to
// /api/passive-tree on the MMO server. Public read-only.
viewer.get("/api/v1/vcs/combat-passive-tree", async (c) => {
  return await dispatchToBridge(c, "GET", "/api/v1/vcs/combat-passive-tree", {});
});

// Project Ascendant: set passive allocations for a build set.
// Body: { passives: string[], set?: "A"|"B" }
viewer.post("/api/v1/vcs/combat-passives", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  const body = await safeJson(c.req.raw);
  const passives = Array.isArray(body.passives) ? body.passives : [];
  const set = typeof body.set === "string" ? body.set : "";
  return await dispatchToBridge(c, "POST", "/api/v1/vcs/combat-passives", {
    ...viewerFields(ctx),
    passives,
    set,
  });
});

// Vampire Survivors weapon layer: static catalog + synergy/evolution matrix.
// No auth required — mirrors combat-passive-tree. Bridge proxies to
// GET /api/weapon-catalog on the loopback MMO server.
viewer.get("/api/v1/vcs/combat-weapon-catalog", async (c) => {
  return await dispatchToBridge(c, "GET", "/api/v1/vcs/combat-weapon-catalog", {});
});

// Vampire Survivors weapon layer: viewer's current weapon loadout + evolutions.
// Login-scoped (same as combat-sigma). Bridge proxies to
// GET /api/sigma/:login/weapons on the MMO server.
viewer.get("/api/v1/vcs/combat-weapons", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  return await dispatchToBridge(c, "GET", "/api/v1/vcs/combat-weapons", viewerFields(ctx));
});

// Vampire Survivors weapon layer: set weapon loadout. Mirrors combat-passives.
// Body: { weapons: string[], set?: string }
// `set` is the active-weapon id (NOT a build-set "A"/"B" — see bridge contract §1).
// Unknown ids dropped, de-duped, capped to maxSlots=6 by the MMO server.
viewer.post("/api/v1/vcs/combat-weapons", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  const body = await safeJson(c.req.raw);
  const weapons = Array.isArray(body.weapons) ? body.weapons : [];
  const set = typeof body.set === "string" ? body.set : "";
  return await dispatchToBridge(c, "POST", "/api/v1/vcs/combat-weapons", {
    ...viewerFields(ctx),
    weapons,
    set,
  });
});

// Project Ascendant: set spirit reservations for a build set.
// Body: { reserved: string[], set?: "A"|"B" }
viewer.post("/api/v1/vcs/combat-reserve", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  const body = await safeJson(c.req.raw);
  const reserved = Array.isArray(body.reserved) ? body.reserved : [];
  const set = typeof body.set === "string" ? body.set : "";
  return await dispatchToBridge(c, "POST", "/api/v1/vcs/combat-reserve", {
    ...viewerFields(ctx),
    reserved,
    set,
  });
});

// Project Ascendant: set tactical position for a build set.
// Body: { position: "front"|"mid"|"back", set?: "A"|"B" }
viewer.post("/api/v1/vcs/combat-position", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  const body = await safeJson(c.req.raw);
  return await dispatchToBridge(c, "POST", "/api/v1/vcs/combat-position", {
    ...viewerFields(ctx),
    position: stringOrEmpty(body.position),
    set: stringOrEmpty(body.set),
  });
});

// Project Ascendant: swap active build set (A↔B). Body: { set?: "A"|"B" }
viewer.post("/api/v1/vcs/combat-swap-set", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  const body = await safeJson(c.req.raw);
  return await dispatchToBridge(c, "POST", "/api/v1/vcs/combat-swap-set", {
    ...viewerFields(ctx),
    set: stringOrEmpty(body.set),
  });
});

viewer.get("/api/v1/vcs/combat-gear", async (c) => {
  // Read-only MMO sigma loadout. Bridge intercepts this path and forwards
  // to the loopback MMO server (127.0.0.1:7777/api/sigma/:login) instead
  // of chat-elixir. The viewer's twitch_login keys the MMO character.
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  return await dispatchToBridge(c, "GET", "/api/v1/vcs/combat-gear", viewerFields(ctx));
});

viewer.get("/api/v1/vcs/combat-loadout", async (c) => {
  // Read-only MMO gear loadout (equipped gear per slot + the equippable
  // inventory). Bridge intercepts this path and forwards to the loopback MMO
  // server (127.0.0.1:7777/api/sigma/:login/loadout). The viewer's
  // twitch_login keys the MMO character — never a client-supplied login.
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  return await dispatchToBridge(c, "GET", "/api/v1/vcs/combat-loadout", viewerFields(ctx));
});

viewer.post("/api/v1/vcs/combat-equip", async (c) => {
  // Real MMO gear swap. Bridge forwards to MMO POST /api/sigma/:login/equip.
  // slot + index come from the request body; the MMO server is the trust
  // boundary and validates slot ∈ GEAR_SLOTS, index in range, item.slot===slot.
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  const body = await safeJson(c.req.raw);
  // Require a real non-negative integer index — a missing/empty index must 400,
  // not silently coerce to 0 (which would equip whatever sits in inventory[0]).
  const index = Number(body.index);
  if (
    body.index === undefined ||
    body.index === null ||
    body.index === "" ||
    !Number.isInteger(index) ||
    index < 0
  ) {
    return c.json({ ok: false, error: "valid inventory index required" }, 400);
  }
  return await dispatchToBridge(c, "POST", "/api/v1/vcs/combat-equip", {
    ...viewerFields(ctx),
    slot: stringOrEmpty(body.slot),
    index,
  });
});

viewer.post("/api/v1/vcs/equip", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  const body = await safeJson(c.req.raw);
  return await dispatchToBridge(c, "POST", "/api/v1/vcs/equip", {
    ...viewerFields(ctx),
    slot: stringOrEmpty(body.slot),
    item_key: stringOrEmpty(body.item_key),
  });
});

viewer.post("/api/v1/vcs/unequip", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  const body = await safeJson(c.req.raw);
  return await dispatchToBridge(c, "POST", "/api/v1/vcs/unequip", {
    ...viewerFields(ctx),
    slot: stringOrEmpty(body.slot),
  });
});

viewer.post("/api/v1/vcs/buy", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  const body = await safeJson(c.req.raw);
  return await dispatchToBridge(c, "POST", "/api/v1/vcs/buy", {
    ...viewerFields(ctx),
    item_key: stringOrEmpty(body.item_key),
  });
});

viewer.post("/api/v1/vcs/color", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  const body = await safeJson(c.req.raw);
  return await dispatchToBridge(c, "POST", "/api/v1/vcs/color", {
    ...viewerFields(ctx),
    slot: stringOrEmpty(body.slot),
    hex: stringOrEmpty(body.hex),
  });
});

viewer.post("/api/v1/vcs/hue", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  const body = await safeJson(c.req.raw);
  return await dispatchToBridge(c, "POST", "/api/v1/vcs/hue", {
    ...viewerFields(ctx),
    hue: body.hue ?? "",
  });
});

viewer.post("/api/v1/vcs/raw_slot", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  const body = await safeJson(c.req.raw);
  return await dispatchToBridge(c, "POST", "/api/v1/vcs/raw_slot", {
    ...viewerFields(ctx),
    slot: stringOrEmpty(body.slot),
    value: stringOrEmpty(body.value),
  });
});

viewer.post("/api/v1/vcs/body", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  const body = await safeJson(c.req.raw);
  return await dispatchToBridge(c, "POST", "/api/v1/vcs/body", {
    ...viewerFields(ctx),
    body: stringOrEmpty(body.body),
  });
});

viewer.post("/api/v1/vcs/clear_body", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  return await dispatchToBridge(c, "POST", "/api/v1/vcs/clear_body", viewerFields(ctx));
});

viewer.post("/api/v1/vcs/clear_raw_slot", async (c) => {
  const ctx = await resolveViewer(c);
  if (!ctx) return c.json({ ok: false, error: "unauthenticated" }, 401);
  const body = await safeJson(c.req.raw);
  return await dispatchToBridge(c, "POST", "/api/v1/vcs/clear_raw_slot", {
    ...viewerFields(ctx),
    slot: stringOrEmpty(body.slot),
  });
});

/* ── Helpers ────────────────────────────────────────────────────────────── */

interface ViewerLike {
  source: string;
  login: string;
  user_id: string;
  display: string;
  twitch_user_id: string;
  twitch_login: string;
  twitch_display: string;
}

const BRAINS_SCENE_MAX = 96;
const BRAINS_STIMULUS_MAX = 512;
const BRAINS_MOOD_MAX = 64;
const BRAINS_NEARBY_MAX_ITEMS = 6;
const BRAINS_NEARBY_ITEM_MAX = 64;
const BRAINS_IMAGE_DATA_URL_MAX = 16_384;

function viewerFields(v: ViewerLike): Record<string, string> {
  return {
    source: v.source,
    login: v.login,
    user_id: v.user_id,
    display: v.display,
    twitch_user_id: v.twitch_user_id,
    twitch_login: v.twitch_login,
    twitch_display: v.twitch_display,
  };
}

function brainsTickFields(body: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const scene = clampedOptionalString(body.scene, BRAINS_SCENE_MAX);
  const stimulus = clampedOptionalString(body.stimulus, BRAINS_STIMULUS_MAX);
  const mood = clampedOptionalString(body.mood, BRAINS_MOOD_MAX);
  const nearby = clampedNearby(body.nearby);
  const imageDataUrl = clampedOptionalString(body.image_data_url, BRAINS_IMAGE_DATA_URL_MAX);
  if (scene) payload.scene = scene;
  if (stimulus) payload.stimulus = stimulus;
  if (mood) payload.mood = mood;
  if (nearby) payload.nearby = nearby;
  if (imageDataUrl) payload.image_data_url = imageDataUrl;
  return payload;
}

function stringOrEmpty(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clampedOptionalString(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function clampedNearby(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const nearby = v
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, BRAINS_NEARBY_MAX_ITEMS)
    .map((item) => item.slice(0, BRAINS_NEARBY_ITEM_MAX));
  return nearby.length > 0 ? nearby : undefined;
}

async function safeJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const j = await req.json();
    return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export default viewer;
