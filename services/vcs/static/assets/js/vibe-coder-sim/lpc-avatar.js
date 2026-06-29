// Vibe Coder Sim — LPC sprite renderer.
//
// Drop-in replacement for avatar.js's composeAvatar(): same signature, so
// vibe-coder-sim.js / hero.js / shop-preview.js only change an import. Renders
// each chatter pet as a layered 64×64 Universal-LPC paperdoll — real body /
// head / hair / clothes / hat / wings sprites — palette-recoloured per chatter
// from their seed + !color/!hair/!hatstyle catalog choices.
//
// Pipeline:
//   cosmetics.lpcBuild(pet)  → ordered LPC layers (assetId + recolour)
//   pick anim + direction from pet state (idle / walk / sit + facing)
//   composite the 64×64 frame  (cached per build-signature × anim × dir × frame)
//   blit scaled to the overlay canvas, feet on groundY
//   draw the procedural FX on top (aura / trail / companion / pose / props) —
//     those are positional effects LPC has no sprite for; avatar.js still owns them.
//
// composeAvatar() owns facing: it picks the LPC left/right directional row, and
// the procedural fallback mirrors internally. Callers must NOT pre-mirror ctx.
//
// Until index.json + the body sheet have loaded, composeAvatar() transparently
// delegates to the procedural avatar.js so the overlay never shows empty pets.

import {
  applyPoseTransform,
  drawAura,
  drawCompanion,
  drawSleepZ,
  drawTrailSample,
  composeAvatar as proceduralCompose,
} from "./avatar.js";
import { drawLpcProps, lpcBuild } from "./cosmetics.js";
import { ANIMS, animSpec, DIR_ROW, FRAME, LPC_BASE } from "./lpc-manifest.js";
import { makeCanvas, recolorCanvas } from "./lpc-recolor.js";

// Where the character's feet sit inside the 64-tall frame, and a size nudge so
// an LPC paperdoll reads at roughly the same on-stage size as the old 24×32.
const FOOT_Y = 60;
const SCALE_BOOST = 1.3;

export const AVATAR_DIMENSIONS = { width: FRAME, height: FRAME };

// ── async asset state ─────────────────────────────────────────────────
let index = null; // /assets/lpc/index.json — what actually shipped
let indexReady = false;
const imgCache = new Map(); // url → { img, ready }
const sheetCache = new Map(); // assetId|anim|part|ramp → recoloured sheet canvas
const frameCache = new Map(); // sig|anim|dir|frame → composited 64×64 canvas
const CACHE_MAX = 280;

function lru(map, key, value) {
  if (value !== undefined) {
    if (map.size >= CACHE_MAX) map.delete(map.keys().next().value);
    map.set(key, value);
    return value;
  }
  const v = map.get(key);
  if (v !== undefined) {
    map.delete(key);
    map.set(key, v);
  }
  return v;
}

function loadImage(url) {
  let e = imgCache.get(url);
  if (e) return e;
  e = { img: new Image(), ready: false, failed: false };
  e.img.onload = () => {
    e.ready = true;
  };
  e.img.onerror = () => {
    e.failed = true;
  };
  e.img.src = url;
  imgCache.set(url, e);
  return e;
}

async function init() {
  try {
    // index.json is the live asset manifest — it changes on every deploy that
    // adds or renames a sprite, so revalidate it (`no-cache`, a cheap 304).
    // `force-cache` pinned a stale copy: expandLayers() then drops any newly
    // named layer, and a dropped dress renders the avatar NAKED.
    const res = await fetch(`${LPC_BASE}/index.json`, { cache: "no-cache" });
    index = await res.json();
    indexReady = true;
    preloadAllAssets();
  } catch {
    indexReady = false; // stay on the procedural fallback forever — still playable
  }
}
init();

// The anims any pet on the VCS builder or OBS overlay actually paints:
// `walk` is universal, `idle` is the static-stand pose, `sit` is the
// builder thumbnails' default. Fire-and-forget every available match —
// the browser caps concurrent requests per-origin, so this naturally
// pipelines without overwhelming the network.
//
// Without this, the first time a chatter picks a new shirt / hair / hat
// the avatar paints with the layer MISSING until the .png finishes
// downloading (~50-300ms on first hit). That's the "character loaded
// with no shirt" symptom users hit on first selection of a fresh asset.
const PRELOAD_ANIMS = new Set(["walk", "idle", "sit"]);

