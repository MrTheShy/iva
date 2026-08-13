/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// tasks update: riprogrammare/annullare un promemoria senza perdere l'id.
// Stesso harness di retract.test.ts: il tool importato direttamente, DATA_DIR
// temporanea, niente eve.
import "./lib/ts-esm-hooks.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "iva-tasks-"));
process.env.ASSISTANT_DATA_DIR = DATA;
process.on("exit", () => rmSync(DATA, { recursive: true, force: true }));

const tool = (await import("../agent/tools/tasks.ts")).default as unknown as {
  execute: (i: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

test("update moves, re-arms and removes a reminder without losing the id", async () => {
  const added = (await tool.execute({
    action: "add",
    text: "bere acqua",
    remindAt: "2026-08-13T18:00:00+02:00",
  })) as { ok: boolean; added: { id: number } };
  assert.equal(added.ok, true);
  const id = added.added.id;

  // Sposta l'orario: remindAt nuovo, remindedAt (simulato) sparisce.
  const moved = (await tool.execute({
    action: "update",
    id,
    remindAt: "2026-08-13T19:30:00+02:00",
  })) as { ok: boolean; updated: { remindAt: string; remindedAt?: string } };
  assert.equal(moved.ok, true);
  assert.equal(moved.updated.remindAt, "2026-08-13T19:30:00+02:00");
  assert.equal(moved.updated.remindedAt, undefined);

  // Stringa vuota = promemoria rimosso; testo modificabile nello stesso giro.
  const cleared = (await tool.execute({
    action: "update",
    id,
    text: "bere due bicchieri",
    remindAt: "",
  })) as { ok: boolean; updated: { text: string; remindAt: null } };
  assert.equal(cleared.ok, true);
  assert.equal(cleared.updated.text, "bere due bicchieri");
  assert.equal(cleared.updated.remindAt, null);

  // Garbage rifiutato, id inesistente rifiutato.
  const bad = await tool.execute({
    action: "update",
    id,
    remindAt: "domani alle otto",
  });
  assert.equal(bad.ok, false);
  const missing = await tool.execute({ action: "update", id: 999 });
  assert.equal(missing.ok, false);
});
