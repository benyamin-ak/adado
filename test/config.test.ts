import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, coerceForTest, toGSettingsAccel } from "../src/core/config.ts";

const coerce = coerceForTest;

describe("config coercion", () => {
  it("falls back to defaults for junk input", () => {
    assert.deepEqual(coerce(null), DEFAULT_CONFIG);
    assert.deepEqual(coerce("nope"), DEFAULT_CONFIG);
    assert.deepEqual(coerce([1, 2]), DEFAULT_CONFIG);
    assert.deepEqual(coerce({}), DEFAULT_CONFIG);
  });

  it("keeps valid values", () => {
    const cfg = coerce({
      hotkey: "  Ctrl+Alt+K  ",
      restoreDelayMs: 500,
      notify: "always",
      optOutApps: ["chrome", "code"],
      readPrimary: false,
      writeRecoveryFile: false,
    });
    assert.equal(cfg.hotkey, "Ctrl+Alt+K");
    assert.equal(cfg.restoreDelayMs, 500);
    assert.equal(cfg.notify, "always");
    assert.deepEqual(cfg.optOutApps, ["chrome", "code"]);
    assert.equal(cfg.readPrimary, false);
    assert.equal(cfg.writeRecoveryFile, false);
  });

  it("ignores unknown keys and wrong types", () => {
    const cfg = coerce({ hotkey: 42, notify: "sometimes", optOutApps: "chrome", nonsense: true } as never);
    assert.deepEqual(cfg, DEFAULT_CONFIG);
  });

  it("filters non-strings out of optOutApps", () => {
    assert.deepEqual(coerce({ optOutApps: ["chrome", 7, null, "code"] }).optOutApps, ["chrome", "code"]);
  });

  it("clamps an absurd restore delay", () => {
    assert.equal(coerce({ restoreDelayMs: 999999 }).restoreDelayMs, 5000);
    assert.equal(coerce({ restoreDelayMs: -5 }).restoreDelayMs, DEFAULT_CONFIG.restoreDelayMs);
    assert.equal(coerce({ restoreDelayMs: Number.NaN }).restoreDelayMs, DEFAULT_CONFIG.restoreDelayMs);
  });

  it("rejects an empty hotkey", () => {
    assert.equal(coerce({ hotkey: "   " }).hotkey, DEFAULT_CONFIG.hotkey);
  });
});

describe("toGSettingsAccel", () => {
  it("converts the default hotkey", () => {
    assert.equal(toGSettingsAccel("Ctrl+Shift+J"), "<Ctrl><Shift>j");
  });

  it("orders modifiers the way GSettings conventionally stores them", () => {
    assert.equal(toGSettingsAccel("Shift+Ctrl+Alt+K"), "<Ctrl><Alt><Shift>k");
  });

  it("supports single-character and named keys", () => {
    assert.equal(toGSettingsAccel("Ctrl+9"), "<Ctrl>9");
    assert.equal(toGSettingsAccel("Alt+F4"), "<Alt>F4");
    assert.equal(toGSettingsAccel("Ctrl+F12"), "<Ctrl>F12");
    assert.equal(toGSettingsAccel("Ctrl+Enter"), "<Ctrl>Return");
    assert.equal(toGSettingsAccel("Ctrl+Space"), "<Ctrl>space");
    assert.equal(toGSettingsAccel("Super+J"), "<Super>j");
  });

  it("rejects function keys outside F1-F24", () => {
    assert.equal(toGSettingsAccel("Ctrl+F25"), null);
    assert.equal(toGSettingsAccel("Ctrl+F0"), null);
  });

  it("rejects malformed input rather than producing a broken accel", () => {
    assert.equal(toGSettingsAccel(""), null);
    assert.equal(toGSettingsAccel("Hyper+J"), null);
    assert.equal(toGSettingsAccel("Ctrl+NotAKey"), null);
  });
});