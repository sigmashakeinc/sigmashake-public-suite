// SIGMA ABYSS edge — world map, balance constants, deterministic RNG.
//
// Pure (no platform APIs) so it runs identically in the Worker, the DO, and a
// test. This is the TS port of the local game's shared/agent-world.js +
// shared/rng.js + the agent/oracle constants — the single source of truth for
// the edge realm's shape and tuning.

// ── World dimensions + tile content ─────────────────────────────────────────
export const WORLD_W = 11;
export const WORLD_H = 11;
export const START = { x: 5, y: 5 } as const;
export const ORACLE_TILE = { x: 5, y: 4 } as const;

export interface MonsterDef {
  code: string;
  name: string;
  level: number;
  hp: number;
  attack: number;
  xp: number;
  gold: number;
  drop: string;
}
export interface ResourceDef {
  code: string;
  name: string;
  skill: string;
  level: number;
  xp: number;
  drop: string;
}
export interface RecipeDef {
  code: string;
  skill: string;
  level: number;
  station: string;
  ingredients: Record<string, number>;
  xp: number;
  value: number;
  heal?: number;
}
export interface TileContent {
  type: "town" | "oracle" | "bank" | "workshop" | "monster" | "resource";
  code: string;
}

export const MONSTERS: Record<string, MonsterDef> = {
  chrome_rat: {
    code: "chrome_rat",
    name: "Chrome Rat",
    level: 1,
    hp: 28,
    attack: 5,
    xp: 8,
    gold: 4,
    drop: "rat_tail",
  },
  void_slime: {
    code: "void_slime",
    name: "Void Slime",
    level: 3,
    hp: 60,
    attack: 9,
    xp: 18,
    gold: 9,
    drop: "slime_gel",
  },
  abyss_crawler: {
    code: "abyss_crawler",
    name: "Abyss Crawler",
    level: 6,
    hp: 120,
    attack: 16,
    xp: 38,
    gold: 20,
    drop: "crawler_chitin",
  },
  hollow_knight: {
    code: "hollow_knight",
    name: "Hollow Knight",
    level: 10,
    hp: 240,
    attack: 28,
    xp: 80,
    gold: 48,
    drop: "hollow_plate",
  },
  sigma_wraith: {
    code: "sigma_wraith",
    name: "Sigma Wraith",
    level: 15,
    hp: 460,
    attack: 44,
    xp: 170,
    gold: 110,
    drop: "wraith_essence",
  },
};

export const RESOURCES: Record<string, ResourceDef> = {
  chrome_vein: {
    code: "chrome_vein",
    name: "Chrome Vein",
    skill: "mining",
    level: 1,
    xp: 6,
    drop: "chrome_ore",
  },
  void_timber: {
    code: "void_timber",
    name: "Void Timber",
    skill: "woodcutting",
    level: 1,
    xp: 6,
    drop: "void_log",
  },
  data_pool: {
    code: "data_pool",
    name: "Data Pool",
    skill: "fishing",
    level: 3,
    xp: 9,
    drop: "data_shard",
  },
  ether_bloom: {
    code: "ether_bloom",
    name: "Ether Bloom",
    skill: "alchemy",
    level: 5,
    xp: 14,
    drop: "ether_petal",
  },
};

export const WORKSHOPS: Record<string, { code: string; skill: string }> = {
  forge: { code: "forge", skill: "mining" },
  lab: { code: "lab", skill: "alchemy" },
};

export const RECIPES: Record<string, RecipeDef> = {
  chrome_ingot: {
    code: "chrome_ingot",
    skill: "mining",
    level: 1,
    station: "forge",
    ingredients: { chrome_ore: 3 },
    xp: 12,
    value: 18,
  },
  void_plank: {
    code: "void_plank",
    skill: "woodcutting",
    level: 1,
    station: "forge",
    ingredients: { void_log: 3 },
    xp: 12,
    value: 16,
  },
  ether_tonic: {
    code: "ether_tonic",
    skill: "alchemy",
    level: 5,
    station: "lab",
    ingredients: { ether_petal: 2, data_shard: 1 },
    xp: 30,
    value: 60,
    heal: 60,
  },
};

export const SKILLS = ["mining", "woodcutting", "fishing", "alchemy", "oracle"] as const;

const PLACED: Record<string, TileContent> = {
  "5,5": { type: "town", code: "spawn" },
  "5,4": { type: "oracle", code: "oracle" },
  "4,5": { type: "bank", code: "bank" },
  "6,5": { type: "workshop", code: "forge" },
  "5,6": { type: "workshop", code: "lab" },
  "5,2": { type: "monster", code: "chrome_rat" },
  "7,3": { type: "monster", code: "chrome_rat" },
  "2,4": { type: "monster", code: "void_slime" },
  "8,6": { type: "monster", code: "void_slime" },
  "1,8": { type: "monster", code: "abyss_crawler" },
  "9,9": { type: "monster", code: "hollow_knight" },
  "0,0": { type: "monster", code: "sigma_wraith" },
  "3,2": { type: "resource", code: "chrome_vein" },
  "7,7": { type: "resource", code: "void_timber" },
  "2,9": { type: "resource", code: "data_pool" },
  "9,1": { type: "resource", code: "ether_bloom" },
};

export function inBounds(x: number, y: number): boolean {
  return (
    Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < WORLD_W && y >= 0 && y < WORLD_H
  );
}
export function manhattan(x1: number, y1: number, x2: number, y2: number): number {
  return Math.abs(x1 - x2) + Math.abs(y1 - y2);
}
export function contentAt(x: number, y: number): TileContent | null {
  if (!inBounds(x, y)) return null;
  return PLACED[`${x},${y}`] ?? null;
}
export function worldSnapshot() {
  const tiles = Object.entries(PLACED).map(([k, content]) => {
    const [x, y] = k.split(",").map(Number);
    return { x, y, content };
  });
  return {
    width: WORLD_W,
    height: WORLD_H,
    tiles,
    monsters: MONSTERS,
    resources: RESOURCES,
    recipes: RECIPES,
    workshops: WORKSHOPS,
  };
}

// ── Cooldowns (seconds) + caps ──────────────────────────────────────────────
export const COOLDOWN = { move: 4, fight: 8, gather: 6, rest: 3, craft: 9, oracle: 4 } as const;
export const COOLDOWN_PER_TILE = 3;
export const COOLDOWN_MAX_S = 120;
export const BASE_HP = 100;
export const HP_PER_LEVEL = 12;
export const INVENTORY_MAX = 50;
export const NAME_RE = /^[a-zA-Z0-9_-]{2,24}$/;

// ── Oracle Bazaar tunables ──────────────────────────────────────────────────
export const ORACLE = {
  PROMPT_MAX: 8000,
  CONTEXT_MAX: 24000,
  ANSWER_MAX: 16000,
  CHOICES_MAX: 12,
  REDUNDANCY_DEFAULT: 1,
  REDUNDANCY_MAX: 9,
  TTL_MS_DEFAULT: 5 * 60_000,
  TTL_MS_MAX: 60 * 60_000,
  LEASE_MS: 90_000,
  OPEN_MAX: 500,
  REWARD_DEFAULT: { gold: 25, coins: 1, xp: 12 },
  KINDS: ["inference", "classify", "rank", "extract"],
} as const;

// ── Deterministic RNG (mulberry32; one serializable uint32 of state) ─────────
export function makeRng(seed: number) {
  let s = seed >>> 0 || 1;
  return {
    next(): number {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    get state(): number {
      return s >>> 0;
    },
  };
}

export function xpForLevel(n: number): number {
  return Math.round(40 * 1.14 ** (n - 1));
}
