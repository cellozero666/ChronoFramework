# CHRONO Documentation

This directory separates normative framework rules from implementation guidance and historical material.

All CHRONO-authored software and documentation in this repository are distributed under the root [Apache License 2.0](../LICENSE), unless a bundled third-party component explicitly declares another compatible license. Third-party notices and attribution MUST be preserved.

## Authority and reading order

1. [`reference/FRAMEWORK-DEFINITION.md`](reference/FRAMEWORK-DEFINITION.md) — framework purpose, roles, authority, lifecycle, and guardrails.
2. [`product/SDD-INNOVATION-STANDARD.md`](product/SDD-INNOVATION-STANDARD.md) — normative product differentiation and technology-agnostic acceptance standard.
3. [`protocols/`](protocols/README.md) — normative process contracts, read in numeric order.
4. [`architecture/REFERENCE-ARCHITECTURE.md`](architecture/REFERENCE-ARCHITECTURE.md) — approved technical architecture and boundaries.
5. [`implementation/IMPLEMENTATION-PLAN.md`](implementation/IMPLEMENTATION-PLAN.md) — ordered path from specifications to final v1.
6. [`history/PROTOCOL-AUTHORING-BRIEF.md`](history/PROTOCOL-AUTHORING-BRIEF.md) — non-normative provenance only.

If documents appear to conflict, apply the precedence above, stop affected implementation, and route a documented decision to the Product Owner. An implementation agent may clarify technical detail through the Domain/Core specifications but may not invent product policy, weaken security, or override an approved decision.

## Planned generated documentation

The implementation phases will add:

```text
docs/
├── domain/
│   ├── DOMAIN-MODEL.md
│   ├── STATE-MODEL.md
│   └── CORE-INVARIANTS.md
└── core/
    ├── CORE-SPECIFICATION.md
    └── RUNTIME-CONTRACT.md
```

These files do not exist yet and MUST be produced and approved at the gates defined in the implementation plan before Core code is written.