function preloadAllAssets() {
  if (!index) return;
  for (const [assetId, meta] of Object.entries(index)) {
    const have = meta.anims || [];
    const parts = meta.parts || ["_"];
    for (const anim of have) {
      if (!PRELOAD_ANIMS.has(anim)) continue;
      for (const part of parts) {
        const suffix = part === "_" ? "" : `.${part}`;
        loadImage(`${LPC_BASE}/${assetId}/${anim}${suffix}.png`);
      }
    }
  }
}

// ── anim / direction selection ────────────────────────────────────────
function pickState(pet, animOverride) {
  const m = pet?._motion;
  // Explicit dir override (set by the VCS builder direction buttons) takes
  // precedence — lets the user face up/down, which facing can't express.
  const dir = m?.dir || (m && m.facing < 0 ? "left" : "right");
  // An explicit anim passed by the caller (e.g. "slash" while a preview is
  // mid-swing) wins over everything so a surface can SHOW the avatar attacking.
  // The facing row still follows `dir`. Callers that don't pass one keep the
  // old _duelAnim / _actionState / motion behaviour exactly.
  if (animOverride && ANIMS[animOverride]) return { anim: animOverride, dir };
  // A duel overrides everything else — duel.js drives the combat anims
  // (slash / hurt) by setting pet._duelAnim.
  if (pet?._duelAnim) return { anim: pet._duelAnim, dir };
  if (pet?.sleeping) return { anim: "sit", dir: "down" };
  // Per-pet action override (character_action redemptions, dance_party).
  // Wins over motion so a sitting/emoting pet keeps the pose even if chat
  // velocity nudges it. Auto-expires via _actionUntilMs.
  if (pet?._actionState && pet._actionUntilMs > Date.now() && ANIMS[pet._actionState]) {
    return { anim: pet._actionState, dir };
  }
  // vibe-coder-sim motion caps |vx| at ~0.30 (direction x SPEED_CAP); the old
  // 0.5 gate was never met, so pets slid in the idle pose. vx is exactly 0
  // when stopped, so a small epsilon cleanly separates moving from stopped.
  const moving = m && (Math.abs(m.vx) > 0.02 || Math.abs(m.vz) > 0.001);
  // At rest: sit. The sit anim transitions stand→seated and holds the last
  // frame, so a pet that stops between waypoints crouches down naturally.
  return { anim: moving ? "walk" : "sit", dir };
}

// The anim a given asset will actually use (some layers have no idle/sit, etc.).
// Listed in fallback order — first available wins. Combat / shoot / climb fall
// back to a walk cycle so a dressed pet keeps moving rather than freezing.
const ANIM_FALLBACK = {
  idle: ["idle", "walk"],
  walk: ["walk", "idle"],
  run: ["run", "walk"],
  jump: ["jump", "walk", "idle"],
  sit: ["sit", "idle", "walk"],
  emote: ["emote", "idle", "walk"],
  combat_idle: ["combat_idle", "idle", "walk"],
  climb: ["climb", "walk"],
  slash: ["slash", "halfslash", "thrust", "walk"],
  backslash: ["backslash", "slash", "thrust", "walk"],
  halfslash: ["halfslash", "slash", "thrust", "walk"],
  thrust: ["thrust", "slash", "walk"],
  shoot: ["shoot", "thrust", "walk"],
  hurt: ["hurt", "idle", "walk"],
  spellcast: ["spellcast", "idle", "walk"],
};
function resolveAnim(assetId, want) {
  const have = index?.[assetId]?.anims || [];
  for (const a of ANIM_FALLBACK[want] || [want]) {
    if (have.includes(a)) return a;
  }
  return have[0] || want;
}

// ── sheet access (load + recolour, cached) ────────────────────────────
function getSheet(assetId, anim, part, recolor) {
  const ramp = recolor ? recolor.ramp : "";
  const key = `${assetId}|${anim}|${part}|${ramp}`;
  const cached = lru(sheetCache, key);
  if (cached) return cached;

  const suffix = part === "_" ? "" : `.${part}`;
  const entry = loadImage(`${LPC_BASE}/${assetId}/${anim}${suffix}.png`);
  if (!entry.ready) return entry.failed ? "fail" : null; // null = not ready yet

  let sheet = makeCanvas(entry.img.width, entry.img.height);
  sheet.getContext("2d").drawImage(entry.img, 0, 0);
  if (recolor) sheet = recolorCanvas(sheet, recolor.material, recolor.ramp);
  return lru(sheetCache, key, sheet);
}

