#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    base: "origin/main",
    allowAutomationChange: process.env.ALLOW_AUTOMATION_CHANGE === "1",
    noDiffRequired: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") args.root = argv[++i];
    else if (arg === "--base") args.base = argv[++i];
    else if (arg === "--allow-automation-change") args.allowAutomationChange = true;
    else if (arg === "--no-diff-required") args.noDiffRequired = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function git(root, args, allowFailure = false) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function changedFiles(root, base, noDiffRequired) {
  const output = git(root, ["diff", "--name-only", `${base}...HEAD`], noDiffRequired);
  return output.split(/\r?\n/).filter(Boolean);
}

function diffText(root, base, noDiffRequired) {
  return git(root, ["diff", "--unified=0", `${base}...HEAD`], noDiffRequired);
}

function serviceOf(file) {
  const match = file.match(/^services\/([^/]+)\//);
  return match ? match[1] : "";
}

function isSourceFile(file) {
  return /^services\/[^/]+\/(src|client|server|static|tools|integrations)\//.test(file)
    && !/\/(README|SPEC|AGENTS|RUNBOOK|CLAUDE)\.md$/.test(file);
}

function isTestFile(file) {
  return /^services\/[^/]+\/(test|integrations)\//.test(file);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  if (!existsSync(path.join(root, ".git"))) {
    throw new Error(`review root is not a git checkout: ${root}`);
  }

  const files = changedFiles(root, args.base, args.noDiffRequired);
  const findings = [];

  const deniedPath = /(^|\/)(\.env(\..*)?|wrangler\.toml|\.wrangler|\.sigmashake|node_modules|dist|coverage|\.last-[^/]*)(\/|$)|^services\/mmo\/data\//;
  const deniedObsPath = /^services\/obs-chat-overlay\/(data|runtime|state|logs|chat-logs|recordings|captures|screenshots|obs-config|obs-studio|scene-collections?|profiles?)(\/|$)|^services\/obs-chat-overlay\/(?:.*\/)?(global\.ini|service\.json|obs-websocket[^/]*\.json|scene-collection[^/]*\.json)$/;
  for (const file of files) {
    if (deniedPath.test(file) || deniedObsPath.test(file)) {
      findings.push(`blocked private/generated path changed: ${file}`);
    }
  }

  const automationPath = /^(?:\.github\/|scripts\/|config\/pr-gates\.json$|package\.json$)/;
  const automationChanges = files.filter((file) => automationPath.test(file));
  if (automationChanges.length && !args.allowAutomationChange) {
    findings.push(
      `automation changes require manual review: ${automationChanges.join(", ")}`,
    );
  }

  const servicesWithSourceChanges = new Set(files.filter(isSourceFile).map(serviceOf));
  const servicesWithTests = new Set(files.filter(isTestFile).map(serviceOf));
  for (const service of servicesWithSourceChanges) {
    if (!servicesWithTests.has(service)) {
      findings.push(`source changes in ${service} need matching tests or public integration updates`);
    }
  }

  const diff = diffText(root, args.base, args.noDiffRequired);
  const secretPatterns = [
    ["private key material", /BEGIN [A-Z ]*PRIVATE KEY/],
    ["AWS access key", /AKIA[0-9A-Z]{16}/],
    ["local operator path", /\/home\/[A-Za-z0-9_.-]+/],
    ["runtime tunnel URL", /https:\/\/[A-Za-z0-9.-]+\.trycloudflare\.com/],
    ["HMAC/OBS/chat secret assignment", /(VCS_HMAC_KEY|MMO_HMAC_KEY|OBS_WS_PASSWORD|OBS_WEBSOCKET_PASSWORD|OBS_CHAT_HMAC_KEY|OBS_CHAT_OVERLAY_HMAC_KEY|OBS_CHAT_OVERLAY_SECRET|TWITCH_(CLIENT_SECRET|OAUTH_TOKEN|IRC_TOKEN|BOT_TOKEN|CHAT_TOKEN)|YOUTUBE_(API_KEY|CLIENT_SECRET|REFRESH_TOKEN|ACCESS_TOKEN)|DISCORD_WEBHOOK_URL|STREAM_KEY|RTMP_URL|WRANGLER_API_TOKEN)=[A-Za-z0-9_./+=:-]{20,}/],
    ["OBS/chat runtime config secret field", /"?(streamKey|stream_key|oauthToken|oauth_token|chatToken|chat_token|obsWebSocketPassword|obs_ws_password)"?\s*[:=]\s*"?[A-Za-z0-9_./+=:-]{20,}/],
  ];
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(diff)) findings.push(`diff contains ${label}`);
  }

  if (findings.length) {
    console.error("[review-policy] BLOCKED");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exit(1);
  }

  console.log(`[review-policy] passed (${files.length} changed files)`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
