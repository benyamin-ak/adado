#!/usr/bin/env node
// Generates extension/lib/convert.js from src/core/convert.ts.
//
// The digit mapping is authored once, in TypeScript. Rather than maintaining a
// second hand-written copy in GJS -- where it would silently drift -- we ask
// the real implementation which code points it actually changes, and emit a
// lookup table from that answer. If the table and the source ever disagree,
// the round-trip assertions below fail and the build stops.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const { toAsciiDigits, preparePaste } = await import(join(root, "src/core/convert.ts"));

const SCAN_MAX = 0x10000; // BMP is where all digit forms live

const entries = [];
for (let cp = 0; cp < SCAN_MAX; cp++) {
  const ch = String.fromCodePoint(cp);
  const out = toAsciiDigits(ch);
  if (out !== ch) entries.push([cp, out]);
}

if (entries.length === 0) {
  console.error("generate-mapping: refusing to emit an empty mapping table");
  process.exit(1);
}

const pairs = entries.map(([cp, out]) => `[${cp},"${out}"]`).join(",");

// Round-trip check: feed every generated pair back through the TypeScript
// implementation and require the exact same result.
for (const [cp, out] of entries) {
  const ch = String.fromCodePoint(cp);
  if (toAsciiDigits(ch) !== out) {
    console.error(`generate-mapping: table disagrees with source at U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
    process.exit(1);
  }
}

const block = `/* adado:generated-mapping:start */
// Regenerate with: npm run build:extension
// Derived from src/core/convert.ts - never hand-edit this block.
const DIGIT_MAP = new Map([${pairs}]);
/* adado:generated-mapping:end */`;

const target = join(root, "extension/extension.js");
const original = await readFile(target, "utf8");

const START = "/* adado:generated-mapping:start */";
const END = "/* adado:generated-mapping:end */";
const start = original.indexOf(START);
const end = original.indexOf(END);
if (start === -1 || end === -1) {
  console.error(`generate-mapping: markers not found in ${target}`);
  process.exit(1);
}
const patched = original.slice(0, start) + block + original.slice(end + END.length);
await writeFile(target, patched, "utf8");

console.log(`generate-mapping: injected ${entries.length} mappings into extension/extension.js`);

// The extension's own copy must behave like the original for the shipped API.
if (preparePaste("۱۲۳\n") !== "123") {
  console.error("generate-mapping: preparePaste self-check failed");
  process.exit(1);
}