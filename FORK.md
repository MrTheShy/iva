# Fork of smixs/iva

MIT, same as upstream. Upstream is active — merge before changing anything:

```bash
git fetch upstream && git merge upstream/main
```

Working branch: `retract`.

## Why this fork exists

The memory design in iva is the best treatment of "an assistant that remembers"
I have found. Three decisions in particular are kept intact here:

1. **Memory is not written during conversation.** The nightly rollup writes it,
   plus the live agent on an explicit "remember …".
   _"Never let routine chat edit it."_ This is what stops a single turn's
   mistake from becoming a fact on the next turn.
2. **`CORE.md` is RAM with a hard character cap** (~1200), and when the model
   fails to consolidate enough, `doctor.ts` clamps it deterministically. The
   rule lives in code, not in the model's good intentions.
3. **`ADD` / `UPDATE` / `SUPERSEDE` / `NOOP`** as typed operations, with
   "Compiled Truth" at the top of a card and append-only `## History` below.

## What this fork changes

### `RETRACT` — a fact that was never true

Upstream has `SUPERSEDE`: the value was true, now it isn't. The old value moves
to `## History` as `- 2026-03→06: TDI Group`.

What is missing is the case where **the value was never true**: misheard,
mis-linked, or inferred wrong. Filing those as SUPERSEDE archives a falsehood
as a past truth — and `## History` is exactly what the model reads back as the
subject's past. From there the line lands in the weekly rollup, and by the
monthly one nothing distinguishes it from a fact.

Added:

- `status: retracted` on every `node_type` (`vault-template/schema.json`), with
  `status_order` 9.5 — more visible than `archived`, because it flags an
  unreliable source rather than something merely no longer relevant.
- A `## Retracted` card section: dated, with the reason.
- The fifth operation documented in
  `scripts/memory/instructions/dbrain-processor/references/classification.md`.
- `retracted` in the hardcoded fallback of `agent/tools/write_card.ts` too: if
  the schema fails to load, retracting must not be the one operation that gets
  rejected.

It pairs with the `confidence:` field upstream already has. An INFERRED value
that turns out wrong is the ordinary case for RETRACT. And a card carrying three
retractions is telling you its source is unreliable — information no
`## History` line will ever give you.

## Candidate for upstream

`RETRACT` is additive, breaks nothing, and closes a real gap. If it holds up in
use, it should be proposed to upstream rather than kept here.

## Not changed

`install.sh` is untouched. It is written for a freshly provisioned VPS — it
installs system packages, adds an APT source, nvm, uv, systemd units and a
swapfile. Read it before running it on a machine you care about.
