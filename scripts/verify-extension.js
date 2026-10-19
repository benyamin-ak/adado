// Loads the real extension module under GJS with GNOME Shell's typelibs, then
// exercises the parts that do not need a live compositor: the injected-key
// sequence, the hotkey forwarder, and the opt-out matching.
//
// This exists because a brand-new extension needs a logout to activate, and
// GNOME 50 cannot hot-reload code changes. Running the module here catches
// import errors, renamed Clutter constants and typos BEFORE a user has to log
// out, which is the difference between one logout and five.
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";

const EXT_DIR = "/home/ben/.local/share/gnome-shell/extensions/adado@benyamin-ak.github.io";

let pass = 0;
let fail = 0;
function check(label, condition, extra = "") {
    if (condition) {
        pass++;
        print(`ok    ${label}`);
    } else {
        fail++;
        print(`FAIL  ${label} ${extra}`);
    }
}

// The extension imports resource:///org/gnome/shell/... which only resolves
// inside gnome-shell, so stub the two shell-only modules and import the rest.
const stubs = `
const _settings = { get_string: () => '<Ctrl><Shift>j' };
class FakeExt {
  getSettings() { return _settings; }
  _loadConfig() { return { restoreDelayMs: 250, copyDelayMs: 120, notify: 'error-only', optOutApps: ['chrome'], readPrimary: true, writeRecoveryFile: true }; }
}
globalThis.__FakeExt = FakeExt;
globalThis.__Main = { wm: { addKeybinding: () => 1, removeKeybinding: () => {} }, messageTray: { add: () => {} } };
globalThis.__MessageTray = { Source: class {}, Notification: class {} };
`;
eval(stubs);

// Rewrite the shell-only imports to our stubs, leaving gi:// imports real.
const fs = await import("resource:///org/gnome/Shell/Extensions/js/modules/script.js").catch(() => null);

const [, bytes] = GLib.file_get_contents(`${EXT_DIR}/extension.js`);
const patched = new TextDecoder().decode(bytes)
    .replace("import * as Main from 'resource:///org/gnome/shell/ui/main.js';",
        "const Main = globalThis.__Main;")
    .replace("import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';",
        "const MessageTray = globalThis.__MessageTray;")
    .replace("import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';",
        "const Extension = globalThis.__FakeExt;")
    // Needs a live compositor context, which only exists inside gnome-shell.
    .replaceAll("Clutter.get_current_event_time()", "0");

check("patched out every shell-only import",
    !patched.includes("resource:///org/gnome/shell"),
    "(a leftover import would hide a real failure)");

// GJS cannot import data: URIs, so write the patched module to a real file.
const tmp = GLib.dir_make_tmp("adado-verify-XXXXXX");
const patchedPath = `${tmp}/patched-extension.js`;
GLib.file_set_contents(patchedPath, patched);

const {default: AdadoExtension} = await import(`file://${patchedPath}`);
check("module imported and has a default export", typeof AdadoExtension === "function");

const ext = Object.create(AdadoExtension.prototype);
ext._settings = { get_string: () => '<Ctrl><Shift>j' };
ext._device = new Clutter.VirtualInputDevice({
    device_type: Clutter.InputDeviceType.KEYBOARD_DEVICE,
});

// --- injected key sequence -------------------------------------------------
const pressed = [];
ext._press = undefined;
ext._device = {
    notify_keyval: (t, kv, state) => pressed.push([kv, state]),
};
ext._press = AdadoExtension.prototype._press.bind(ext);

ext._press(Clutter.KEY_v, [Clutter.KEY_Control_L]);
check("_press emits press+release for key and modifier",
    pressed.length === 4 &&
    pressed[0][0] === Clutter.KEY_Control_L && pressed[0][1] === Clutter.KeyState.PRESSED &&
    pressed[1][0] === Clutter.KEY_v && pressed[1][1] === Clutter.KeyState.PRESSED &&
    pressed[2][0] === Clutter.KEY_v && pressed[2][1] === Clutter.KeyState.RELEASED &&
    pressed[3][0] === Clutter.KEY_Control_L && pressed[3][1] === Clutter.KeyState.RELEASED,
    JSON.stringify(pressed));

// --- hotkey forwarder ------------------------------------------------------
const forwarded = [];
pressed.length = 0;
check("_forwardHotkey returns true for <Ctrl><Shift>j", ext._forwardHotkey() === true);
check("_forwardHotkey pressed Control_L and Shift_L",
    pressed.some(([kv]) => kv === Clutter.KEY_Control_L) &&
    pressed.some(([kv]) => kv === Clutter.KEY_Shift_L),
    JSON.stringify(pressed));
check("_forwardHotkey produced keyval j (106)",
    pressed.some(([kv]) => kv === 106), JSON.stringify(pressed));

// --- opt-out matching ------------------------------------------------------
const cfg = { optOutApps: ["chrome", "Code"] };
check("opted out for chrome", ext._isOptedOut("Google-chrome", cfg) === true);
check("opted out for Code (case-insensitive)", ext._isOptedOut("Code", cfg) === true);
check("not opted out for firefox", ext._isOptedOut("Navigator", cfg) === false);
check("empty opt-out list opts out nothing", ext._isOptedOut("Google-chrome", { optOutApps: [] }) === false);

// --- config loading --------------------------------------------------------
const loaded = ext._loadConfig();
check("_loadConfig returns defaults when file is absent",
    loaded.restoreDelayMs === 250 && loaded.notify === "error-only");

print("");
print(`extension.js: ${pass} passed, ${fail} failed`);
if (fail > 0)
    throw new Error(`${fail} check(s) failed`);