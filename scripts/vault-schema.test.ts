/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// The schema is the single source of truth for card types and statuses:
// write_card.ts reads it and builds the zod enums from it, so a status missing
// here is a status the model cannot write. These tests pin the invariants that
// are easy to break by editing JSON by hand.
//
// Lives in scripts/, not next to the file it checks: vault-template/ is copied
// wholesale into the user's vault (scripts/init-vault.ts), so a test file there
// would ship into every install.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

type NodeType = { status?: string[] };
type Schema = {
  node_types: Record<string, NodeType>;
  status_order: Record<string, number>;
};

const REPO = fileURLToPath(new URL("..", import.meta.url));
const schema = JSON.parse(
  readFileSync(join(REPO, "vault-template", "schema.json"), "utf8"),
) as Schema;

test("schema parses and declares node types", () => {
  assert.ok(Object.keys(schema.node_types).length > 0);
});

test("every node type can be retracted", () => {
  // RETRACT is the operation for a value that was never true — misheard,
  // mis-linked, or inferred wrong. Without this status the only way to remove
  // such a card is `archived`, which means "no longer relevant" and quietly
  // asserts the thing was once true.
  for (const [type, node] of Object.entries(schema.node_types)) {
    assert.ok(
      node.status?.includes("retracted"),
      `${type} cannot be retracted: ${JSON.stringify(node.status)}`,
    );
  }
});

test("retracted sorts as more visible than archived", () => {
  // A retraction says the source was wrong, which is worth surfacing; an
  // archive only says the subject went quiet.
  const order = schema.status_order;
  assert.ok(
    order.retracted < order.archived,
    `retracted (${order.retracted}) must sort before archived (${order.archived})`,
  );
});

test("retracted stays distinct from superseded", () => {
  // The two must never collapse into one value: superseded writes a dated
  // range into ## History, which asserts the fact held during that window.
  // Doing that to a falsehood files it as a past truth, and ## History is what
  // the model reads back as the subject's past.
  const order = schema.status_order;
  assert.notEqual(order.retracted, order.superseded);
  const decision = schema.node_types.decision.status;
  for (const s of ["superseded", "reverted", "retracted"]) {
    assert.ok(decision?.includes(s), `decision is missing ${s}`);
  }
});

test("every status used by a node type has a sort order", () => {
  // MOC generation sorts by status_order; an unlisted status sorts as
  // undefined and lands in an arbitrary place.
  const missing: string[] = [];
  for (const [type, node] of Object.entries(schema.node_types)) {
    for (const s of node.status ?? []) {
      if (!(s in schema.status_order)) missing.push(`${type}.${s}`);
    }
  }
  assert.deepEqual(missing, []);
});
