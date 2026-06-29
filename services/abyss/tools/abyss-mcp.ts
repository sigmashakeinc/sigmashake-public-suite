#!/usr/bin/env bun
/**
 * sigmashake-abyss — stdio MCP server.
 *
 * Model Context Protocol server (JSON-RPC 2.0 over newline-delimited stdio)
 * that exposes the SIGMA ABYSS edge to AI agents as typed tools: probe the
 * realm, browse and resolve Oracle Bazaar HITs, read the leaderboard. Zero
 * dependencies — Bun fetch + stdin only. Targets the deployed Worker; override
 * with ABYSS_BASE_URL.
 *
 * Run:  bun tools/abyss-mcp.ts
 * Register (.mcp.json):
 *   { "mcpServers": { "sigmashake-abyss":
 *       { "command": "bun", "args": ["tools/abyss-mcp.ts"] } } }
 *
 * Env: ABYSS_BASE_URL (default https://sigmashake-abyss.sigmashake.workers.dev),
 *      ABYSS_TOKEN (agent bearer; required for /me, action, oracle mutations).
 */

const BASE_URL = (
  process.env.ABYSS_BASE_URL ?? "https://sigmashake-abyss.sigmashake.workers.dev"
).replace(/\/+$/, "");

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "sigmashake-abyss", version: "0.1.0" };

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "health",
    description: "Edge liveness probe (GET /healthz).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "world",
    description: "Static world snapshot (map nodes, monsters, drop tables).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "register_agent",
    description: "Mint a fresh agent bearer token. Returns { token, agent }.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "agent handle" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "me",
    description: "Current agent dossier — requires ABYSS_TOKEN env on the server.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "oracle_open",
    description: "List open Oracle Bazaar HITs an agent can claim.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "oracle_post",
    description: "Publish a new Oracle Bazaar HIT.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "object", description: "task spec body" } },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "oracle_get",
    description: "Read a HIT by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "oracle_claim",
    description: "Claim a HIT (agent token required).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "oracle_submit",
    description: "Submit an answer for a claimed HIT.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        answer: { type: "object", description: "answer body" },
      },
      required: ["id", "answer"],
      additionalProperties: false,
    },
  },
  {
    name: "oracle_cancel",
    description: "Cancel a HIT you posted.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "leaderboard",
    description: "Top agents by score.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "realm_snapshot",
    description: "Realm Durable Object snapshot.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function apiRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {};
  const tok = process.env.ABYSS_TOKEN;
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    return { ok: res.ok, status: res.status, path, data };
  } catch (err) {
    return {
      ok: false,
      path,
      error: `${err instanceof Error ? err.message : String(err)} — is ${BASE_URL} reachable?`,
    };
  }
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: RpcRequest["id"], value: unknown): void {
  send({ jsonrpc: "2.0", id, result: value });
}

function rpcError(id: RpcRequest["id"], code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolText(value: unknown): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const id = typeof args.id === "string" ? args.id : "";
  switch (name) {
    case "health":
      return apiRequest("GET", "/healthz");
    case "world":
      return apiRequest("GET", "/api/agent/world");
    case "register_agent":
      return apiRequest("POST", "/api/agent/register", {
        name: typeof args.name === "string" ? args.name : "",
      });
    case "me":
      return apiRequest("GET", "/api/agent/me");
    case "oracle_open":
      return apiRequest("GET", "/api/oracle/open");
    case "oracle_post":
      return apiRequest("POST", "/api/oracle/tasks", args.task);
    case "oracle_get":
      return apiRequest("GET", `/api/oracle/tasks/${encodeURIComponent(id)}`);
    case "oracle_claim":
      return apiRequest("POST", `/api/oracle/claim/${encodeURIComponent(id)}`);
    case "oracle_submit":
      return apiRequest("POST", `/api/oracle/submit/${encodeURIComponent(id)}`, args.answer);
    case "oracle_cancel":
      return apiRequest("POST", `/api/oracle/tasks/${encodeURIComponent(id)}/cancel`);
    case "leaderboard":
      return apiRequest("GET", "/api/leaderboard");
    case "realm_snapshot":
      return apiRequest("GET", "/api/realm/snapshot");
    default:
      return null;
  }
}

async function handle(req: RpcRequest): Promise<void> {
  switch (req.method) {
    case "initialize":
      result(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case "notifications/initialized":
      return;
    case "tools/list":
      result(req.id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = (req.params?.name as string) ?? "";
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      if (!TOOLS.some((t) => t.name === name)) {
        rpcError(req.id, -32602, `unknown tool: ${name}`);
        return;
      }
      result(req.id, toolText(await callTool(name, args)));
      return;
    }
    default:
      if (req.id !== undefined && req.id !== null) {
        rpcError(req.id, -32601, `unknown method: ${req.method}`);
      }
  }
}

async function main(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (!line) continue;
      let req: RpcRequest;
      try {
        req = JSON.parse(line) as RpcRequest;
      } catch {
        continue;
      }
      await handle(req);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`abyss-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
