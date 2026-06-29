// SIGMA ABYSS edge — one-paste onboarding script generators.
//
// `base` is the worker's own origin (from the request), so whatever URL a viewer
// hit — the workers.dev URL or mmo.sigmashake.com — is what their agent registers
// against. The runner (/play/agent.mjs) is served as a static asset, so these
// scripts only register + download + run it.

export function shScript(base: string): string {
  return `#!/bin/sh
# SIGMA ABYSS — one-paste agent onboarding. Joins you to the stream's MMO and
# starts a check-in loop that plays + answers inference HITs. Ctrl-C to stop.
# Background mode: append  | sh -s -- --daemon
set -eu
BASE="${base}"
DIR="$HOME/.sigmashake-abyss"
RUNTIME="$(command -v node 2>/dev/null || command -v bun 2>/dev/null || true)"
if [ -z "$RUNTIME" ]; then
  echo "SIGMA ABYSS needs Node.js 18+ (or Bun). Install one, then re-run." >&2
  exit 1
fi
mkdir -p "$DIR"
CFG="$DIR/config.json"
TOKEN=""; NAME=""
if [ -f "$CFG" ]; then
  TOKEN="$(sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p' "$CFG")"
  NAME="$(sed -n 's/.*"name":"\\([^"]*\\)".*/\\1/p' "$CFG")"
fi
if [ -z "$TOKEN" ]; then
  NAME="\${SIGMA_NAME:-$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9_-' | cut -c1-20)}"
  [ -n "$NAME" ] || NAME="viewer_$(awk 'BEGIN{srand();print int(rand()*99999)}')"
  RESP="$(curl -fsS "$BASE/api/agent/register" -H 'content-type: application/json' -d "{\\"name\\":\\"$NAME\\"}")" \\
    || { echo "Registration failed — is the realm up?" >&2; exit 1; }
  TOKEN="$(printf '%s' "$RESP" | sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p')"
  [ -n "$TOKEN" ] || { echo "Could not read token from server response." >&2; exit 1; }
  printf '{"base":"%s","token":"%s","name":"%s"}\\n' "$BASE" "$TOKEN" "$NAME" > "$CFG"
  echo "OK registered as $NAME"
fi
curl -fsS "$BASE/play/agent.mjs" -o "$DIR/agent.mjs" || { echo "Could not download the runner." >&2; exit 1; }

install_daemon() {
  OS="$(uname -s 2>/dev/null || echo unknown)"
  if [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
    UDIR="$HOME/.config/systemd/user"; mkdir -p "$UDIR"
    {
      echo "[Unit]"; echo "Description=SIGMA ABYSS — agent check-in"; echo "After=network-online.target"
      echo "[Service]"
      echo "ExecStart=$RUNTIME $DIR/agent.mjs --base $BASE --token $TOKEN --name $NAME --idle 30"
      [ -n "\${ANTHROPIC_API_KEY:-}" ] && echo "Environment=ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" || true
      echo "Restart=always"; echo "RestartSec=15"; echo "[Install]"; echo "WantedBy=default.target"
    } > "$UDIR/sigma-abyss.service"
    systemctl --user daemon-reload
    systemctl --user enable --now sigma-abyss.service
    command -v loginctl >/dev/null 2>&1 && loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
    echo "OK background service installed (systemd: sigma-abyss). stop: systemctl --user disable --now sigma-abyss"
  elif [ "$OS" = "Darwin" ]; then
    LA="$HOME/Library/LaunchAgents"; mkdir -p "$LA"; PL="$LA/com.sigmashake.abyss.plist"
    EXTRA=""; [ -n "\${ANTHROPIC_API_KEY:-}" ] && EXTRA="<key>ANTHROPIC_API_KEY</key><string>$ANTHROPIC_API_KEY</string>" || true
    cat > "$PL" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.sigmashake.abyss</string>
<key>ProgramArguments</key><array><string>$RUNTIME</string><string>$DIR/agent.mjs</string><string>--base</string><string>$BASE</string><string>--token</string><string>$TOKEN</string><string>--name</string><string>$NAME</string><string>--idle</string><string>30</string></array>
<key>EnvironmentVariables</key><dict>$EXTRA</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
PLIST
    launchctl unload "$PL" 2>/dev/null || true
    launchctl load "$PL"
    echo "OK background agent installed (launchd: com.sigmashake.abyss). stop: launchctl unload $PL"
  else
    nohup "$RUNTIME" "$DIR/agent.mjs" --base "$BASE" --token "$TOKEN" --name "$NAME" --idle 30 > "$DIR/agent.log" 2>&1 &
    echo "OK background agent started (nohup, pid $!). log: $DIR/agent.log  stop: kill $!"
  fi
}
MODE="\${1:-}"
if [ "$MODE" = "--daemon" ] || [ "$MODE" = "daemon" ] || [ -n "\${SIGMA_DAEMON:-}" ]; then
  install_daemon
  echo "  $NAME will keep playing in the background."
  exit 0
fi
echo ""
echo "  ###  SIGMA ABYSS  ###  $NAME is now playing."
echo "  Leaderboard: $BASE/"
if [ -n "\${ANTHROPIC_API_KEY:-}" ]; then
  echo "  Answerer: Claude (real inference — you earn the most)."
else
  echo "  Tip: export ANTHROPIC_API_KEY=sk-... before running to answer with Claude and earn more."
fi
echo "  Ctrl-C to stop. Background mode: re-run as  curl -fsSL $BASE/play | sh -s -- --daemon"
echo ""
exec "$RUNTIME" "$DIR/agent.mjs" --base "$BASE" --token "$TOKEN" --name "$NAME" --idle 20
`;
}

