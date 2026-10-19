import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { hasArabicDigits, preparePaste, toAsciiDigits } from "../src/core/convert.ts";

describe("toAsciiDigits", () => {
  it("converts Persian digits (U+06F0..U+06F9)", () => {
    assert.equal(toAsciiDigits("۰۱۲۳۴۵۶۷۸۹"), "0123456789");
    assert.equal(toAsciiDigits("۱۲۳"), "123");
  });

  it("converts Arabic-Indic digits (U+0660..U+0669)", () => {
    assert.equal(toAsciiDigits("٠١٢٣٤٥٦٧٨٩"), "0123456789");
    assert.equal(toAsciiDigits("٢٠٢٤"), "2024");
  });

  it("converts mixed digit systems in one string", () => {
    assert.equal(toAsciiDigits("۱۲abc۴۵"), "12abc45");
    assert.equal(toAsciiDigits("12۳"), "123");
    assert.equal(toAsciiDigits("۱۲۳0۴۵۶"), "1230456");
  });

  it("leaves letters and all other characters untouched", () => {
    assert.equal(toAsciiDigits("سال ۱۴۰۳"), "سال 1403");
    assert.equal(toAsciiDigits("سلام"), "سلام");
    assert.equal(toAsciiDigits("hello"), "hello");
  });

  it("leaves Arabic punctuation untouched, per spec", () => {
    // U+066B is deliberately NOT converted. See README "What it does not do".
    assert.equal(toAsciiDigits("۱۲٫۵"), "12٫5");
    assert.equal(toAsciiDigits("۵۰٪"), "50٪");
    assert.equal(toAsciiDigits("۱٬۰۰۰"), "1٬000");
  });

  it("handles other numeral systems without touching them", () => {
    assert.equal(toAsciiDigits("१२३"), "१२३"); // Devanagari
    assert.equal(toAsciiDigits("๑๒๓"), "๑๒๓"); // Thai
  });

  it("preserves whitespace, newlines and emoji", () => {
    assert.equal(toAsciiDigits("  ۱۲\t\n۳۴  "), "  12\t\n34  ");
    assert.equal(toAsciiDigits("۱ 🎉 ۲"), "1 🎉 2");
  });

  it("is a no-op on empty and non-BMP input", () => {
    assert.equal(toAsciiDigits(""), "");
    assert.equal(toAsciiDigits("𝟙"), "𝟙");
  });

  it("does not corrupt surrogate pairs", () => {
    assert.equal(toAsciiDigits("👩‍💻 ۱۲"), "👩‍💻 12");
  });
});

describe("hasArabicDigits", () => {
  it("detects both ranges", () => {
    assert.equal(hasArabicDigits("۱"), true);
    assert.equal(hasArabicDigits("١"), true);
  });

  it("rejects text with no Arabic or Persian digits", () => {
    assert.equal(hasArabicDigits("سلام"), false);
    assert.equal(hasArabicDigits("123"), false);
    assert.equal(hasArabicDigits(""), false);
  });
});

describe("preparePaste", () => {
  it("returns null when there is nothing to convert", () => {
    assert.equal(preparePaste("سلام دنیا"), null);
    assert.equal(preparePaste("already 123"), null);
    assert.equal(preparePaste(""), null);
  });

  it("returns null rather than pasting an unchanged selection", () => {
    // Same behaviour even when the clipboard has a trailing newline.
    assert.equal(preparePaste("hello\n"), null);
  });

  it("strips exactly one trailing line break", () => {
    assert.equal(preparePaste("۱۲۳\n"), "123");
    assert.equal(preparePaste("۱۲۳\r\n"), "123");
  });

  it("strips only one newline, not all trailing whitespace", () => {
    assert.equal(preparePaste("۱۲۳\n\n"), "123\n");
    assert.equal(preparePaste("۱۲۳  \n"), "123  ");
  });

  it("converts multi-line selections", () => {
    assert.equal(preparePaste("۱۰\n۲۰\n۳۰\n"), "10\n20\n30");
  });
});