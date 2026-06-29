import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import http from "node:http";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { postDiscordDeployNotification } from "../scripts/notify-discord-deploy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reviewPolicy = path.join(repoRoot, "scripts", "review-policy.mjs");
const deployFromHost = path.join(repoRoot, "scripts", "deploy-from-host.sh");
const reviewPr = path.join(repoRoot, "scripts", "review-pr.sh");
const webhookServer = path.join(repoRoot, "scripts", "webhook-server.mjs");
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

async function withEnv(overrides, callback) {
  const original = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    original.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of original.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function captureConsoleError(callback) {
  const messages = [];
  const original = console.error;
  console.error = (...args) => {
    messages.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    const result = await callback();
    return {
      result,
      stderr: messages.join("\n"),
    };
  } finally {
    console.error = original;
  }
}

function createGitRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "public-suite-hardening-"));
  mkdirSync(path.join(root, "services", "vcs"), { recursive: true });
  run("git", ["init", "-b", "main"], { cwd: root });
  run("git", ["config", "user.name", "Codex Test"], { cwd: root });
  run("git", ["config", "user.email", "codex@example.com"], { cwd: root });
  return root;
}

function writeServicePackage(root, scripts) {
  const file = path.join(root, "services", "vcs", "package.json");
  writeFileSync(
    file,
    `${JSON.stringify({ name: "vcs", version: "1.0.0", scripts }, null, 2)}\n`,
  );
}

function gitCommit(root, message) {
  run("git", ["add", "."], { cwd: root });
  run("git", ["commit", "-m", message], { cwd: root });
}

function execExpectFailure(command, args, options = {}) {
  const expectedStatus = options.expectedStatus ?? 1;
  const execOptions = { ...options };
  delete execOptions.expectedStatus;
  try {
    run(command, args, execOptions);
    assert.fail(`expected failure from ${command} ${args.join(" ")}`);
  } catch (error) {
    assert.equal(error.status, expectedStatus);
    return {
      stdout: error.stdout?.toString("utf8") || "",
      stderr: error.stderr?.toString("utf8") || "",
    };
  }
}

