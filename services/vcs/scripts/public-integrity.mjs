#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

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

function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((fields) => fields.some((value) => value.trim() !== ""));
}

function validateNoPrivateFiles() {
  const allowedClaudeFiles = new Set([
    ".claude/skills/vcs/SKILL.md",
    ".claude/agents/vcs-worker-api-implementer.md",
    ".claude/agents/vcs-ui-implementer.md",
    ".claude/agents/vcs-stream-integration-implementer.md",
    ".claude/agents/vcs-public-collaboration-reviewer.md",
  ]);
  const forbidden = [
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
      fail.push(`forbidden private or automation path present: ${entry}`);
    }
  }

  for (const file of walk(".")) {
    if (file.includes("/.sigmashake/") || file.startsWith(".sigmashake/")) {
      fail.push(`forbidden governance state copied: ${file}`);
    }
    if (file.includes("/node_modules/") || file.startsWith("node_modules/")) {
      fail.push(`forbidden dependency tree copied: ${file}`);
    }
    if (file.startsWith(".claude/") && !allowedClaudeFiles.has(file)) {
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
  if (pkg.scripts?.postinstall || pkg.scripts?.preinstall || pkg.scripts?.prepare) {
    fail.push("package.json must not define install-time lifecycle scripts");
  }
}

function validateGithubPolicy() {
  const owners = requireFile(".github/CODEOWNERS");
  if (owners && !owners.split(/\r?\n/).some((line) => line.trim() === "* @ncmd")) {
    fail.push(".github/CODEOWNERS must route all public mirror changes to @ncmd");
  }

  const workflowPath = ".github/workflows/ssg-practices.yml";
  const allowedGithubFiles = new Set([".github/CODEOWNERS", workflowPath]);
  for (const file of walk(".github")) {
    if (!allowedGithubFiles.has(file)) {
      fail.push(`unexpected GitHub metadata file: ${file}`);
    }
  }

  const workflow = requireFile(workflowPath);
  if (!workflow) return;
  const checkoutSha = "93cb6efe18208431cddfb8368fd83d5badbf9bfd";
  const allowedUse = `actions/checkout@${checkoutSha}`;
  const matrixJobName = "name: ssg-practices / $" + "{{ matrix.os }}";
  const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)\s*$/gm)].map((match) => match[1]);
  const requiredCommands = [
    "bun install --frozen-lockfile",
    "bun scripts/ssg-public-check.mjs",
    "bun scripts/public-integrity.mjs",
    "bun run lint",
    "bun run typecheck",
    "bun test",
  ];

  if (!/^name:\s*ssg-practices\s*$/m.test(workflow)) {
    fail.push(`${workflowPath} must be named ssg-practices`);
  }
  if (workflow.includes("pull_request_target")) {
    fail.push(`${workflowPath} must not use pull_request_target`);
  }
  if (!/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(workflow)) {
    fail.push(`${workflowPath} must set the default token to contents: read`);
  }
  if (!workflow.includes("if: github.repository == 'sigmashakeinc/sigmashake-vcs'")) {
    fail.push(`${workflowPath} must be scoped to sigmashakeinc/sigmashake-vcs`);
  }
  if (/^\s*[a-z-]+:\s*write\s*$/m.test(workflow) || /write-all/.test(workflow)) {
    fail.push(`${workflowPath} must not request write token permissions`);
  }
  if (/id-token\s*:/i.test(workflow)) {
    fail.push(`${workflowPath} must not request OIDC id-token permissions`);
  }
  if (/\$\{\{\s*secrets\./i.test(workflow) || /\bsecrets\s*:/i.test(workflow)) {
    fail.push(`${workflowPath} must not reference repository secrets`);
  }
  if (uses.length !== 1 || uses[0] !== allowedUse) {
    fail.push(`${workflowPath} may only use ${allowedUse}`);
  }
  for (const runner of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    if (!workflow.includes(`runner: ${runner}`)) {
      fail.push(`${workflowPath} missing required runner: ${runner}`);
    }
  }
  if (!workflow.includes(matrixJobName)) {
    fail.push(`${workflowPath} must expose stable branch-protection status names`);
  }
  for (const command of requiredCommands) {
    if (!workflow.includes(command)) {
      fail.push(`${workflowPath} missing required command: ${command}`);
    }
  }
  if (/\bwrangler\s+deploy\b/.test(workflow) || /\bgh\s+/.test(workflow)) {
    fail.push(`${workflowPath} must not deploy or mutate GitHub state`);
  }
  note.push("GitHub workflow policy verified");
}

function validateTextLeaks() {
  const localPathMarkers = ["/home/" + "user/", "/home/" + "nick/", "/" + "Users/"];
  const textFiles = walk(".").filter((file) => !/\.(png|jpg|jpeg|gif|ico|wasm|bin)$/i.test(file));
  for (const file of textFiles) {
    const body = readFileSync(abs(file), "utf8");
    if (localPathMarkers.some((marker) => body.includes(marker))) {
      fail.push(`absolute local path leaked in ${file}`);
    }
    if (/\b[0-9a-f]{32}\b/i.test(body)) {
      fail.push(`32-hex infrastructure identifier pattern present in ${file}`);
    }
  }
}

function sha256(relPath) {
  return createHash("sha256")
    .update(readFileSync(abs(relPath)))
    .digest("hex");
}

function validateManifest() {
  const raw = requireFile("MIRROR_MANIFEST.json");
  if (!raw) return;
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    fail.push(`MIRROR_MANIFEST.json is not valid JSON: ${err.message}`);
    return;
  }

  if (manifest.schema !== "sigmashake-vcs-public-mirror-manifest-v1") {
    fail.push("MIRROR_MANIFEST.json has an unexpected schema");
  }
  if (!/^[0-9a-f]{40}$/i.test(manifest.source_commit ?? "")) {
    fail.push("MIRROR_MANIFEST.json source_commit must be a 40-hex git commit");
  }
  if (manifest.source_rel !== "sigmashake-vcs") {
    fail.push("MIRROR_MANIFEST.json source_rel must be sigmashake-vcs");
  }
  if (manifest.transform_version !== "public-mirror-v1") {
    fail.push("MIRROR_MANIFEST.json transform_version must be public-mirror-v1");
  }
  if (!Number.isInteger(manifest.lpc_rows) || manifest.lpc_rows <= 0) {
    fail.push("MIRROR_MANIFEST.json lpc_rows must be a positive integer");
  }
  if (!Array.isArray(manifest.files)) {
    fail.push("MIRROR_MANIFEST.json files must be an array");
    return;
  }

  const actual = new Map(
    walk(".")
      .filter((file) => file !== "MIRROR_MANIFEST.json")
      .sort()
      .map((file) => [file, { size: statSync(abs(file)).size, sha256: sha256(file) }]),
  );
  const expected = new Map();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string") {
      fail.push("MIRROR_MANIFEST.json contains a file row without path");
      continue;
    }
    if (expected.has(file.path)) {
      fail.push(`MIRROR_MANIFEST.json duplicates file path: ${file.path}`);
      continue;
    }
    expected.set(file.path, file);
  }

  for (const [file, data] of actual) {
    const row = expected.get(file);
    if (!row) {
      fail.push(`MIRROR_MANIFEST.json missing file row: ${file}`);
      continue;
    }
    if (row.size !== data.size) {
      fail.push(`MIRROR_MANIFEST.json size mismatch for ${file}`);
    }
    if (row.sha256 !== data.sha256) {
      fail.push(`MIRROR_MANIFEST.json sha256 mismatch for ${file}`);
    }
  }
  for (const file of expected.keys()) {
    if (!actual.has(file)) {
      fail.push(`MIRROR_MANIFEST.json references absent file: ${file}`);
    }
  }
  note.push(`manifest covers ${expected.size}/${actual.size} files`);
}

