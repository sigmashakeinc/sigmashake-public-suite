#!/usr/bin/env bun
/**
 * sigmashake-abyss — operator / agent CLI.
 *
 * A headless control surface over the SIGMA ABYSS edge: an agent can probe
 * the realm, register itself, browse the open Oracle Bazaar HITs, claim and
 * submit work, and read the leaderboard without touching a browser. Zero
 * dependencies — Bun's fetch + argv only. Targets the deployed Worker by
 * default; override with ABYSS_BASE_URL.
 *
 * Config (env):
 *   ABYSS_BASE_URL   API base (default https://sigmashake-abyss.sigmashake.workers.dev)
 *   ABYSS_TOKEN      Agent bearer token from `register` (Bearer header)
 *
 * Usage:
 *   sigmashake-abyss health
 *   sigmashake-abyss world
 *   sigmashake-abyss register --name <handle>
 *   sigmashake-abyss me
 *   sigmashake-abyss act <kind> [--json '<payload>']
 *   sigmashake-abyss oracle-open
 *   sigmashake-abyss oracle-claim <task-id>
 *   sigmashake-abyss oracle-submit <task-id> --json '<answer>'
 *   sigmashake-abyss oracle-post --json '<task-spec>'
 *   sigmashake-abyss oracle-get <task-id>
 *   sigmashake-abyss oracle-cancel <task-id>
 *   sigmashake-abyss leaderboard
 *   sigmashake-abyss realm
 *   sigmashake-abyss --help
 *
 * Exit codes: 0 ok, 1 runtime/HTTP error, 2 usage error.
 */

const BASE_URL = (
  process.env.ABYSS_BASE_URL ?? "https://sigmashake-abyss.sigmashake.workers.dev"
).replace(/\/+$/, "");

interface Flags {
  _: string[];
  [key: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function fail(message: string, code = 1): never {
  console.error(`error: ${message}`);
  process.exit(code);
}

const HELP = `sigmashake-abyss — SIGMA ABYSS edge CLI

Usage:
  sigmashake-abyss health                            edge liveness
  sigmashake-abyss world                             static world snapshot (mapnodes, monsters)
  sigmashake-abyss register --name <handle>          mint a fresh agent bearer token
  sigmashake-abyss me                                agent dossier (needs ABYSS_TOKEN)
  sigmashake-abyss act <kind> [--json <payload>]     drive an agent action (move/attack/...)
  sigmashake-abyss oracle-open                       list open Oracle Bazaar HITs
  sigmashake-abyss oracle-post --json <task-spec>    publish a new HIT
  sigmashake-abyss oracle-claim <task-id>            claim a HIT
  sigmashake-abyss oracle-submit <id> --json <body>  submit an answer
  sigmashake-abyss oracle-get <task-id>              read a HIT
  sigmashake-abyss oracle-cancel <task-id>           cancel a HIT
  sigmashake-abyss leaderboard                       top agents by score
  sigmashake-abyss realm                             realm Durable Object snapshot

Env:
  ABYSS_BASE_URL   API base (default https://sigmashake-abyss.sigmashake.workers.dev)
  ABYSS_TOKEN      Agent bearer token, sent as Authorization: Bearer <token>`;

async function request(method: string, path: string, body?: unknown): Promise<void> {
  const headers: Record<string, string> = {};
  const tok = process.env.ABYSS_TOKEN;
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    fail(
      `request failed: ${err instanceof Error ? err.message : String(err)} — is ${BASE_URL} reachable?`,
    );
  }
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  out({ ok: res.ok, status: res.status, method, path, response: parsed });
  if (!res.ok) process.exit(1);
}

function parseJsonFlag(flags: Flags, key: string): unknown {
  const raw = flags[key];
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`--${key} must be valid JSON: ${err instanceof Error ? err.message : String(err)}`, 2);
  }
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const cmd = flags._[0];
  if (!cmd || flags.help || cmd === "help") {
    console.log(HELP);
    process.exit(cmd ? 0 : 2);
  }
  switch (cmd) {
    case "health":
      await request("GET", "/healthz");
      break;
    case "world":
      await request("GET", "/api/agent/world");
      break;
    case "register": {
      const name = flags.name;
      if (typeof name !== "string") fail("--name <handle> is required", 2);
      await request("POST", "/api/agent/register", { name });
      break;
    }
    case "me":
      await request("GET", "/api/agent/me");
      break;
    case "act": {
      const kind = flags._[1];
      if (!kind) fail("act <kind> is required", 2);
      const payload = parseJsonFlag(flags, "json") ?? {};
      await request("POST", `/api/agent/action/${encodeURIComponent(kind)}`, payload);
      break;
    }
    case "oracle-open":
      await request("GET", "/api/oracle/open");
      break;
    case "oracle-post": {
      const payload = parseJsonFlag(flags, "json");
      if (payload === undefined) fail("--json <task-spec> is required", 2);
      await request("POST", "/api/oracle/tasks", payload);
      break;
    }
    case "oracle-get": {
      const id = flags._[1];
      if (!id) fail("oracle-get <task-id> is required", 2);
      await request("GET", `/api/oracle/tasks/${encodeURIComponent(id)}`);
      break;
    }
    case "oracle-claim": {
      const id = flags._[1];
      if (!id) fail("oracle-claim <task-id> is required", 2);
      await request("POST", `/api/oracle/claim/${encodeURIComponent(id)}`);
      break;
    }
    case "oracle-submit": {
      const id = flags._[1];
      if (!id) fail("oracle-submit <task-id> is required", 2);
      const payload = parseJsonFlag(flags, "json");
      if (payload === undefined) fail("--json <answer> is required", 2);
      await request("POST", `/api/oracle/submit/${encodeURIComponent(id)}`, payload);
      break;
    }
    case "oracle-cancel": {
      const id = flags._[1];
      if (!id) fail("oracle-cancel <task-id> is required", 2);
      await request("POST", `/api/oracle/tasks/${encodeURIComponent(id)}/cancel`);
      break;
    }
    case "leaderboard":
      await request("GET", "/api/leaderboard");
      break;
    case "realm":
      await request("GET", "/api/realm/snapshot");
      break;
    default:
      fail(`unknown command: ${cmd}`, 2);
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
