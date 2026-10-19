import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Clipboard {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
  /** Synthesises the platform paste chord. Throws with a useful message. */
  paste(): Promise<void>;
}

const MAC_READ = ["-e", "the clipboard as text"];

// Pass the text through argv rather than interpolating it into the script, so
// quotes, newlines and RTL text cannot break the command line.
const MAC_WRITE = [
  "-e", "on run argv",
  "-e", "set the clipboard to (item 1 of argv)",
  "-e", "end run",
];

const MAC_PASTE = [
  "-e", 'tell application "System Events" to keystroke "v" using command down',
];

function macClipboard(): Clipboard {
  return {
    async read() {
      try {
        const { stdout } = await run("osascript", MAC_READ);
        // `the clipboard as text` yields "" for non-text pasteboard contents.
        return stdout === "" ? null : stdout;
      } catch {
        return null;
      }
    },
    async write(text) {
      await run("osascript", [...MAC_WRITE, "--", text]);
    },
    async paste() {
      try {
        await run("osascript", MAC_PASTE);
      } catch (e) {
        throw new Error(
          "macOS blocked the synthetic paste. Grant Accessibility permission to your " +
            `terminal or node binary in System Settings > Privacy & Security > Accessibility. (${String(e)})`,
        );
      }
    },
  };
}

const PS = "powershell.exe";
const PS_FLAGS = ["-NoProfile", "-NonInteractive", "-Command"];

// keybd_event rather than SendKeys: SendKeys is unreliable inside Chromium,
// Electron and VM windows, which is exactly where this tool is used.
const PS_PASTE = `
Add-Type -Namespace Adado -Name Keys -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
'@
$up = 2
[Adado::Keys]::keybd_event(0x11,0,0,[UIntPtr]::Zero)
[Adado::Keys]::keybd_event(0x56,0,0,[UIntPtr]::Zero)
[Adado::Keys]::keybd_event(0x56,0,$up,[UIntPtr]::Zero)
[Adado::Keys]::keybd_event(0x11,0,$up,[UIntPtr]::Zero)
`;

function windowsClipboard(): Clipboard {
  return {
    async read() {
      try {
        const { stdout } = await run(PS, [...PS_FLAGS, "Get-Clipboard -Raw"]);
        return stdout === "" ? null : stdout;
      } catch {
        return null;
      }
    },
    async write(text) {
      // Feed the text on stdin so no quoting layer can mangle it.
      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          PS,
          [...PS_FLAGS, "$v=[Console]::In.ReadToEnd(); Set-Clipboard -Value $v"],
          (err) => (err ? reject(err) : resolve()),
        );
        child.stdin?.end(text, "utf8");
      });
    },
    async paste() {
      await run(PS, [...PS_FLAGS, PS_PASTE]);
    },
  };
}

export function clipboardFor(os: NodeJS.Platform = platform()): Clipboard {
  if (os === "darwin") return macClipboard();
  if (os === "win32") return windowsClipboard();
  throw new Error(
    `no clipboard backend for ${os}. On Linux, adado runs inside the GNOME Shell ` +
      "extension, which reads and writes the clipboard in-process.",
  );
}

/** Parses "Ctrl+Shift+J" into {modifiers, key}. */
export function parseHotkey(hotkey: string): { modifiers: string[]; key: string } {
  const parts = hotkey.split("+").map((p) => p.trim()).filter(Boolean);
  const key = (parts.pop() ?? "j").toLowerCase();
  const modifiers = parts.map((m) => m.toLowerCase());
  for (const m of modifiers) {
    if (!["ctrl", "alt", "shift", "super", "meta"].includes(m))
      throw new Error(`unknown modifier "${m}" in hotkey "${hotkey}"`);
  }
  return { modifiers, key };
}