function validateLpcCredits() {
  const lpcPrefix = "static/assets/lpc/";
  const blockerMarker = "BLOCKER" + ":";
  const pngs = new Set(
    walk("static/assets/lpc")
      .filter((file) => file.endsWith(".png"))
      .map((file) => file.slice(lpcPrefix.length))
      .sort(),
  );
  const csvText = requireFile("static/assets/lpc/CREDITS.csv");
  if (!csvText) return;
  if (csvText.toUpperCase().includes(blockerMarker)) {
    fail.push("LPC CREDITS.csv still contains a blocker sentinel");
  }

  const rows = parseCsv(csvText);
  const header = rows.shift() ?? [];
  const required = [
    "filename",
    "authors",
    "licenses",
    "urls",
    "local_path",
    "upstream_path",
    "upstream_credit_path",
    "source_credits_url",
    "change_notice",
  ];
  for (const column of required) {
    if (!header.includes(column)) {
      fail.push(`LPC CREDITS.csv missing column: ${column}`);
    }
  }
  const index = new Map(header.map((column, idx) => [column, idx]));
  const seen = new Set();
  for (const fields of rows) {
    const get = (column) => fields[index.get(column)]?.trim() ?? "";
    const localPath = get("local_path");
    if (!localPath) {
      fail.push("LPC credit row missing local_path");
      continue;
    }
    if (!pngs.has(localPath)) {
      fail.push(`LPC credit row references missing local PNG: ${localPath}`);
    }
    if (seen.has(localPath)) {
      fail.push(`LPC credit row duplicated: ${localPath}`);
    }
    seen.add(localPath);
    for (const column of required) {
      if (!get(column)) {
        fail.push(`LPC credit row ${localPath} missing ${column}`);
      }
    }
    if (get("change_notice") !== "no_changes_unmodified_upstream_asset") {
      fail.push(`LPC credit row ${localPath} has unexpected change_notice`);
    }
  }

  for (const png of pngs) {
    if (!seen.has(png)) {
      fail.push(`LPC PNG missing credit row: ${png}`);
    }
  }
  note.push(`LPC credits cover ${seen.size}/${pngs.size} PNG assets`);
}

validateNoPrivateFiles();
validatePackage();
validateGithubPolicy();
validateTextLeaks();
validateLpcCredits();
validateManifest();

if (fail.length > 0) {
  console.error("[public-integrity] FAILED");
  for (const message of fail) {
    console.error(`  - ${message}`);
  }
  process.exit(1);
}

console.log("[public-integrity] PASSED");
for (const message of note) {
  console.log(`  ${message}`);
}