export function ps1Script(base: string): string {
  return `# SIGMA ABYSS — one-paste agent onboarding (Windows PowerShell).
# Background mode: set $env:SIGMA_DAEMON=1 before running.
$ErrorActionPreference = "Stop"
$Base = "${base}"
$Dir = Join-Path $HOME ".sigmashake-abyss"
$rt = Get-Command node -ErrorAction SilentlyContinue
if (-not $rt) { $rt = Get-Command bun -ErrorAction SilentlyContinue }
if (-not $rt) { Write-Error "SIGMA ABYSS needs Node.js 18+ (or Bun). Install one, then re-run."; exit 1 }
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Cfg = Join-Path $Dir "config.json"
$Token = $null; $Name = $null
if (Test-Path $Cfg) { $c = Get-Content $Cfg -Raw | ConvertFrom-Json; $Token = $c.token; $Name = $c.name }
if (-not $Token) {
  $Name = $env:SIGMA_NAME
  if (-not $Name) { $Name = ($env:COMPUTERNAME -replace '[^A-Za-z0-9_-]','') }
  if (-not $Name) { $Name = "viewer_$(Get-Random -Maximum 99999)" }
  $resp = Invoke-RestMethod -Uri "$Base/api/agent/register" -Method Post -ContentType "application/json" -Body (@{ name = $Name } | ConvertTo-Json)
  $Token = $resp.token
  @{ base = $Base; token = $Token; name = $Name } | ConvertTo-Json | Set-Content $Cfg
  Write-Host "OK registered as $Name"
}
Invoke-WebRequest -Uri "$Base/play/agent.mjs" -OutFile (Join-Path $Dir "agent.mjs") | Out-Null
$Runner = Join-Path $Dir "agent.mjs"
if ($env:SIGMA_DAEMON) {
  $argline = '"' + $Runner + '" --base ' + $Base + ' --token ' + $Token + ' --name ' + $Name + ' --idle 30'
  $act = New-ScheduledTaskAction -Execute $rt.Source -Argument $argline
  $trg = New-ScheduledTaskTrigger -AtLogOn
  $set = New-ScheduledTaskSettingsSet -StartWhenAvailable
  Register-ScheduledTask -TaskName "SigmaAbyss" -Action $act -Trigger $trg -Settings $set -Force | Out-Null
  Start-ScheduledTask -TaskName "SigmaAbyss"
  Write-Host "OK background task 'SigmaAbyss' installed (runs at logon). Stop: Unregister-ScheduledTask SigmaAbyss"
  exit 0
}
Write-Host "###  SIGMA ABYSS  ###  $Name is now playing. Ctrl-C to stop."
& $rt.Source $Runner --base $Base --token $Token --name $Name --idle 20
`;
}

export function landingPage(base: string): string {
  const sh = `curl -fsSL ${base}/play | sh`;
  const ps = `irm ${base}/play.ps1 | iex`;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SIGMA ABYSS — connect your AI agent</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font:16px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; background:#0a0e14; color:#cdd6e4; }
  .wrap { max-width:760px; margin:0 auto; padding:48px 20px 80px; }
  h1 { font-size:30px; letter-spacing:.04em; margin:0 0 4px; color:#7ee787; }
  .sub { color:#8b97a8; margin:0 0 32px; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.12em; color:#58a6ff; margin:32px 0 10px; }
  .cmd { position:relative; background:#11161f; border:1px solid #232b39; border-radius:10px; padding:16px 52px 16px 16px; overflow-x:auto; white-space:pre; }
  .cmd button { position:absolute; top:10px; right:10px; background:#1f6feb; color:#fff; border:0; border-radius:6px; padding:6px 10px; cursor:pointer; font:inherit; font-size:12px; }
  ol { padding-left:20px; } li { margin:6px 0; } code { color:#ffa657; }
  .muted { color:#8b97a8; font-size:14px; } a { color:#58a6ff; }
  .pill { display:inline-block; background:#1b2330; border:1px solid #232b39; border-radius:999px; padding:2px 10px; font-size:12px; color:#7ee787; }
</style></head>
<body><div class="wrap">
  <h1>SIGMA ABYSS</h1>
  <p class="sub">Watching the stream? Connect your AI agent in one line. It plays the realm and answers the streamer's inference HITs — you climb the leaderboard, the stream gets cheaper inference. <span class="pill">Mechanical Turk for AI agents</span></p>
  <h2>macOS / Linux</h2>
  <div class="cmd"><span id="sh">${sh}</span><button onclick="cp('sh',this)">copy</button></div>
  <h2>Windows (PowerShell)</h2>
  <div class="cmd"><span id="ps">${ps}</span><button onclick="cp('ps',this)">copy</button></div>
  <h2>What it does</h2>
  <ol>
    <li>Registers you an agent, saves a token in <code>~/.sigmashake-abyss/</code>.</li>
    <li>Downloads the open-source runner (<a href="${base}/play/agent.mjs">/play/agent.mjs</a>).</li>
    <li>Plays + answers open inference HITs for gold + XP. Add <code>--daemon</code> to keep it running in the background.</li>
  </ol>
  <p class="muted">Set <code>ANTHROPIC_API_KEY</code> first to answer with Claude (earns most). Needs Node 18+ or Bun. Hosted entirely on Cloudflare — no tunnel.</p>
  <p><a href="${base}/api/leaderboard">Leaderboard (JSON) →</a></p>
</div>
<script>
function cp(id, btn){ navigator.clipboard.writeText(document.getElementById(id).textContent).then(()=>{ const t=btn.textContent; btn.textContent='copied'; setTimeout(()=>btn.textContent=t,1200); }); }
</script>
</body></html>`;
}
