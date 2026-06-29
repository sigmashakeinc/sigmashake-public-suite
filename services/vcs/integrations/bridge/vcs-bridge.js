#!/usr/bin/env bun

const BRAINS_PATH = "/api/v1/vcs/brains/tick";

const MMO_PATHS = new Set([
  "/api/v1/vcs/combat-gear",
  "/api/v1/vcs/combat-loadout",
  "/api/v1/vcs/combat-equip",
  "/api/v1/vcs/combat-sigma",
  "/api/v1/vcs/combat-passive-tree",
  "/api/v1/vcs/combat-passives",
  "/api/v1/vcs/combat-reserve",
  "/api/v1/vcs/combat-position",
  "/api/v1/vcs/combat-swap-set",
  "/api/v1/vcs/combat-weapon-catalog",
  "/api/v1/vcs/combat-weapons",
]);

export function getBridgeConfig(env = process.env) {
  return {
    chatElixirBase: env.CHAT_ELIXIR_BASE ?? "http://127.0.0.1:8081",
    mmoBaseUrl: env.MMO_BASE_URL ?? "http://127.0.0.1:7777",
    vcsBaseUrl: env.VCS_BASE_URL ?? "http://127.0.0.1:8787",
    vcsHmacKey: env.VCS_HMAC_KEY ?? "",
    fetchTimeoutMs: Number(env.VCS_BRIDGE_FETCH_TIMEOUT_MS ?? 4000),
    reconnectDelayMs: Number(env.VCS_BRIDGE_RECONNECT_MS ?? 5000),
    brainsEnabled: env.VCS_BRAINS_ENABLED === "1",
    brainsRateLimitMs: Number(env.VCS_BRAINS_RATE_LIMIT_MS ?? 5000),
    brainsTimeoutMs: Number(env.VCS_BRAINS_TIMEOUT_MS ?? env.VCS_BRIDGE_FETCH_TIMEOUT_MS ?? 4000),
    cerebrasApiKey: env.CEREBRAS_API_KEY ?? env.CEREBRAS_AI_API_KEY ?? "",
    cerebrasBaseUrl: env.CEREBRAS_BASE_URL ?? "https://api.cerebras.ai",
    cerebrasModel: env.CEREBRAS_MODEL ?? "gemma-4-31b",
  };
}

const DEFAULT_CONFIG = getBridgeConfig();
const BRAINS_RATE_LIMIT = new Map();

async function hmacSign(body, key) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchWithTimeout(url, init = {}, timeoutMs, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function rpcLogin(body = {}) {
  return String(body.login ?? body.twitch_login ?? "").toLowerCase();
}

function rpcSource(body = {}) {
  return String(body.source ?? "twitch").toLowerCase();
}

function jsonReply(status, body) {
  return { status, body: JSON.stringify(body) };
}

function unavailableReply(reason) {
  return jsonReply(200, { ok: true, unavailable: true, reason });
}

function normalizedBaseUrl(url) {
  return url.replace(/\/+$/, "");
}

function brainsRateKey(body = {}) {
  return `${rpcSource(body)}:${String(body.user_id ?? rpcLogin(body) ?? "").toLowerCase()}`;
}

function brainsPrompt(body = {}) {
  const prompt = {
    viewer: {
      source: rpcSource(body),
      login: String(body.login ?? ""),
      user_id: String(body.user_id ?? ""),
      display: String(body.display ?? ""),
    },
    scene: typeof body.scene === "string" ? body.scene : undefined,
    stimulus: typeof body.stimulus === "string" ? body.stimulus : undefined,
    mood: typeof body.mood === "string" ? body.mood : undefined,
    nearby: Array.isArray(body.nearby)
      ? body.nearby.filter((item) => typeof item === "string")
      : [],
    image_data_url: typeof body.image_data_url === "string" ? body.image_data_url : undefined,
  };
  return JSON.stringify(prompt);
}

function parseBrainContent(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Plaintext fallback is acceptable for the public harness.
  }
  return { ok: true, content: text };
}

