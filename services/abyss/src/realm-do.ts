// SIGMA ABYSS edge — RealmRoom Durable Object.
//
// The authoritative game state, in DO SQLite. Because a DO is single-threaded,
// claim → answer → finalize on an oracle HIT is serializable for free — the
// race-prone dance the local JSON-store version had to hand-roll is just
// sequential code here. Owns three tables: `agents`, `tasks` (oracle HITs),
// `answers` (composite PK gives per-agent dedup for free). An alarm sweeps
// expired HITs and archives finalized ones to R2 so SQLite stays lean.
//
// The Worker (index.ts) verifies oracle-requester HMAC and extracts the agent
// bearer token, then forwards to internal routes here; this DO returns the final
// Response (status codes and all), which the Worker passes straight through.

import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "./index";
import {
  BASE_HP,
  COOLDOWN,
  COOLDOWN_MAX_S,
  COOLDOWN_PER_TILE,
  contentAt,
  HP_PER_LEVEL,
  INVENTORY_MAX,
  inBounds,
  MONSTERS,
  makeRng,
  manhattan,
  NAME_RE,
  ORACLE,
  ORACLE_TILE,
  RECIPES,
  RESOURCES,
  SKILLS,
  START,
  worldSnapshot,
  xpForLevel,
} from "./world";

type SqlVal = string | number | null;
interface AgentRow {
  token: string;
  name: string;
  x: number;
  y: number;
  level: number;
  xp: number;
  hp: number;
  max_hp: number;
  gold: number;
  task_coins: number;
  skills: string;
  inventory: string;
  cooldown_expires: number;
  rng_state: number;
  reputation: number;
  lifetime: string;
  created_at: number;
  seen_at: number;
  [key: string]: SqlVal;
}
interface TaskRow {
  id: string;
  kind: string;
  prompt: string;
  context: string | null;
  choices: string | null;
  schema_str: string | null;
  redundancy: number;
  reward: string;
  requester: string;
  status: string;
  result: string | null;
  leases: string;
  created_at: number;
  expires_at: number;
  completed_at: number | null;
  [key: string]: SqlVal;
}
interface AnswerRow {
  task_id: string;
  token: string;
  agent: string;
  answer: string;
  at: number;
  [key: string]: SqlVal;
}

interface Agent {
  token: string;
  name: string;
  x: number;
  y: number;
  level: number;
  xp: number;
  hp: number;
  maxHp: number;
  gold: number;
  taskCoins: number;
  skills: Record<string, { level: number; xp: number }>;
  inventory: Record<string, number>;
  cooldownExpires: number;
  rngState: number;
  reputation: number;
  lifetime: { kills: number; gathers: number; crafts: number; answers: number; deaths: number };
  createdAt: number;
  seenAt: number;
}

