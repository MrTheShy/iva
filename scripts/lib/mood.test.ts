import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAbsence,
  applyAppraisal,
  applyDecay,
  defaultMood,
  moodLine,
  parseAppraisal,
  type Appraisal,
} from "./mood.ts";

const NOW = 1_754_600_000_000;

const appraisal = (over: Partial<Appraisal> = {}): Appraisal => ({
  valenza: 0,
  intensita: 0,
  chiusura: "neutra",
  temaAperto: null,
  ...over,
});

test("a warm intense exchange raises warmth and energy, talking discharges curiosity", () => {
  const out = applyAppraisal(
    defaultMood(0),
    appraisal({ valenza: 1, intensita: 1, chiusura: "calda" }),
    NOW,
  );
  assert.equal(out.calore, 58);
  assert.equal(out.energia, 60);
  assert.equal(out.curiosita, 35);
  assert.equal(out.ultimaChiusura?.tono, "calda");
});

test("a heavy exchange lowers both, and the closure is remembered", () => {
  const out = applyAppraisal(
    defaultMood(0),
    appraisal({ valenza: -1, intensita: 0.5, chiusura: "pesante" }),
    NOW,
  );
  assert.equal(out.calore, 46);
  assert.equal(out.energia, 45);
  assert.equal(out.ultimaChiusura?.tono, "pesante");
  assert.equal(out.ultimaChiusura?.at, NOW);
});

test("an open thread keeps curiosity at least at 60", () => {
  const out = applyAppraisal(
    defaultMood(0),
    appraisal({ temaAperto: "trasloco" }),
    NOW,
  );
  assert.equal(out.curiosita, 60);
  assert.equal(out.ultimaChiusura?.temaAperto, "trasloco");
});

test("values never leave 0..100", () => {
  const hot = { ...defaultMood(0), calore: 99, energia: 99 };
  const out = applyAppraisal(
    hot,
    appraisal({ valenza: 1, intensita: 1 }),
    NOW,
  );
  assert.equal(out.calore, 100);
  assert.equal(out.energia, 100);
});

test("48 hours halve the distance from baseline", () => {
  const mood = { ...defaultMood(0), calore: 90, energia: 10, curiosita: 70 };
  const out = applyDecay(mood, 48, NOW);
  assert.equal(Math.round(out.calore), 70);
  assert.equal(Math.round(out.energia), 30);
  assert.equal(Math.round(out.curiosita), 60);
  assert.equal(out.updatedAt, NOW);
});

test("zero or negative hours change nothing", () => {
  const mood = { ...defaultMood(0), calore: 90 };
  assert.equal(applyDecay(mood, 0, NOW), mood);
  assert.equal(applyDecay(mood, -5, NOW), mood);
});

test("absence raises curiosity only past 12 hours, capped at 85", () => {
  const mood = defaultMood(0);
  assert.equal(applyAbsence(mood, 12, NOW), mood);
  assert.equal(applyAbsence(mood, 22, NOW).curiosita, 70);
  assert.equal(applyAbsence(mood, 400, NOW).curiosita, 85);
});

test("a cold relationship does not accumulate abandonment anxiety", () => {
  const cold = { ...defaultMood(0), calore: 39 };
  assert.equal(applyAbsence(cold, 100, NOW), cold);
});

test("appraisal JSON survives surrounding chatter and gets clamped", () => {
  const parsed = parseAppraisal(
    'Ecco la valutazione: {"valenza": 3, "intensita": -2, "chiusura": "calda", "temaAperto": "  trasloco  "} spero vada bene',
  );
  assert.deepEqual(parsed, {
    valenza: 1,
    intensita: 0,
    chiusura: "calda",
    temaAperto: "trasloco",
  });
});

test("garbage, wrong closures and missing numbers become null, never a crash", () => {
  for (const raw of [
    "",
    "no json here",
    "{not json}",
    '{"valenza": "x", "intensita": 1, "chiusura": "calda"}',
    '{"valenza": 0, "intensita": 1, "chiusura": "tsundere"}',
    "[1,2,3]",
  ]) {
    assert.equal(parseAppraisal(raw), null, `raw: ${raw}`);
  }
});

test("an empty open theme is null, a long one is cut at 80 chars", () => {
  assert.equal(
    parseAppraisal('{"valenza":0,"intensita":0,"chiusura":"neutra","temaAperto":"   "}')
      ?.temaAperto,
    null,
  );
  const long = parseAppraisal(
    `{"valenza":0,"intensita":0,"chiusura":"neutra","temaAperto":"${"a".repeat(200)}"}`,
  );
  assert.equal(long?.temaAperto?.length, 80);
});

test("the injected line carries the state, the usage rule and the open thread", () => {
  const mood = applyAppraisal(
    { ...defaultMood(0), energia: 30 },
    appraisal({ valenza: -1, intensita: 0.6, temaAperto: "trasloco" }),
    NOW,
  );
  const en = moodLine(mood, "en");
  assert.ok(en.includes("warmth"));
  assert.ok(en.includes("sober"), "low energy must ask for a sober tone");
  assert.ok(en.includes("trasloco"));
  assert.ok(en.includes("honestly"));
  const ru = moodLine(mood, "ru");
  assert.ok(ru.includes("тепло"));
  assert.ok(ru.includes("трезвый"));
});
