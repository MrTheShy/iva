/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// The quiet window wraps midnight, which is the one piece of heartbeat logic
// that fails silently: get it backwards and she either calls at 04:00 or never
// speaks at all, and both look like "the schedule isn't working".
//
// Also covers the interval gate, whose job is to space ticks out so the
// 5-minute cron floor never becomes the real cadence.

import test from "node:test";
import assert from "node:assert/strict";
import { inQuietHours, shouldTick } from "./lib/heartbeat-window.ts";

test("a window that wraps midnight covers both sides of it", () => {
  const from = 23;
  const to = 8;
  for (const h of [23, 0, 3, 7]) {
    assert.equal(inQuietHours(h, from, to), true, `${h}:00 should be quiet`);
  }
  for (const h of [8, 12, 18, 22]) {
    assert.equal(inQuietHours(h, from, to), false, `${h}:00 should be awake`);
  }
});

test("a window inside one day does not wrap", () => {
  // Someone who works nights could invert it: quiet 09:00–17:00.
  for (const h of [9, 13, 16]) assert.equal(inQuietHours(h, 9, 17), true);
  for (const h of [8, 17, 23, 0]) assert.equal(inQuietHours(h, 9, 17), false);
});

test("the boundaries are half-open, so an hour is never quiet on both ends", () => {
  assert.equal(inQuietHours(23, 23, 8), true, "the start hour is quiet");
  assert.equal(inQuietHours(8, 23, 8), false, "the end hour is awake");
});

test("an empty window silences nothing", () => {
  // from === to must mean "no quiet hours", not "quiet all day" — otherwise
  // setting both to the same value would mute her forever with no error.
  for (const h of [0, 8, 12, 23]) assert.equal(inQuietHours(h, 7, 7), false);
});

test("a tick is due only after the configured interval", () => {
  const at = (mins: number) => ({ now: mins * 60_000, hour: 12, lastTickAt: 0 });
  assert.equal(shouldTick({ intervalMinutes: 15 }, at(14)), false);
  assert.equal(shouldTick({ intervalMinutes: 15 }, at(15)), true);
  assert.equal(shouldTick({}, at(14)), false, "the default is 15 minutes");
});

test("an interval below the cron floor is clamped, not honoured", () => {
  // The cron cannot fire faster than every 5 minutes, so a 1-minute setting
  // must not turn every cron slot into a tick.
  const at = (mins: number) => ({ now: mins * 60_000, hour: 12, lastTickAt: 0 });
  assert.equal(shouldTick({ intervalMinutes: 1 }, at(4)), false);
  assert.equal(shouldTick({ intervalMinutes: 1 }, at(5)), true);
});

test("quiet hours win over a due tick", () => {
  const due = { now: 10 * 3_600_000, hour: 3, lastTickAt: 0 };
  assert.equal(shouldTick({ intervalMinutes: 15 }, due), false);
  assert.equal(shouldTick({ intervalMinutes: 15 }, { ...due, hour: 12 }), true);
});

test("a first-ever tick is due immediately outside quiet hours", () => {
  // lastTickAt is 0 when the state file does not exist yet. Any real clock is
  // far past the interval from the epoch, so she starts on the next tick
  // instead of waiting one interval after being switched on.
  const now = Date.UTC(2026, 7, 6, 10, 0, 0);
  assert.equal(shouldTick({}, { now, hour: 10, lastTickAt: 0 }), true);
});
