import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const gate = process.argv[2] || "gate";
const required = [
  "overlay/chat-bubbles.html",
  "test/chat-bubbles-html.test.ts",
  "tools/server.mjs",
];
for (const rel of required) {
  const file = path.join(root, rel);
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`missing required public overlay file: ${rel}`);
  }
}

const html = readFileSync(path.join(root, "overlay/chat-bubbles.html"), "utf8");
if (!html.includes("ws://localhost:8080/chat")) {
  throw new Error("chat-bubbles.html must keep the local chat websocket contract");
}
if (!html.includes("function appendChat")) {
  throw new Error("chat-bubbles.html missing appendChat renderer");
}

const deny = [
  [/\/home\/[A-Za-z0-9_.-]+/, "local operator path"],
  [/BEGIN [A-Z ]*PRIVATE KEY/, "private key material"],
  [
    /(OBS_WS_PASSWORD|OBS_WEBSOCKET_PASSWORD|OBS_CHAT_HMAC_KEY|OBS_CHAT_OVERLAY_HMAC_KEY|OBS_CHAT_OVERLAY_SECRET|TWITCH_(CLIENT_SECRET|OAUTH_TOKEN|IRC_TOKEN|BOT_TOKEN|CHAT_TOKEN)|YOUTUBE_(API_KEY|CLIENT_SECRET|REFRESH_TOKEN|ACCESS_TOKEN)|DISCORD_WEBHOOK_URL|STREAM_KEY|RTMP_URL|WRANGLER_API_TOKEN)=\S{8,}/,
    "secret assignment",
  ],
  [/https:\/\/[A-Za-z0-9.-]+\.trycloudflare\.com/, "runtime tunnel URL"],
];

function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if ([".git", "node_modules"].includes(entry)) continue;
    const abs = path.join(dir, entry);
    const rel = path.relative(root, abs);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...files(abs));
    else out.push(rel);
  }
  return out;
}

for (const rel of files(root)) {
  const text = readFileSync(path.join(root, rel), "utf8");
  for (const [regex, label] of deny) {
    if (regex.test(text)) throw new Error(`${label} in ${rel}`);
  }
}

console.log(`[obs-chat-overlay] ${gate}: passed`);
