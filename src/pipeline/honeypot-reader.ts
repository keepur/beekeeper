import { execFileSync } from "node:child_process";
import { createLogger } from "../logging/logger.js";

const log = createLogger("honeypot-reader");

/** macOS `security` exit code for "the specified item could not be found in the keychain". */
const SECURITY_ITEM_NOT_FOUND = 44;

/**
 * Read a Beekeeper-tier secret from macOS Keychain via the Honeypot
 * convention. Honeypot stores beekeeper-tier entries as
 * `service=beekeeper/<KEY>, account=<KEY>` (matches the per-instance
 * `service=hive/<id>/<KEY>, account=<KEY>` shape used elsewhere by
 * `scripts/honeypot`). Returns undefined when the key is not set;
 * unexpected `security(1)` failures are logged at warn level and also
 * return undefined so callers can fall back gracefully.
 */
export function readBeekeeperSecret(key: string): string | undefined {
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", `beekeeper/${key}`, "-a", key, "-w"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.trim();
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status === SECURITY_ITEM_NOT_FOUND) return undefined;
    // Anything else — missing security binary, locked keychain, permission
    // denied — is unexpected. Log it so the operator can debug, but still
    // return undefined so the caller's missing-key guard can fire cleanly.
    log.warn("Unexpected security(1) failure", {
      key: `beekeeper/${key}`,
      status,
      error: (err as Error)?.message ?? String(err),
    });
    return undefined;
  }
}

/**
 * Resolve a secret env-first, Honeypot-fallback. Mirrors Hive's config.ts
 * resolution pattern for cross-instance Beekeeper secrets.
 */
export function resolveBeekeeperSecret(key: string): string | undefined {
  return process.env[key] ?? readBeekeeperSecret(key);
}
