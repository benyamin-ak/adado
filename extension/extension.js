import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

/* adado:generated-mapping:start */
// Regenerate with: npm run build:extension
// Derived from src/core/convert.ts - never hand-edit this block.
const DIGIT_MAP = new Map([[1632,"0"],[1633,"1"],[1634,"2"],[1635,"3"],[1636,"4"],[1637,"5"],[1638,"6"],[1639,"7"],[1640,"8"],[1641,"9"],[1776,"0"],[1777,"1"],[1778,"2"],[1779,"3"],[1780,"4"],[1781,"5"],[1782,"6"],[1783,"7"],[1784,"8"],[1785,"9"]]);
/* adado:generated-mapping:end */

function toAsciiDigits(input) {
    let out = '';
    for (const ch of input) {
        const mapped = DIGIT_MAP.get(ch.codePointAt(0));
        out += mapped === undefined ? ch : mapped;
    }
    return out;
}

function preparePaste(raw) {
    // Clipboards often end with one line break that was never part of the
    // selection; pasting it back would insert a stray blank line.
    const hadTrailingNewline = /\r?\n$/.test(raw);
    const body = hadTrailingNewline ? raw.replace(/\r?\n$/, '') : raw;
    const converted = toAsciiDigits(body);
    if (converted === body) return null; // nothing changed -> leave everything alone
    return converted;
}

const CLIPBOARD = St.ClipboardType.CLIPBOARD;
const PRIMARY = St.ClipboardType.PRIMARY;

const DEFAULTS = {
    hotkey: 'Ctrl+Shift+J',
    restoreDelayMs: 250,
    copyDelayMs: 120,
    notify: 'error-only',
    optOutApps: [],
    readPrimary: true,
    writeRecoveryFile: true,
};

// A bare Ctrl+C in a terminal is SIGINT and will kill the user's foreground
// process. Terminals get the "copy" chord instead, which is inert with no
// selection.
const TERMINALS = new Set([
    'gnome-terminal-server', 'gnome-terminal', 'ghostty', 'ptyxis', 'konsole',
    'xterm', 'xterm-256color', 'kitty', 'alacritty', 'wezterm', 'foot',
    'terminator', 'tilix', 'urxvt', 'rxvt', 'rio', 'st', 'iterm', 'iterm2',
]);