const J = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
function randHex(n: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(n)));
}
function normalize(s: string): string {
  return String(s).trim().toLowerCase().replace(/\s+/g, " ");
}
function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export class RealmRoom extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(
        `CREATE TABLE IF NOT EXISTS agents(
          token TEXT PRIMARY KEY, name TEXT, x INTEGER, y INTEGER, level INTEGER, xp INTEGER,
          hp INTEGER, max_hp INTEGER, gold INTEGER, task_coins INTEGER, skills TEXT, inventory TEXT,
          cooldown_expires INTEGER, rng_state INTEGER, reputation INTEGER, lifetime TEXT,
          created_at INTEGER, seen_at INTEGER)`,
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS tasks(
          id TEXT PRIMARY KEY, kind TEXT, prompt TEXT, context TEXT, choices TEXT, schema_str TEXT,
          redundancy INTEGER, reward TEXT, requester TEXT, status TEXT, result TEXT, leases TEXT,
          created_at INTEGER, expires_at INTEGER, completed_at INTEGER)`,
      );
      sql.exec(`CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, expires_at)`);
      sql.exec(
        `CREATE TABLE IF NOT EXISTS answers(
          task_id TEXT, token TEXT, agent TEXT, answer TEXT, at INTEGER,
          PRIMARY KEY(task_id, token))`,
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS feed(
          id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, text TEXT, at INTEGER)`,
      );
    });
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  // ── Agent (de)serialization ──────────────────────────────────────────────
  private rowToAgent(r: AgentRow): Agent {
    return {
      token: r.token,
      name: r.name,
      x: r.x,
      y: r.y,
      level: r.level,
      xp: r.xp,
      hp: r.hp,
      maxHp: r.max_hp,
      gold: r.gold,
      taskCoins: r.task_coins,
      skills: JSON.parse(r.skills),
      inventory: JSON.parse(r.inventory),
      cooldownExpires: r.cooldown_expires,
      rngState: r.rng_state,
      reputation: r.reputation,
      lifetime: JSON.parse(r.lifetime),
      createdAt: r.created_at,
      seenAt: r.seen_at,
    };
  }
  private loadAgent(token: string): Agent | null {
    const rows = this.sql.exec<AgentRow>("SELECT * FROM agents WHERE token = ?", token).toArray();
    return rows.length ? this.rowToAgent(rows[0]) : null;
  }
  private saveAgent(a: Agent): void {
    this.sql.exec(
      `INSERT INTO agents(token,name,x,y,level,xp,hp,max_hp,gold,task_coins,skills,inventory,
         cooldown_expires,rng_state,reputation,lifetime,created_at,seen_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(token) DO UPDATE SET
         name=excluded.name, x=excluded.x, y=excluded.y, level=excluded.level, xp=excluded.xp,
         hp=excluded.hp, max_hp=excluded.max_hp, gold=excluded.gold, task_coins=excluded.task_coins,
         skills=excluded.skills, inventory=excluded.inventory, cooldown_expires=excluded.cooldown_expires,
         rng_state=excluded.rng_state, reputation=excluded.reputation, lifetime=excluded.lifetime,
         seen_at=excluded.seen_at`,
      a.token,
      a.name,
      a.x,
      a.y,
      a.level,
      a.xp,
      a.hp,
      a.maxHp,
      a.gold,
      a.taskCoins,
      JSON.stringify(a.skills),
      JSON.stringify(a.inventory),
      a.cooldownExpires,
      a.rngState,
      a.reputation,
      JSON.stringify(a.lifetime),
      a.createdAt,
      a.seenAt,
    );
  }
  private freshAgent(name: string): Agent {
    const token = `agt_${randHex(18)}`;
    const skills: Agent["skills"] = {};
    for (const k of SKILLS) skills[k] = { level: 1, xp: 0 };
    const seed = (Math.floor(Math.random() * 0xffffffff) ^ Date.now()) >>> 0 || 1;
    const now = Date.now();
    return {
      token,
      name,
      x: START.x,
      y: START.y,
      level: 1,
      xp: 0,
      hp: BASE_HP,
      maxHp: BASE_HP,
      gold: 0,
      taskCoins: 0,
      skills,
      inventory: {},
      cooldownExpires: 0,
      rngState: seed,
      reputation: 0,
      lifetime: { kills: 0, gathers: 0, crafts: 0, answers: 0, deaths: 0 },
      createdAt: now,
      seenAt: now,
    };
  }

  // ── Progression helpers ───────────────────────────────────────────────────
  private addCharXp(a: Agent, amount: number): number {
    a.xp += amount;
    let leveled = 0;
    while (a.xp >= xpForLevel(a.level)) {
      a.xp -= xpForLevel(a.level);
      a.level += 1;
      leveled += 1;
    }
    if (leveled) {
      a.maxHp = BASE_HP + (a.level - 1) * HP_PER_LEVEL;
      a.hp = a.maxHp;
    }
    return leveled;
  }
  private addSkillXp(a: Agent, skill: string, amount: number): number {
    const s = a.skills[skill];
    if (!s) return 0;
    s.xp += amount;
    let leveled = 0;
    while (s.xp >= xpForLevel(s.level)) {
      s.xp -= xpForLevel(s.level);
      s.level += 1;
      leveled += 1;
    }
    return leveled;
  }

  private cooldownRemaining(a: Agent): number {
    return Math.max(0, (a.cooldownExpires - Date.now()) / 1000);
  }
  private applyCooldown(a: Agent, seconds: number) {
    const total = Math.min(COOLDOWN_MAX_S, Math.max(0, Math.round(seconds)));
    const now = Date.now();
    a.cooldownExpires = now + total * 1000;
    return {
      total_seconds: total,
      remaining_seconds: total,
      started_at: new Date(now).toISOString(),
      expiration: new Date(a.cooldownExpires).toISOString(),
    };
  }
  private publicAgent(a: Agent) {
    return {
      name: a.name,
      x: a.x,
      y: a.y,
      level: a.level,
      xp: a.xp,
      xpToLevel: xpForLevel(a.level),
      hp: Math.round(a.hp),
      maxHp: a.maxHp,
      gold: a.gold,
      taskCoins: a.taskCoins,
      reputation: a.reputation,
      skills: a.skills,
      inventory: a.inventory,
      cooldown: { remaining_seconds: Math.round(this.cooldownRemaining(a) * 10) / 10 },
      tile: contentAt(a.x, a.y),
      lifetime: a.lifetime,
    };
  }

  // ── Deterministic combat ──────────────────────────────────────────────────
  private resolveFight(a: Agent, monHp: number, monAtk: number): { won: boolean; rounds: number } {
    const rng = makeRng(a.rngState);
    let mhp = monHp;
    let rounds = 0;
    const power = 6 + (a.level - 1) * 2;
    for (let i = 0; i < 60 && mhp > 0 && a.hp > 0; i++) {
      mhp -= Math.max(1, Math.round(power * (0.85 + rng.next() * 0.45)));
      if (mhp <= 0) break;
      a.hp = Math.max(0, a.hp - Math.max(1, Math.round(monAtk * (0.8 + rng.next() * 0.5))));
      rounds++;
    }
    a.rngState = rng.state >>> 0;
    return { won: mhp <= 0 && a.hp > 0, rounds };
  }

  // ── Request dispatch (called by the Worker) ───────────────────────────────
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p === "/ws" && request.headers.get("Upgrade") === "websocket") {
      return this.handleWsUpgrade();
    }
    if (p === "/realm/snapshot") return J({ ok: true, ...this.realmSnapshot() });
    const token = request.headers.get("x-agent-token") || "";
    let body: Record<string, unknown> = {};
    if (request.method === "POST") {
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }

    try {
      if (p === "/register") return this.register(body);
      if (p === "/me") return this.me(token);
      if (p === "/action") return this.action(token, body);
      if (p === "/oracle/post") return this.oraclePost(body);
      if (p === "/oracle/get") return this.oracleGet(url.searchParams.get("id") || "");
      if (p === "/oracle/cancel") return this.oracleCancel(String(body.id || ""));
      if (p === "/oracle/open") return this.oracleOpen(token);
      if (p === "/oracle/claim") return this.oracleClaim(token, String(body.id || ""));
      if (p === "/oracle/submit") return this.oracleSubmit(token, body);
      if (p === "/leaderboard") return this.leaderboard();
      return J({ error: "not found" }, 404);
    } catch (err) {
      console.error("[realm] fault", p, err);
      return J({ error: "internal" }, 500);
    }
  }

  private requireAgent(token: string): Agent | Response {
    if (!token) return J({ error: "missing or invalid agent token" }, 401);
    const a = this.loadAgent(token);
    if (!a) return J({ error: "missing or invalid agent token" }, 401);
    a.seenAt = Date.now();
    return a;
  }

  // ── Agent realm ───────────────────────────────────────────────────────────
  private register(body: Record<string, unknown>): Response {
    const name = String(body.name || "").slice(0, 24);
    if (!NAME_RE.test(name)) return J({ error: "name must match [A-Za-z0-9_-]{2,24}" }, 400);
    const a = this.freshAgent(name);
    this.saveAgent(a);
    this.pushFeed("join", `${a.name} entered the abyss`);
    return J({ ok: true, token: a.token, character: this.publicAgent(a) });
  }
  private me(token: string): Response {
    const a = this.requireAgent(token);
    if (a instanceof Response) return a;
    this.saveAgent(a);
    return J({ ok: true, character: this.publicAgent(a) });
  }
  private action(token: string, body: Record<string, unknown>): Response {
    const a = this.requireAgent(token);
    if (a instanceof Response) return a;
    const kind = String(body.kind || "");
    const remaining = this.cooldownRemaining(a);
    if (remaining > 0) {
      return J(
        {
          error: "character in cooldown",
          cooldown: { remaining_seconds: Math.round(remaining * 10) / 10 },
        },
        429,
      );
    }
    const done = (extra: object, cooldown: object) => {
      this.saveAgent(a);
      return J({ ok: true, cooldown, character: this.publicAgent(a), ...extra });
    };

    switch (kind) {
      case "move": {
        const x = Math.trunc(Number(body.x));
        const y = Math.trunc(Number(body.y));
        if (!inBounds(x, y)) return J({ error: "destination out of bounds" }, 400);
        const dist = manhattan(a.x, a.y, x, y);
        if (dist === 0) return J({ error: "already on that tile" }, 400);
        a.x = x;
        a.y = y;
        return done(
          { moved: { x, y }, tile: contentAt(x, y) },
          this.applyCooldown(a, COOLDOWN.move + dist * COOLDOWN_PER_TILE),
        );
      }
      case "fight": {
        const c = contentAt(a.x, a.y);
        if (!c || c.type !== "monster") return J({ error: "no monster on this tile" }, 400);
        const mon = MONSTERS[c.code];
        if (!mon) return J({ error: "unknown monster" }, 500);
        const r = this.resolveFight(a, mon.hp, mon.attack);
        if (r.won) {
          a.lifetime.kills += 1;
          const levels = this.addCharXp(a, mon.xp);
          a.gold += mon.gold;
          a.inventory[mon.drop] = (a.inventory[mon.drop] || 0) + 1;
          return done(
            {
              fight: { result: "win", monster: mon.code, rounds: r.rounds },
              rewards: { xp: mon.xp, gold: mon.gold, drop: mon.drop, levels },
            },
            this.applyCooldown(a, COOLDOWN.fight),
          );
        }
        a.lifetime.deaths += 1;
        a.hp = 1;
        a.x = START.x;
        a.y = START.y;
        return done(
          { fight: { result: "loss", monster: mon.code, rounds: r.rounds }, respawned: true },
          this.applyCooldown(a, COOLDOWN.fight),
        );
      }
      case "gather": {
        const c = contentAt(a.x, a.y);
        if (!c || c.type !== "resource") return J({ error: "no resource on this tile" }, 400);
        const res = RESOURCES[c.code];
        if (!res) return J({ error: "unknown resource" }, 500);
        if ((a.skills[res.skill]?.level || 1) < res.level)
          return J({ error: `${res.skill} level ${res.level} required` }, 400);
        if (Object.keys(a.inventory).length >= INVENTORY_MAX && !a.inventory[res.drop])
          return J({ error: "inventory full" }, 400);
        a.lifetime.gathers += 1;
        a.inventory[res.drop] = (a.inventory[res.drop] || 0) + 1;
        const levels = this.addSkillXp(a, res.skill, res.xp);
        return done(
          {
            gather: { resource: res.code, drop: res.drop },
            rewards: { skill: res.skill, xp: res.xp, levels },
          },
          this.applyCooldown(a, COOLDOWN.gather),
        );
      }
      case "rest": {
        const before = Math.round(a.hp);
        a.hp = a.maxHp;
        return done({ rest: { healed: a.maxHp - before } }, this.applyCooldown(a, COOLDOWN.rest));
      }
      case "craft": {
        const code = String(body.code || "");
        const qty = clampInt(body.qty, 1, 100, 1);
        const recipe = RECIPES[code];
        if (!recipe) return J({ error: "unknown recipe" }, 400);
        const c = contentAt(a.x, a.y);
        if (!c || c.type !== "workshop" || c.code !== recipe.station)
          return J({ error: `must be on the ${recipe.station} workshop tile` }, 400);
        if ((a.skills[recipe.skill]?.level || 1) < recipe.level)
          return J({ error: `${recipe.skill} level ${recipe.level} required` }, 400);
        for (const [ing, need] of Object.entries(recipe.ingredients)) {
          if ((a.inventory[ing] || 0) < need * qty)
            return J({ error: `need ${need * qty}x ${ing}` }, 400);
        }
        for (const [ing, need] of Object.entries(recipe.ingredients)) {
          a.inventory[ing] -= need * qty;
          if (a.inventory[ing] <= 0) delete a.inventory[ing];
        }
        a.inventory[code] = (a.inventory[code] || 0) + qty;
        a.lifetime.crafts += qty;
        const levels = this.addSkillXp(a, recipe.skill, recipe.xp * qty);
        return done(
          { craft: { code, qty }, rewards: { skill: recipe.skill, xp: recipe.xp * qty, levels } },
          this.applyCooldown(a, COOLDOWN.craft),
        );
      }
      default:
        return J({ error: "unknown action; valid: move|fight|gather|rest|craft" }, 400);
    }
  }

  // ── Oracle Bazaar ─────────────────────────────────────────────────────────
  private answersCount(taskId: string): number {
    const r = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM answers WHERE task_id = ?", taskId)
      .toArray();
    return r[0]?.n ?? 0;
  }
  private loadTask(id: string): TaskRow | null {
    const r = this.sql.exec<TaskRow>("SELECT * FROM tasks WHERE id = ?", id).toArray();
    return r.length ? r[0] : null;
  }
  private finalize(t: TaskRow): void {
    const ans = this.sql.exec<AnswerRow>("SELECT * FROM answers WHERE task_id = ?", t.id).toArray();
    const tally: Record<string, number> = {};
    for (const a of ans) {
      const n = normalize(a.answer);
      tally[n] = (tally[n] || 0) + 1;
    }
    let topKey: string | null = null;
    let topN = 0;
    for (const [k, v] of Object.entries(tally)) {
      if (v > topN) {
        topN = v;
        topKey = k;
      }
    }
    let result: unknown;
    const choices: string[] | null = t.choices ? JSON.parse(t.choices) : null;
    if (choices && choices.length) {
      const choice = choices.find((c) => normalize(c) === topKey) ?? topKey;
      result = {
        answer: choice,
        votes: topN,
        total: ans.length,
        confidence: ans.length ? topN / ans.length : 0,
        distribution: tally,
      };
    } else {
      const orig =
        ans.find((a) => normalize(a.answer) === topKey)?.answer ?? ans[0]?.answer ?? null;
      result = {
        answer: orig,
        agreement: ans.length ? topN / ans.length : 0,
        total: ans.length,
        answers: ans.map((a) => a.answer),
      };
    }
    this.sql.exec(
      "UPDATE tasks SET status='complete', result=?, completed_at=? WHERE id=?",
      JSON.stringify(result),
      Date.now(),
      t.id,
    );
  }
  /** Expire a past-TTL open task (finalize if it has answers, else mark expired). */
  private expireIfDue(t: TaskRow): boolean {
    if (t.status === "open" && Date.now() > t.expires_at) {
      if (this.answersCount(t.id) > 0) this.finalize(t);
      else this.sql.exec("UPDATE tasks SET status='expired' WHERE id=?", t.id);
      return true;
    }
    return false;
  }
  private requesterView(t: TaskRow) {
    const ans = this.sql
      .exec<AnswerRow>("SELECT agent, answer, at FROM answers WHERE task_id = ?", t.id)
      .toArray();
    return {
      id: t.id,
      kind: t.kind,
      prompt: t.prompt,
      choices: t.choices ? JSON.parse(t.choices) : null,
      schema: t.schema_str,
      redundancy: t.redundancy,
      reward: JSON.parse(t.reward),
      status: t.status,
      answersCollected: ans.length,
      answers: ans.map((a) => ({ agent: a.agent, answer: a.answer, at: a.at })),
      result: t.result ? JSON.parse(t.result) : null,
      requester: t.requester,
      createdAt: t.created_at,
      expiresAt: t.expires_at,
      completedAt: t.completed_at,
    };
  }

  private oraclePost(body: Record<string, unknown>): Response {
    const kind = (ORACLE.KINDS as readonly string[]).includes(String(body.kind))
      ? String(body.kind)
      : "inference";
    const prompt = String(body.prompt || "").slice(0, ORACLE.PROMPT_MAX);
    if (!prompt.trim()) return J({ error: "prompt required" }, 400);
    const context = body.context != null ? String(body.context).slice(0, ORACLE.CONTEXT_MAX) : null;
    let choices: string[] | null = null;
    if (Array.isArray(body.choices) && body.choices.length) {
      choices = (body.choices as unknown[])
        .slice(0, ORACLE.CHOICES_MAX)
        .map((c) => String(c).slice(0, 200));
    }
    const schema = body.schema != null ? String(body.schema).slice(0, 2000) : null;
    const redundancy = clampInt(
      body.redundancy,
      1,
      ORACLE.REDUNDANCY_MAX,
      ORACLE.REDUNDANCY_DEFAULT,
    );
    const ttlMs = clampInt(body.ttlMs, 10_000, ORACLE.TTL_MS_MAX, ORACLE.TTL_MS_DEFAULT);
    const r = (body.reward && typeof body.reward === "object" ? body.reward : {}) as Record<
      string,
      unknown
    >;
    const reward = {
      gold: clampInt(r.gold, 0, 5000, ORACLE.REWARD_DEFAULT.gold),
      coins: clampInt(r.coins, 0, 100, ORACLE.REWARD_DEFAULT.coins),
      xp: clampInt(r.xp, 0, 5000, ORACLE.REWARD_DEFAULT.xp),
    };
    const requester = String(body.requester || "claude-code").slice(0, 48);

    const open =
      this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status='open'")
        .toArray()[0]?.n ?? 0;
    if (open >= ORACLE.OPEN_MAX) return J({ error: "oracle board full — retry shortly" }, 503);

    const id = `hit_${randHex(12)}`;
    const now = Date.now();
    const expiresAt = now + ttlMs;
    this.sql.exec(
      `INSERT INTO tasks(id,kind,prompt,context,choices,schema_str,redundancy,reward,requester,status,result,leases,created_at,expires_at,completed_at)
       VALUES(?,?,?,?,?,?,?,?,?,'open',NULL,'{}',?,?,NULL)`,
      id,
      kind,
      prompt,
      context,
      choices ? JSON.stringify(choices) : null,
      schema,
      redundancy,
      JSON.stringify(reward),
      requester,
      now,
      expiresAt,
    );
    this.ensureAlarm(expiresAt);
    return J({ ok: true, id, status: "open", expiresAt });
  }
  private oracleGet(id: string): Response {
    const t = this.loadTask(id);
    if (!t) return J({ error: "no such task" }, 404);
    if (this.expireIfDue(t)) {
      const fresh = this.loadTask(id);
      if (fresh) return J({ ok: true, task: this.requesterView(fresh) });
    }
    return J({ ok: true, task: this.requesterView(t) });
  }
  private oracleCancel(id: string): Response {
    const t = this.loadTask(id);
    if (!t) return J({ error: "no such task" }, 404);
    if (t.status === "open") this.sql.exec("UPDATE tasks SET status='cancelled' WHERE id=?", id);
    const fresh = this.loadTask(id);
    return J({ ok: true, status: fresh?.status ?? "cancelled" });
  }
  private oracleOpen(token: string): Response {
    const a = this.requireAgent(token);
    if (a instanceof Response) return a;
    const onOracleTile = a.x === ORACLE_TILE.x && a.y === ORACLE_TILE.y;
    const rows = this.sql
      .exec<TaskRow>("SELECT * FROM tasks WHERE status='open' ORDER BY created_at ASC LIMIT 200")
      .toArray();
    const out: unknown[] = [];
    for (const t of rows) {
      if (this.expireIfDue(t)) continue;
      const answered =
        this.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM answers WHERE task_id=? AND token=?",
            t.id,
            token,
          )
          .toArray()[0]?.n ?? 0;
      if (answered > 0) continue;
      if (this.answersCount(t.id) >= t.redundancy) continue;
      out.push({
        id: t.id,
        kind: t.kind,
        prompt: t.prompt,
        context: t.context,
        choices: t.choices ? JSON.parse(t.choices) : null,
        schema: t.schema_str,
        reward: JSON.parse(t.reward),
        redundancy: t.redundancy,
        answersCollected: this.answersCount(t.id),
        expiresAt: t.expires_at,
      });
      if (out.length >= 50) break;
    }
    return J({ ok: true, onOracleTile, count: out.length, tasks: out });
  }
  private oracleClaim(token: string, id: string): Response {
    const a = this.requireAgent(token);
    if (a instanceof Response) return a;
    if (!(a.x === ORACLE_TILE.x && a.y === ORACLE_TILE.y))
      return J({ error: "must be on the oracle tile to claim — move to it first" }, 400);
    const remaining = this.cooldownRemaining(a);
    if (remaining > 0)
      return J(
        {
          error: "character in cooldown",
          cooldown: { remaining_seconds: Math.round(remaining * 10) / 10 },
        },
        429,
      );
    const t = this.loadTask(id);
    if (!t || this.expireIfDue(t) || t.status !== "open") return J({ error: "task not open" }, 409);
    const already =
      this.sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM answers WHERE task_id=? AND token=?",
          id,
          token,
        )
        .toArray()[0]?.n ?? 0;
    if (already > 0) return J({ error: "you already answered this task" }, 409);
    const leases = JSON.parse(t.leases || "{}");
    leases[token] = Date.now() + ORACLE.LEASE_MS;
    this.sql.exec("UPDATE tasks SET leases=? WHERE id=?", JSON.stringify(leases), id);
    const cooldown = this.applyCooldown(a, COOLDOWN.oracle);
    this.saveAgent(a);
    return J({
      ok: true,
      task: {
        id: t.id,
        kind: t.kind,
        prompt: t.prompt,
        context: t.context,
        choices: t.choices ? JSON.parse(t.choices) : null,
        schema: t.schema_str,
        reward: JSON.parse(t.reward),
        redundancy: t.redundancy,
      },
      leaseMs: ORACLE.LEASE_MS,
      cooldown,
    });
  }
  private oracleSubmit(token: string, body: Record<string, unknown>): Response {
    const a = this.requireAgent(token);
    if (a instanceof Response) return a;
    if (!(a.x === ORACLE_TILE.x && a.y === ORACLE_TILE.y))
      return J({ error: "must be on the oracle tile to submit" }, 400);
    const remaining = this.cooldownRemaining(a);
    if (remaining > 0)
      return J(
        {
          error: "character in cooldown",
          cooldown: { remaining_seconds: Math.round(remaining * 10) / 10 },
        },
        429,
      );
    const id = String(body.id || "");
    const t = this.loadTask(id);
    if (!t || this.expireIfDue(t) || t.status !== "open") return J({ error: "task not open" }, 409);
    if (this.answersCount(id) >= t.redundancy) return J({ error: "answer quota already met" }, 409);
    const answer = String(body.answer ?? "").slice(0, ORACLE.ANSWER_MAX);
    if (!answer.trim()) return J({ error: "answer required" }, 400);
    const choices: string[] | null = t.choices ? JSON.parse(t.choices) : null;
    if (choices && choices.length && !choices.some((c) => normalize(c) === normalize(answer))) {
      return J({ error: "answer must be one of the choices", choices }, 400);
    }
    // Composite PK gives dedup; OR IGNORE returns no error but skips a dup.
    const before = this.answersCount(id);
    this.sql.exec(
      "INSERT OR IGNORE INTO answers(task_id,token,agent,answer,at) VALUES(?,?,?,?,?)",
      id,
      token,
      a.name,
      answer,
      Date.now(),
    );
    if (this.answersCount(id) === before)
      return J({ error: "you already answered this task" }, 409);

    const reward = JSON.parse(t.reward) as { gold: number; coins: number; xp: number };
    a.gold += reward.gold;
    a.taskCoins += reward.coins;
    const charLevels = this.addCharXp(a, reward.xp);
    const skillLevels = this.addSkillXp(a, "oracle", reward.xp);
    a.reputation += 1;
    a.lifetime.answers += 1;
    const cooldown = this.applyCooldown(a, COOLDOWN.oracle);
    this.saveAgent(a);

    let finalized = false;
    if (this.answersCount(id) >= t.redundancy) {
      const fresh = this.loadTask(id);
      if (fresh) this.finalize(fresh);
      finalized = true;
    }
    const after = this.loadTask(id);
    this.pushFeed(
      "oracle",
      `${a.name} answered a HIT (+${reward.gold}g)${finalized ? " — resolved" : ""}`,
    );
    return J({
      ok: true,
      accepted: true,
      reward,
      rewardInfo: { charLevels, skillLevels, gold: a.gold, taskCoins: a.taskCoins },
      finalized,
      result: finalized && after?.result ? JSON.parse(after.result) : null,
      cooldown,
      character: this.publicAgent(a),
    });
  }

  private leaderboard(): Response {
    const rows = this.sql
      .exec<AgentRow>(
        "SELECT name, level, gold, task_coins, reputation, lifetime FROM agents ORDER BY level DESC, gold DESC LIMIT 25",
      )
      .toArray();
    const leaderboard = rows.map((r) => {
      const lt = JSON.parse(r.lifetime);
      return {
        name: r.name,
        level: r.level,
        gold: r.gold,
        taskCoins: r.task_coins,
        reputation: r.reputation,
        answers: lt.answers ?? 0,
        kills: lt.kills ?? 0,
      };
    });
    return J({ ok: true, leaderboard });
  }

  // ── Realtime (DO WebSocket hibernation): live feed + leaderboard ──────────
  private pushFeed(kind: string, text: string): void {
    this.sql.exec(
      "INSERT INTO feed(kind,text,at) VALUES(?,?,?)",
      kind,
      text.slice(0, 160),
      Date.now(),
    );
    this.sql.exec(
      "DELETE FROM feed WHERE id NOT IN (SELECT id FROM feed ORDER BY id DESC LIMIT 60)",
    );
    this.broadcastRealm();
  }
  private realmSnapshot() {
    const feed = this.sql
      .exec<{ kind: string; text: string; at: number }>(
        "SELECT kind,text,at FROM feed ORDER BY id DESC LIMIT 30",
      )
      .toArray();
    const leaderboard = this.sql
      .exec<AgentRow>(
        "SELECT name,level,gold,task_coins,reputation FROM agents ORDER BY level DESC, gold DESC LIMIT 15",
      )
      .toArray()
      .map((r) => ({
        name: r.name,
        level: r.level,
        gold: r.gold,
        taskCoins: r.task_coins,
        reputation: r.reputation,
      }));
    const openHits =
      this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status='open'")
        .toArray()[0]?.n ?? 0;
    const agents =
      this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM agents").toArray()[0]?.n ?? 0;
    return { feed, leaderboard, openHits, agents };
  }
  private broadcastRealm(): void {
    const msg = JSON.stringify({ type: "snapshot", ...this.realmSnapshot() });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        /* socket gone */
      }
    }
  }
  private handleWsUpgrade(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "snapshot", ...this.realmSnapshot() }));
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const m = JSON.parse(
        typeof message === "string" ? message : new TextDecoder().decode(message),
      );
      if (m?.type === "ping") ws.send(JSON.stringify({ type: "pong", at: Date.now() }));
    } catch {
      /* ignore non-JSON */
    }
  }
  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  // ── Sweep (alarm): expire due HITs, archive finalized to R2, prune ─────────
  private ensureAlarm(at: number): void {
    this.ctx.storage.getAlarm().then((cur) => {
      if (cur == null || at < cur) this.ctx.storage.setAlarm(at + 1000);
    });
  }
  async alarm(): Promise<void> {
    const due = this.sql
      .exec<TaskRow>("SELECT * FROM tasks WHERE status='open' AND expires_at < ?", Date.now())
      .toArray();
    for (const t of due) this.expireIfDue(t);

    // Archive finalized/expired/cancelled HITs older than 10 min to R2, then drop
    // them (with their answers) so SQLite holds only the live board.
    const cutoff = Date.now() - 10 * 60_000;
    const old = this.sql
      .exec<TaskRow>(
        "SELECT * FROM tasks WHERE status!='open' AND COALESCE(completed_at, expires_at) < ? LIMIT 200",
        cutoff,
      )
      .toArray();
    for (const t of old) {
      try {
        const view = this.requesterView(t);
        await this.env.ARCHIVE.put(`hits/${t.id}.json`, JSON.stringify(view), {
          httpMetadata: { contentType: "application/json" },
        });
      } catch (e) {
        console.error("[realm] archive failed", t.id, e);
        continue; // leave it for next sweep rather than lose it
      }
      this.sql.exec("DELETE FROM answers WHERE task_id=?", t.id);
      this.sql.exec("DELETE FROM tasks WHERE id=?", t.id);
    }

    // Re-arm if any open HITs remain.
    const next = this.sql
      .exec<{ e: number }>("SELECT MIN(expires_at) AS e FROM tasks WHERE status='open'")
      .toArray()[0]?.e;
    if (next) this.ctx.storage.setAlarm(next + 1000);
  }
}
