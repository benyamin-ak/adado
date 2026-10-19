#!/usr/bin/env node
import { platform } from "node:os";
import { toAsciiDigits } from "./core/convert.ts";
import { configPath, loadConfig, type Config } from "./core/config.ts";
import { installAutostart, uninstallAutostart } from "./platform/autostart.ts";
import { parseHotkey } from "./platform/clipboard.ts";
import {
  EXTENSION_UUID,
  installedExtensionDir,
  installExtension,
  isGnome,
  linuxDoctor,
  uninstallExtension,
  writeStarterConfig,
} from "./platform/linux-gnome.ts";
import { runDaemon } from "./platform/daemon.ts";

const HELP = `adado - convert Arabic-Indic and Persian digits to ASCII, wherever you type

Usage
  adado                 install this platform's pieces and start
  adado convert [text]  convert text (or stdin) and print the result
  adado install-extension   install the GNOME Shell extension (Linux)
  adado daemon          run the hotkey daemon in the foreground (macOS/Windows)
  adado doctor          report what was detected about this desktop
  adado uninstall       remove everything this tool installed
  adado --help

Config
  ${configPath()}
`;

const STARTER_CONFIG = `{
  "hotkey": "Ctrl+Shift+J",
  "restoreDelayMs": 250,
  "notify": "error-only",
  "optOutApps": [],
  "readPrimary": true,
  "writeRecoveryFile": true
}
`;

interface ParsedArgs {
  overrides: Partial<Config>;
  positional: string[];
}

/** Splits argv into config overrides and positional text, consuming flag values. */
function parseArgs(argv: string[]): ParsedArgs {
  const overrides: Partial<Config> = {};
  const positional: string[] = [];

  const takeValue = (i: number): string | undefined => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) return undefined;
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--hotkey": {
        const v = takeValue(i);
        if (v !== undefined) overrides.hotkey = v;
        i++;
        break;
      }
      case "--notify": {
        const v = takeValue(i);
        if (v === "always" || v === "error-only") overrides.notify = v;
        if (v !== undefined) i++;
        break;
      }
      case "--restore-delay": {
        const v = takeValue(i);
        const n = Number(v);
        if (v !== undefined && Number.isFinite(n)) overrides.restoreDelayMs = n;
        if (v !== undefined) i++;
        break;
      }
      default:
        positional.push(arg);
    }
  }
  return { overrides, positional };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdConvert(cfg: Config, rest: string[]): Promise<number> {
  let input: string;
  if (rest.length > 0) {
    input = rest.join(" ");
  } else if (!process.stdin.isTTY) {
    input = await readStdin();
  } else {
    process.stderr.write("provide text as an argument or pipe it on stdin\n");
    return 2;
  }
  process.stdout.write(toAsciiDigits(input));
  return 0;
}

async function cmdInstallExtension(cfg: Config): Promise<number> {
  if (platform() !== "linux") {
    process.stderr.write("install-extension is Linux-only; on macOS and Windows run: adado daemon\n");
    return 1;
  }
  if (!(await isGnome())) {
    process.stderr.write(
      "adado's Linux support is a GNOME Shell extension and this session is not GNOME.\n" +
        "Use the convert command, or run this on GNOME 49 or 50.\n",
    );
    return 1;
  }

  const result = await installExtension(cfg);
  process.stdout.write(`installed to ${result.path}\n`);

  if (result.alreadyInstalled && !result.reloaded) {
    process.stdout.write(
      "note: same version as the installed copy. GNOME 50 cannot reload an unchanged\n" +
        "extension - log out and back in, or bump the version to apply changes.\n",
    );
  }

  const wrote = await writeStarterConfig(configPath(), STARTER_CONFIG);
  if (wrote) process.stdout.write(`wrote starter config to ${configPath()}\n`);
  else process.stdout.write(`kept your existing config at ${configPath()}\n`);

  process.stdout.write(
    `\nnext:\n` +
      `  gnome-extensions enable ${EXTENSION_UUID}\n` +
      `  gnome-extensions info ${EXTENSION_UUID}   # State should read ACTIVE\n\n` +
      `if State is not ACTIVE, log out and back in once.\n`,
  );
  return 0;
}

