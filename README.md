# CHRONO — Secure Spec-Driven Multi-Agent Development

**Turn AI-assisted coding and vibe coding into controlled, traceable software engineering.**

CHRONO is an open-source, technology-agnostic **AI software development framework** for orchestrating specialized coding agents through OpenCode, Claude Code, and Kiro. It combines **Spec-Driven Development (SDD)**, multi-agent orchestration, persistent project memory, human approval gates, automated testing, security review, and independent verification.

Instead of trusting an AI coding agent to understand, implement, test, and approve its own work, CHRONO separates those responsibilities. Language models perform semantic engineering tasks; a deterministic Core owns state transitions, permissions, approvals, traceability, evidence, and release gates.

> **Build with AI speed. Ship with engineering evidence.**

## Why developers need CHRONO

AI coding tools are excellent at producing code. They are less reliable at preserving architectural intent across sessions, recognizing when requirements changed, proving that security controls were implemented, or knowing when they should stop and ask a human.

CHRONO is designed for developers who want the speed of agentic coding without surrendering engineering discipline:

- **Vibe coders** get a path from an idea to explicit requirements, architecture, Specs, tests, and review—without needing to design the entire process themselves.
- **Professional developers** get persistent decisions, reproducible gates, scoped context, dependency-aware execution, and evidence tied to exact revisions.
- **Tech leads and architects** get ADRs, traceability, change-impact analysis, and bounded agent autonomy.
- **Security-conscious teams** get threat modeling, least privilege, separate security approvals, negative testing, and fail-closed execution.
- **Existing projects** get repository-first discovery instead of a greenfield template being imposed on the codebase.

CHRONO is not another prompt pack, AI wrapper, autonomous coding demo, or framework-specific project generator. It is a **control plane for AI-assisted software engineering**.

## What makes CHRONO different?

| Common agentic coding workflow | CHRONO approach |
| --- | --- |
| Conversation history acts as project memory | Versioned artifacts and SQLite preserve authoritative state across sessions and models |
| One agent plans, codes, tests, and approves | Gaspar, implementation agents, Lucca, Glenn, and Spekkio have separated responsibilities and authority |
| Prompts ask agents to follow rules | Deterministic gates authorize or deny state transitions and execution |
| Documentation follows generated code | Approved Specs and Harnesses define the contract before implementation |
| A passing happy path is treated as done | Negative tests, security evidence, independent verification, and correction loops are required |
| Model or CLI behavior defines the workflow | A runtime-neutral Core governs OpenCode, Claude Code, and Kiro adapters |
| Changed assumptions quietly become drift | Impact analysis invalidates affected approvals, evidence, Specs, and Harnesses |
| More autonomous execution is always considered better | Autonomy is explicit, bounded, observable, and owned by the Product Owner |

## Spec-Driven Development, made executable

In CHRONO, a specification is not a ticket-shaped prompt. A Spec is a versioned contract linked to requirements, architecture decisions, acceptance criteria, security controls, dependencies, and evidence obligations. Every executable Spec receives a focused **Harness** containing the minimum authoritative context an agent needs to work without inventing missing behavior.

The lifecycle is:

```text
discover → architect → specify → validate → approve
    → authorize → implement → test → secure → verify
    → pass or correct → complete
```

This process is designed to remain **tech agnostic**. Product languages, frameworks, databases, deployment targets, build tools, and test runners belong to project discovery and capability adapters—not to hardcoded assumptions in the CHRONO Core.

## Designed for real projects

CHRONO targets both greenfield and brownfield software development, including:

- web, API, backend, frontend, mobile, desktop, CLI, game, embedded, infrastructure, and data projects;
- monoliths, modular systems, libraries, microservices, and legacy codebases;
- solo developers using AI pair programming;
- teams adopting AI coding agents with architecture, QA, DevSecOps, and compliance requirements;
- long-running projects that must survive context compaction, model replacement, and runtime changes.

The goal is not maximum code generation. The goal is software that remains **understood, specified, approved, secure, testable, traceable, and verifiable**.

## Why CHRONO?

The name is a deliberate reference to *Chrono Trigger*. The game is built around traveling across eras, understanding how decisions propagate through time, assembling specialists with different strengths, and revisiting earlier events to produce a better outcome.

That is also a useful model for software engineering. A codebase is never just its current files: it is the result of requirements, decisions, architecture, implementation, tests, incidents, and revisions made over time. CHRONO preserves that history as project state, keeps every change traceable to its origin, and invalidates downstream assumptions when an earlier decision changes.

The “trigger” is equally important. Agents do not advance work simply because they produced an answer. A validated event—an approved revision, satisfied dependency, passing test, security decision, or verification result—triggers the next legal state transition. Failed evidence sends the work through a correction loop instead of allowing it to drift forward.

In that sense, CHRONO treats development as a controlled timeline:

```text
understand → specify → approve → implement → verify
     ↑                                      │
     └──────────── correct and replay ──────┘
```

## The party

Like *Chrono Trigger*, CHRONO organizes a party of specialists rather than asking one character to solve every problem. The names are thematic; their authority and behavior are defined by deterministic framework contracts, not by role-play prompts.

