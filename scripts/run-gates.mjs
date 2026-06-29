#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";

function parseArgs(argv) {
  const args = {
    categories: [],
    gates: new Set(),
    continueOnFail: false,
    skipHeavy: false,
    allowMissingServices: false,
    list: false,
    root: process.cwd(),
    json: "",
    manifest: "",
    sandbox: process.env.PUBLIC_SUITE_GATE_SANDBOX || "env",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--category") args.categories.push(argv[++i]);
    else if (arg === "--gate") args.gates.add(argv[++i]);
    else if (arg === "--root") args.root = argv[++i];
    else if (arg === "--manifest") args.manifest = argv[++i];
    else if (arg === "--json") args.json = argv[++i];
    else if (arg === "--sandbox") args.sandbox = argv[++i];
    else if (arg === "--continue-on-fail") args.continueOnFail = true;
    else if (arg === "--skip-heavy") args.skipHeavy = true;
    else if (arg === "--allow-missing-services") args.allowMissingServices = true;
    else if (arg === "--list") args.list = true;
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!["env", "bwrap", "off"].includes(args.sandbox)) {
    throw new Error(`Unknown sandbox mode: ${args.sandbox}`);
  }
  return args;
}

function normalizeCategory(category) {
  if (category === "test") return "tests";
  return category;
}

function gateSets(manifest, args) {
  const categories = args.categories.length
    ? args.categories.map(normalizeCategory)
    : ["bootstrap", "preflight", "tests"];

  return categories.flatMap((category) => {
    const gates = manifest[category];
    if (!Array.isArray(gates)) throw new Error(`Unknown gate category: ${category}`);
    return gates.map((gate) => ({ ...gate, category }));
  });
}

