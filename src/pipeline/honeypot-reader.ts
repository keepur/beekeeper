import { execFileSync } from "node:child_process";

/**
 * Read a Beekeeper-tier secret from macOS Keychain via the Honeypot
 * convention. Returns undefined if the key is not set; throws only on
 * unexpected security(1) failure modes (not on "not found").
 */
export function readBeekeeperSecret(key: string): string | undefined {
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", "honeypot", "-a", `beekeeper/${key}`, "-w"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.trim();
  } catch {
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