| Agent | Chrono Trigger connection | CHRONO responsibility |
| --- | --- | --- |
| **Gaspar — Guru of Time** | At the End of Time, Gaspar helps the party understand where to go next. | Systems analyst, software architect, and orchestrator. He discovers the system, maintains architecture and Specs, builds the roadmap, and coordinates the other agents without overriding the Product Owner. |
| **Belthazar — Guru of Reason** | The technological mind associated with major inventions such as the Epoch. | Implementation engineer. He converts approved Specs and Harnesses into working software without redefining requirements or architecture. |
| **Melchior — Guru of Life** | The master craftsman whose work gives form to ideas and enables the party to progress. | UI/UX engineer. He implements accessible interfaces, interaction states, user flows, and visual behavior within the approved product contract. |
| **Prometheus — Robo** | A machine who develops judgment, loyalty, and responsibility beyond his original programming. | Infrastructure and operations engineer. He owns environments, CI/CD, deployment, observability, backup, rollback, and operational safety. |
| **Lucca — Genius Inventor** | An engineer who investigates systems, builds tools, and solves problems through evidence and experimentation. | Test engineer. She derives tests from acceptance criteria and produces unit, integration, end-to-end, negative, and regression evidence. |
| **Glenn — Frog** | A guardian defined by duty, courage, and the protection of others. | Security engineer. He models threats, reviews code and infrastructure, protects users and data, and raises blocking security findings. |
| **Spekkio — God of War** | A demanding trainer whose form reflects the strength of the party facing him. | Independent verification authority. He challenges implementation, test, UX, and security evidence and issues `PASS` only when the approved contract is actually satisfied. |

The Product Owner remains outside this party hierarchy as the human authority. Agents may recommend, implement, test, challenge, and coordinate; only the Product Owner can make reserved product decisions or accept residual risk.

The names are a fan tribute to *Chrono Trigger*. CHRONO Framework is an independent open-source project and is not affiliated with or endorsed by Square Enix.

## Non-negotiable v1 properties

- mandatory global `chrono` launcher delegating to a project-pinned local Core;
- TypeScript monorepo on supported Node.js LTS releases;
- OpenCode, Claude Code, and Kiro adapters with `chrono run` dispatch and blocking `chrono gate` hooks;
- versioned Markdown/YAML contracts plus transactional SQLite operational state;
- cryptographically signed, interactive, human-only Product Owner approvals;
- mandatory RTK integration from [rtk-ai/rtk](https://github.com/rtk-ai/rtk);
- mandatory Karpathy Guidelines process skill from [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills);
- no hardcoded provider, model name, or model version;
- fail-closed security, verification, correction, and approval loops.

## Documentation

Start with the [documentation index](docs/README.md). Implementation agents must also follow [AGENTS.md](AGENTS.md).

The normative reading order is:

1. [Framework Definition](docs/reference/FRAMEWORK-DEFINITION.md)
2. [SDD Innovation Standard](docs/product/SDD-INNOVATION-STANDARD.md)
3. [Normative Protocols](docs/protocols/README.md)
4. [Reference Architecture](docs/architecture/REFERENCE-ARCHITECTURE.md)
5. [Final Implementation Plan](docs/implementation/IMPLEMENTATION-PLAN.md)

The [protocol-authoring brief](docs/history/PROTOCOL-AUTHORING-BRIEF.md) is retained only for provenance and is not normative.

## Core capabilities

CHRONO provides a global `chrono` CLI, a project-pinned deterministic Core, local Markdown/YAML and SQLite state, signed Product Owner decisions, explainable execution gates, drift detection, audit export, bounded correction loops, and adapter conformance across OpenCode, Claude Code, and Kiro.

Every release is held to the same standard: no stubs, simulated integrations, bypassable controls, skipped conformance tests, or undocumented behavior. A feature is complete only when its contract, implementation, tests, security evidence, and independent verification agree.

## Frequently asked questions

### What is CHRONO Framework?

CHRONO is a technology-agnostic, multi-agent software development framework based on Spec-Driven Development. It coordinates AI coding agents while deterministic software enforces project state, authorization, security, testing, traceability, and verification.

### Is CHRONO an AI coding assistant or an AI model?

No. CHRONO does not provide or hardcode an AI model. It governs compatible coding-agent runtimes and lets the Product Owner select models independently from agent roles and project state.

### Does CHRONO replace OpenCode, Claude Code, or Kiro?

No. Those tools execute agents. CHRONO provides the engineering lifecycle and control layer around them, with runtime adapters translating the same policies into each CLI.

### Can CHRONO help with vibe coding?

That is one of its primary use cases. CHRONO preserves the creative speed of AI-assisted development while introducing requirements discovery, architecture, executable Specs, automated tests, security guardrails, approval gates, and independent review.

### Is CHRONO tied to TypeScript or web development?

The CHRONO implementation uses TypeScript and Node.js, but the projects it governs are not limited to that stack. Technology agnosticism is a required conformance property tested with polyglot and non-web fixtures.


## Build with CHRONO

Use CHRONO when you need **AI coding agents**, **agentic software development**, **Spec-Driven Development**, **secure vibe coding**, **multi-agent orchestration**, **AI DevSecOps**, or **model-agnostic developer tools** without giving up architectural control. Install the latest stable distribution through npm or GitHub Releases, initialize it in a new or existing repository, select your supported AI runtime and model, and let Gaspar begin repository discovery.

CHRONO will guide the project from intent to verified implementation while preserving the Product Owner's authority at every material decision. Contributions should focus on measurable conformance rather than unverified autonomy or surface-level integrations.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes. Report vulnerabilities according to [SECURITY.md](SECURITY.md).

## License

CHRONO Framework is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution. The SPDX identifier is `Apache-2.0`.
