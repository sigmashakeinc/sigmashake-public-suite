const command = process.env.OBS_CHAT_OVERLAY_DEPLOY_COMMAND;
if (!command) {
  console.error("OBS_CHAT_OVERLAY_DEPLOY_COMMAND is required for host deploys");
  process.exit(1);
}
console.error(
  "Run deploy-from-host.sh with OBS_CHAT_OVERLAY_DEPLOY_COMMAND from the trusted host checkout.",
);
process.exit(1);
