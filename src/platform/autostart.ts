import { homedir, platform } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const LABEL = "com.adado.daemon";
const STARTUP_NAME = "adado.cmd";

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export function autostartPath(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", STARTUP_NAME);
}

/**
 * Registers the daemon to start at login, using the current node binary and
 * the script that is running right now -- so a globally installed `adado` or a
 * one-off `npx adado` both produce a working entry.
 */
export async function installAutostart(): Promise<string> {
  const target = autostartPath();
  await mkdir(join(target, ".."), { recursive: true });

  const node = process.execPath;
  const script = process.argv[1] ?? "";

  if (platform() === "darwin") {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${script}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardErrorPath</key><string>${join(homedir(), "Library", "Logs", "adado.log")}</string>
</dict>
</plist>
`;
    await writeFile(target, plist, "utf8");
    return target;
  }

  const cmd = `@echo off\r\nstart "" /min "${node}" "${script}" daemon\r\n`;
  await writeFile(target, cmd, "utf8");
  return target;
}

export async function uninstallAutostart(): Promise<boolean> {
  const target = autostartPath();
  if (!(await exists(target))) return false;
  await rm(target, { force: true });
  return true;
}