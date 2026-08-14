# Domain Docs

## Before exploring

Read the root `CONTEXT.md` and relevant ADRs under `docs/adr/`. If they do not exist, proceed silently; `/domain-modeling` creates them when terms or decisions are resolved.

## Layout

ReStar uses a single-context layout:

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Vocabulary

Use terms as defined in `CONTEXT.md` in issue titles, specs, tests, and implementation. Do not drift to synonyms the glossary explicitly avoids.

## ADR conflicts

If proposed work contradicts an ADR, surface the conflict explicitly rather than silently overriding the recorded decision.
