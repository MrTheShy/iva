/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// The picker has two branches that are easy to get wrong and impossible to see
// failing: which language wins, and what happens to a style the menu never
// wrote. A wrong answer just shows a plausible word in the wrong language.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// settings.ts fixes the data directory at import — set it first.
const DATA_DIR = mkdtempSync(join(tmpdir(), "iva-loader-"));
process.env.ASSISTANT_DATA_DIR = DATA_DIR;
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

const { LOADER_STYLES, isLoaderStyle, loaderStyle, pickWorkingWord } =
  await import("./loader-words.ts");

function settings(value: Record<string, unknown> | null) {
  if (value === null) rmSync(SETTINGS_FILE, { force: true });
  else writeFileSync(SETTINGS_FILE, JSON.stringify(value));
}

function withLang(value: string | undefined, run: () => void) {
  const before = process.env.AGENT_LANGUAGE;
  if (value === undefined) delete process.env.AGENT_LANGUAGE;
  else process.env.AGENT_LANGUAGE = value;
  try {
    run();
  } finally {
    if (before === undefined) delete process.env.AGENT_LANGUAGE;
    else process.env.AGENT_LANGUAGE = before;
  }
}

test("an unwritten or unknown style falls back to classic", () => {
  settings(null);
  assert.equal(loaderStyle(), "classic");
  settings({ loaderStyle: "steins-gate" });
  assert.equal(loaderStyle(), "classic");
  settings({ loaderStyle: 42 });
  assert.equal(loaderStyle(), "classic");
});

test("isLoaderStyle accepts exactly the styles the menu can write", () => {
  for (const s of LOADER_STYLES) assert.ok(isLoaderStyle(s));
  assert.equal(isLoaderStyle("kurisi"), false);
  assert.equal(isLoaderStyle(undefined), false);
  assert.equal(isLoaderStyle(null), false);
});

test("AGENT_LANGUAGE=it wins, because settings.language cannot say it", () => {
  // i18n only knows en/ru, so an Italian chat can only be recognized here.
  settings({ loaderStyle: "classic", language: "ru" });
  withLang("it", () => assert.equal(pickWorkingWord(), "Lavoro…"));
});

test("settings.language beats AGENT_LANGUAGE for the languages i18n knows", () => {
  settings({ loaderStyle: "classic", language: "ru" });
  withLang("en", () => assert.equal(pickWorkingWord(), "Работаю…"));
  settings({ loaderStyle: "classic", language: "en" });
  withLang("ru", () => assert.equal(pickWorkingWord(), "Working…"));
});

test("English is the fallback when nothing says otherwise", () => {
  settings(null);
  withLang(undefined, () => assert.equal(pickWorkingWord(), "Working…"));
  settings({ language: "fr" });
  withLang("de", () => assert.equal(pickWorkingWord(), "Working…"));
});

test("every style has a non-empty pool in every language", () => {
  // pickWorkingWord indexes the pool directly, so an empty list would return
  // undefined and put the literal "undefined" next to the spinner.
  for (const style of LOADER_STYLES) {
    for (const lang of ["it", "en", "ru"] as const) {
      settings({ loaderStyle: style, language: lang === "ru" ? "ru" : "en" });
      withLang(lang, () => {
        const word = pickWorkingWord();
        assert.equal(typeof word, "string", `${style}/${lang} is not a string`);
        assert.ok(word.length > 0, `${style}/${lang} is empty`);
      });
    }
  }
});

process.on("exit", () => rmSync(DATA_DIR, { recursive: true, force: true }));
