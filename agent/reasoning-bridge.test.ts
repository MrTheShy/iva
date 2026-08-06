/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// The bridge is the one place that decides whether a chat turn's thinking is
// shown, and whether what it collected belongs to that turn at all. Both are
// invisible at runtime — a wrong answer looks like a normal message — so they
// are pinned here.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// settings.ts fixes the data directory at import, so point it at a temp dir
// BEFORE importing anything that pulls it in.
const DATA_DIR = mkdtempSync(join(tmpdir(), "iva-reasoning-"));
process.env.ASSISTANT_DATA_DIR = DATA_DIR;
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

const {
  showReasoning,
  beginReasoning,
  pushReasoning,
  noteForeignStep,
  currentReasoning,
  endReasoning,
} = await import("./reasoning-bridge.ts");

function settings(value: Record<string, unknown> | null) {
  if (value === null) rmSync(SETTINGS_FILE, { force: true });
  else writeFileSync(SETTINGS_FILE, JSON.stringify(value));
}

function withEnv(value: string | undefined, run: () => void) {
  const before = process.env.SHOW_REASONING;
  if (value === undefined) delete process.env.SHOW_REASONING;
  else process.env.SHOW_REASONING = value;
  try {
    run();
  } finally {
    if (before === undefined) delete process.env.SHOW_REASONING;
    else process.env.SHOW_REASONING = before;
  }
}

test("deltas are dropped when no turn opened a buffer", () => {
  endReasoning(); // make sure nothing is left open from another test
  pushReasoning("stray");
  assert.equal(currentReasoning(), "");
  assert.equal(endReasoning(), "");
});

test("a turn collects its deltas and the buffer resets after it", () => {
  beginReasoning();
  pushReasoning("let me ");
  pushReasoning("think");
  assert.equal(currentReasoning(), "let me think");
  assert.equal(endReasoning(), "let me think");
  assert.equal(endReasoning(), "", "a second read must not replay the turn");
});

test("a foreign step poisons the buffer instead of mixing sessions", () => {
  // The rollup and the digest run turns in this process through eve/client, so
  // their deltas reach the same middleware while a chat turn is open. Showing
  // them as the owner's own thinking is worse than showing nothing.
  beginReasoning();
  pushReasoning("mine");
  noteForeignStep();
  pushReasoning("theirs");
  assert.equal(currentReasoning(), "", "the live draft must go quiet too");
  assert.equal(endReasoning(), "");
});

test("poisoning does not leak into the next turn", () => {
  beginReasoning();
  noteForeignStep();
  endReasoning();

  beginReasoning();
  pushReasoning("clean");
  assert.equal(endReasoning(), "clean");
});

test("a foreign step outside a turn is harmless", () => {
  noteForeignStep(); // nightly rollup while the chat is idle
  beginReasoning();
  pushReasoning("clean");
  assert.equal(endReasoning(), "clean");
});

test("showReasoning is off unless something turns it on", () => {
  settings(null);
  withEnv(undefined, () => assert.equal(showReasoning(), false));
});

test("SHOW_REASONING=1 still works for installs that predate the menu", () => {
  settings(null);
  withEnv("1", () => assert.equal(showReasoning(), true));
  withEnv("0", () => assert.equal(showReasoning(), false));
});

test("the menu setting overrides the env in both directions", () => {
  settings({ showReasoning: false });
  withEnv("1", () => assert.equal(showReasoning(), false));
  settings({ showReasoning: true });
  withEnv(undefined, () => assert.equal(showReasoning(), true));
});

test("a non-boolean setting falls back to the env, not to true", () => {
  // Menu writes a real boolean; anything else is corruption or a hand edit.
  settings({ showReasoning: "yes" });
  withEnv(undefined, () => assert.equal(showReasoning(), false));
  withEnv("1", () => assert.equal(showReasoning(), true));
});

process.on("exit", () => rmSync(DATA_DIR, { recursive: true, force: true }));
