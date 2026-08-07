# Card templates

Frontmatter per type. `type` and `status` MUST exist in
`vault/schema.json` → `node_types`. `description` is a search snippet
(what/why), never a title repeat. `tags`: 2–5, lowercase, kebab-case.

Every card also gets `salience: 0.0–1.0` — how much this weighs emotionally or
decisionally for the owner. It slows forgetting and boosts recall, so be honest,
not generous: `0.8+` events that clearly moved him or decisions with real
consequences (a fight, a diagnosis, a signed contract); `0.5` ordinary facts
worth keeping; `0.2` routine and logistics. When updating a card, raise salience
only if the new material itself justifies it; never lower it below the old value.

The canonical generic templates live in
`scripts/autograph/docs/references/card-templates.md` — these are the dbrain-specific
shapes.

## note — `cards/notes/<slug>.md`

```yaml
---
type: note
description: >-
  [What this fact/learning is, in one line — used for retrieval]
tags: [topic, subtopic]
status: active
salience: 0.5
created: YYYY-MM-DD
source: daily/YYYY-MM-DD.md
---
```

## contact — `cards/contacts/<slug>.md`

```yaml
---
type: contact
description: >-
  [Who they are + relationship context]
tags: [network, role]
status: active
salience: 0.5
created: YYYY-MM-DD
source: daily/YYYY-MM-DD.md
---
```

## project — `cards/projects/<slug>.md`

```yaml
---
type: project
description: >-
  [What it delivers, for whom]
tags: [area, kind]
status: active
salience: 0.5
created: YYYY-MM-DD
source: daily/YYYY-MM-DD.md
---
```

## idea — `cards/ideas/<slug>.md`

```yaml
---
type: idea
description: >-
  [The proposal/hypothesis in one line — title as a claim]
tags: [topic]
status: active
salience: 0.5
created: YYYY-MM-DD
source: daily/YYYY-MM-DD.md
---
```

## decision — `cards/decisions/YYYY-MM-DD-<slug>.md`

```yaml
---
type: decision
description: >-
  [What was decided + the one-line reason]
tags: [area]
status: active
salience: 0.5
created: YYYY-MM-DD
source: daily/YYYY-MM-DD.md
---

## Decision
…

## Rationale
…
```

## Anti-patterns

- `description: "Contact"` — useless for search; write a real snippet.
- `status: "interested"` — not in any enum; use what the schema defines.
- `tags: []` — pick 2–5 relevant kebab-case tags.
- No `## Related` — every card must link (see `linking.md`).
- New card when an existing one covers the subject — update instead.