export async function proxyToBrains(
  rpc,
  {
    config = DEFAULT_CONFIG,
    fetchImpl = fetch,
    now = () => Date.now(),
    rateLimitStore = BRAINS_RATE_LIMIT,
  } = {},
) {
  if (!config.brainsEnabled) return unavailableReply("brains_disabled");
  if (!config.cerebrasApiKey) return unavailableReply("brains_unconfigured");

  const rateKey = brainsRateKey(rpc.body ?? {});
  const nowMs = now();
  const lastTickMs = rateLimitStore.get(rateKey);
  if (
    rateKey !== ":" &&
    typeof lastTickMs === "number" &&
    nowMs - lastTickMs < config.brainsRateLimitMs
  ) {
    return jsonReply(429, { ok: false, error: "brain_rate_limited" });
  }
  if (rateKey !== ":") rateLimitStore.set(rateKey, nowMs);

  let response;
  try {
    response = await fetchWithTimeout(
      `${normalizedBaseUrl(config.cerebrasBaseUrl)}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.cerebrasApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.cerebrasModel,
          reasoning_effort: "none",
          max_completion_tokens: 180,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You are the VCS brains tick mock for local integration tests. Return a compact JSON object.",
            },
            {
              role: "user",
              content: brainsPrompt(rpc.body ?? {}),
            },
          ],
        }),
      },
      config.brainsTimeoutMs,
      fetchImpl,
    );
  } catch (err) {
    const timeout = err instanceof Error && err.name === "AbortError";
    console.error("[vcs-bridge] brains upstream failed", timeout ? "timeout" : err);
    return unavailableReply(timeout ? "brain_timeout" : "brain_unavailable");
  }

  if (!response.ok) {
    console.error("[vcs-bridge] brains upstream returned non-200", response.status);
    return unavailableReply("brain_unavailable");
  }

  let json;
  try {
    json = await response.json();
  } catch (err) {
    console.error("[vcs-bridge] brains upstream returned invalid JSON", err);
    return unavailableReply("brain_unavailable");
  }

  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    return unavailableReply("brain_unavailable");
  }
  return jsonReply(200, parseBrainContent(content.trim()));
}

async function proxyToMmo(rpc, options = {}) {
  const { config = DEFAULT_CONFIG } = options;
  if (rpc.path === "/api/v1/vcs/combat-passive-tree") {
    return upstreamText(
      `${normalizedBaseUrl(config.mmoBaseUrl)}/api/passive-tree`,
      { method: "GET" },
      "mmo",
      options,
    );
  }
  if (rpc.path === "/api/v1/vcs/combat-weapon-catalog") {
    return upstreamText(
      `${normalizedBaseUrl(config.mmoBaseUrl)}/api/weapon-catalog`,
      { method: "GET" },
      "mmo",
      options,
    );
  }

  if (rpcSource(rpc.body) !== "twitch") {
    return {
      status: 200,
      body: JSON.stringify({ ok: true, unavailable: true, reason: "combat_twitch_only" }),
    };
  }

  const login = rpcLogin(rpc.body);
  if (!login.match(/^[a-z0-9_]{1,32}$/)) {
    return { status: 400, body: JSON.stringify({ ok: false, error: "invalid_login" }) };
  }

  if (rpc.path === "/api/v1/vcs/combat-loadout") {
    return upstreamText(
      `${normalizedBaseUrl(config.mmoBaseUrl)}/api/sigma/${login}/loadout`,
      { method: "GET" },
      "mmo",
      options,
    );
  }
  if (rpc.path === "/api/v1/vcs/combat-equip") {
    return upstreamText(
      `${normalizedBaseUrl(config.mmoBaseUrl)}/api/sigma/${login}/equip`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot: rpc.body?.slot, index: rpc.body?.index }),
      },
      "mmo",
      options,
    );
  }
  if (rpc.path === "/api/v1/vcs/combat-passives") {
    return upstreamText(
      `${normalizedBaseUrl(config.mmoBaseUrl)}/api/sigma/${login}/passives`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passives: rpc.body?.passives ?? [], set: rpc.body?.set }),
      },
      "mmo",
      options,
    );
  }
  if (rpc.path === "/api/v1/vcs/combat-reserve") {
    return upstreamText(
      `${normalizedBaseUrl(config.mmoBaseUrl)}/api/sigma/${login}/reserve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reserved: rpc.body?.reserved ?? [], set: rpc.body?.set }),
      },
      "mmo",
      options,
    );
  }
  if (rpc.path === "/api/v1/vcs/combat-position") {
    return upstreamText(
      `${normalizedBaseUrl(config.mmoBaseUrl)}/api/sigma/${login}/position`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ position: rpc.body?.position, set: rpc.body?.set }),
      },
      "mmo",
      options,
    );
  }
  if (rpc.path === "/api/v1/vcs/combat-swap-set") {
    return upstreamText(
      `${normalizedBaseUrl(config.mmoBaseUrl)}/api/sigma/${login}/swap-set`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ set: rpc.body?.set }),
      },
      "mmo",
      options,
    );
  }
  if (rpc.path === "/api/v1/vcs/combat-weapons") {
    const url = `${normalizedBaseUrl(config.mmoBaseUrl)}/api/sigma/${login}/weapons`;
    if (rpc.method === "POST") {
      return upstreamText(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ weapons: rpc.body?.weapons ?? [], set: rpc.body?.set }),
        },
        "mmo",
        options,
      );
    }
    return upstreamText(url, { method: "GET" }, "mmo", options);
  }

  return upstreamText(
    `${normalizedBaseUrl(config.mmoBaseUrl)}/api/sigma/${login}`,
    { method: "GET" },
    "mmo",
    options,
  );
}

