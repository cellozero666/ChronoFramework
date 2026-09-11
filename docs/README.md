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

## Domain and Core documentation

The implementation phases produced the following normative specifications:

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

These files exist and govern the implementation. Historical slice reports and
the current execution queue are indexed below:

- [`implementation/SLICE-5-REMEDIATION.md`](implementation/SLICE-5-REMEDIATION.md) — closed remediation gate for Slices 1–5.
- [`implementation/SLICE-6.md`](implementation/SLICE-6.md) and [`implementation/SLICE-7.md`](implementation/SLICE-7.md) — completed implementation reports.
- [`implementation/FIXES-SL-1-7.md`](implementation/FIXES-SL-1-7.md) and [`implementation/FIXES-SL-8.md`](implementation/FIXES-SL-8.md) — independent corrective reviews.
- [`implementation/POST-SLICE-8-REVIEW.md`](implementation/POST-SLICE-8-REVIEW.md) — current code/documentation comparison and release-readiness findings.
- [`implementation/SLICE-9.md`](implementation/SLICE-9.md) — next blocking implementation slice.
- [`implementation/SLICE-10.md`](implementation/SLICE-10.md) — one-command bootstrap and automatic Gaspar start/resume experience.
- [`implementation/IMPLEMENTER-TASKS.md`](implementation/IMPLEMENTER-TASKS.md) — ordered work queue through release-candidate readiness.

## User guides

- [`guides/FIRST-RUN.md`](guides/FIRST-RUN.md) — installation, one-command setup, normal runtime launch, re-run/repair, removal, troubleshooting, and security notes. Describes only demonstrated behavior; open acceptance items are marked as such.
