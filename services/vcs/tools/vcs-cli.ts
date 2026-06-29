#!/usr/bin/env bun
/**
 * sigmashake-vcs — operator / agent CLI.
 *
 * A headless control surface over the Vibe Coder Sim Worker
 * (vcs.sigmashake.com). Lets an AI agent inspect bridge status, query the
 * item catalog, and fetch character data without the web UI or hand-rolled
 * curl. Zero dependencies — argv parsing, fetch, and process only.
 *
 * Config (env):
 *   VCS_BASE_URL   Worker base URL (default https://vcs.sigmashake.com)
 *   VCS_API_KEY    Public API bearer key with "read" scope (for catalog/character)
 *
 * Usage:
 *   sigmashake-vcs health
 *   sigmashake-vcs bridge-status
 *   sigmashake-vcs catalog
 *   sigmashake-vcs character <twitch_login>
 *   sigmashake-vcs --help
 *
 * Exit codes: 0 ok, 1 runtime/HTTP error, 2 usage error.
 */

const BASE_URL = (process.env.VCS_BASE_URL ?? "https://vcs.sigmashake.com").replace(/\/+$/, "");

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
      const eqIdx = key.indexOf("=");
      if (eqIdx !== -1) {
        flags[key.slice(0, eqIdx)] = key.slice(eqIdx + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          flags[key] = true;
        } else {
          flags[key] = next;
          i++;
        }
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

function apiHeaders(): Record<string, string> {
  const key = process.env.VCS_API_KEY;
  if (!key) fail("VCS_API_KEY is not set", 2);
  return {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  };
}

const HELP = `sigmashake-vcs — Vibe Coder Sim operator CLI

Usage:
  sigmashake-vcs health
  sigmashake-vcs bridge-status
  sigmashake-vcs catalog
  sigmashake-vcs character <twitch_login>
  sigmashake-vcs --help

Env:
  VCS_BASE_URL   Worker base URL (default https://vcs.sigmashake.com)
  VCS_API_KEY    Public API bearer key with "read" scope`;

async function cmdHealth(): Promise<void> {
  const res = await fetch(`${BASE_URL}/healthz`);
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = body;
  }
  out({ command: "health", ok: res.ok, status: res.status, body: parsed });
  if (!res.ok) process.exit(1);
}

async function cmdBridgeStatus(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/vcs/bridge/status`);
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = body;
  }
  out({ command: "bridge-status", ok: res.ok, status: res.status, body: parsed });
  if (!res.ok) process.exit(1);
}

async function cmdCatalog(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/public/v1/catalog`, {
    headers: apiHeaders(),
  });
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = body;
  }
  out({ command: "catalog", ok: res.ok, status: res.status, body: parsed });
  if (!res.ok) process.exit(1);
}

async function cmdCharacter(flags: Flags): Promise<void> {
  const login = flags._[1];
  if (!login) fail("`character` needs a twitch_login argument", 2);

  const res = await fetch(`${BASE_URL}/api/public/v1/character/${encodeURIComponent(login)}`, {
    headers: apiHeaders(),
  });
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = body;
  }
  out({ command: "character", login, ok: res.ok, status: res.status, body: parsed });
  if (!res.ok) process.exit(1);
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const cmd = flags._[0];

  if (flags.help || cmd === "help") {
    console.log(HELP);
    process.exit(0);
  }
  if (!cmd) {
    console.error(HELP);
    process.exit(2);
  }

  switch (cmd) {
    case "health":
      await cmdHealth();
      break;
    case "bridge-status":
      await cmdBridgeStatus();
      break;
    case "catalog":
      await cmdCatalog();
      break;
    case "character":
      await cmdCharacter(flags);
      break;
    default:
      fail(`unknown command: ${cmd}`, 2);
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
