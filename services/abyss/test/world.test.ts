// SIGMA ABYSS edge — pure sim/world unit tests (node env, no Worker runtime).
//
// Covers the deterministic core that the RealmRoom DO depends on. The full
// edge HTTP loop (register → move → submit → consensus, HMAC enforcement) is
// verified end-to-end against the live workers.dev deploy; the same ported
// domain logic is also exercised by sigmashake-mmo/test/unit/oracle.test.js.

import { describe, expect, test } from "vitest";
import {
  contentAt,
  inBounds,
  MONSTERS,
  makeRng,
  manhattan,
  ORACLE,
  ORACLE_TILE,
  RECIPES,
  RESOURCES,
  START,
  worldSnapshot,
  xpForLevel,
} from "../src/world";

describe("deterministic RNG", () => {
  test("same seed → identical sequence; state advances + serializes", () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    const seqA = [a.next(), a.next(), a.next()];
    const seqB = [b.next(), b.next(), b.next()];
    expect(seqA).toEqual(seqB);
    for (const v of seqA) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThan(1);
    expect(a.state).toBe(b.state);
    expect(a.state >>> 0).toBe(a.state); // a valid uint32

    // Restoring from a saved state replays exactly (the offline/replay contract).
    const c = makeRng(a.state);
    expect(c.next()).toBe(makeRng(a.state).next());
  });

  test("different seeds diverge", () => {
    expect(makeRng(1).next()).not.toBe(makeRng(2).next());
  });
});

describe("world map", () => {
  test("snapshot shape", () => {
    const w = worldSnapshot();
    expect(w.tiles.length).toBe(16);
    expect(Object.keys(w.monsters).length).toBe(5);
    expect(Object.keys(w.resources).length).toBe(4);
    expect(Object.keys(w.recipes).length).toBe(3);
    expect(w.width).toBe(11);
    expect(w.height).toBe(11);
  });

  test("tile content lookup", () => {
    expect(contentAt(START.x, START.y)?.type).toBe("town");
    expect(contentAt(ORACLE_TILE.x, ORACLE_TILE.y)?.type).toBe("oracle");
    expect(contentAt(5, 2)?.type).toBe("monster");
    expect(contentAt(3, 2)?.type).toBe("resource");
    expect(contentAt(1, 1)).toBeNull(); // empty ground
    expect(contentAt(99, 99)).toBeNull(); // out of bounds
  });

  test("bounds + distance", () => {
    expect(inBounds(0, 0)).toBe(true);
    expect(inBounds(11, 0)).toBe(false);
    expect(inBounds(-1, 0)).toBe(false);
    expect(manhattan(5, 5, 5, 4)).toBe(1);
    expect(manhattan(0, 0, 9, 9)).toBe(18);
  });

  test("every monster/resource tile references a real def", () => {
    for (const t of worldSnapshot().tiles) {
      if (t.content.type === "monster") expect(MONSTERS[t.content.code]).toBeDefined();
      if (t.content.type === "resource") expect(RESOURCES[t.content.code]).toBeDefined();
    }
  });

  test("recipe ingredients are gatherable drops", () => {
    const drops = new Set(Object.values(RESOURCES).map((r) => r.drop));
    for (const r of Object.values(RECIPES)) {
      for (const ing of Object.keys(r.ingredients)) {
        // every ingredient is either a gathered drop or another crafted item
        expect(drops.has(ing) || ing in RECIPES).toBe(true);
      }
    }
  });
});

describe("progression + tunables", () => {
  test("xpForLevel is positive + monotonic", () => {
    let prev = 0;
    for (let n = 1; n <= 20; n++) {
      const v = xpForLevel(n);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  test("oracle defaults are sane", () => {
    expect(ORACLE.REDUNDANCY_DEFAULT).toBeGreaterThanOrEqual(1);
    expect(ORACLE.REDUNDANCY_MAX).toBeGreaterThanOrEqual(ORACLE.REDUNDANCY_DEFAULT);
    expect(ORACLE.TTL_MS_MAX).toBeGreaterThan(ORACLE.TTL_MS_DEFAULT);
    expect(ORACLE.REWARD_DEFAULT.gold).toBeGreaterThan(0);
  });
});
