/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  NAG_COOLDOWN_MS,
  shouldThink,
  THINK_IDLE_MS,
} from "./heartbeat-gate.ts";

const NOW = 1_754_600_000_000;
const base = {
  fingerprint: "a|b|c",
  lastFingerprint: "a|b|c",
  lastThinkAt: NOW - 10 * 60_000,
  now: NOW,
  ghosted: false,
};

test("a changed world triggers a think, a static one does not", () => {
  assert.equal(shouldThink({ ...base, fingerprint: "a|b|D" }).think, true);
  assert.equal(shouldThink(base).think, false);
});

test("a static world still gets a periodic think after the idle window", () => {
  assert.equal(
    shouldThink({ ...base, lastThinkAt: NOW - THINK_IDLE_MS }).think,
    true,
  );
  assert.equal(
    shouldThink({ ...base, lastThinkAt: undefined }).think,
    true, // mai pensato → pensa
  );
});

test("two unanswered initiatives block even a changed world, until tomorrow", () => {
  const nagged = {
    ...base,
    fingerprint: "a|b|D",
    ghosted: true,
    unanswered: 2,
    lastSpokeAt: NOW - 3 * 3_600_000,
  };
  assert.equal(shouldThink(nagged).think, false);
  // Passato il cooldown si riprova.
  assert.equal(
    shouldThink({ ...nagged, lastSpokeAt: NOW - NAG_COOLDOWN_MS }).think,
    true,
  );
  // Una sola senza risposta non blocca.
  assert.equal(shouldThink({ ...nagged, unanswered: 1 }).think, true);
  // Se ha risposto (non ghosted), nessun blocco.
  assert.equal(shouldThink({ ...nagged, ghosted: false }).think, true);
});
