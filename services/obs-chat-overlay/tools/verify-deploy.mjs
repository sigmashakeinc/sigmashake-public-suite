const url = process.env.OBS_CHAT_OVERLAY_URL || "http://127.0.0.1:8080/chat-bubbles";
const res = await fetch(url);
if (!res.ok) {
  throw new Error(`overlay probe failed: ${res.status} ${res.statusText}`);
}
const body = await res.text();
if (!body.includes("chat-bubbles") && !body.includes("appendChat")) {
  throw new Error(`overlay probe did not return chat-bubbles HTML: ${url}`);
}
console.log(`[obs-chat-overlay] verified ${url}`);
