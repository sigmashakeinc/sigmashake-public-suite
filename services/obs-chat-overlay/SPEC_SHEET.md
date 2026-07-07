# OBS Chat Overlay Public Surface

The public mirror owns the `chat-bubbles.html` browser-source UI and lightweight
test harness. The private streaming stack owns live chat ingestion, OBS scene
management, credentials, emote caches, and local process supervision.

Required public-suite gates are implemented as deterministic checks around the
static overlay and its tests. Host deploys remain operator-owned and must provide
explicit deploy and verify commands.
