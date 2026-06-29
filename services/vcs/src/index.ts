import { Hono } from "hono";
import bridge from "./routes/bridge";
import publicApi from "./routes/public";
import viewer from "./routes/viewer";
import { VcsRoom } from "./vcs-room";

export { VcsRoom };

interface SecretStoreSecret {
  get(): Promise<string>;
}

export type Bindings = {
  VCS_ROOM: DurableObjectNamespace;
  SESSIONS: KVNamespace;
  VCS_API_KEYS?: KVNamespace;
  ASSETS?: { fetch(r: Request): Promise<Response> };
  ENCRYPTION_KEY?: SecretStoreSecret;
  VCS_HMAC_KEY?: SecretStoreSecret;
  VAULT?: {
    getSecret(name: string): Promise<string | null>;
    putSecret(name: string, value: string, opts?: { description?: string }): Promise<unknown>;
  };
  TWITCH_CHANNEL?: string;
  TWITCH_BROADCASTER_ID?: string;
  ACCOUNTS_ORIGIN?: string;
  BRIDGE_RPC_TIMEOUT_MS?: string;
};

export type HonoEnv = { Bindings: Bindings };

const app = new Hono<HonoEnv>();

// Page and API are same-origin in production (both on vcs.sigmashake.com),
// so CORS is only needed for `wrangler dev` against the deployed worker.
app.use("*", async (c, next) => {
  await next();
  const origin = c.req.header("Origin") ?? "";
  if (
    origin === "https://vcs.sigmashake.com" ||
    origin === "http://localhost:8787" ||
    origin === "http://127.0.0.1:8787"
  ) {
    c.res.headers.set("Access-Control-Allow-Origin", origin);
    c.res.headers.set("Access-Control-Allow-Credentials", "true");
    c.res.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Vcs-Signature, X-Vcs-Timestamp",
    );
  }
});

app.options("*", () => new Response(null, { status: 204 }));

app.route("/", viewer);
app.route("/", bridge);
app.route("/", publicApi);

app.get("/healthz", (c) => c.json({ ok: true, service: "sigmashake-vcs" }));

// Static assets (index.html, panel.js, panel.css, …)
app.get("*", async (c) => {
  const assets = (c.env as unknown as { ASSETS?: { fetch(r: Request): Promise<Response> } }).ASSETS;
  if (assets) {
    const res = await assets.fetch(c.req.raw);
    if (res.status !== 404) return res;
  }
  return c.text("Not found", 404);
});

app.onError((err, c) => {
  console.error("[vcs] unhandled error", {
    path: new URL(c.req.url).pathname,
    method: c.req.method,
    err: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return c.json({ ok: false, error: "internal_error" }, 500);
});

export default app;
