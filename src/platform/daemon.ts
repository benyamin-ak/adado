import { mkdir, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname } from "node:path";

import type { UiohookKeyboardEvent } from "uiohook-napi";

import { preparePaste } from "../core/convert.ts";
import { recoveryPath, type Config } from "../core/config.ts";
import { clipboardFor, parseHotkey, type Clipboard } from "./clipboard.ts";

type UiohookModule = typeof import("uiohook-napi");
type Uiohook = UiohookModule["uIOhook"];

/** Named keys the hotkey parser accepts, mapped to libuiohook key names. */
const NAMED_KEYS: Record<string, string> = {
  enter: "ENTER",
  return: "ENTER",
  space: "SPACE",
  tab: "TAB",
  escape: "ESC",
  esc: "ESC",
  backspace: "BACKSPACE",
  delete: "DELETE",
  insert: "INSERT",
  home: "HOME",
  end: "END",
  pageup: "PAGE_UP",
  pagedown: "PAGE_DOWN",
};

interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

function chordFor(modifiers: string[]): Chord {
  return {
    ctrl: modifiers.includes("ctrl"),
    alt: modifiers.includes("alt"),
    shift: modifiers.includes("shift"),
    meta: modifiers.includes("super") || modifiers.includes("meta"),
  };
}

/**
 * uiohook reports libuiohook keycodes (A is 30, not ASCII 97), so the hotkey's
 * character is resolved through the library's own key table.
 */
function resolveKeycode(mod: UiohookModule, key: string): number {
  const table = mod.UiohookKey as unknown as Record<string, number | string>;

  const named = NAMED_KEYS[key];
  if (named !== undefined && typeof table[named] === "number") return table[named] as number;

  const fn = /^f([1-9]|1\d|2[0-4])$/.exec(key);
  if (fn && typeof table[`F${fn[1]}`] === "number") return table[`F${fn[1]}`] as number;

  for (const [name, value] of Object.entries(table)) {
    if (name.length === 1 && name.toLowerCase() === key.toLowerCase() && typeof value === "number")
      return value;
  }
  throw new Error(`hotkey key "${key}" is not supported by the native hotkey backend`);
}

async function loadUiohook(): Promise<{ mod: UiohookModule; hook: Uiohook }> {
  try {
    const mod = await import("uiohook-napi");
    return { mod, hook: mod.uIOhook };
  } catch (e) {
    throw new Error(
      "could not load the optional native hotkey dependency (uiohook-napi). " +
        "Reinstall on a supported Node version, or use `adado convert` instead. " +
        `(${String(e)})`,
    );
  }
}

/**
 * macOS/Windows daemon.
 *
 * Linux is deliberately not handled here: on GNOME the Shell extension does the
 * whole job in-process, with no Node process running at all.
 */
export async function runDaemon(cfg: Config): Promise<void> {
  const os = platform();
  if (os === "linux")
    throw new Error("on Linux adado runs as a GNOME Shell extension - run: npx adado install-extension");

  const clipboard = clipboardFor(os);
  const { modifiers, key } = parseHotkey(cfg.hotkey);
  const { mod, hook } = await loadUiohook();
  const want = chordFor(modifiers);
  const targetKey = resolveKeycode(mod, key);

  let busy = false;

  const handler = async (e: UiohookKeyboardEvent): Promise<void> => {
    if (busy || e.keycode !== targetKey) return;
    // Exact match on every modifier, so Ctrl+Alt+Shift+J never hijacks Ctrl+Shift+J.
    if (e.ctrlKey !== want.ctrl || e.altKey !== want.alt ||
        e.shiftKey !== want.shift || e.metaKey !== want.meta) return;

    busy = true;
    try {
      await convertSelection(clipboard, cfg);
    } catch (err) {
      process.stderr.write(`adado: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      busy = false;
    }
  };

  process.stdout.write(
    `adado listening for ${cfg.hotkey}\n` +
      `press Ctrl+C in this terminal to stop\n`,
  );

  hook.on("keydown", (e) => void handler(e));
  hook.start();

  const stop = () => {
    hook.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function convertSelection(clipboard: Clipboard, cfg: Config): Promise<void> {
  const original = await clipboard.read();
  if (original === null) return;

  // macOS and Windows have a single clipboard, so reading the selection means
  // copying it. Restore the original afterwards either way.
  const prepared = preparePaste(original);
  if (prepared === null) return; // nothing to convert: stay silent, change nothing

  await clipboard.write(prepared);
  await clipboard.paste();

  if (cfg.writeRecoveryFile) {
    const path = recoveryPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, original, "utf8");
  }

  await new Promise((r) => setTimeout(r, cfg.restoreDelayMs));
  await clipboard.write(original);
}