async function cmdDoctor(cfg: Config): Promise<number> {
  const os = platform();
  process.stdout.write(`adado doctor\n${"=".repeat(40)}\n`);
  process.stdout.write(`platform:  ${os}\n`);
  process.stdout.write(`config:    ${configPath()}\n`);
  process.stdout.write(`hotkey:    ${cfg.hotkey}\n`);
  try {
    const { modifiers, key } = parseHotkey(cfg.hotkey);
    process.stdout.write(`parsed:    modifiers=[${modifiers.join(", ")}] key=${key}\n`);
  } catch (e) {
    process.stdout.write(`parsed:    INVALID - ${(e as Error).message}\n`);
  }

  if (os === "linux") {
    const gnome = await isGnome();
    if (!gnome) {
      process.stdout.write(
        `\nnot a GNOME session.\n` +
          "adado's Linux hotkey is a GNOME Shell extension, so there is nothing to\n" +
          "install here. The convert command still works on this machine.\n",
      );
      return 1;
    }
    process.stdout.write(`\n${"-".repeat(40)}\n`);
    let failed = 0;
    for (const check of await linuxDoctor(cfg)) {
      if (!check.ok) failed++;
      process.stdout.write(`${check.ok ? "ok  " : "FAIL"}  ${check.label.padEnd(26)} ${check.detail}\n`);
    }
    if (failed > 0) process.stdout.write(`\n${failed} check(s) need attention.\n`);
    return failed > 0 ? 1 : 0;
  }

  process.stdout.write(`\n${"-".repeat(40)}\n`);
  process.stdout.write(`ok    hotkey backend          uiohook-napi (optional dependency)\n`);
  process.stdout.write(
    os === "darwin"
      ? `WARN  Accessibility          required for synthetic paste; grant it to\n` +
        `                             this node binary in System Settings >\n` +
        `                             Privacy & Security > Accessibility\n`
      : `ok    paste backend           keybd_event P/Invoke (not SendKeys)\n`,
  );
  process.stdout.write(`info  clipboard slots         single slot - the original is saved\n`);
  process.stdout.write(`                             to a recovery file before conversion\n`);
  return 0;
}

async function cmdDefault(cfg: Config): Promise<number> {
  const os = platform();

  if (os === "linux") {
    return cmdInstallExtension(cfg);
  }

  const entry = await installAutostart();
  process.stdout.write(`registered autostart at ${entry}\n`);
  process.stdout.write("starting daemon; press Ctrl+C to stop this foreground process\n\n");
  await runDaemon(cfg);
  return 0;
}

async function cmdUninstall(): Promise<number> {
  const os = platform();
  if (os === "linux") {
    const removed = await uninstallExtension();
    process.stdout.write(removed ? `removed ${EXTENSION_UUID}\n` : "extension was not installed\n");
    process.stdout.write(`installed dir was ${installedExtensionDir()}\n`);
  } else {
    const removed = await uninstallAutostart();
    process.stdout.write(removed ? "removed autostart entry\n" : "no autostart entry found\n");
  }
  process.stdout.write("config files were left in place; delete them if you want a clean slate\n");
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : null;
  const { overrides, positional } = parseArgs(command ? argv.slice(1) : argv);
  const cfg = await loadConfig(overrides);

  switch (command) {
    case null:
      return cmdDefault(cfg);
    case "convert":
      return cmdConvert(cfg, positional);
    case "install-extension":
      return cmdInstallExtension(cfg);
    case "daemon":
      await runDaemon(cfg);
      return 0;
    case "doctor":
      return cmdDoctor(cfg);
    case "uninstall":
      return cmdUninstall();
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`adado: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);