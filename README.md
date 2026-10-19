# adado

Press one hotkey to convert Arabic-Indic and Persian digits in your selection to
ASCII digits — in whatever app you're typing in.

You write `۱۴۰۳`, press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd>, and it
becomes `1403`. Your selection, your undo stack and your clipboard come out the
other side exactly as they went in.

```
قیمت ۱۲۳ تومان   →   قیمت 123 تومان
سال ۱۴۰۳         →   سال 1403
٢٠٢٤              →   2024
```

## Install

```sh
npx adado                 # Linux: installs and enables the GNOME extension
npx adado doctor          # check that it works on your desktop
```

On **macOS** and **Windows** the same command registers a login item and starts
the daemon. macOS will ask you to grant Accessibility permission to your
terminal or `node` binary — that is required for synthetic paste and cannot be
avoided.

### Also available without the hotkey

```sh
npx adado convert "۱۲۳"        # -> 123
cat log.txt | npx adado convert # filter
```

As a library:

```js
import { toAsciiDigits, preparePaste } from "adado";

toAsciiDigits("۱۲۳");   // "123"
preparePaste("۱۲۳\n");  // "123"   (strips the trailing newline)
preparePaste("سلام");    // null    (nothing to do)
```

## What it converts

Exactly two Unicode ranges:

| Range | Digits |
|---|---|
| `U+0660`–`U+0669` | `٠١٢٣٤٥٦٧٨٩` Arabic-Indic |
| `U+06F0`–`U+06F9` | `۰۱۲۳۴۵۶۷۸۹` Persian / Extended Arabic-Indic |

## What it does not do

Letters are never transliterated. `علي` stays `علي`. This is a digit tool, not a
transliterator.

**Arabic punctuation is deliberately left alone too.** That means the Arabic
decimal separator and thousands separator survive:

```
۱۲٫۵   →   12٫5      ← the ٫ (U+066B) is still there
۵۰٪     →   50٪
۱٬۰۰۰   →   1٬000
```

This is intentional and it is the one sharp edge. A decimal number written with
`٫` comes out looking broken, because we only touch digits. If you would rather
those three numeric marks convert too (`٫` → `.`, `٬` → `,`, `٪` → `%`), that is a
small change to one mapping table.

## Configuration

`~/.config/adado/config.json` (macOS: `~/Library/Application Support/adado`,
Windows: `%APPDATA%\adado`). Every key is optional; the file is created on first
run.

```json
{
  "hotkey": "Ctrl+Shift+J",
  "restoreDelayMs": 250,
  "notify": "error-only",
  "optOutApps": [],
  "readPrimary": true,
  "writeRecoveryFile": true
}
```

| Key | Default | Meaning |
|---|---|---|
| `hotkey` | `Ctrl+Shift+J` | See the GNOME note below. |
| `restoreDelayMs` | `250` | How long to wait before restoring the clipboard after pasting. |
| `notify` | `error-only` | `always` also toasts on success. |
| `optOutApps` | `[]` | Apps that keep the hotkey for themselves. |
| `readPrimary` | `true` | Read the X11 PRIMARY selection before injecting a copy. |
| `writeRecoveryFile` | `true` | Save the pre-conversion clipboard when nothing was selected. |

### The hotkey on GNOME

GNOME only grants global keybindings that are declared in a GSettings schema, so
on Linux the hotkey lives in GSettings and your JSON value is mirrored into it at
install time:

```sh
gsettings set org.gnome.shell.extensions.adado hotkey '<Ctrl><Alt>j'
```

`Ctrl+Shift+J` is also DevTools in Chrome, the Console in Firefox, and the
shortcut editor in VS Code. GNOME grabs the key globally, so those apps will stop
receiving it. Put them in `optOutApps` and adado will **replay** the keystroke
into the focused window so they keep working:

```json
{ "optOutApps": ["chrome", "firefox", "code"] }
```

Matching is a case-insensitive substring of the window's `wm_class`.

## How it behaves

**With a selection:** adado reads the selection, converts it, writes the result
to the clipboard, presses <kbd>Ctrl</kbd>+<kbd>V</kbd>, then puts both clipboard
slots back exactly as they were.

**With nothing selected:** on Linux the converted text goes to the clipboard and
the original goes to the PRIMARY selection (middle-click), so nothing is lost. On
macOS and Windows there is only one clipboard, so the original is written to
`~/.local/state/adado/last-clipboard.txt` and the notification tells you where.

**With text that has no Arabic or Persian digits:** nothing happens at all. No
toast, no paste, your selection and undo stack untouched.

**In terminals:** a bare <kbd>Ctrl</kbd>+<kbd>C</kbd> is `SIGINT`, so adado never
sends it to a terminal. It sends <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>
instead, which is inert when there is no selection.

## Platform support

| Platform | Hotkey | How |
|---|---|---|
| Linux (GNOME 49/50, Wayland) | yes | Shell extension, in-process |
| Linux (KDE, Sway, X11 sessions) | no | `convert` works; the hotkey needs GNOME |
| macOS | yes | Node daemon + Accessibility permission |
| Windows | yes | Node daemon, `keybd_event` injection |

**Zero root, everywhere.** No `uinput`, no `xdotool`, no `wl-clipboard`, no
`sudo`, and nothing to install from your distro. On Linux adado runs entirely
inside GNOME Shell; there is no background Node process.

### Snap apps

Snap confinement gives each snap its own clipboard surface. adado is expected to
work with the majority of your apps, but clipboard round-tripping inside a snap
(including Firefox) is not guaranteed and is documented as untested.

## Development

```sh
npm install
npm test                  # node:test
npm run typecheck
npm run build             # tsc -> dist/
npm run build:extension   # regenerate the mapping inside extension.js
```

The digit mapping is authored once, in `src/core/convert.ts`. The extension's
copy is generated from it, and a test asserts the two agree across the entire
BMP, so they cannot drift apart.

`scripts/verify-extension.js` loads the real extension module under GJS with
GNOME Shell's typelibs and exercises it. This exists because GNOME 50 cannot
hot-reload extension code, so this is what catches a broken import or a renamed
Clutter constant *before* you spend a logout on it:

```sh
GI_TYPELIB_PATH=/usr/lib/gnome-shell:/usr/lib/x86_64-linux-gnu/mutter-18 \
LD_LIBRARY_PATH=/usr/lib/gnome-shell:/usr/lib/x86_64-linux-gnu/mutter-18 \
gjs -m scripts/verify-extension.js
```

### A GNOME development loop worth knowing

GNOME 50 dropped `Alt+F2 r`, and an extension can only be imported once per
session. To apply a code change:

```sh
npm run build:extension
# bump "version" in extension/metadata.json
node dist/cli.js install-extension   # disables, redeploys, re-enables
```

Bumping the version is what lets the shell accept the new code without a logout.
Skip it and the extension silently enters an error state instead.

## License

MIT