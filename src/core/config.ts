import { homedir, platform } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

export interface Config {
  /** e.g. "Ctrl+Shift+J". On Linux/GNOME this is mirrored into GSettings. */
  hotkey: string;
  /** How long to wait before restoring the clipboard after injecting paste. */
  restoreDelayMs: number;
  notify: "error-only" | "always";
  /** wm_class (Linux) / bundle id (macOS) / process name (Windows). Substring match. */
  optOutApps: string[];
  /** Read the PRIMARY selection before injecting a copy keystroke. */
  readPrimary: boolean;
  /** Save the pre-conversion clipboard to a recovery file when nothing was selected. */
  writeRecoveryFile: boolean;
}

export const DEFAULT_CONFIG: Config = {
  hotkey: "Ctrl+Shift+J",
  restoreDelayMs: 250,
  notify: "error-only",
  optOutApps: [],
  readPrimary: true,
  writeRecoveryFile: true,
};

export function configDir(): string {
  switch (platform()) {
    case "win32":
      return process.env.APPDATA ? join(process.env.APPDATA, "adado") : join(homedir(), "AppData", "Roaming", "adado");
    case "darwin":
      return join(homedir(), "Library", "Application Support", "adado");
    default:
      return process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "adado") : join(homedir(), ".config", "adado");
  }
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function stateDir(): string {
  switch (platform()) {
    case "win32":
      return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "adado") : join(homedir(), "AppData", "Local", "adado");
    case "darwin":
      return join(homedir(), "Library", "Application Support", "adado");
    default:
      return join(process.env.XDG_STATE_HOME ? process.env.XDG_STATE_HOME : join(homedir(), ".local", "state"), "adado");
  }
}

export function recoveryPath(): string {
  return join(stateDir(), "last-clipboard.txt");
}

function coerce(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_CONFIG };
  const o = raw as Record<string, unknown>;
  const cfg: Config = { ...DEFAULT_CONFIG };
  if (typeof o.hotkey === "string" && o.hotkey.trim() !== "") cfg.hotkey = o.hotkey.trim();
  if (typeof o.restoreDelayMs === "number" && Number.isFinite(o.restoreDelayMs) && o.restoreDelayMs >= 0) {
    cfg.restoreDelayMs = Math.min(o.restoreDelayMs, 5000);
  }
  if (o.notify === "error-only" || o.notify === "always") cfg.notify = o.notify;
  if (Array.isArray(o.optOutApps)) cfg.optOutApps = o.optOutApps.filter((x): x is string => typeof x === "string");
  if (typeof o.readPrimary === "boolean") cfg.readPrimary = o.readPrimary;
  if (typeof o.writeRecoveryFile === "boolean") cfg.writeRecoveryFile = o.writeRecoveryFile;
  return cfg;
}

/** Exposed for tests: pure coercion of an already-parsed config object. */
export const coerceForTest = coerce;

/** Never throws: an absent or corrupt config falls back to documented defaults. */
export async function loadConfig(overrides: Partial<Config> = {}): Promise<Config> {
  let fileCfg: Config = { ...DEFAULT_CONFIG };
  try {
    fileCfg = coerce(JSON.parse(await readFile(configPath(), "utf8")));
  } catch {
    // no file, or unreadable, or invalid JSON -> defaults
  }
  return { ...fileCfg, ...stripUndefined(overrides) };
}

function stripUndefined(o: Partial<Config>): Partial<Config> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<Config>;
}

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Super", "Meta"] as const;

/** "Ctrl+Shift+J" -> "<Ctrl><Shift>j" (the format GSettings stores). */
export function toGSettingsAccel(hotkey: string): string | null {
  const parts = hotkey.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts.pop()!;
  const known = new Set<string>(MODIFIER_ORDER);
  if (parts.some((m) => !known.has(m))) return null;

  const lower = key.toLowerCase();
  const named: Record<string, string> = {
    plus: "plus", minus: "minus", space: "space", tab: "Tab",
    enter: "Return", return: "Return", esc: "Escape", escape: "Escape",
    backspace: "BackSpace", delete: "Delete", home: "Home", end: "End",
    pageup: "Page_Up", pagedown: "Page_Down", insert: "Insert",
  };

  let accel: string | null;
  if (named[lower] !== undefined) {
    accel = named[lower]!;
  } else if (/^f([1-9]|1\d|2[0-4])$/.test(lower)) {
    // GSettings stores function keys verbatim: "<Alt>F4".
    accel = lower.toUpperCase();
  } else if (lower.length === 1) {
    accel = lower;
  } else {
    return null;
  }

  // GSettings is order-insensitive but conventionally Ctrl, Alt, Shift, Super.
  const ordered = MODIFIER_ORDER.filter((m) => parts.includes(m)).map((m) => `<${m}>`).join("");
  return ordered + accel;
}