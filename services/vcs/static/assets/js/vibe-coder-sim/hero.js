// Vibe Coder Sim — hero-moment choreography state machine
// triggerHero(payload) starts a 4-phase spotlight sequence.
// draw(ctx, pets, frameMs, groundY, VW, VH, avatarFn, particleFns) paints the active hero.

import { emitConfetti, emitGlamburst, emitSparkle } from "./particles.js";

let _hero = null;

// Phases: rise → slam → hold → exit
const PHASE_RISE = 0;
const PHASE_SLAM = 1;
const PHASE_HOLD = 2;
const PHASE_EXIT = 3;

const PHASE_DURATION = [600, 800, 1600, 1000]; // ms each

const REASON_LABEL = {
  daily_drop: "LEGENDARY DROP",
  tier_up: "TIER UP!",
  host_pick: "SPOTLIGHT",
  event_ball_night: "BALL NIGHT",
  event_catwalk: "CATWALK",
  event_tea_time: "TEA TIME",
  event_storm: "STORM RISING",
  event_royal_ceremony: "ROYAL CEREMONY",
};

export function triggerHero(payload) {
  const now = Date.now();
  _hero = {
    source: payload.source,
    login: payload.login,
    reason: payload.reason ?? "host_pick",
    until_ms: payload.until_ms ?? now + 6000,
    startMs: now,
    slamFired: false,
    exitMs: null,
  };
}

export function isActive() {
  if (!_hero) return false;
  return Date.now() < (_hero.until_ms ?? 0);
}

export function isHeroPet(pet) {
  return _hero && pet.login === _hero.login && pet.source === _hero.source;
}

export function draw(ctx, pets, frameMs, groundY, VW, VH, drawAvatarFn, accentHue) {
  if (!_hero) return;

  const now = Date.now();
  if (now >= _hero.until_ms) {
    _hero = null;
    return;
  }

  const elapsed = now - _hero.startMs;
  const totalPhase = PHASE_DURATION.reduce((a, b) => a + b, 0);

  // Determine current phase
  let phase = PHASE_EXIT;
  let phaseElapsed = elapsed;
  let phaseTotal = totalPhase;
  let acc = 0;
  for (let i = 0; i < PHASE_DURATION.length; i++) {
    if (elapsed < acc + PHASE_DURATION[i]) {
      phase = i;
      phaseElapsed = elapsed - acc;
      phaseTotal = PHASE_DURATION[i];
      break;
    }
    acc += PHASE_DURATION[i];
  }

  const t = Math.min(1, phaseElapsed / phaseTotal);
  const easeOut = 1 - (1 - t) ** 3;
  const easeIn = t ** 2;

  // Dim other pets
  const dimAlpha = phase === PHASE_HOLD ? 0.28 : lerp(1, 0.28, easeOut);
  if (dimAlpha < 0.98) {
    ctx.save();
    ctx.globalAlpha = 1 - dimAlpha;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(0, 0, VW, VH);
    ctx.restore();
  }

  // Find hero pet data
  const heroPet = pets.find((p) => p.login === _hero.login && p.source === _hero.source);

  // Compute hero position + scale
  const centerX = VW / 2;
  const centerY = VH * 0.45;

  let heroScale, heroX, heroY;

  if (phase === PHASE_RISE) {
    heroScale = lerp(1.0, 3.0, easeOut);
    const originX = heroPet ? (heroPet._x ?? centerX) : centerX;
    const originY = groundY;
    heroX = lerp(originX, centerX, easeOut);
    heroY = lerp(originY, centerY, easeOut);
    // Shake at end
    if (t > 0.85) {
      heroX += (Math.random() - 0.5) * 6 * (1 - t) * 30;
      heroY += (Math.random() - 0.5) * 3 * (1 - t) * 20;
    }
  } else if (phase === PHASE_SLAM) {
    heroScale = 3.0;
    heroX = centerX;
    heroY = centerY;

    // Fire glamburst once
    if (!_hero.slamFired) {
      _hero.slamFired = true;
      emitGlamburst(centerX, centerY + 60, accentHue, 180);
      emitConfetti(centerX, centerY - 80, 50);
    }

    // Impact ring
    const ringProgress = easeOut;
    const ringR = ringProgress * VW * 0.3;
    if (ringProgress < 0.9) {
      ctx.save();
      ctx.globalAlpha = (1 - ringProgress) * 0.7;
      ctx.strokeStyle = `hsl(${accentHue},100%,75%)`;
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(centerX, centerY + 80, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  } else if (phase === PHASE_HOLD) {
    heroScale = 3.0 + 0.05 * Math.sin(frameMs / 300);
    heroX = centerX;
    heroY = centerY;
    // Continuous sparkle emission
    if (Math.random() < 0.3) {
      emitSparkle(
        heroX + (Math.random() - 0.5) * 120,
        heroY + (Math.random() - 0.5) * 200,
        accentHue,
      );
    }
  } else {
    // EXIT
    heroScale = lerp(3.0, 1.0, easeIn);
    const destX = heroPet ? (heroPet._x ?? centerX) : centerX;
    heroX = lerp(centerX, destX, easeIn);
    heroY = lerp(centerY, groundY, easeIn);
  }

  // Draw avatar at hero position
  if (heroPet && drawAvatarFn) {
    // Store position for exit tween
    heroPet._heroX = heroX;
    heroPet._heroY = heroY;
    drawAvatarFn(ctx, heroX, heroY + 80 * heroScale, heroPet, frameMs, heroScale);
  }

  // Labels (phase HOLD)
  if (phase === PHASE_HOLD) {
    drawHeroLabel(ctx, heroX, heroY - 140 * heroScale, _hero, accentHue, easeIn);
  }
}

function drawHeroLabel(ctx, cx, y, hero, hue, fade) {
  const line1 = REASON_LABEL[hero.reason] ?? "SPOTLIGHT";
  const line2 = `@${hero.login}`;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Line 1 — big rainbow
  ctx.font = 'bold 56px FredokaOne, "Fredoka One", sans-serif';
  const rg = ctx.createLinearGradient(cx - 200, y, cx + 200, y);
  rg.addColorStop(0, `hsl(${hue},100%,65%)`);
  rg.addColorStop(0.5, "#ffffff");
  rg.addColorStop(1, `hsl(${(hue + 60) % 360},100%,65%)`);
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.lineWidth = 6;
  ctx.globalAlpha = fade;
  ctx.strokeText(line1, cx, y);
  ctx.fillStyle = rg;
  ctx.fillText(line1, cx, y);

  // Line 2 — username
  ctx.font = 'bold 34px FredokaOne, "Fredoka One", sans-serif';
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 4;
  ctx.strokeText(line2, cx, y + 56);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(line2, cx, y + 56);

  ctx.restore();
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
