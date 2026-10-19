import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toGSettingsAccel, type Config } from "../core/config.ts";

const run = promisify(execFile);

export const EXTENSION_UUID = "adado@benyamin-ak.github.io";
export const SCHEMA_ID = "org.gnome.shell.extensions.adado";

function packageRoot(): string {
  // dist/platform/linux-gnome.js -> package root
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function extensionSourceDir(): string {
  return join(packageRoot(), "extension");
}

export function installedExtensionDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "gnome-shell", "extensions", EXTENSION_UUID);
}

export async function isGnome(): Promise<boolean> {
  const desktop = process.env.XDG_CURRENT_DESKTOP ?? "";
  return /GNOME/i.test(desktop) || /gnome/i.test(await safeShellOutput("echo $XDG_SESSION_DESKTOP"));
}

async function safeShellOutput(cmd: string): Promise<string> {
  try {
    const { stdout } = await run("sh", ["-c", cmd]);
    return stdout.trim();
  } catch {
    return "";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface InstallResult {
  path: string;
  alreadyInstalled: boolean;
  installedVersion: number | null;
  reloaded: boolean;
}

/**
 * Copies the extension into the user's extension directory and compiles its
 * GSettings schema. No root required.
 *
 * Note: GNOME 50 cannot re-import an extension at the same version, so a
 * re-install of an unchanged build will not take effect until logout. We report
 * that rather than pretending it reloaded.
 */
export async function installExtension(cfg: Config): Promise<InstallResult> {
  const src = extensionSourceDir();
  const dest = installedExtensionDir();
  const metadata = JSON.parse(await readFile(join(src, "metadata.json"), "utf8")) as { version: number };

  let installedVersion: number | null = null;
  const alreadyInstalled = await exists(join(dest, "metadata.json"));
  if (alreadyInstalled) {
    try {
      const prev = JSON.parse(await readFile(join(dest, "metadata.json"), "utf8")) as { version: number };
      installedVersion = prev.version ?? null;
    } catch {
      installedVersion = null;
    }
  }

  // Wipe first: a plain copy leaves stale files behind, and a leftover module
  // from an older layout is exactly the kind of thing that silently shadows the
  // file you think you just deployed.
  if (alreadyInstalled) await run("gnome-extensions", ["disable", EXTENSION_UUID]).catch(() => {});
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  for (const entry of ["metadata.json", "extension.js", "schemas"]) {
    await cp(join(src, entry), join(dest, entry), { recursive: true });
  }

  await run("glib-compile-schemas", [join(dest, "schemas")]);

  // GNOME only grants keybindings declared in a schema, so the hotkey from the
  // JSON config has to be mirrored into GSettings here.
  const accel = toGSettingsAccel(cfg.hotkey);
  if (accel) {
    try {
      await run("gsettings", ["set", SCHEMA_ID, "hotkey", accel]);
    } catch {
      // Schema not installed yet (first run) - the enable step will pick it up.
    }
  }

  let reloaded = false;
  if (installedVersion !== null) {
    // A version bump is what lets GNOME re-import without a logout.
    if (installedVersion !== metadata.version) {
      await run("gnome-extensions", ["enable", EXTENSION_UUID]).catch(() => {});
      reloaded = true;
    }
  }

  return { path: dest, alreadyInstalled, installedVersion, reloaded };
}

export async function uninstallExtension(): Promise<boolean> {
  const dest = installedExtensionDir();
  if (!(await exists(dest))) return false;
  await run("gnome-extensions", ["disable", EXTENSION_UUID]).catch(() => {});
  await run("gnome-extensions", ["uninstall", EXTENSION_UUID]).catch(() => {});
  await rm(dest, { recursive: true, force: true });
  return true;
}

export interface DoctorCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export async function linuxDoctor(cfg: Config): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const session = process.env.XDG_SESSION_TYPE || await safeShellOutput("echo $XDG_SESSION_TYPE");

  checks.push({
    label: "Session type",
    ok: session === "wayland" || session === "x11",
    detail: session || "unknown",
  });
  checks.push({
    label: "Desktop",
    ok: (await isGnome()),
    detail: process.env.XDG_CURRENT_DESKTOP || "unknown",
  });

  // `gnome-shell --version` prints "GNOME Shell 50.1"; take the major from the
  // first dotted number rather than splitting the whole string on ".".
  const version = await safeShellOutput("gnome-shell --version");
  const dotted = /(\d+)\.\d+/.exec(version);
  const bare = /\b([4-9]\d)\b/.exec(version);
  const major = dotted?.[1] ?? bare?.[1] ?? "";
  checks.push({
    label: "GNOME version",
    ok: major === "49" || major === "50",
    detail: version || "not detected (extension declares shell-version 49, 50)",
  });

  const installed = await exists(join(installedExtensionDir(), "metadata.json"));
  checks.push({
    label: "Extension installed",
    ok: installed,
    detail: installed ? installedExtensionDir() : `not found - run: npx adado install-extension`,
  });

  let state = "";
  if (installed) state = await safeShellOutput(`gnome-extensions info ${EXTENSION_UUID} | grep '^State'`);
  const stateOk = /ACTIVE/.test(state);
  checks.push({
    label: "Extension active",
    ok: stateOk,
    detail: state.replace(/^State:\s*/, "").trim() || (installed ? "unknown - run: gnome-extensions enable " + EXTENSION_UUID : "n/a"),
  });

  const accel = await safeShellOutput(`gsettings get ${SCHEMA_ID} hotkey`);
  checks.push({
    label: "Hotkey bound",
    ok: accel.startsWith("'"),
    detail: `${cfg.hotkey} -> ${accel || "(unset)"}`,
  });

  const schema = join(installedExtensionDir(), "schemas", "gschemas.compiled");
  checks.push({
    label: "GSettings schema compiled",
    ok: await exists(schema),
    detail: schema,
  });

  checks.push({
    label: "Zero-install",
    ok: true,
    detail: "no uinput, no xdotool, no wl-clipboard, no root",
  });

  return checks;
}

/** Writes a starter config file, never overwriting an existing one. */
export async function writeStarterConfig(path: string, contents: string): Promise<boolean> {
  if (await exists(path)) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
  return true;
}