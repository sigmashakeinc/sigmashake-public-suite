#!/usr/bin/env node
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const trustedRoot = path.resolve(scriptDir, "..");
const host = process.env.PUBLIC_SUITE_WEBHOOK_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PUBLIC_SUITE_WEBHOOK_PORT || "7918", 10);
const secret = process.env.GITHUB_WEBHOOK_SECRET || "";
const suiteRepo = process.env.SUITE_REPO || "sigmashakeinc/sigmashake-public-suite";
const autoMerge = process.env.AUTO_MERGE === "1";
const autoDeploy = process.env.AUTO_DEPLOY === "1";
const triggerOnPr = process.env.TRIGGER_ON_PR !== "0";
const triggerOnWorkflowSuccess = process.env.TRIGGER_ON_WORKFLOW_SUCCESS === "1";

const queue = [];
const queuedKeys = new Set();
const activeKeys = new Set();
let running = false;

if (!secret) {
  console.error("GITHUB_WEBHOOK_SECRET is required");
  process.exit(1);
}

function verifySignature(body, signature) {
  if (!signature || !signature.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function enqueue(prNumber, reason, delivery) {
  const key = `${prNumber}`;
  if (queuedKeys.has(key) || activeKeys.has(key)) {
    console.log(`[webhook] PR #${prNumber} already queued or running (${reason})`);
    return;
  }
  queuedKeys.add(key);
  queue.push({ prNumber, reason, delivery });
  console.log(`[webhook] queued PR #${prNumber}: ${reason}`);
  void drainQueue();
}

function reviewArgs(prNumber) {
  const args = [path.join(trustedRoot, "scripts", "review-pr.sh"), `${prNumber}`];
  if (autoMerge || autoDeploy) args.push("--merge");
  if (autoDeploy) args.push("--deploy");
  return args;
}

async function drainQueue() {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      const key = `${job.prNumber}`;
      queuedKeys.delete(key);
      activeKeys.add(key);
      try {
        await runReview(job);
      } finally {
        activeKeys.delete(key);
      }
    }
  } finally {
    running = false;
  }
}

function childEnv() {
  const env = { ...process.env, SUITE_REPO: suiteRepo };
  delete env.GITHUB_WEBHOOK_SECRET;
  return env;
}

function runReview(job) {
  return new Promise((resolve) => {
    const args = reviewArgs(job.prNumber);
    console.log(
      `[webhook] starting PR #${job.prNumber} (${job.reason}, delivery=${job.delivery || "unknown"})`,
    );
    const child = spawn("bash", args, {
      cwd: trustedRoot,
      env: childEnv(),
      stdio: "inherit",
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        console.log(`[webhook] PR #${job.prNumber} completed`);
      } else {
        console.error(`[webhook] PR #${job.prNumber} failed code=${code} signal=${signal || ""}`);
      }
      resolve();
    });
  });
}

function prFromPullRequest(payload) {
  const allowedActions = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);
  if (!allowedActions.has(payload.action)) return null;
  const pr = payload.pull_request;
  if (!pr || pr.draft) return null;
  return pr.number;
}

function prsFromWorkflowRun(payload) {
  if (payload.action !== "completed") return [];
  if (payload.workflow_run?.conclusion !== "success") return [];
  return (payload.workflow_run.pull_requests || [])
    .map((pr) => pr.number)
    .filter((number) => Number.isInteger(number));
}

function handleEvent(event, payload, delivery) {
  if (event === "ping") return { queued: 0, message: "pong" };

  if (event === "pull_request" && triggerOnPr) {
    const pr = prFromPullRequest(payload);
    if (pr) {
      enqueue(pr, `pull_request.${payload.action}`, delivery);
      return { queued: 1 };
    }
    return { queued: 0, message: "pull request action ignored" };
  }

  if (event === "workflow_run" && triggerOnWorkflowSuccess) {
    const prs = prsFromWorkflowRun(payload);
    for (const pr of prs) enqueue(pr, "workflow_run.success", delivery);
    return { queued: prs.length };
  }

  return { queued: 0, message: `event ignored: ${event}` };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error("payload too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/healthz") {
      send(response, 200, { ok: true, queued: queue.length, running, active: activeKeys.size });
      return;
    }

    if (request.method !== "POST" || request.url !== "/github") {
      send(response, 404, { ok: false, error: "not_found" });
      return;
    }

    const body = await readBody(request);
    if (!verifySignature(body, request.headers["x-hub-signature-256"])) {
      send(response, 401, { ok: false, error: "bad_signature" });
      return;
    }

    const event = request.headers["x-github-event"] || "";
    const delivery = request.headers["x-github-delivery"] || "";
    const payload = JSON.parse(body.toString("utf8"));
    const result = handleEvent(event, payload, delivery);
    send(response, 202, { ok: true, ...result });
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    send(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, () => {
  console.log(`[webhook] listening on http://${host}:${port}/github for ${suiteRepo}`);
  console.log(`[webhook] auto_merge=${autoMerge} auto_deploy=${autoDeploy}`);
});
