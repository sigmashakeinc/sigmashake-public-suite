import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const root = process.cwd();
const port = Number.parseInt(process.env.PORT || "8080", 10);
const html = readFileSync(path.join(root, "overlay/chat-bubbles.html"));

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "obs-chat-overlay" }));
    return;
  }
  if (url.pathname === "/" || url.pathname === "/chat-bubbles") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  if (url.pathname.startsWith("/emote/")) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("emote cache is provided by the trusted local overlay server\n");
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found\n");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[obs-chat-overlay] serving http://127.0.0.1:${port}/chat-bubbles`);
});