async function proxyToChat(rpc, options = {}) {
  const { config = DEFAULT_CONFIG } = options;
  let target = `${normalizedBaseUrl(config.chatElixirBase)}${rpc.path}`;
  const init = { method: rpc.method };

  if (rpc.method === "POST") {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(rpc.body ?? {});
  } else if (rpc.body && Object.keys(rpc.body).length > 0) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(rpc.body)) {
      if (value !== null && value !== undefined) params.set(key, String(value));
    }
    target += `${target.includes("?") ? "&" : "?"}${params}`;
  }

  return upstreamText(target, init, "chat", options);
}

async function upstreamText(
  url,
  init,
  service,
  { config = DEFAULT_CONFIG, fetchImpl = fetch } = {},
) {
  try {
    const res = await fetchWithTimeout(url, init, config.fetchTimeoutMs, fetchImpl);
    return { status: res.status, body: await res.text() };
  } catch (err) {
    const timeout = err instanceof Error && err.name === "AbortError";
    console.error(`[vcs-bridge] ${service} upstream failed`, url, timeout ? "timeout" : err);
    return {
      status: timeout ? 504 : 502,
      body: JSON.stringify({
        ok: false,
        error: timeout ? `${service}_timeout` : `${service}_failed`,
      }),
    };
  }
}

export async function routeRpc(rpc, options = {}) {
  if (rpc.path === BRAINS_PATH) return await proxyToBrains(rpc, options);
  if (MMO_PATHS.has(rpc.path)) return await proxyToMmo(rpc, options);
  return await proxyToChat(rpc, options);
}

async function connect(config = DEFAULT_CONFIG) {
  const ts = Math.floor(Date.now() / 1000);
  const signature = await hmacSign(`timestamp:${ts}`, config.vcsHmacKey);
  const wsUrl = `${config.vcsBaseUrl.replace(/^http/, "ws")}/ws/streamer`;
  const ws = new WebSocket(wsUrl, {
    headers: {
      "X-Vcs-Signature": signature,
      "X-Vcs-Timestamp": String(ts),
    },
  });

  let heartbeat = null;

  ws.addEventListener("open", () => {
    console.log(
      `[vcs-bridge] connected to ${config.vcsBaseUrl}; chat=${config.chatElixirBase}; mmo=${config.mmoBaseUrl}`,
    );
    heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      }
    }, 15000);
  });

  ws.addEventListener("message", async (event) => {
    let msg;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (msg.type === "pong") return;
    if (msg.type !== "rpc" || !msg.req_id || !msg.path) return;

    const reply = await routeRpc(msg, { config });
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "rpc_reply",
        req_id: msg.req_id,
        status: reply.status,
        body: reply.body,
      }),
    );
  });

  ws.addEventListener("close", () => {
    if (heartbeat) clearInterval(heartbeat);
    console.log(`[vcs-bridge] disconnected; reconnecting in ${config.reconnectDelayMs}ms`);
    setTimeout(() => {
      connect(config).catch((err) => console.error("[vcs-bridge] reconnect failed", err));
    }, config.reconnectDelayMs);
  });

  ws.addEventListener("error", (event) => {
    console.error("[vcs-bridge] websocket error", event.message ?? event.type ?? event);
  });
}

if (import.meta.main) {
  if (!DEFAULT_CONFIG.vcsHmacKey) {
    console.error("[vcs-bridge] VCS_HMAC_KEY is required");
    process.exit(1);
  }

  connect(DEFAULT_CONFIG).catch((err) => {
    console.error("[vcs-bridge] failed to start", err);
    process.exit(1);
  });
}
