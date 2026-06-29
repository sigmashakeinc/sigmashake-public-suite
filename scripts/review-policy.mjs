#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    base: "origin/main",
    allowAutomationChange: process.env.ALLOW_AUTOMATION_CHANGE === "1",
    allowGeneratedServiceChange: process.env.ALLOW_GENERATED_SERVICE_CHANGE === "1",
    noDiffRequired: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") args.root = argv[++i];
    else if (arg === "--base") args.base = argv[++i];
    else if (arg === "--allow-automation-change") args.allowAutomationChange = true;
    else if (arg === "--allow-generated-service-change") args.allowGeneratedServiceChange = true;
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

function gitOk(root, args) {
  try {
    execFileSync("git", ["-C", root, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
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

const componentRepos = new Map([
  ["mmo", "https://github.com/sigmashakeinc/sigmashake-mmo"],
  ["abyss", "https://github.com/sigmashakeinc/sigmashake-abyss"],
  ["vcs", "https://github.com/sigmashakeinc/sigmashake-vcs"],
]);

function generatedComponentServiceOf(file) {
  const match = file.match(/^services\/(mmo|abyss|vcs)\//);
  return match ? match[1] : "";
}

function isSourceFile(file) {
  return /^services\/[^/]+\/(src|client|server|static|tools|integrations)\//.test(file)
    && !/\/(README|SPEC|AGENTS|RUNBOOK|CLAUDE)\.md$/.test(file);
}

function isTestFile(file) {
  return /^services\/[^/]+\/(test|integrations)\//.test(file);
}

const deniedScriptKeys = new Set([
  "deploy",
  "verify:deploy",
  "predeploy",
  "postdeploy",
  "prepublish",
  "postpublish",
  "prepare",
  "preinstall",
  "install",
  "postinstall",
]);

function isDeniedScriptKey(key) {
  return key.startsWith("deploy:") || deniedScriptKeys.has(key);
}

function inspectPackageState(root, rev, file) {
  const blobRef = `${rev}:${file}`;
  if (!gitOk(root, ["cat-file", "-e", blobRef])) {
    return { ok: true, scripts: new Map(), missing: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(git(root, ["show", blobRef]));
  } catch (error) {
    return {
      ok: false,
      reason: `${file} at ${rev} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: `${file} at ${rev} is not a JSON object` };
  }

  const scriptsValue = Object.prototype.hasOwnProperty.call(parsed, "scripts") ? parsed.scripts : {};
  if (scriptsValue === null || typeof scriptsValue !== "object" || Array.isArray(scriptsValue)) {
    return { ok: false, reason: `${file} at ${rev} has a non-object scripts field` };
  }

  const scripts = new Map();
  for (const [key, value] of Object.entries(scriptsValue)) {
    if (typeof value !== "string") {
      return { ok: false, reason: `${file} at ${rev} has a non-string script for ${key}` };
    }
    scripts.set(key, value);
  }

  return { ok: true, scripts, missing: false };
}

function checkServicePackageScriptDrift(root, base, files, allowAutomationChange) {
  const findings = [];
  const changedPackages = files.filter((file) => /^services\/[^/]+\/package\.json$/.test(file));
  for (const file of changedPackages) {
    const previous = inspectPackageState(root, base, file);
    const current = inspectPackageState(root, "HEAD", file);

    if (!previous.ok || !current.ok) {
      if (!allowAutomationChange) {
        findings.push(
          `unable to inspect ${file}: ${previous.reason || current.reason || "unknown package state error"}`,
        );
      }
      continue;
    }

    const keys = new Set([
      ...Array.from(previous.scripts.keys()).filter(isDeniedScriptKey),
      ...Array.from(current.scripts.keys()).filter(isDeniedScriptKey),
    ]);
    for (const key of keys) {
      const oldValue = previous.scripts.get(key);
      const newValue = current.scripts.get(key);
      if (oldValue === newValue) continue;
      if (!allowAutomationChange) {
        findings.push(
          `${file} changed denied script ${key} (${oldValue === undefined ? "added" : newValue === undefined ? "removed" : "modified"})`,
        );
      }
    }
  }
  return findings;
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
  for (const file of files) {
    if (deniedPath.test(file)) {
      findings.push(`blocked private/generated path changed: ${file}`);
    }
  }

  const generatedServiceChanges = new Map();
  for (const file of files) {
    const service = generatedComponentServiceOf(file);
    if (!service) continue;
    if (!generatedServiceChanges.has(service)) generatedServiceChanges.set(service, []);
    generatedServiceChanges.get(service).push(file);
  }
  if (generatedServiceChanges.size && !args.allowGeneratedServiceChange) {
    for (const [service, changed] of generatedServiceChanges.entries()) {
      findings.push(
        [
          `generated ${service} snapshot changed in public-suite: ${changed.join(", ")}`,
          `send component changes to ${componentRepos.get(service)} via fork PR;`,
          "the suite services tree is regenerated from component mirrors.",
        ].join(" "),
      );
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

  findings.push(...checkServicePackageScriptDrift(root, args.base, files, args.allowAutomationChange));

  const diff = diffText(root, args.base, args.noDiffRequired);
  const secretPatterns = [
    ["private key material", /BEGIN [A-Z ]*PRIVATE KEY/],
    ["AWS access key", /AKIA[0-9A-Z]{16}/],
    ["local operator path", /\/home\/[A-Za-z0-9_.-]+/],
    ["runtime tunnel URL", /https:\/\/[A-Za-z0-9.-]+\.trycloudflare\.com/],
    ["HMAC secret assignment", /(VCS_HMAC_KEY|MMO_HMAC_KEY|OBS_WS_PASSWORD|WRANGLER_API_TOKEN)=[A-Za-z0-9_./+=:-]{20,}/],
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
