import assert from "node:assert/strict";
import test from "node:test";
import { memoryWeight } from "./memory-weight.ts";

test("missing fields keep the old behaviour: full relevance, routine salience", () => {
  assert.equal(
    memoryWeight(100, undefined, undefined, false),
    100 * 1 * (1 + 0.09),
  );
});

test("high salience wins over routine at equal BM25", () => {
  const routine = memoryWeight(100, 1, 0.3, false);
  const salient = memoryWeight(100, 1, 0.9, false);
  assert.ok(salient > routine);
});

test("decayed relevance suppresses until reinforcement lifts it back", () => {
  const fresh = memoryWeight(100, 1, 0.3, false);
  const decayed = memoryWeight(100, 0.1, 0.3, false);
  assert.ok(decayed < fresh * 0.7);
  assert.ok(decayed > 0, "suppressed, never erased");
});

test("stale keeps its historical 0.3 malus", () => {
  assert.equal(
    memoryWeight(100, 1, 0.3, true),
    memoryWeight(100, 1, 0.3, false) * 0.3,
  );
});

test("out-of-range values are clamped, not trusted", () => {
  assert.equal(memoryWeight(100, 7, -3, false), 100 * 1 * 1);
  assert.equal(memoryWeight(100, Number.NaN, Number.NaN, false), 100 * 1.09);
});
