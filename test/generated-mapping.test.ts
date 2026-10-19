import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toAsciiDigits } from "../src/core/convert.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(root, "extension/extension.js");

/**
 * The extension embeds its own copy of the digit mapping, injected by
 * scripts/generate-extension-mapping.mjs. This test proves the embedded copy is
 * equivalent to the TypeScript source across the whole BMP -- if someone edits
 * one and forgets the other, this fails instead of shipping two behaviours.
 */
describe("generated extension mapping", () => {
  let source = "";

  before(async () => {
    source = await readFile(extensionPath, "utf8");
  });

  it("contains exactly one generated mapping block", () => {
    const starts = source.match(/adado:generated-mapping:start/g) ?? [];
    const ends = source.match(/adado:generated-mapping:end/g) ?? [];
    assert.equal(starts.length, 1, "expected one start marker");
    assert.equal(ends.length, 1, "expected one end marker");
  });

  it("imports nothing from a sibling module", () => {
    // The extension must stay a single self-contained file: gnome-extensions
    // pack silently drops subdirectories, which broke an earlier layout.
    const relativeImports = [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(relativeImports, [], `unexpected relative imports: ${relativeImports.join(", ")}`);
  });

  it("maps every code point exactly as the TypeScript source does", () => {
    const block = /adado:generated-mapping:start[\s\S]*?new Map\((\[\[.*?\]\])\);[\s\S]*?adado:generated-mapping:end/.exec(source);
    assert.ok(block, "could not locate the DIGIT_MAP literal");

    const entries = new Map<number, string>(JSON.parse(block[1]!));

    let mismatches = 0;
    for (let cp = 0; cp <= 0xffff; cp++) {
      const ch = String.fromCodePoint(cp);
      // An absent entry means "unchanged", which is what the source does too.
      const expected = toAsciiDigits(ch);
      const actual = entries.get(cp) ?? ch;
      if (expected !== actual) {
        if (mismatches === 0) {
          console.error(
            `mismatch at U+${cp.toString(16).toUpperCase().padStart(4, "0")}: ` +
            `source=${JSON.stringify(expected)} extension=${JSON.stringify(actual)}`,
          );
        }
        mismatches++;
      }
    }
    assert.equal(mismatches, 0, `${mismatches} code point(s) differ from the TypeScript source`);
  });

  it("actually changes the two digit ranges", () => {
    const block = /new Map\((\[\[.*?\]\])\);/.exec(source);
    assert.ok(block);
    const entries = new Map<number, string>(JSON.parse(block[1]!));
    assert.equal(entries.size, 20, "expected exactly 10 Arabic-Indic + 10 Persian digits");

    for (let i = 0; i < 10; i++) {
      assert.equal(entries.get(0x0660 + i), String(i));
      assert.equal(entries.get(0x06f0 + i), String(i));
    }
  });
});