export default class AdadoExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._device = new Clutter.VirtualInputDevice({
            device_type: Clutter.InputDeviceType.KEYBOARD_DEVICE,
        });
        this._source = null;

        this._keybindingId = Main.wm.addKeybinding(
            'hotkey',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._onHotkey(),
        );

        if (this._keybindingId === 0)
            console.error('adado: another application already owns the hotkey');
    }

    disable() {
        if (this._keybindingId) {
            Main.wm.removeKeybinding('hotkey');
            this._keybindingId = 0;
        }
        this._settings = null;
        this._device = null;
    }

    // ---------------------------------------------------------------- config

    _loadConfig() {
        const cfg = {...DEFAULTS};
        try {
            const path = GLib.build_filenamev([GLib.get_user_config_dir(), 'adado', 'config.json']);
            const [, bytes] = GLib.file_get_contents(path);
            const parsed = JSON.parse(new TextDecoder().decode(bytes));
            if (typeof parsed === 'object' && parsed !== null) {
                if (typeof parsed.restoreDelayMs === 'number')
                    cfg.restoreDelayMs = Math.min(Math.max(parsed.restoreDelayMs, 0), 5000);
                if (typeof parsed.copyDelayMs === 'number')
                    cfg.copyDelayMs = Math.min(Math.max(parsed.copyDelayMs, 20), 2000);
                if (parsed.notify === 'always' || parsed.notify === 'error-only')
                    cfg.notify = parsed.notify;
                if (Array.isArray(parsed.optOutApps))
                    cfg.optOutApps = parsed.optOutApps.filter(x => typeof x === 'string');
                if (typeof parsed.readPrimary === 'boolean')
                    cfg.readPrimary = parsed.readPrimary;
                if (typeof parsed.writeRecoveryFile === 'boolean')
                    cfg.writeRecoveryFile = parsed.writeRecoveryFile;
            }
        } catch {
            // No config, or unreadable, or invalid JSON -> documented defaults.
        }
        return cfg;
    }

    // ------------------------------------------------------------- utilities

    _delay(ms) {
        return new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _getText(type) {
        return new Promise(resolve => {
            let done = false;
            this._clipboard.get_text(type, (_clipboard, text) => {
                if (done)
                    return;
                done = true;
                resolve(typeof text === 'string' ? text : null);
            });
        });
    }

    _setText(type, text) {
        this._clipboard.set_text(type, text);
    }

    _press(keyval, modifiers = []) {
        const time = Clutter.get_current_event_time();
        for (const mod of modifiers)
            this._device.notify_keyval(time, mod, Clutter.KeyState.PRESSED);
        this._device.notify_keyval(time, keyval, Clutter.KeyState.PRESSED);
        this._device.notify_keyval(time, keyval, Clutter.KeyState.RELEASED);
        for (const mod of [...modifiers].reverse())
            this._device.notify_keyval(time, mod, Clutter.KeyState.RELEASED);
    }

    _focusClass() {
        const win = global.display?.focus_window;
        return win?.get_wm_class?.() ?? '';
    }

    _isOptedOut(wmClass, cfg) {
        if (cfg.optOutApps.length === 0)
            return false;
        const haystack = wmClass.toLowerCase();
        return cfg.optOutApps.some(app => haystack.includes(app.toLowerCase()));
    }

    _recoveryPath() {
        const state = GLib.get_user_state_dir();
        return GLib.build_filenamev([state, 'adado', 'last-clipboard.txt']);
    }

    _writeRecovery(text) {
        try {
            const path = this._recoveryPath();
            const dir = GLib.path_get_dirname(path);
            GLib.mkdir_with_parents(dir, 0o755);
            return GLib.file_set_contents(path, text);
        } catch (e) {
            console.error(`adado: could not write recovery file: ${e.message}`);
            return false;
        }
    }

    _notify(banner) {
        try {
            if (!this._source) {
                this._source = new MessageTray.Source('adado', 'adado');
                this._source.connect('destroy', () => (this._source = null));
                Main.messageTray.add(this._source);
            }
            const notification = new MessageTray.Notification({
                source: this._source,
                title: 'adado',
                banner,
            });
            this._source.showNotification(notification);
        } catch (e) {
            console.error(`adado: notification failed: ${e.message}`);
        }
    }

    /**
     * GNOME grabs a global keybinding in every window, so an opted-out app
     * never sees the keystroke. The only way to give the app its shortcut back
     * is to replay the combo into the focused window.
     */
    _forwardHotkey() {
        const accel = this._settings.get_string('hotkey');
        const modifiers = [];
        const key = accel.replace(/<[^>]+>/g, token => {
            switch (token.slice(1, -1).toLowerCase()) {
            case 'ctrl': case 'control': modifiers.push(Clutter.KEY_Control_L); break;
            case 'alt': modifiers.push(Clutter.KEY_Alt_L); break;
            case 'shift': modifiers.push(Clutter.KEY_Shift_L); break;
            case 'super': case 'meta': modifiers.push(Clutter.KEY_Super_L); break;
            }
            return '';
        }).trim();

        const named = {
            return: Clutter.KEY_Return,
            escape: Clutter.KEY_Escape,
            tab: Clutter.KEY_Tab,
            space: Clutter.KEY_space,
            plus: Clutter.KEY_plus,
            minus: Clutter.KEY_minus,
        };
        const fn = /^f([1-9]|1\d|2[0-4])$/.exec(key);
        let keyval = named[key.toLowerCase()]
            ?? (fn ? Clutter[`KEY_${fn[1]}`] : undefined);
        // Clutter has no keysym_to_keyval in this version; unicode_to_keysym is
        // the supported route and agrees with the KEY_* constants for ASCII.
        if (keyval === undefined && key.length === 1)
            keyval = Clutter.unicode_to_keysym(key.toLowerCase().codePointAt(0));
        if (!keyval)
            return false;

        this._press(keyval, modifiers);
        return true;
    }

    // ------------------------------------------------------------ the hotkey

    async _onHotkey() {
        this._clipboard = St.Clipboard.get_default();
        const cfg = this._loadConfig();
        const wmClass = this._focusClass();

        if (this._isOptedOut(wmClass, cfg)) {
            // Hand the keystroke back to the app so it keeps its own shortcut.
            if (!this._forwardHotkey() && cfg.notify === 'always')
                this._notify(`Hotkey is opted out for ${wmClass || 'this app'}`);
            return;
        }

        // Snapshot both slots before anything can disturb them.
        const snapshot = {
            clipboard: await this._getText(CLIPBOARD),
            primary: await this._getText(PRIMARY),
        };

        let selection = null;

        // Ask the app directly first. Reading PRIMARY first would be cheaper,
        // but PRIMARY is a snapshot of whatever was selected last -- in an app
        // that never publishes it, that is stale text, and pasting it over the
        // user's real selection would destroy their work.
        const isTerminal = TERMINALS.has(wmClass.toLowerCase());
        this._press(Clutter.KEY_c, isTerminal
            ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L]
            : [Clutter.KEY_Control_L]);
        await this._delay(cfg.copyDelayMs);
        selection = await this._getText(CLIPBOARD);

        // An unchanged clipboard means either "nothing was selected" or "this
        // app does not implement that chord". PRIMARY can still be current in
        // the latter case, so fall back to it rather than giving up.
        if (selection === snapshot.clipboard) {
            selection = cfg.readPrimary && snapshot.primary ? snapshot.primary : null;
            if (selection === snapshot.clipboard)
                selection = null;
        }

        const prepared = selection === null
            ? this._prepareClipboard(snapshot.clipboard, cfg)
            : preparePaste(selection);

        if (prepared === null) {
            // Nothing to convert. The copy keystroke we injected may still have
            // overwritten the clipboard, so put it back, then stay silent so
            // the selection and the undo stack are untouched.
            this._restore(snapshot, cfg.restoreDelayMs);
            return;
        }

        if (selection === null) {
            this._noSelection(prepared, snapshot, cfg);
            return;
        }

        this._setText(CLIPBOARD, prepared);
        this._press(Clutter.KEY_v, [Clutter.KEY_Control_L]);
        await this._delay(cfg.restoreDelayMs);
        this._restore(snapshot, 0);
    }

    _prepareClipboard(original, cfg) {
        if (typeof original !== 'string' || original === '')
            return null;
        const converted = toAsciiDigits(original);
        return converted === original ? null : converted;
    }

    _noSelection(prepared, snapshot, cfg) {
        // Linux has two selection slots, so nothing is actually lost:
        // the converted text goes to CLIPBOARD, the original to PRIMARY.
        this._setText(CLIPBOARD, prepared);
        if (typeof snapshot.clipboard === 'string')
            this._setText(PRIMARY, snapshot.clipboard);

        if (cfg.writeRecoveryFile && typeof snapshot.clipboard === 'string' &&
            this._writeRecovery(snapshot.clipboard)) {
            this._notify(`Clipboard converted. Original saved to ${this._recoveryPath()}`);
        } else if (cfg.notify === 'always') {
            this._notify('Clipboard converted (nothing was selected)');
        }
    }

    _restore(snapshot, delayMs) {
        const apply = () => {
            // Restoring text we only saw as null would wipe the user's image
            // or rich-text clipboard, so leave those alone.
            if (typeof snapshot.clipboard === 'string')
                this._setText(CLIPBOARD, snapshot.clipboard);
            if (typeof snapshot.primary === 'string')
                this._setText(PRIMARY, snapshot.primary);
        };
        if (delayMs > 0)
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => (apply(), GLib.SOURCE_REMOVE));
        else
            apply();
    }
}