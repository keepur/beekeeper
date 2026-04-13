import { createLogger } from "./logging/logger.js";

const log = createLogger("beekeeper-capabilities");

export interface CapabilityEntry {
  name: string;
  localWsUrl: string;
  healthUrl: string;
  consecutiveFailures: number;
  lastCheckedAt: number | null;
  addedAt: number;
}

export interface RegisterInput {
  name: string;
  localWsUrl: string;
  healthUrl: string;
}

const BEEKEEPER_NAME = "beekeeper";
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_FAILURE_THRESHOLD = 2;

export class CapabilityManifest {
  private entries = new Map<string, CapabilityEntry>();
  private timer: NodeJS.Timeout | null = null;

  /**
   * Register (or idempotently upsert) a capability. Resets its failure count.
   * `beekeeper` is reserved and cannot be registered here — it is always
   * implicitly present via `list()`.
   */
  register(input: RegisterInput): CapabilityEntry {
    if (input.name === BEEKEEPER_NAME) {
      throw new Error(`Cannot register reserved capability name: ${BEEKEEPER_NAME}`);
    }

    const existing = this.entries.get(input.name);
    const now = Date.now();
    const entry: CapabilityEntry = {
      name: input.name,
      localWsUrl: input.localWsUrl,
      healthUrl: input.healthUrl,
      consecutiveFailures: 0,
      lastCheckedAt: existing?.lastCheckedAt ?? null,
      addedAt: existing?.addedAt ?? now,
    };
    this.entries.set(input.name, entry);

    if (!existing) {
      log.info("Capability added", { name: entry.name, localWsUrl: entry.localWsUrl });
    } else {
      log.info("Capability updated", { name: entry.name, localWsUrl: entry.localWsUrl });
    }
    return entry;
  }

  /**
   * Remove a capability. Logs the drop transition if it was present.
   */
  unregister(name: string): boolean {
    const existed = this.entries.delete(name);
    if (existed) {
      log.info("Capability dropped", { name });
    }
    return existed;
  }

  /**
   * Return capability names. `beekeeper` is always first and always present;
   * other registered names follow in sorted order.
   */
  list(): string[] {
    const names = Array.from(this.entries.keys()).sort();
    return [BEEKEEPER_NAME, ...names];
  }

  /**
   * Lookup a registered capability by name. `beekeeper` is not stored in the
   * manifest so this returns undefined for it — the WS proxy handles that case
   * separately.
   */
  get(name: string): CapabilityEntry | undefined {
    return this.entries.get(name);
  }

  /**
   * Start the health check loop. Polls each registered capability's health URL
   * on the given interval; on failure, increments `consecutiveFailures` and
   * drops the capability once the threshold is reached. On success, resets.
   */
  startHealthLoop(
    intervalMs: number = DEFAULT_INTERVAL_MS,
    failureThreshold: number = DEFAULT_FAILURE_THRESHOLD,
  ): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runHealthChecks(failureThreshold);
    }, intervalMs);
    // Don't block process exit on the health timer
    if (typeof this.timer.unref === "function") this.timer.unref();
    log.info("Capability health loop started", { intervalMs, failureThreshold });
  }

  /**
   * Stop the health loop. Safe to call multiple times.
   */
  stopHealthLoop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info("Capability health loop stopped");
    }
  }

  /**
   * Run one round of health checks. Exposed for tests to drive deterministically.
   */
  async runHealthChecks(failureThreshold: number = DEFAULT_FAILURE_THRESHOLD): Promise<void> {
    const snapshot = Array.from(this.entries.values());
    await Promise.all(
      snapshot.map(async (entry) => {
        const ok = await this.probe(entry.healthUrl);
        // Entry may have been removed or re-registered during the await.
        // On re-registration `register()` creates a fresh CapabilityEntry
        // object, so identity differs from our snapshot — drop the stale
        // probe result on the floor rather than applying it to a freshly
        // reset failure count (which could cause premature eviction).
        const current = this.entries.get(entry.name);
        if (!current || current !== entry) return;

        current.lastCheckedAt = Date.now();
        if (ok) {
          if (current.consecutiveFailures > 0) {
            log.info("Capability health recovered", { name: current.name });
          }
          current.consecutiveFailures = 0;
          return;
        }

        current.consecutiveFailures += 1;
        log.warn("Capability health check failed", {
          name: current.name,
          consecutiveFailures: current.consecutiveFailures,
        });
        if (current.consecutiveFailures >= failureThreshold) {
          this.unregister(current.name);
        }
      }),
    );
  }

  private async probe(healthUrl: string): Promise<boolean> {
    try {
      const res = await fetch(healthUrl);
      return res.ok;
    } catch {
      return false;
    }
  }
}
