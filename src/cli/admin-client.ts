import { loadConfig } from "../config.js";

export interface AdminContext {
  url: string;
  adminSecret: string;
}

/**
 * Build the localhost URL the CLI uses to talk to the running daemon, plus
 * the admin secret it needs for `/admin/*` and `/devices/*` endpoints. Reads
 * from the same config path the daemon uses (`~/.beekeeper/env` →
 * `loadConfig()`), so the CLI doesn't need any flags or env juggling.
 */
export function loadAdminContext(): AdminContext {
  const config = loadConfig();
  return {
    url: `http://localhost:${config.port}`,
    adminSecret: config.adminSecret,
  };
}

/**
 * Format a fetch failure into an actionable, single-line message. Handles
 * the two common cases: connection refused (gateway not running) and
 * any other network-layer error.
 */
function describeFetchError(err: unknown, url: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    /ECONNREFUSED|fetch failed/i.test(msg) &&
    err instanceof Error &&
    "cause" in err
  ) {
    const cause = (err as Error & { cause?: { code?: string } }).cause;
    if (cause?.code === "ECONNREFUSED") {
      return `Gateway not running at ${url}. Start it with: launchctl kickstart -k gui/$(id -u)/io.keepur.beekeeperd`;
    }
  }
  return `Request to ${url} failed: ${msg}`;
}

/**
 * GET a JSON endpoint with optional admin auth. Returns the parsed body or
 * throws an Error with an actionable message. Status codes other than 200
 * surface the daemon's error payload when present.
 */
export async function adminGet<T = unknown>(
  ctx: AdminContext,
  path: string,
  opts: { auth?: boolean } = {},
): Promise<T> {
  const auth = opts.auth ?? true;
  const url = `${ctx.url}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: auth ? { Authorization: `Bearer ${ctx.adminSecret}` } : {},
    });
  } catch (err) {
    throw new Error(describeFetchError(err, url));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path} → ${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
  }
  return (await res.json()) as T;
}

/**
 * Convenience: POST a JSON body (or no body) and return parsed JSON.
 */
export async function adminPost<T = unknown>(
  ctx: AdminContext,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${ctx.url}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminSecret}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(describeFetchError(err, url));
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`POST ${path} → ${res.status} ${res.statusText}${errBody ? `: ${errBody}` : ""}`);
  }
  return (await res.json()) as T;
}

/**
 * Render an array as a fixed-width text table. Returns the rendered string
 * (no trailing newline). Empty input → "(none)". Used by the CLI list
 * subcommands; `--json` callers bypass this and dump raw responses.
 */
export function renderTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "(none)";
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [fmt(headers), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt)].join("\n");
}

/**
 * Format a timestamp as a relative age (e.g. "5s", "12m", "3h").
 * Accepts either a millisecond number or an ISO date string — the daemon's
 * /devices endpoint returns ISO strings while /admin/sessions returns
 * milliseconds, and both flow through the same renderer. Returns "-" for
 * null/empty/unparseable input.
 */
export function formatAge(ts: number | string | null | undefined, now: number = Date.now()): string {
  if (ts === null || ts === undefined || ts === 0 || ts === "") return "-";
  const ms = typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(ms)) return "-";
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}
