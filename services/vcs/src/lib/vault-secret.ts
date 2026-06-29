// vault-secret.ts — read a secret from sigmashake-vault, falling back to the
// worker's own binding. Part of the platform-wide migration onto the vault.
//
// Write-through: on a vault miss, the value resolved from the local Secrets
// Store binding is copied back into the vault, so the next read — here or in
// any other consumer — resolves vault-first. This lazily populates the vault
// during the migration window with no admin token and no one-shot export
// route. Once a secret is in the vault the write never fires again; once the
// Store binding is decommissioned there is nothing left to copy.

type VaultBinding = {
  getSecret(name: string): Promise<string | null>;
  putSecret?(name: string, value: string): Promise<unknown>;
};

/**
 * Resolve `name` vault-first. On a vault miss or error, fall back to `local`
 * (the worker's own Secrets Store binding or a plain string) and write that
 * value back into the vault (best-effort). Returns "" if neither source
 * yields a value.
 */
export async function resolveVaultSecret(
  env: { VAULT?: VaultBinding },
  name: string,
  local: { get(): Promise<string> } | string | undefined,
): Promise<string> {
  try {
    const v = await env.VAULT?.getSecret(name);
    if (typeof v === "string" && v.length > 0) return v;
  } catch {
    // vault unreachable — fall through to the local binding
  }
  let value = "";
  if (typeof local === "string") {
    value = local;
  } else if (local) {
    try {
      value = await local.get();
    } catch {
      value = "";
    }
  }
  // Write-through: seed the vault from the local fallback so subsequent reads
  // resolve vault-first. Best-effort — a failed write never affects the caller.
  const vault = env.VAULT;
  if (value.length > 0 && vault && typeof vault.putSecret === "function") {
    try {
      await vault.putSecret(name, value);
    } catch {
      // vault write failed — the read still succeeded; retry on the next miss
    }
  }
  return value;
}
