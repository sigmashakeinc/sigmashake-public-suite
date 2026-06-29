#!/usr/bin/env bun
/**
 * sigmashake-vcs — stdio MCP server.
 *
 * A Model Context Protocol server an AI agent connects to as a first-class
 * tool source: it exposes the deployed Vibe Coder Sim Worker's operations as
 * typed MCP tools instead of raw HTTP. Transport is newline-delimited
 * JSON-RPC 2.0 over stdio — the house pattern for a headless, zero-dependency
 * MCP surface.
 *
 * Run it directly as an MCP server:
 *   bun tools/vcs-mcp.ts
 *
 * Register with an agent (Claude Code):
 *   claude mcp add sigmashake-vcs -- bun /abs/path/tools/vcs-mcp.ts
 *
 * Config (env):
 *   VCS_BASE_URL   Worker base URL (default https://vcs.sigmashake.com)
 *   VCS_API_KEY    Public API bearer key with "read" scope (required for catalog/character)
 *
 * stdout carries the JSON-RPC protocol stream — only ever protocol frames.
 * All diagnostics go to stderr.
 */

const SERVER_NAME = "sigmashake-vcs";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2024-11-05";
const BASE_URL = (process.env.VCS_BASE_URL ?? "https://vcs.sigmashake.com").replace(/\/+$/, "");

// ── JSON-RPC 2.0 / MCP types ─────────────────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: McpTool[] = [
  {
    name: "vcs_health",
    description:
      "Liveness probe for the Vibe Coder Sim Worker — GET /healthz. Returns the HTTP status and body. Call this to confirm the vcs service is reachable.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vcs_bridge_status",
    description:
      "Check the streamer bridge connection status — GET /api/v1/vcs/bridge/status. Returns whether the streamer-side bridge WebSocket is connected.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vcs_catalog",
    description:
      "Fetch the full Vibe Coder Sim item catalog — GET /api/public/v1/catalog. Requires VCS_API_KEY in the environment.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vcs_character",
    description:
      "Fetch the VCS character loadout for a named Twitch login — GET /api/public/v1/character/:login. Requires VCS_API_KEY in the environment.",
    inputSchema: {
      type: "object",
      properties: {
        login: {
          type: "string",
          description: "Twitch login name of the viewer (required).",
        },
      },
      required: ["login"],
    },
  },
];

// ── Tool result helpers ──────────────────────────────────────────────────────

function ok(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function argString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function apiHeaders(): Record<string, string> | null {
  const key = process.env.VCS_API_KEY;
  if (!key) return null;
  return {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  };
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── Tool dispatch ────────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  switch (name) {
    case "vcs_health": {
      const res = await fetch(`${BASE_URL}/healthz`);
      const body = await parseBody(res);
      return ok({ ok: res.ok, status: res.status, body });
    }

    case "vcs_bridge_status": {
      const res = await fetch(`${BASE_URL}/api/v1/vcs/bridge/status`);
      const body = await parseBody(res);
      return ok({ ok: res.ok, status: res.status, body });
    }

    case "vcs_catalog": {
      const headers = apiHeaders();
      if (!headers) return fail("VCS_API_KEY is not set in the environment");
      const res = await fetch(`${BASE_URL}/api/public/v1/catalog`, { headers });
      const body = await parseBody(res);
      return ok({ ok: res.ok, status: res.status, body });
    }

    case "vcs_character": {
      const headers = apiHeaders();
      if (!headers) return fail("VCS_API_KEY is not set in the environment");
      const login = argString(args, "login");
      if (!login) return fail("Missing required argument: login");
      const res = await fetch(`${BASE_URL}/api/public/v1/character/${encodeURIComponent(login)}`, {
        headers,
      });
      const body = await parseBody(res);
      return ok({ login, ok: res.ok, status: res.status, body });
    }

    default:
      return fail(`Unknown tool: ${name}`);
  }
}

// ── JSON-RPC method dispatch ─────────────────────────────────────────────────

async function dispatch(msg: JsonRpcMessage): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;

  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      };

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notification — no response

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call": {
      const params = msg.params as
        | { name?: string; arguments?: Record<string, unknown> }
        | undefined;
      if (!params?.name) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Missing tool name" },
        };
      }
      try {
        const result = await callTool(params.name, params.arguments ?? {});
        return { jsonrpc: "2.0", id, result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: "2.0",
          id,
          result: fail(`Tool execution failed: ${message}`),
        };
      }
    }

    default:
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      };
  }
}

// ── stdio transport — newline-delimited JSON-RPC ─────────────────────────────

function send(res: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(res)}\n`);
}

async function* readLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let idx = buf.indexOf("\n");
    while (idx !== -1) {
      yield buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      idx = buf.indexOf("\n");
    }
  }
  if (buf.trim()) yield buf;
}

async function main(): Promise<void> {
  for await (const line of readLines()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      continue;
    }
    const res = await dispatch(msg);
    if (res) send(res);
  }
}

main().catch((err) => {
  process.stderr.write(
    `${SERVER_NAME} mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