function createCommandFixtureBin(responses) {
  const root = mkdtempSync(path.join(os.tmpdir(), "public-suite-bin-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const logFile = path.join(root, "commands.log");
  const responseFile = path.join(root, "responses.json");
  writeFileSync(responseFile, `${JSON.stringify(responses)}\n`);
  const fixture = path.join(bin, "gh");
  writeFileSync(
    fixture,
    `#!/usr/bin/env node
const fs = require("node:fs");
const logFile = process.env.PUBLIC_SUITE_FIXTURE_LOG;
const responses = JSON.parse(fs.readFileSync(process.env.PUBLIC_SUITE_FIXTURE_RESPONSES, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(logFile, JSON.stringify(args) + "\\n");
const key = args.join(" ");
if (Object.prototype.hasOwnProperty.call(responses, key)) {
  process.stdout.write(String(responses[key]));
  process.exit(0);
}
if (args[0] === "api") process.exit(0);
console.error("unexpected gh command: " + key);
process.exit(1);
`,
  );
  chmodSync(fixture, 0o755);
  return { root, bin, logFile, responseFile };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("expected TCP server address")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function waitForOutput(stream, pattern) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${pattern}`));
    }, 5000);
    const onData = (chunk) => {
      output += chunk.toString("utf8");
      if (pattern.test(output)) {
        cleanup();
        resolve(output);
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off("data", onData);
    };
    stream.on("data", onData);
  });
}

function postWebhookPayload(port, secret, delivery, event, payload, options = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  const signature = options.badSignature
    ? "sha256=0000000000000000000000000000000000000000000000000000000000000000"
    : `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/github",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
          "x-github-event": event,
          "x-github-delivery": delivery,
          "x-hub-signature-256": signature,
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            body: JSON.parse(responseBody),
          });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

function postWebhook(port, secret, delivery, options = {}) {
  return postWebhookPayload(
    port,
    secret,
    delivery,
    "ping",
    { zen: "Keep it logically awesome." },
    options,
  );
}

function pullRequestPayload(action, overrides = {}) {
  return {
    action,
    number: overrides.number || 7,
    pull_request: {
      number: overrides.number || 7,
      draft: overrides.draft || false,
      merged: overrides.merged || false,
      merge_commit_sha: overrides.mergeCommitSha || null,
      head: { sha: overrides.headSha || "1111111111111111111111111111111111111111" },
      base: { ref: overrides.baseRef || "main" },
    },
  };
}

async function getHealth(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/healthz`, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject);
  });
}

async function startWebhookServer(port, secret, stateFile, envOverrides = {}) {
  const child = spawn(process.execPath, [webhookServer], {
    cwd: repoRoot,
    env: {
      ...process.env,
      GITHUB_WEBHOOK_SECRET: secret,
      PUBLIC_SUITE_WEBHOOK_HOST: "127.0.0.1",
      PUBLIC_SUITE_WEBHOOK_PORT: String(port),
      PUBLIC_SUITE_WEBHOOK_STATE: stateFile,
      PUBLIC_SUITE_WEBHOOK_MAX_DELIVERIES: "8",
      AUTO_MERGE: "0",
      AUTO_DEPLOY: "0",
      TRIGGER_ON_PR: "0",
      TRIGGER_ON_WORKFLOW_SUCCESS: "0",
      ...envOverrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForOutput(child.stdout, /listening/);
  return child;
}

async function stopChild(child) {
  child.kill("SIGTERM");
  await once(child, "close");
}

test("review-policy blocks denied service package deploy script drift", () => {
  const root = createGitRepo();
  try {
    writeServicePackage(root, { test: "node --test" });
    gitCommit(root, "base");
    writeServicePackage(root, { test: "node --test", deploy: "node deploy.mjs" });
    gitCommit(root, "add deploy");

    const result = execExpectFailure(
      "node",
      [reviewPolicy, "--root", root, "--base", "HEAD~1"],
      { cwd: repoRoot },
    );
    assert.match(result.stderr, /changed denied script deploy \(added\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-policy blocks malformed changed service package state", () => {
  const root = createGitRepo();
  try {
    writeServicePackage(root, { test: "node --test" });
    gitCommit(root, "base");
    writeFileSync(path.join(root, "services", "vcs", "package.json"), "{ invalid json\n");
    gitCommit(root, "malformed package");

    const result = execExpectFailure(
      "node",
      [reviewPolicy, "--root", root, "--base", "HEAD~1"],
      { cwd: repoRoot },
    );
    assert.match(result.stderr, /not valid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-policy blocks direct generated MMO snapshot changes", () => {
  const root = createGitRepo();
  try {
    writeFileSync(path.join(root, "README.md"), "fixture\n");
    gitCommit(root, "base");
    mkdirSync(path.join(root, "services", "mmo", "server"), { recursive: true });
    writeFileSync(path.join(root, "services", "mmo", "server", "server.js"), "export {};\n");
    gitCommit(root, "edit generated mmo service");

    const result = execExpectFailure(
      "node",
      [reviewPolicy, "--root", root, "--base", "HEAD~1"],
      { cwd: repoRoot },
    );
    assert.match(result.stderr, /generated mmo snapshot changed in public-suite/);
    assert.match(result.stderr, /https:\/\/github\.com\/sigmashakeinc\/sigmashake-mmo/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-policy blocks direct generated VCS snapshot changes", () => {
  const root = createGitRepo();
  try {
    writeFileSync(path.join(root, "README.md"), "fixture\n");
    gitCommit(root, "base");
    mkdirSync(path.join(root, "services", "vcs", "src"), { recursive: true });
    writeFileSync(path.join(root, "services", "vcs", "src", "index.ts"), "export {};\n");
    gitCommit(root, "edit generated vcs service");

    const result = execExpectFailure(
      "node",
      [reviewPolicy, "--root", root, "--base", "HEAD~1"],
      { cwd: repoRoot },
    );
    assert.match(result.stderr, /generated vcs snapshot changed in public-suite/);
    assert.match(result.stderr, /https:\/\/github\.com\/sigmashakeinc\/sigmashake-vcs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-policy blocks generated component documentation changes", () => {
  const root = createGitRepo();
  try {
    writeFileSync(path.join(root, "README.md"), "fixture\n");
    gitCommit(root, "base");
    mkdirSync(path.join(root, "services", "abyss"), { recursive: true });
    writeFileSync(path.join(root, "services", "abyss", "README.md"), "component docs\n");
    gitCommit(root, "edit generated abyss docs");

    const result = execExpectFailure(
      "node",
      [reviewPolicy, "--root", root, "--base", "HEAD~1"],
      { cwd: repoRoot },
    );
    assert.match(result.stderr, /generated abyss snapshot changed in public-suite/);
    assert.match(result.stderr, /https:\/\/github\.com\/sigmashakeinc\/sigmashake-abyss/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-policy accepts generated component changes only with explicit override", () => {
  const root = createGitRepo();
  try {
    writeFileSync(path.join(root, "README.md"), "fixture\n");
    gitCommit(root, "base");
    mkdirSync(path.join(root, "services", "vcs", "src"), { recursive: true });
    mkdirSync(path.join(root, "services", "vcs", "test"), { recursive: true });
    writeFileSync(path.join(root, "services", "vcs", "src", "index.ts"), "export {};\n");
    writeFileSync(path.join(root, "services", "vcs", "test", "index.test.ts"), "export {};\n");
    gitCommit(root, "edit generated vcs with tests");

    const output = run(
      "node",
      [reviewPolicy, "--root", root, "--base", "HEAD~1", "--allow-generated-service-change"],
      { cwd: repoRoot },
    );
    assert.match(output, /\[review-policy\] passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-policy accepts generated component changes with explicit env override", () => {
  const root = createGitRepo();
  try {
    writeFileSync(path.join(root, "README.md"), "fixture\n");
    gitCommit(root, "base");
    mkdirSync(path.join(root, "services", "mmo", "test"), { recursive: true });
    writeFileSync(path.join(root, "services", "mmo", "test", "fixture.test.js"), "export {};\n");
    gitCommit(root, "edit generated mmo test");

    const output = run(
      "node",
      [reviewPolicy, "--root", root, "--base", "HEAD~1"],
      {
        cwd: repoRoot,
        env: { ...process.env, ALLOW_GENERATED_SERVICE_CHANGE: "1" },
      },
    );
    assert.match(output, /\[review-policy\] passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-policy allows root suite documentation changes", () => {
  const root = createGitRepo();
  try {
    writeFileSync(path.join(root, "README.md"), "fixture\n");
    gitCommit(root, "base");
    writeFileSync(path.join(root, "README.md"), "suite docs update\n");
    gitCommit(root, "edit suite docs");

    const output = run(
      "node",
      [reviewPolicy, "--root", root, "--base", "HEAD~1"],
      { cwd: repoRoot },
    );
    assert.match(output, /\[review-policy\] passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deploy-from-host refuses missing host deploy commands", () => {
  const root = createGitRepo();
  try {
    writeFileSync(path.join(root, "README.md"), "fixture\n");
    gitCommit(root, "base");

    const result = execExpectFailure(
      "bash",
      [deployFromHost, "--root", root, "--confirm", "--services", "vcs", "--skip-verify"],
      {
        cwd: repoRoot,
        env: { ...process.env },
      },
    );
    assert.match(result.stderr, /VCS_DEPLOY_COMMAND: must be set to an absolute host script path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deploy-from-host refuses repo-local deploy command paths", () => {
  const root = createGitRepo();
  try {
    const localScript = path.join(root, "deploy.sh");
    writeFileSync(localScript, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(localScript, 0o755);
    gitCommit(root, "base");

    const result = execExpectFailure(
      "bash",
      [deployFromHost, "--root", root, "--confirm", "--services", "vcs", "--skip-verify"],
      {
        cwd: repoRoot,
        env: { ...process.env, VCS_DEPLOY_COMMAND: localScript },
      },
    );
    assert.match(result.stderr, /must point outside the repository root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deploy-from-host refuses symlink deploy command paths", () => {
  const root = createGitRepo();
  const hostDir = mkdtempSync(path.join(os.tmpdir(), "public-suite-host-command-"));
  try {
    const realScript = path.join(hostDir, "real-deploy.sh");
    const linkScript = path.join(hostDir, "deploy-link.sh");
    writeFileSync(realScript, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(realScript, 0o755);
    symlinkSync(realScript, linkScript);
    writeFileSync(path.join(root, "README.md"), "fixture\n");
    gitCommit(root, "base");

    const result = execExpectFailure(
      "bash",
      [deployFromHost, "--root", root, "--confirm", "--services", "vcs", "--skip-verify"],
      {
        cwd: repoRoot,
        env: { ...process.env, VCS_DEPLOY_COMMAND: linkScript },
      },
    );
    assert.match(result.stderr, /must not be a symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(hostDir, { recursive: true, force: true });
  }
});

test("deploy-from-host refuses unexpected deployment revision", () => {
  const root = createGitRepo();
  try {
    writeFileSync(path.join(root, "README.md"), "fixture\n");
    gitCommit(root, "base");

    const result = execExpectFailure(
      "bash",
      [
        deployFromHost,
        "--root",
        root,
        "--confirm",
        "--services",
        "vcs",
        "--skip-verify",
        "--expected-sha",
        "0000000000000000000000000000000000000000",
      ],
      { cwd: repoRoot, env: { ...process.env } },
    );
    assert.match(result.stderr, /refusing to deploy unexpected revision/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deploy-from-host validate-only checks commands without running them", () => {
  const root = createGitRepo();
  const hostDir = mkdtempSync(path.join(os.tmpdir(), "public-suite-host-command-"));
  try {
    writeFileSync(path.join(root, "README.md"), "fixture\n");
    gitCommit(root, "base");
    const marker = path.join(hostDir, "ran");
    const deployScript = path.join(hostDir, "deploy.sh");
    const verifyScript = path.join(hostDir, "verify.sh");
    writeFileSync(deployScript, `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\n`);
    writeFileSync(verifyScript, `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\n`);
    chmodSync(deployScript, 0o755);
    chmodSync(verifyScript, 0o755);

    const output = run(
      "bash",
      [deployFromHost, "--root", root, "--confirm", "--services", "vcs", "--validate-only"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          VCS_DEPLOY_COMMAND: deployScript,
          VCS_VERIFY_COMMAND: verifyScript,
        },
      },
    );
    assert.match(output, /validation complete/);
    assert.equal(run("test", ["!", "-e", marker], { cwd: repoRoot }), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(hostDir, { recursive: true, force: true });
  }
});

test("review-pr refuses auto-merge for automation-change overrides", () => {
  const result = execExpectFailure("bash", [reviewPr, "1", "--merge"], {
    cwd: repoRoot,
    env: { ...process.env, ALLOW_AUTOMATION_CHANGE: "1" },
  });
  assert.match(result.stderr, /refusing --merge\/--deploy when ALLOW_AUTOMATION_CHANGE=1/);
});

test("review-pr refuses auto-merge for generated-service overrides", () => {
  const result = execExpectFailure("bash", [reviewPr, "1", "--merge"], {
    cwd: repoRoot,
    env: { ...process.env, ALLOW_GENERATED_SERVICE_CHANGE: "1" },
  });
  assert.match(result.stderr, /refusing --merge\/--deploy when ALLOW_GENERATED_SERVICE_CHANGE=1/);
});

test("review-pr refuses deploy-only for automation-change overrides", () => {
  const result = execExpectFailure(
    "bash",
    [
      reviewPr,
      "1",
      "--deploy-only",
      "--merged-sha",
      "1111111111111111111111111111111111111111",
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, ALLOW_AUTOMATION_CHANGE: "1" },
    },
  );
  assert.match(result.stderr, /refusing --merge\/--deploy when ALLOW_AUTOMATION_CHANGE=1/);
});

test("review-pr deploy-only exits nonzero when deploy command fails", () => {
  const root = createGitRepo();
  const hostDir = mkdtempSync(path.join(os.tmpdir(), "public-suite-host-command-"));
  const fixture = createCommandFixtureBin({});
  try {
    writeFileSync(path.join(root, "README.md"), "fixture\n");
    gitCommit(root, "base");
    const sha = run("git", ["rev-parse", "HEAD"], { cwd: root }).trim();
    const remote = path.join(hostDir, "remote.git");
    run("git", ["clone", "--bare", root, remote], { cwd: hostDir });
    const failScript = path.join(hostDir, "deploy-fail.sh");
    const okScript = path.join(hostDir, "verify-ok.sh");
    writeFileSync(failScript, "#!/usr/bin/env bash\nexit 7\n");
    writeFileSync(okScript, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(failScript, 0o755);
    chmodSync(okScript, 0o755);

    const result = execExpectFailure(
      "bash",
      [reviewPr, "21", "--deploy-only", "--merged-sha", sha, "--base-ref", "main"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fixture.bin}:${process.env.PATH}`,
          PUBLIC_SUITE_FIXTURE_LOG: fixture.logFile,
          PUBLIC_SUITE_FIXTURE_RESPONSES: fixture.responseFile,
          SUITE_REPO: remote,
          SUITE_REPO_CLONE_URL: remote,
          VCS_DEPLOY_COMMAND: failScript,
          ABYSS_DEPLOY_COMMAND: failScript,
          MMO_DEPLOY_COMMAND: failScript,
          VCS_VERIFY_COMMAND: okScript,
          ABYSS_VERIFY_COMMAND: okScript,
          MMO_VERIFY_COMMAND: okScript,
        },
        expectedStatus: 7,
      },
    );

    assert.equal(result.stdout.includes("sigmashake/public-suite-deploy"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(hostDir, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("review-pr deploy path does not fall back to origin base head", () => {
  const source = readFileSync(reviewPr, "utf8");
  assert.match(source, /unable to resolve merged commit SHA/);
  assert.doesNotMatch(source, /MERGED_SHA="\$\(git rev-parse "origin\/\$BASE_REF"\)"/);
});

test("webhook-server requires HMAC and persistently rejects duplicate deliveries", async () => {
  const port = await freePort();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "public-suite-webhook-state-"));
  const secret = "test-webhook-secret";
  const stateFile = path.join(stateDir, "deliveries.json");
  let child;

  try {
    child = await startWebhookServer(port, secret, stateFile);
    const rejected = await postWebhook(port, secret, "bad-delivery", { badSignature: true });
    const first = await postWebhook(port, secret, "delivery-one");
    await stopChild(child);
    child = await startWebhookServer(port, secret, stateFile);
    const second = await postWebhook(port, secret, "delivery-one");

    assert.equal(rejected.status, 401);
    assert.deepEqual(rejected.body, { ok: false, error: "bad_signature" });
    assert.equal(first.status, 202);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.queued, 0);
    assert.equal(second.status, 202);
    assert.deepEqual(
      {
        ok: second.body.ok,
        queued: second.body.queued,
        duplicate: second.body.duplicate,
        event: second.body.event,
      },
      { ok: true, queued: 0, duplicate: true, event: "ping" },
    );
  } finally {
    if (child && child.exitCode === null) {
      await stopChild(child);
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("webhook-server persists queued review jobs with deliveries before ack", async () => {
  const port = await freePort();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "public-suite-webhook-state-"));
  const secret = "test-webhook-secret";
  const stateFile = path.join(stateDir, "deliveries.json");
  let child;

  try {
    child = await startWebhookServer(port, secret, stateFile, {
      PUBLIC_SUITE_WEBHOOK_DRAIN: "0",
      TRIGGER_ON_PR: "1",
    });
    const first = await postWebhookPayload(
      port,
      secret,
      "delivery-review-one",
      "pull_request",
      pullRequestPayload("opened", {
        number: 11,
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    );
    await stopChild(child);

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(first.status, 202);
    assert.equal(first.body.queued, 1);
    assert.equal(state.deliveries.length, 1);
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].id, "review:11:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(state.jobs[0].state, "queued");

    child = await startWebhookServer(port, secret, stateFile, {
      PUBLIC_SUITE_WEBHOOK_DRAIN: "0",
      TRIGGER_ON_PR: "1",
    });
    const health = await getHealth(port);
    const duplicate = await postWebhookPayload(
      port,
      secret,
      "delivery-review-one",
      "pull_request",
      pullRequestPayload("opened", {
        number: 11,
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    );

    assert.equal(health.queued, 1);
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.queued, 0);
  } finally {
    if (child && child.exitCode === null) {
      await stopChild(child);
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("webhook-server keeps newer PR heads queued instead of dropping active updates", async () => {
  const port = await freePort();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "public-suite-webhook-state-"));
  const secret = "test-webhook-secret";
  const stateFile = path.join(stateDir, "deliveries.json");
  let child;

  try {
    child = await startWebhookServer(port, secret, stateFile, {
      PUBLIC_SUITE_WEBHOOK_DRAIN: "0",
      TRIGGER_ON_PR: "1",
    });
    await postWebhookPayload(
      port,
      secret,
      "delivery-review-old",
      "pull_request",
      pullRequestPayload("opened", {
        number: 12,
        headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    );
    const newer = await postWebhookPayload(
      port,
      secret,
      "delivery-review-new",
      "pull_request",
      pullRequestPayload("synchronize", {
        number: 12,
        headSha: "cccccccccccccccccccccccccccccccccccccccc",
      }),
    );
    const health = await getHealth(port);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));

    assert.equal(newer.body.queued, 1);
    assert.equal(health.queued, 2);
    assert.deepEqual(
      state.jobs.map((job) => job.id).sort(),
      [
        "review:12:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "review:12:cccccccccccccccccccccccccccccccccccccccc",
      ],
    );
  } finally {
    if (child && child.exitCode === null) {
      await stopChild(child);
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("webhook-server queues deploy-only jobs for merged PR events", async () => {
  const port = await freePort();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "public-suite-webhook-state-"));
  const secret = "test-webhook-secret";
  const stateFile = path.join(stateDir, "deliveries.json");
  let child;

  try {
    child = await startWebhookServer(port, secret, stateFile, {
      AUTO_DEPLOY: "1",
      PUBLIC_SUITE_WEBHOOK_DRAIN: "0",
      TRIGGER_ON_PR: "1",
    });
    const merged = await postWebhookPayload(
      port,
      secret,
      "delivery-merged",
      "pull_request",
      pullRequestPayload("closed", {
        number: 13,
        merged: true,
        mergeCommitSha: "dddddddddddddddddddddddddddddddddddddddd",
      }),
    );
    const state = JSON.parse(readFileSync(stateFile, "utf8"));

    assert.equal(merged.body.queued, 1);
    assert.equal(state.jobs.length, 1);
    assert.deepEqual(
      {
        id: state.jobs[0].id,
        kind: state.jobs[0].kind,
        prNumber: state.jobs[0].prNumber,
        mergedSha: state.jobs[0].mergedSha,
      },
      {
        id: "deploy:13:dddddddddddddddddddddddddddddddddddddddd",
        kind: "deploy",
        prNumber: 13,
        mergedSha: "dddddddddddddddddddddddddddddddddddddddd",
      },
    );
  } finally {
    if (child && child.exitCode === null) {
      await stopChild(child);
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("notify-discord-deploy posts merged deploy metadata without exposing the webhook", async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });
      response.writeHead(204).end();
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected TCP server address");
    }

    const { result, stderr } = await withEnv(
      {
        DISCORD_DEPLOY_WEBHOOK_URL: `http://127.0.0.1:${address.port}/discord-webhook`,
        SUITE_REPO: "sigmashakeinc/sigmashake-public-suite",
        PR_NUMBER: "42",
        MERGED_SHA: "abc123",
        DEPLOYED_SHA: "def456",
        DEPLOY_STATUS: "deployed",
      },
      () => captureConsoleError(() => postDiscordDeployNotification()),
    );

    assert.equal(requests.length, 1);
    assert.deepEqual(result, { skipped: false });
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].headers["content-type"], "application/json");
    assert.doesNotMatch(stderr, /discord-webhook/);

    const payload = JSON.parse(requests[0].body);
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    assert.equal(
      payload.content,
      [
        "Deployment status: deployed",
        "Repository: sigmashakeinc/sigmashake-public-suite",
        "PR: #42",
        "Merged SHA: abc123",
        "Deployed SHA: def456",
      ].join("\n"),
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("notify-discord-deploy skips cleanly when the webhook env var is unset", async () => {
  const { result, stderr } = await withEnv(
    {
      DISCORD_DEPLOY_WEBHOOK_URL: undefined,
    },
    () => captureConsoleError(() => postDiscordDeployNotification()),
  );
  assert.deepEqual(result, { skipped: true });
  assert.match(stderr, /DISCORD_DEPLOY_WEBHOOK_URL is not set/);
});
