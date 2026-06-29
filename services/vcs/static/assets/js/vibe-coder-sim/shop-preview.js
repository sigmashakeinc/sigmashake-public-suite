// Vibe Coder Sim — shop catalog thumbnail renderer.
//
// Every <canvas.vcs-thumb data-slot data-key> on the shop page gets a small
// idle avatar wearing that one cosmetic, drawn through the shared
// composeAvatar() renderer — the exact same code path as the live OBS
// overlay. One throttled rAF loop drives every on-screen thumbnail.
//
// Loaded once as a module from vibe_coder_sim_shop_live.ex (inside a
// phx-update="ignore" wrapper so LiveView never re-touches it).

import { composeAvatar } from "./lpc-avatar.js";

// Guard against a double-load.
if (!window.__vcsShopPreviewStarted) {
  window.__vcsShopPreviewStarted = true;

  // Fixed seed → every thumbnail shares one neutral base body, so the
  // cosmetic itself is what visibly differs from card to card.
  const PREVIEW_SEED = 8;
  const FRAME_MS = 1000 / 24; // throttle the shared loop to ~24 fps

  // Synthetic idle pet per canvas, built once from its data-* attributes.
  const petCache = new WeakMap();

  function petFor(canvas) {
    let pet = petCache.get(canvas);
    if (!pet) {
      const slot = canvas.dataset.slot;
      const key = canvas.dataset.key;
      pet = {
        seed: PREVIEW_SEED,
        sleeping: false,
        cosmetics: slot && key ? { [slot]: key } : {},
      };
      petCache.set(canvas, pet);
    }
    return pet;
  }

  function onScreen(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > -100 && r.top < window.innerHeight + 100;
  }

  function renderThumb(canvas, now) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const pet = petFor(canvas);

    ctx.clearRect(0, 0, w, h);
    // Fit the LPC paperdoll (64-frame, ~1.3× boosted) with headroom for head
    // items + glow; nudge the anchor left when a companion is shown so it
    // doesn't clip the edge.
    const scale = Math.min(w / 100, h / 92);
    const cx = pet.cosmetics.companion ? w * 0.38 : w * 0.5;
    const groundY = h - 8;
    try {
      composeAvatar(ctx, cx, groundY, pet, now, scale);
    } catch (_) {
      // one malformed cosmetic shouldn't take down the whole loop
    }
  }

  let last = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (now - last < FRAME_MS) return;
    last = now;

    for (const canvas of document.querySelectorAll("canvas.vcs-thumb")) {
      if (onScreen(canvas)) renderThumb(canvas, now);
    }
  }

  requestAnimationFrame(frame);
}
