/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// RETRACT: a value that was NEVER true (misheard / mis-inferred). Unlike SUPERSEDE,
// the removed value must NOT land in ## History (where the next rollup reads it back
// as a past fact) — it goes to a dated ## Retracted section, and status flips to
// `retracted`. This exercises the fork's flagship operation end to end through the tool.

import "./lib/ts-esm-hooks.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const VAULT = mkdtempSync(join(tmpdir(), "iva-retract-"));
process.env.ASSISTANT_VAULT_DIR = VAULT;
process.env.ASSISTANT_TIMEZONE = "UTC";
mkdirSync(join(VAULT, "cards", "contacts"), { recursive: true });
cpSync(join(REPO, "vault-template", "schema.json"), join(VAULT, "schema.json"));
process.on("exit", () => rmSync(VAULT, { recursive: true, force: true }));

const writeCard = (
  (await import(
    join(REPO, "agent", "tools", "write_card.ts")
  )) as typeof import("../agent/tools/write_card.ts")
).default;
type WriteCardInput = Parameters<typeof writeCard.execute>[0];
const inputSchema = writeCard.inputSchema as unknown as {
  parse: (v: unknown) => WriteCardInput;
};
const tool = writeCard as unknown as {
  execute: (i: WriteCardInput) => Promise<{
    ok: boolean;
    action?: string;
    status?: string;
    error?: string;
  }>;
};
const call = (args: unknown) => tool.execute(inputSchema.parse(args));
const read = (rel: string) => readFileSync(join(VAULT, rel), "utf8");

const CARD = `---
type: contact
description: Ivan, met at conference
tags: [contact]
status: active
created: 2026-07-01
source: daily/2026-07-01.md
---

# Ivan

Works at TDI Group as CTO.
`;

test("RETRACT flips status, files the reason under ## Retracted, and never archives the false value in ## History", async () => {
  writeFileSync(join(VAULT, "cards/contacts/ivan.md"), CARD, "utf8");

  const res = await call({
    operation: "RETRACT",
    type: "contact",
    title: "Ivan",
    description: "Ivan, met at conference",
    tags: ["contact"],
    body: "# Ivan\n\nCompany unknown — the TDI Group link was misheard.",
    retract_reason: "never at TDI Group — misheard company name",
  });

  assert.equal(res.ok, true);
  assert.equal(res.action, "retracted");
  assert.equal(res.status, "retracted");

  const out = read("cards/contacts/ivan.md");
  assert.match(out, /status: retracted/, "status must be retracted");
  assert.match(out, /## Retracted/, "must have a ## Retracted section");
  assert.match(
    out,
    /## Retracted[\s\S]*never at TDI Group/,
    "reason must be under ## Retracted",
  );
  assert.match(out, /2026-\d\d-\d\d: never at TDI Group/, "reason must be dated");
  // The whole point: the never-true value must not be archived as a past truth.
  assert.doesNotMatch(out, /## History/, "RETRACT must not open a ## History");
  assert.doesNotMatch(
    out,
    /Works at TDI Group/,
    "the false Compiled Truth must be replaced, not kept",
  );
});

test("RETRACT requires a reason; retract_reason is rejected on other operations", async () => {
  writeFileSync(join(VAULT, "cards/contacts/ivan.md"), CARD, "utf8");

  const noReason = await call({
    operation: "RETRACT",
    type: "contact",
    title: "Ivan",
    description: "x",
    tags: ["contact"],
    body: "# Ivan\n\nCompany unknown.",
  });
  assert.equal(noReason.ok, false);
  assert.match(noReason.error ?? "", /retract_reason/);

  const wrongOp = await call({
    operation: "UPDATE",
    type: "contact",
    title: "Ivan",
    description: "x",
    tags: ["contact"],
    body: "A neutral extra fact.",
    retract_reason: "should not be allowed here",
  });
  assert.equal(wrongOp.ok, false);
  assert.match(wrongOp.error ?? "", /RETRACT/);
});
