/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import { strict as assert } from "node:assert";
import test from "node:test";
import { isEvalFresh } from "../agent/lib/eval-flag.ts";

const NOW = 1_754_600_000_000;

test("a fresh eval flag mutes, a stale or future-proofed one does not linger", () => {
  assert.equal(isEvalFresh(NOW - 60_000, NOW), true);
  assert.equal(isEvalFresh(NOW - 29 * 60_000, NOW), true);
  // Un flag orfano (crash del runner) smette di silenziare da solo.
  assert.equal(isEvalFresh(NOW - 31 * 60_000, NOW), false);
});
