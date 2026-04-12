import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../logging/logger.js";

const log = createLogger("beekeeper-service");

const LABEL = "com.keepur.beekeeper";

export function generatePlist(configDir?: string): string {
  const nodePath = execSync("which node", { encoding: "utf-8" }).trim();
  const indexPath = resolve(import.meta.dirname, "../index.js");
  const workDir = configDir ?? join(homedir(), ".beekeeper");
  const logDir = join(workDir, "logs");

  mkdirSync(logDir, { recursive: true });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${indexPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${workDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BEEKEEPER_CONFIG</key>
    <string>beekeeper.yaml</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logDir}/beekeeper.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/beekeeper.err</string>
</dict>
</plist>`;
}

export function install(configDir?: string): void {
  const plistContent = generatePlist(configDir);
  const plistDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(plistDir, `${LABEL}.plist`);

  mkdirSync(plistDir, { recursive: true });
  writeFileSync(plistPath, plistContent);
  log.info("Plist installed", { path: plistPath });

  console.log(`LaunchAgent installed: ${plistPath}`);
  console.log(`Start with: launchctl load ${plistPath}`);
  console.log(`Stop with: launchctl unload ${plistPath}`);
}

export function uninstall(): void {
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: "ignore" });
  } catch {
    // Already unloaded
  }

  if (existsSync(plistPath)) {
    unlinkSync(plistPath);
    log.info("Plist removed", { path: plistPath });
    console.log(`LaunchAgent removed: ${plistPath}`);
  } else {
    console.log("No LaunchAgent found to remove.");
  }
}
