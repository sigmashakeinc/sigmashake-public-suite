#!/usr/bin/env node
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
const autoDrain = process.env.PUBLIC_SUITE_WEBHOOK_DRAIN !== "0";
const stateFile = process.env.PUBLIC_SUITE_WEBHOOK_STATE
  || path.join(homedir(), ".sigmashake", "public-suite", "webhook-deliveries.json");
const maxDeliveries = Number.parseInt(process.env.PUBLIC_SUITE_WEBHOOK_MAX_DELIVERIES || "2048", 10);

const deliveryRecords = new Map();
const jobs = new Map();
let running = false;

if (!secret) {
  console.error("GITHUB_WEBHOOK_SECRET is required");
  process.exit(1);
}

if (!Number.isInteger(maxDeliveries) || maxDeliveries < 1) {
  console.error("PUBLIC_SUITE_WEBHOOK_MAX_DELIVERIES must be a positive integer");
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

function queuedJobs() {
  return Array.from(jobs.values()).filter((job) => job.state === "queued");
}

function activeJobs() {
  return Array.from(jobs.values()).filter((job) => job.state === "running");
}

function persistState() {
  const directory = path.dirname(stateFile);
  mkdirSync(directory, { recursive: true });
  const tempFile = `${stateFile}.tmp`;
  const payload = {
    version: 2,
    deliveries: Array.from(deliveryRecords.values()),
    jobs: Array.from(jobs.values()),
  };
  writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempFile, stateFile);
}

function loadState() {
  if (!existsSync(stateFile)) return;
  const raw = readFileSync(stateFile, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `invalid webhook state at ${stateFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const deliveries = parsed?.deliveries;
  if (!Array.isArray(deliveries)) {
    throw new Error(`invalid webhook state at ${stateFile}: deliveries must be an array`);
  }
  for (const entry of deliveries) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      throw new Error(`invalid webhook state at ${stateFile}: malformed delivery record`);
    }
    deliveryRecords.set(entry.id, entry);
  }
  while (deliveryRecords.size > maxDeliveries) {
    const oldest = deliveryRecords.keys().next().value;
    if (!oldest) break;
    deliveryRecords.delete(oldest);
  }

  const loadedJobs = parsed?.jobs || [];
  if (!Array.isArray(loadedJobs)) {
    throw new Error(`invalid webhook state at ${stateFile}: jobs must be an array`);
  }
  for (const entry of loadedJobs) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      throw new Error(`invalid webhook state at ${stateFile}: malformed job record`);
    }
    const state = entry.state === "running" ? "queued" : entry.state;
    if (!["queued", "running", "completed", "failed"].includes(state)) {
      throw new Error(`invalid webhook state at ${stateFile}: malformed job state`);
    }
    jobs.set(entry.id, { ...entry, state });
  }
}

function deliveryInfo(event, payload) {
  if (event === "pull_request") {
    return {
      pr: Number.isInteger(payload.pull_request?.number) ? payload.pull_request.number : null,
      sha: typeof payload.pull_request?.head?.sha === "string" ? payload.pull_request.head.sha : null,
      reason: `pull_request.${payload.action || "unknown"}`,
    };
  }

  if (event === "workflow_run") {
    const pullRequests = Array.isArray(payload.workflow_run?.pull_requests)
      ? payload.workflow_run.pull_requests.map((pr) => pr.number).filter(Number.isInteger)
      : [];
    return {
      pr: pullRequests.length === 1 ? pullRequests[0] : null,
      sha: typeof payload.workflow_run?.head_sha === "string" ? payload.workflow_run.head_sha : null,
      reason: `workflow_run.${payload.action || "unknown"}.${payload.workflow_run?.conclusion || "unknown"}`,
    };
  }

  return { pr: null, sha: null, reason: `${event || "unknown"}` };
}

function buildDeliveryRecord(delivery, event, payload) {
  const info = deliveryInfo(event, payload);
  return {
    id: delivery,
    event,
    pr: info.pr,
    sha: info.sha,
    reason: info.reason,
    timestamp: new Date().toISOString(),
  };
}

function rememberDeliveryAndJobs(delivery, event, payload, newJobs) {
  const record = buildDeliveryRecord(delivery, event, payload);
  deliveryRecords.delete(delivery);
  deliveryRecords.set(delivery, record);
  while (deliveryRecords.size > maxDeliveries) {
    const oldest = deliveryRecords.keys().next().value;
    if (!oldest) break;
    deliveryRecords.delete(oldest);
  }

  let queued = 0;
  for (const job of newJobs) {
    const existing = jobs.get(job.id);
    if (existing?.state === "queued" || existing?.state === "running" || existing?.state === "completed") {
      continue;
    }
    jobs.set(job.id, {
      ...existing,
      ...job,
      state: "queued",
      attempts: existing?.attempts || 0,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    queued += 1;
  }

  persistState();
  if (queued > 0 && autoDrain) void drainQueue();
  return { record, queued };
}

function reviewJobId(prNumber, headSha) {
  return `review:${prNumber}:${headSha}`;
}

function deployJobId(prNumber, mergedSha) {
  return `deploy:${prNumber}:${mergedSha}`;
}

function reviewJob(prNumber, headSha, reason, delivery) {
  return {
    id: reviewJobId(prNumber, headSha),
    kind: "review",
    prNumber,
    headSha,
    reason,
    delivery,
  };
}

function deployJob(prNumber, mergedSha, baseRef, reason, delivery) {
  return {
    id: deployJobId(prNumber, mergedSha),
    kind: "deploy",
    prNumber,
    mergedSha,
    baseRef,
    reason,
    delivery,
  };
}

function reviewArgs(job) {
  const args = [path.join(trustedRoot, "scripts", "review-pr.sh"), `${job.prNumber}`];
  if (job.kind === "deploy") {
    args.push("--deploy-only", "--merged-sha", job.mergedSha);
    if (job.baseRef) args.push("--base-ref", job.baseRef);
    return args;
  }
  if (autoMerge || autoDeploy) args.push("--merge");
  if (autoDeploy) args.push("--require-deploy-ready");
  return args;
}

async function drainQueue() {
  if (running) return;
  running = true;
  try {
    let job;
    while ((job = queuedJobs()[0])) {
      jobs.set(job.id, {
        ...job,
        state: "running",
        attempts: (job.attempts || 0) + 1,
        updatedAt: new Date().toISOString(),
      });
      persistState();
      const code = await runReview(job);
      jobs.set(job.id, {
        ...jobs.get(job.id),
        state: code === 0 ? "completed" : "failed",
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        exitCode: code,
      });
      persistState();
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
    const args = reviewArgs(job);
    console.log(
      `[webhook] starting ${job.kind} PR #${job.prNumber} (${job.reason}, delivery=${job.delivery || "unknown"})`,
    );
    const child = spawn("bash", args, {
      cwd: trustedRoot,
      env: childEnv(),
      stdio: "inherit",
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        console.log(`[webhook] ${job.kind} PR #${job.prNumber} completed`);
      } else {
        console.error(`[webhook] ${job.kind} PR #${job.prNumber} failed code=${code} signal=${signal || ""}`);
      }
      resolve(code ?? 1);
    });
  });
}

