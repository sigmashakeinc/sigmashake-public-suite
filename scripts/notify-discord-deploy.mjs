#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const DISCORD_WEBHOOK_ENV = "DISCORD_DEPLOY_WEBHOOK_URL";
const LOCAL_WEBHOOK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

function readDiscordWebhookUrl() {
  const rawValue = process.env[DISCORD_WEBHOOK_ENV];
  if (!rawValue) {
    return null;
  }

  let webhookUrl;
  try {
    webhookUrl = new URL(rawValue);
  } catch {
    throw new Error(`${DISCORD_WEBHOOK_ENV} must be a valid URL`);
  }

  const isLocalHttp =
    webhookUrl.protocol === "http:" && LOCAL_WEBHOOK_HOSTS.has(webhookUrl.hostname);
  if (webhookUrl.protocol !== "https:" && !isLocalHttp) {
    throw new Error(`${DISCORD_WEBHOOK_ENV} must use https`);
  }

  return webhookUrl;
}

function buildDiscordMessage({ repo, prNumber, mergedSha, deployedSha, status }) {
  return [
    `Deployment status: ${status}`,
    `Repository: ${repo}`,
    `PR: #${prNumber}`,
    `Merged SHA: ${mergedSha}`,
    `Deployed SHA: ${deployedSha}`,
  ].join("\n");
}

async function postDiscordDeployNotification() {
  const webhookUrl = readDiscordWebhookUrl();
  if (!webhookUrl) {
    console.error(`[deploy-notify] skipped: ${DISCORD_WEBHOOK_ENV} is not set`);
    return { skipped: true };
  }

  const repo = requiredEnv("SUITE_REPO");
  const prNumber = requiredEnv("PR_NUMBER");
  const mergedSha = requiredEnv("MERGED_SHA");
  const deployedSha = requiredEnv("DEPLOYED_SHA");
  const status = requiredEnv("DEPLOY_STATUS");
  const content = buildDiscordMessage({ repo, prNumber, mergedSha, deployedSha, status });

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [] },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const errorBody = (await response.text()).slice(0, 200);
    throw new Error(
      `discord webhook responded with HTTP ${response.status}${errorBody ? `: ${errorBody}` : ""}`,
    );
  }

  console.error(`[deploy-notify] sent deploy notification to Discord host ${webhookUrl.host}`);
  return { skipped: false };
}

async function main() {
  await postDiscordDeployNotification();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[deploy-notify] ${message}`);
    process.exitCode = 1;
  });
}

export { buildDiscordMessage, postDiscordDeployNotification, readDiscordWebhookUrl };
