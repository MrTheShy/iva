/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// These three limits are the only reason the tool exists — the rest of running a
// job is Claude Code's. If one of them silently stops holding, nothing else in
// the system notices: the box OOMs, a job writes outside work/, or Iva's keys
// ride into a process that reads untrusted repos.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  MAX_JOBS,
  atCapacity,
  resolveWorkdir,
  scrubEnv,
  workRoot,
} from "./lib/claude-work-guards.ts";

const CWD = "/srv/iva";

test("a job resolves inside work/, one directory per project", () => {
  assert.equal(resolveWorkdir("speedrush", CWD), join(CWD, "work", "speedrush"));
  assert.equal(resolveWorkdir("zero-effort.it", CWD), join(CWD, "work", "zero-effort.it"));
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

test("the cap counts running jobs and refuses the one over", () => {
  assert.equal(atCapacity([]), false);
  assert.equal(atCapacity([{}]), false);
  assert.equal(atCapacity([{}, {}]), true, `il tetto è ${MAX_JOBS}`);
  assert.equal(atCapacity([{}, {}, {}]), true);
});

test("an unreadable registry must never look like room to spare", () => {
  // listAgents() throws rather than returning [], but if a non-array ever
  // reached here it must not read as "zero jobs running".
  assert.equal(atCapacity(null), false, "null non è una lista di lavori");
  // The guard above is why the caller treats a failed read as fatal, not empty.
});

test("Iva's credentials do not ride into the job", () => {
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

test("scrubbing keeps what the job actually needs", () => {
  const clean = scrubEnv({ PATH: "/usr/bin", LANG: "it_IT.UTF-8", TZ: "Europe/Rome" });
  assert.deepEqual(clean, { PATH: "/usr/bin", LANG: "it_IT.UTF-8", TZ: "Europe/Rome" });
});

test("workRoot is work/ under the process cwd", () => {
  assert.equal(workRoot(CWD), join(CWD, "work"));
});