function reviewJobFromPullRequest(payload, delivery) {
  const allowedActions = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);
  if (!allowedActions.has(payload.action)) return null;
  const pr = payload.pull_request;
  if (!pr || pr.draft) return null;
  const prNumber = Number.isInteger(pr.number) ? pr.number : payload.number;
  const headSha = typeof pr.head?.sha === "string" ? pr.head.sha : "";
  if (!Number.isInteger(prNumber) || !headSha) return null;
  return reviewJob(prNumber, headSha, `pull_request.${payload.action}`, delivery);
}

function deployJobFromPullRequest(payload, delivery) {
  if (!autoDeploy || payload.action !== "closed") return null;
  const pr = payload.pull_request;
  if (!pr?.merged) return null;
  const prNumber = Number.isInteger(pr.number) ? pr.number : payload.number;
  const mergedSha = typeof pr.merge_commit_sha === "string" ? pr.merge_commit_sha : "";
  const baseRef = typeof pr.base?.ref === "string" ? pr.base.ref : "";
  if (!Number.isInteger(prNumber) || !mergedSha) return null;
  return deployJob(prNumber, mergedSha, baseRef, "pull_request.closed.merged", delivery);
}

function reviewJobsFromWorkflowRun(payload, delivery) {
  if (payload.action !== "completed") return [];
  if (payload.workflow_run?.conclusion !== "success") return [];
  const headSha = typeof payload.workflow_run?.head_sha === "string" ? payload.workflow_run.head_sha : "";
  if (!headSha) return [];
  return (payload.workflow_run.pull_requests || [])
    .map((pr) => pr.number)
    .filter((number) => Number.isInteger(number))
    .map((number) => reviewJob(number, headSha, "workflow_run.success", delivery));
}

function handleEvent(event, payload, delivery) {
  if (event === "ping") return { jobs: [], message: "pong" };

  if (event === "pull_request" && triggerOnPr) {
    const nextJobs = [
      reviewJobFromPullRequest(payload, delivery),
      deployJobFromPullRequest(payload, delivery),
    ].filter(Boolean);
    return nextJobs.length
      ? { jobs: nextJobs }
      : { jobs: [], message: "pull request action ignored" };
  }

  if (event === "workflow_run" && triggerOnWorkflowSuccess) {
    return { jobs: reviewJobsFromWorkflowRun(payload, delivery) };
  }

  return { jobs: [], message: `event ignored: ${event}` };
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
      send(response, 200, { ok: true, queued: queuedJobs().length, running, active: activeJobs().length });
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
    if (!delivery) {
      send(response, 400, { ok: false, error: "missing_delivery" });
      return;
    }
    if (deliveryRecords.has(delivery)) {
      const existing = deliveryRecords.get(delivery);
      console.log(`[webhook] duplicate delivery ignored: ${delivery}`);
      send(response, 202, { ok: true, queued: 0, duplicate: true, event: existing?.event || event });
      return;
    }
    const payload = JSON.parse(body.toString("utf8"));
    const result = handleEvent(event, payload, delivery);
    const { queued } = rememberDeliveryAndJobs(delivery, event, payload, result.jobs);
    send(response, 202, { ok: true, queued, message: result.message });
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    send(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

loadState();
if (autoDrain) void drainQueue();

server.listen(port, host, () => {
  console.log(`[webhook] listening on http://${host}:${port}/github for ${suiteRepo}`);
  console.log(`[webhook] auto_merge=${autoMerge} auto_deploy=${autoDeploy}`);
  console.log(`[webhook] delivery state=${stateFile} max=${maxDeliveries}`);
});