// Expand an lpcBuild() result into flat, z-sorted render layers.
function expandLayers(build) {
  const out = [];
  for (const layer of build) {
    const meta = index[layer.assetId];
    if (!meta) continue;
    for (const part of meta.parts || ["_"]) {
      const z = part === "bg" ? (meta.zBack ?? meta.z - 1) : meta.z;
      out.push({ assetId: layer.assetId, part, z, recolor: layer.recolor || null });
    }
  }
  return out.sort((a, b) => a.z - b.z);
}

// Composite one 64×64 frame from z-sorted layers. Returns { canvas, complete }.
function compositeFrame(layers, want, dir, frameMs) {
  const wantSpec = animSpec(want);
  const tick = Math.floor((frameMs * wantSpec.fps) / 1000);
  const sig = layers
    .map((l) => `${l.assetId}${l.part}${l.recolor ? l.recolor.ramp : ""}`)
    .join(",");
  const baseFrame = wantSpec.hold ? wantSpec.frames - 1 : tick % wantSpec.frames;
  const key = `${sig}|${want}|${dir}|${baseFrame}`;
  const cached = lru(frameCache, key);
  if (cached) return { canvas: cached, complete: true };

  const out = makeCanvas(FRAME, FRAME);
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = false;
  let complete = true;

  for (const layer of layers) {
    const anim = resolveAnim(layer.assetId, want);
    const sheet = getSheet(layer.assetId, anim, layer.part, layer.recolor);
    if (sheet === "fail") continue;
    if (!sheet) {
      complete = false;
      continue;
    }
    const spec = animSpec(anim);
    const frame = spec.hold ? spec.frames - 1 : tick % spec.frames;
    const row = spec.rows === 1 ? 0 : (DIR_ROW[dir] ?? DIR_ROW.right);
    octx.drawImage(sheet, frame * FRAME, row * FRAME, FRAME, FRAME, 0, 0, FRAME, FRAME);
  }
  if (complete) lru(frameCache, key, out);
  return { canvas: out, complete };
}

// ── public: chatter pet ───────────────────────────────────────────────
export function composeAvatar(ctx, cx, groundY, pet, frameMs, scale = 1, animOverride = null) {
  const build = indexReady ? lpcBuild(pet) : null;
  const bodyId = build?.[0]?.assetId;
  const bodyReady =
    bodyId &&
    getSheet(
      bodyId,
      resolveAnim(bodyId, pickState(pet, animOverride).anim),
      "_",
      build[0].recolor,
    ) instanceof Object;

  // Boot race / missing assets → procedural avatar, mirrored for facing.
  if (!indexReady || !build || !bodyReady) {
    ctx.save();
    if (pet?._motion && pet._motion.facing < 0) {
      ctx.translate(cx * 2, 0);
      ctx.scale(-1, 1);
    }
    proceduralCompose(ctx, cx, groundY, pet, frameMs, scale);
    ctx.restore();
    return;
  }

  const { anim, dir } = pickState(pet, animOverride);
  const layers = expandLayers(build);
  const { canvas } = compositeFrame(layers, anim, dir, frameMs);

  const s = scale * SCALE_BOOST;
  const w = FRAME * s;
  const h = FRAME * s;
  const dx = Math.round(cx - w / 2);
  const dy = Math.round(groundY - FOOT_Y * s);

  const c = pet?.cosmetics || {};
  // Aura + trail sit behind the body.
  if (c.aura) drawAura(ctx, cx, groundY - h * 0.42, h * 0.5, c.aura, frameMs);
  if (c.trail && !pet.sleeping) drawTrailSample(ctx, cx, groundY, s, c.trail, frameMs);

  ctx.save();
  if (c.pose && !pet.sleeping) applyPoseTransform(ctx, c.pose, cx, groundY, h, frameMs);
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, dx, dy, w, h);
  ctx.imageSmoothingEnabled = prev;
  // Held props + fantasy headpieces LPC has no layer for (halo, antlers, fan…).
  drawLpcProps(ctx, cx, dy, s, pet, frameMs);
  ctx.restore();

  if (c.companion) drawCompanion(ctx, cx + w * 0.34, groundY, c.companion, frameMs, s * 0.95);
  if (pet.sleeping) drawSleepZ(ctx, cx, groundY - h * 0.7, frameMs, scale);
}

export function lpcReady() {
  return indexReady;
}
