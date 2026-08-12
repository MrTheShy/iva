/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import { strict as assert } from "node:assert";
import test from "node:test";
import { dueReminders } from "./reminders.ts";

const NOW = Date.parse("2026-08-12T18:30:00+02:00");

const task = (over: Record<string, unknown>) => ({
  id: 1,
  text: "chiama il dentista",
  done: false,
  ...over,
});

test("a reminder fires at its minute and not before", () => {
  const early = task({ remindAt: "2026-08-12T18:31:00+02:00" });
  const due = task({ remindAt: "2026-08-12T18:30:00+02:00" });
  assert.deepEqual(dueReminders([early], NOW), []);
  assert.deepEqual(dueReminders([due], NOW), [due]);
});

test("done, already-reminded, absent and garbage remindAt never fire", () => {
  const past = "2026-08-12T10:00:00+02:00";
  assert.deepEqual(
    dueReminders(
      [
        task({ remindAt: past, done: true }),
        task({ remindAt: past, remindedAt: "2026-08-12T10:00:05.000Z" }),
        task({}),
        task({ remindAt: null }),
        task({ remindAt: "domani alle otto" }),
      ],
      NOW,
    ),
    [],
  );
});

test("a reminder missed during downtime is still due afterwards", () => {
  const missed = task({ remindAt: "2026-08-11T09:00:00+02:00" });
  assert.deepEqual(dueReminders([missed], NOW), [missed]);
});
