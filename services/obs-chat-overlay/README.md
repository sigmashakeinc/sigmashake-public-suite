# SigmaShake OBS Chat Overlay

Public OBS browser-source overlay for rendering the unified SigmaShake chat
feed as animated chat bubbles.

## Run locally

```sh
bun install --frozen-lockfile
bun run dev
```

Open <http://127.0.0.1:8080/chat-bubbles>. In production OBS points a Browser
Source at the same path and receives chat events from the trusted streamer-local
overlay server over `ws://localhost:8080/chat`.

## Safety boundary

This mirror contains only the public browser UI, regression tests, and local
verification helpers. It must not contain OBS scene collections, profiles,
recordings, screenshots, chat logs, runtime state, local operator paths, or
secrets.
