#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const CHECKOUT_SHA = "93cb6efe18208431cddfb8368fd83d5badbf9bfd";
const WORKFLOW = ".github/workflows/ssg-practices.yml";
const REQUIRED_RUNNERS = ["ubuntu-latest", "macos-latest", "windows-latest"];
const REQUIRED_COMMANDS = [
  "bun install --frozen-lockfile",
  "bun scripts/ssg-public-check.mjs",
  "bun scripts/public-integrity.mjs",
  "bun run lint",
  "bun run typecheck",
  "bun test",
];
const ALLOWED_GITHUB_FILES = new Set([".github/CODEOWNERS", WORKFLOW]);
const MATRIX_JOB_NAME = "name: ssg-practices / $" + "{{ matrix.os }}";

const args = process.argv.slice(2);
let root = process.cwd();
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--root") {
    if (!args[i + 1]) {
      throw new Error("--root requires a path");
    }
    root = path.resolve(args[i + 1]);
    i += 1;
  } else {
    throw new Error(`Unknown argument: ${args[i]}`);
  }
}

const fail = [];
const note = [];

function rel(...parts) {
  return path.join(...parts).replaceAll(path.sep, "/");
}

function abs(relPath) {
  return path.join(root, relPath);
}

function exists(relPath) {
  try {
    statSync(abs(relPath));
    return true;
  } catch {
    return false;
  }
}

function requireFile(relPath) {
  if (!exists(relPath)) {
    fail.push(`missing required file: ${relPath}`);
    return "";
  }
  return readFileSync(abs(relPath), "utf8");
}

function walk(dirRel, out = []) {
  if (!exists(dirRel)) {
    return out;
  }
  for (const entry of readdirSync(abs(dirRel), { withFileTypes: true })) {
    if (entry.name === ".git") {
      continue;
    }
    const entryRel = rel(dirRel, entry.name);
    if (entry.isDirectory()) {
      walk(entryRel, out);
    } else if (entry.isFile()) {
      out.push(entryRel);
    }
  }
  return out;
}

function validateNoPrivateState() {
  const allowedClaudeFiles = new Set([
    ".claude/skills/vcs/SKILL.md",
    ".claude/agents/vcs-worker-api-implementer.md",
    ".claude/agents/vcs-ui-implementer.md",
    ".claude/agents/vcs-stream-integration-implementer.md",
    ".claude/agents/vcs-public-collaboration-reviewer.md",
  ]);
  const forbidden = [
    ".env",
    ".env.local",
    ".security.toml",
    "sbom.spdx.json",
    "wrangler.toml",
    "docs/oncall.toml",
    "docs/privacy",
    ".sigmashake",
    ".wrangler",
    "dist",
    "node_modules",
  ];

  for (const entry of forbidden) {
    if (exists(entry)) {
      fail.push(`forbidden private path present: ${entry}`);
    }
  }

  for (const file of walk(".claude")) {
    if (!allowedClaudeFiles.has(file)) {
      fail.push(`unexpected Claude Code metadata file: ${file}`);
    }
  }
}

function validatePackage() {
  const raw = requireFile("package.json");
  if (!raw) return;
  const pkg = JSON.parse(raw);
  if (pkg.scripts?.deploy !== "wrangler deploy") {
    fail.push('package.json scripts.deploy must be the public-safe "wrangler deploy"');
  }
  if (pkg.private !== true) {
    fail.push("package.json private must remain true in the public mirror");
  }
  for (const scriptName of ["preinstall", "postinstall", "prepare"]) {
    if (pkg.scripts?.[scriptName]) {
      fail.push(`package.json must not define install lifecycle script: ${scriptName}`);
    }
  }
}

function validateGithubFiles() {
  const owners = requireFile(".github/CODEOWNERS");
  if (owners && !owners.split(/\r?\n/).some((line) => line.trim() === "* @ncmd")) {
    fail.push(".github/CODEOWNERS must route all public mirror changes to @ncmd");
  }

  for (const file of walk(".github")) {
    if (!ALLOWED_GITHUB_FILES.has(file)) {
      fail.push(`unexpected GitHub metadata file: ${file}`);
    }
  }
}

function validateWorkflow() {
  const yaml = requireFile(WORKFLOW);
  if (!yaml) return;

  if (!/^name:\s*ssg-practices\s*$/m.test(yaml)) {
    fail.push(`${WORKFLOW} must be named ssg-practices`);
  }
  if (yaml.includes("pull_request_target")) {
    fail.push(`${WORKFLOW} must not use pull_request_target`);
  }
  if (!/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(yaml)) {
    fail.push(`${WORKFLOW} must set the default token to contents: read`);
  }
  if (!yaml.includes("if: github.repository == 'sigmashakeinc/sigmashake-vcs'")) {
    fail.push(`${WORKFLOW} must be scoped to sigmashakeinc/sigmashake-vcs`);
  }
  if (/^\s*[a-z-]+:\s*write\s*$/m.test(yaml) || /write-all/.test(yaml)) {
    fail.push(`${WORKFLOW} must not request write token permissions`);
  }
  if (/id-token\s*:/i.test(yaml)) {
    fail.push(`${WORKFLOW} must not request OIDC id-token permissions`);
  }
  if (/\$\{\{\s*secrets\./i.test(yaml) || /\bsecrets\s*:/i.test(yaml)) {
    fail.push(`${WORKFLOW} must not reference repository secrets`);
  }

  const uses = [...yaml.matchAll(/^\s*uses:\s*([^\s#]+)\s*$/gm)].map((match) => match[1]);
  const allowedUse = `actions/checkout@${CHECKOUT_SHA}`;
  if (uses.length !== 1 || uses[0] !== allowedUse) {
    fail.push(`${WORKFLOW} may only use ${allowedUse}`);
  }

  for (const runner of REQUIRED_RUNNERS) {
    if (!yaml.includes(`runner: ${runner}`)) {
      fail.push(`${WORKFLOW} missing required runner: ${runner}`);
    }
  }
  if (!yaml.includes(MATRIX_JOB_NAME)) {
    fail.push(`${WORKFLOW} must expose stable branch-protection status names`);
  }
  for (const command of REQUIRED_COMMANDS) {
    if (!yaml.includes(command)) {
      fail.push(`${WORKFLOW} missing required command: ${command}`);
    }
  }
  if (/\bwrangler\s+deploy\b/.test(yaml) || /\bgh\s+/.test(yaml)) {
    fail.push(`${WORKFLOW} must not deploy or mutate GitHub state`);
  }
  if (!/^concurrency:\s*$/m.test(yaml) || !/cancel-in-progress:\s*true/.test(yaml)) {
    fail.push(`${WORKFLOW} must use concurrency cancellation`);
  }
  note.push("workflow policy locked to one read-only, SHA-pinned, cross-platform job");
}

validateNoPrivateState();
validatePackage();
validateGithubFiles();
validateWorkflow();

if (fail.length > 0) {
  console.error("[ssg-public-check] FAILED");
  for (const message of fail) {
    console.error(`  - ${message}`);
  }
  process.exit(1);
}

console.log("[ssg-public-check] PASSED");
for (const message of note) {
  console.log(`  ${message}`);
}
