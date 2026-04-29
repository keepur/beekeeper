import { adminGet, formatAge, loadAdminContext, renderTable } from "./admin-client.js";

interface HealthResponse {
  status: string;
  sessions: number;
  connectedDevices: number;
}

interface AdminSession {
  sessionId: string;
  path: string;
  state: "idle" | "busy";
  queryStartedAt: number | null;
  lastActivityAt: number;
}

interface AdminSessionsResponse {
  sessions: AdminSession[];
}

interface AdminDevice {
  deviceId: string;
  label: string;
  user: string;
  active: boolean;
  paired: boolean;
  // /devices returns these as ISO strings; formatAge accepts string | number.
  pairedAt: string | number | null;
  lastSeenAt: string | number | null;
  connected: boolean;
  hasPendingCode: boolean;
}

interface AdminCapability {
  name: string;
  localWsUrl: string;
  healthUrl: string;
  consecutiveFailures: number;
  lastCheckedAt: number | null;
  addedAt: number;
}

interface AdminCapabilitiesResponse {
  capabilities: AdminCapability[];
}

function wantsJson(args: string[]): boolean {
  return args.includes("--json");
}

export async function runStatus(args: string[]): Promise<number> {
  const ctx = loadAdminContext();
  // /health is public — no admin auth needed.
  const data = await adminGet<HealthResponse>(ctx, "/health", { auth: false });
  if (wantsJson(args)) {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }
  console.log(
    `gateway: ${data.status}  sessions: ${data.sessions}  devices: ${data.connectedDevices}`,
  );
  return 0;
}

export async function runSessionsList(args: string[]): Promise<number> {
  const ctx = loadAdminContext();
  const data = await adminGet<AdminSessionsResponse>(ctx, "/admin/sessions");
  if (wantsJson(args)) {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }
  const now = Date.now();
  const rows = data.sessions.map((s) => [
    s.sessionId,
    s.state,
    formatAge(s.queryStartedAt, now),
    formatAge(s.lastActivityAt, now),
    s.path,
  ]);
  console.log(renderTable(["SESSION", "STATE", "QUERY", "ACTIVITY", "PATH"], rows));
  return 0;
}

export async function runDevicesList(args: string[]): Promise<number> {
  const ctx = loadAdminContext();
  // The existing /devices endpoint serves admin device-list duty and is what
  // the CLI calls — there is no /admin/devices alias.
  const data = await adminGet<AdminDevice[]>(ctx, "/devices");
  if (wantsJson(args)) {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }
  const now = Date.now();
  const rows = data.map((d) => [
    d.deviceId,
    d.user,
    d.label,
    d.active ? "yes" : "no",
    d.connected ? "yes" : "no",
    d.paired ? "yes" : (d.hasPendingCode ? "pending" : "no"),
    formatAge(d.lastSeenAt, now),
  ]);
  console.log(renderTable(["DEVICE", "USER", "LABEL", "ACTIVE", "CONNECTED", "PAIRED", "SEEN"], rows));
  return 0;
}

export async function runCapabilitiesList(args: string[]): Promise<number> {
  const ctx = loadAdminContext();
  const data = await adminGet<AdminCapabilitiesResponse>(ctx, "/admin/capabilities");
  if (wantsJson(args)) {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }
  const now = Date.now();
  const rows = data.capabilities.map((c) => [
    c.name,
    c.consecutiveFailures === 0 ? "healthy" : `failing(${c.consecutiveFailures})`,
    formatAge(c.lastCheckedAt, now),
    c.localWsUrl,
  ]);
  console.log(renderTable(["NAME", "STATUS", "CHECKED", "LOCAL_WS_URL"], rows));
  return 0;
}
