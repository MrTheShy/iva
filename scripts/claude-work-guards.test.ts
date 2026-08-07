/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// These are the only reasons the tool exists — the rest of running a Claude
// conversation is Claude Code's own. If one of them silently stops holding,
// nothing else notices: a session opens outside work/, Iva's keys ride into a
// process that reads untrusted repos, or a malformed id reaches a command line.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  isSessionId,
  resolveWorkdir,
  scrubEnv,
  workRoot,
} from "./lib/claude-work-guards.ts";

const CWD = "/srv/iva";

test("a project resolves to one directory inside work/", () => {
  assert.equal(resolveWorkdir("speedrush", CWD), join(CWD, "work", "speedrush"));
  assert.equal(
    resolveWorkdir("zero-effort.it", CWD),
    join(CWD, "work", "zero-effort.it"),
  );
});

test("traversal and absolute paths are refused, not normalized away", () => {
  for (const bad of [
    "../vault",
    "../../etc",
    "a/b",
    "/etc/passwd",
    "..",
    ".",
    "",
    "-flag",
    "x".repeat(65),
  ]) {
    assert.throws(
      () => resolveWorkdir(bad, CWD),
      `"${bad}" doveva essere rifiutato`,
    );
  }
});

test("only a real session id reaches the command line", () => {
  assert.ok(isSessionId("495c69a8-d4a6-4353-bbc6-07320b290b23"));
  for (const bad of [
    "",
    "495c69a8",
    "--dangerously-skip-permissions",
    "495c69a8-d4a6-4353-bbc6-07320b290b23 ; rm -rf /",
    undefined,
    null,
    42,
  ]) {
    assert.equal(isSessionId(bad), false, `"${String(bad)}" non è un id`);
  }
});

test("Iva's credentials do not ride into the conversation", () => {
  const clean = scrubEnv({
    PATH: "/usr/bin",
    HOME: "/home/maurizio",
    OLLAMA_API_KEY: "sk-deepseek",
    TELEGRAM_BOT_TOKEN: "123:abc",
    DEEPGRAM_API_KEY: "dg",
    TAVILY_API_KEY: "tvly",
    ASSISTANT_BEARER: "bearer",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "shh",
    GH_PASSWORD: "hunter2",
    SOME_CREDENTIAL: "x",
  });
  assert.deepEqual(clean, { PATH: "/usr/bin", HOME: "/home/maurizio" });
});

test("scrubbing keeps what the session actually needs", () => {
  const clean = scrubEnv({
    PATH: "/usr/bin",
    LANG: "it_IT.UTF-8",
    TZ: "Europe/Rome",
  });
  assert.deepEqual(clean, {
    PATH: "/usr/bin",
    LANG: "it_IT.UTF-8",
    TZ: "Europe/Rome",
  });
});

test("workRoot is work/ under the process cwd", () => {
  assert.equal(workRoot(CWD), join(CWD, "work"));
});
