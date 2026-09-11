# CHRONO Framework

CHRONO is a model-neutral, security-first development framework for orchestrating specialized AI agents through OpenCode, Claude Code, and Kiro. Deterministic software owns lifecycle state, approvals, gates, traceability, and evidence; models perform semantic engineering work inside those controls.

> Repository status: specification complete; final v1 implementation pending.

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
2. [Normative Protocols](docs/protocols/README.md)
3. [Reference Architecture](docs/architecture/REFERENCE-ARCHITECTURE.md)
4. [Final Implementation Plan](docs/implementation/IMPLEMENTATION-PLAN.md)

The [protocol-authoring brief](docs/history/PROTOCOL-AUTHORING-BRIEF.md) is retained only for provenance and is not normative.

## Implementation status

The next agent must derive the implementation-ready domain/Core specifications and then complete all phases through final v1. Passing an MVP fixture is an intermediate gate, not the endpoint. No release is valid with stubs, simulated integrations, bypassable controls, skipped conformance tests, or undocumented behavior.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes. Report vulnerabilities according to [SECURITY.md](SECURITY.md).

## License

CHRONO Framework is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution. The SPDX identifier is `Apache-2.0`.