function printList(gates) {
  for (const gate of gates) {
    const heavy = gate.heavy ? " heavy" : "";
    console.log(`${gate.category}/${gate.id}${heavy}: ${gate.name}`);
    for (const command of gate.commands ?? []) {
      console.log(`  - ${command.service}: (${command.cwd || "."}) ${command.cmd}`);
    }
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function runtimePath() {
  const nodeBin = path.dirname(process.execPath);
  const bunBin = path.join(process.env.HOME || "", ".bun", "bin");
  return unique([
    existsSync(nodeBin) ? nodeBin : "",
    existsSync(bunBin) ? bunBin : "",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/local/sbin",
    "/usr/sbin",
    "/sbin",
  ]).join(":");
}

function safeEnv(home) {
  const env = {
    CI: process.env.CI || "1",
    HOME: home,
    TMPDIR: "/tmp",
    PATH: runtimePath(),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  };
  for (const key of ["LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function addDirMount(args, dir) {
  if (existsSync(dir)) args.push("--ro-bind", dir, dir);
}

function addHomeRuntimeMount(args, runtimeRoot) {
  if (!runtimeRoot || !existsSync(runtimeRoot)) return;
  const parts = runtimeRoot.split(path.sep).filter(Boolean);
  let cursor = "";
  for (const part of parts.slice(0, -1)) {
    cursor += `${path.sep}${part}`;
    args.push("--dir", cursor);
  }
  args.push("--ro-bind", runtimeRoot, runtimeRoot);
}

function addRuntimeMounts(args) {
  addHomeRuntimeMount(args, path.dirname(path.dirname(process.execPath)));
  addHomeRuntimeMount(args, path.join(process.env.HOME || "", ".bun"));
}

function runBwrap(root, cwd, cmd) {
  const relCwd = path.relative(root, cwd);
  if (relCwd.startsWith("..") || path.isAbsolute(relCwd)) {
    throw new Error(`Gate command cwd escapes root: ${cwd}`);
  }
  if (!existsSync("/usr/bin/bwrap")) {
    throw new Error("Bubblewrap sandbox is required for host PR review gates");
  }

  const args = [
    "--die-with-parent",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/tmp/home",
    "--dir",
    "/workspace",
  ];
  for (const dir of ["/usr", "/bin", "/lib", "/lib64", "/etc"]) addDirMount(args, dir);
  addDirMount(args, "/run/systemd/resolve");
  addRuntimeMounts(args);
  args.push(
    "--bind",
    root,
    "/workspace",
    "--chdir",
    path.posix.join("/workspace", relCwd),
    "/usr/bin/env",
    "-i",
  );
  for (const [key, value] of Object.entries(safeEnv("/tmp/home"))) {
    args.push(`${key}=${value}`);
  }
  args.push("/bin/sh", "-lc", cmd);
  return spawnSync("/usr/bin/bwrap", args, {
    env: {},
    stdio: "inherit",
  });
}

function runCommand(root, command, sandbox) {
  const cwd = path.resolve(root, command.cwd || ".");
  if (!existsSync(cwd)) {
    return {
      status: "missing",
      code: 127,
      service: command.service,
      cwd,
      cmd: command.cmd,
      durationMs: 0,
    };
  }

  const started = Date.now();
  console.log(`\n[gate] ${command.service}: ${command.cmd}`);
  console.log(`[gate] cwd: ${cwd}`);
  let result;
  let tempHome = "";
  try {
    if (sandbox === "bwrap") {
      result = runBwrap(root, cwd, command.cmd);
    } else {
      tempHome = mkdtempSync(path.join(os.tmpdir(), "public-suite-gate-home."));
      result = spawnSync(command.cmd, {
        cwd,
        env: sandbox === "off" ? { ...process.env, CI: process.env.CI || "1" } : safeEnv(tempHome),
        shell: true,
        stdio: "inherit",
      });
    }
  } finally {
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  }

  return {
    status: result.status === 0 ? "passed" : "failed",
    code: result.status ?? 1,
    signal: result.signal || "",
    service: command.service,
    cwd,
    cmd: command.cmd,
    durationMs: Date.now() - started,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  const manifestPath = path.resolve(
    args.manifest || path.join(root, "config", "pr-gates.json"),
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let gates = gateSets(manifest, args);

  if (args.gates.size) {
    gates = gates.filter((gate) => args.gates.has(gate.id));
  }

  if (args.list) {
    printList(gates);
    return;
  }

  const results = [];
  let failed = false;
  let skipped = 0;

  for (const gate of gates) {
    if (args.skipHeavy && gate.heavy) {
      console.log(`\n[gate] SKIP heavy gate ${gate.category}/${gate.id}`);
      results.push({ gate: gate.id, category: gate.category, status: "skipped-heavy" });
      skipped += 1;
      continue;
    }

    console.log(`\n[gate] START ${gate.category}/${gate.id}: ${gate.name}`);
    const commandResults = [];
    for (const command of gate.commands ?? []) {
      const result = runCommand(root, command, args.sandbox);
      commandResults.push(result);
      if (result.status === "missing") {
        const message = `[gate] missing service path for ${command.service}: ${result.cwd}`;
        if (args.allowMissingServices || command.optional) {
          console.log(`${message} (skipped)`);
        } else {
          console.error(message);
          failed = true;
          if (!args.continueOnFail) {
            results.push({ gate: gate.id, category: gate.category, status: "failed", commands: commandResults });
            throw new Error(`Gate failed: ${gate.id}`);
          }
        }
      } else if (result.status !== "passed") {
        failed = true;
        if (!args.continueOnFail) {
          results.push({ gate: gate.id, category: gate.category, status: "failed", commands: commandResults });
          throw new Error(`Gate failed: ${gate.id}`);
        }
      }
    }

    const status = commandResults.every((result) => result.status === "passed")
      ? "passed"
      : "failed";
    results.push({ gate: gate.id, category: gate.category, status, commands: commandResults });
    console.log(`[gate] ${status.toUpperCase()} ${gate.category}/${gate.id}`);
  }

  if (args.json) {
    writeFileSync(
      path.resolve(args.json),
      `${JSON.stringify({ root, manifestPath, sandbox: args.sandbox, skipped, results }, null, 2)}\n`,
    );
  }

  const passed = results.filter((result) => result.status === "passed").length;
  const total = results.length;
  console.log(`\n[gate] summary: ${passed}/${total} passed, ${skipped} skipped`);
  if (failed) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
