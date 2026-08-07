/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// These limits are the only reason the tool exists — the rest of running a
// Claude conversation is Claude Code's own. If one of them silently stops
// holding, nothing else notices: a session opens outside work/, Iva's keys
// ride into a process that reads untrusted repos, the box OOMs on a third
// claude, or an autonomous ping-pong burns the subscription for hours.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  BUSY_STALE_MS,
  LEGS_PER_HOUR,
  MAX_CONCURRENT,
  envForClaude,
  isBusy,
  isSessionId,
  pruneLegs,
  resolveWorkdir,
  workRoot,
} from "./lib/claude-work-guards.ts";

const CWD = "/srv/iva";

test("a project resolves to one directory inside work/", () => {
  assert.equal(
    resolveWorkdir("speedrush", CWD),
    join(CWD, "work", "speedrush"),
  );
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

test("the env is an allowlist: unknown names are dropped, listed ones kept", () => {
  // PHILOSOPHY bans blacklists as a security boundary. The proof that an
  // allowlist is right: a secret with an unmatchable name still does not pass.
  const clean = envForClaude({
    PATH: "/usr/bin",
    HOME: "/home/maurizio",
    LANG: "it_IT.UTF-8",
    LC_ALL: "it_IT.UTF-8",
    TZ: "Europe/Rome",
    SSH_AUTH_SOCK: "/run/user/1000/ssh",
    // secrets, including ones no name-pattern would catch:
    OLLAMA_API_KEY: "sk-deepseek",
    TELEGRAM_BOT_TOKEN: "123:abc",
    ASSISTANT_BEARER: "bearer",
    DG: "a-secret-with-an-innocent-name",
    IVA_PORT: "8723",
  });
  assert.deepEqual(clean, {
    PATH: "/usr/bin",
    HOME: "/home/maurizio",
    LANG: "it_IT.UTF-8",
    LC_ALL: "it_IT.UTF-8",
    TZ: "Europe/Rome",
    SSH_AUTH_SOCK: "/run/user/1000/ssh",
  });
});

test("busy means a fresh claim; a crashed leg expires on its own", () => {
  const now = 10_000_000;
  assert.equal(isBusy(undefined, now), false);
  assert.equal(isBusy({}, now), false);
  assert.equal(isBusy({ busyAt: now - 1000 }, now), true);
  assert.equal(
    isBusy({ busyAt: now - BUSY_STALE_MS - 1 }, now),
    false,
    "un claim più vecchio del timeout del runner è un crash, non un lavoro",
  );
});

test("the leash window keeps an hour of legs and drops garbage", () => {
  const now = 10_000_000_000;
  const legs = [
    now - 30 * 60_000, // dentro l'ora
    now - 59 * 60_000, // dentro
    now - 61 * 60_000, // fuori
    "not-a-number",
    null,
  ];
  assert.deepEqual(pruneLegs(legs, now), [
    now - 30 * 60_000,
    now - 59 * 60_000,
  ]);
  assert.deepEqual(pruneLegs(undefined, now), []);
  assert.deepEqual(pruneLegs("x", now), []);
});

test("the constants say what the comments promise", () => {
  assert.equal(MAX_CONCURRENT, 2);
  assert.ok(LEGS_PER_HOUR >= 6 && LEGS_PER_HOUR <= 20);
  assert.ok(BUSY_STALE_MS > 45 * 60_000, "deve superare il timeout del runner");
});

test("workRoot is work/ under the process cwd", () => {
  assert.equal(workRoot(CWD), join(CWD, "work"));
});
