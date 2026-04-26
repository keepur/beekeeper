import type { BudgetCounters } from "./types.js";

export class Budget {
  private spawnUsed = 0;
  private actionUsed = 0;

  constructor(
    public readonly spawnLimit: number,
    public readonly actionLimit: number,
  ) {
    if (spawnLimit < 0) throw new Error("spawnLimit must be >= 0");
    if (actionLimit < 0) throw new Error("actionLimit must be >= 0");
  }

  /** Always consumes an action slot. Returns false if the action-budget is exhausted. */
  tryConsumeAction(): boolean {
    if (this.actionUsed >= this.actionLimit) return false;
    this.actionUsed += 1;
    return true;
  }

  /** Consumes both an action slot and a spawn slot. Returns false if either is exhausted. */
  tryConsumeSpawn(): boolean {
    if (this.spawnUsed >= this.spawnLimit) return false;
    if (this.actionUsed >= this.actionLimit) return false;
    this.spawnUsed += 1;
    this.actionUsed += 1;
    return true;
  }

  summary(): BudgetCounters {
    return {
      spawnUsed: this.spawnUsed,
      spawnLimit: this.spawnLimit,
      actionUsed: this.actionUsed,
      actionLimit: this.actionLimit,
    };
  }
}
