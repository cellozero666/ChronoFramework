# Slice 7 Report — Pinned Skill Release + Functional `skill verify`

**Status:** COMPLETE (implementation + verification loop, 2026-09-11)
**Scope:** PO-approved skill pin as CHRONO release metadata; deterministic
fetch → hash → frontmatter → convert → emit → activation pipeline;
functional `chrono skill verify` recording through the Core.
**Normative basis:** `FW §22/§1222`, `P6.6`, `P8.6`, `CORE §11`,
`DOM §3.28`, `INV §9`, `PL Phase 4` (skill section).
**Rule carried forward:** no publish, push, release, or remote change without
explicit Product Owner authorization.

## 1. Approved pin (PO decision, evidenced — not guessed)

| Field | Value |
|---|---|
| `upstream` | `https://github.com/multica-ai/andrej-karpathy-skills` (equals normative `SKILL_UPSTREAM`) |
| `pinnedCommit` | `2c606141936f1eeef17fa3043a72095b4765b9c2` (`main` HEAD, 2026-04-20) |
| `sourcePath` | `skills/karpathy-guidelines/SKILL.md` |
| `sourceHash` | `sha256:6e22cc54cb02a5e98ae42d06d9d7292db0c1b43894831b32879beb0166b2aea7` (raw file bytes) |
| `license` | MIT (confirmed in file frontmatter) |
| `converterVersion` | `chrono-skill-converter/1` |

Stability evidence: the file is byte-identical since its creation commit
`64723a49` (2026-01-28) — same SHA-256 at both commits; all later upstream
commits are README-only. Reproduction command (any machine):
`curl -sL https://codeload.github.com/multica-ai/andrej-karpathy-skills/tar.gz/2c60614…`
→ extract `skills/karpathy-guidelines/SKILL.md` → `sha256sum` must print the
hash above. The production fetch path was additionally proven live against
`raw.githubusercontent.com` (2506 bytes, hash verified).

## 2. What was implemented

- `packages/domain/src/release.ts` (new) — `SKILL_RELEASE` pin,
  `SKILL_RUNTIME_PATHS`, `skillVendorPath`, `hashSkillSource` (raw-byte
  SHA-256), strict `parseSkillFrontmatter` (rejects missing/unclosed/
  malformed/incomplete blocks, never normalizes), `convertSkillSource`
  (byte-identical emission per runtime — no LLM rewriting, versioned by
  converter), `skillGeneratedHashes` (canonical per-runtime hash JSON),
  `verifySkillRelease` (hash → name → license, `SKILL_PROVENANCE_FAILURE`
  otherwise). Exported from `packages/domain/src/index.ts`.
- `packages/persistence` — `SkillRepository.latestFull()` +
  `SkillAttestationDetail` for re-verification divergence checks
  (`CORE §11.1`); exported from index.
- `packages/core/src/chrono-core.ts` — read-only `describeSkillAttestation()`
  and `projectRuntime()` (no new policy; recording rules unchanged).
- `packages/cli/src/index.ts` — `runSkillVerify` rewritten from the
  fail-closed placeholder into the full pipeline: requires `--as` matching
  the caller session + `--session-token`; fetches the immutable commit
  (injectable, 30s timeout, 1 MiB cap); verifies hash/name/license;
  refuses divergent stored rows explicitly (`SKILL_PROVENANCE_FAILURE`,
  nothing recorded); emits vendor + claude/opencode/kiro artifacts;
  proves discovery + activation at rest by byte round-trip (MIT preserved);
  records via `core.recordSkillAttestation` (gaspar/PO capability,
  TTL default 86400 per `RUNTIME §8.1`). Fetch/network failures deny
  (`BLOCKED_PROCESS_SKILL`); usage errors exit 2. Commander wiring updated
  (`--as` required, `--session-token`, `--ttl`).
- Tests (12 new, all hermetic — network always injected):
  `packages/domain/src/skill-release.test.ts` (6: pin shape, fixture ↔
  hash byte-equality, frontmatter strictness, converter determinism,
  tamper/rename/relicense rejection, plan layout paths),
  `packages/cli/src/skill-verify.test.ts` (6: full verify→emit→record→
  current→valid, tamper emits/records nothing, fetch failure fail-closed,
  session requirements, divergence refusal, worker denial).

## 3. Verification loop (until zero findings)

- Iteration 1 — new suites: 1 domain failure (wrong test expectation
  for the unclosed-frontmatter case; product correct) → fixed test.
  Then 1 CLI failure class (4 tests asserted `stdout` for non-JSON
  errors that go to `stderr`) → tests switched to `--json`.
- Iteration 2 — workspace: direct binaries `eslint .`, `tsc --noEmit`,
  `tsc -b packages/cli` all clean; full suite 22 files / 185 tests pass.
- Iteration 3 — clean checkouts with final code, direct binaries:
  Node v22.21.1 and v24.20.0 (`/tmp/chrono-clean`, `/tmp/chrono-clean24`):
  `npm ci` + lint + typecheck + build + 22 files / 185 tests pass.
- Iteration 4 — pack from clean copy → isolated fixture: 4 tarballs,
  0 test files, install clean, `chrono init/status/validate` across
  processes → VALID; packed `skill verify --help` serves new options.
- Sweeps: no stale skill placeholders remain in code (residual "Slice 8"
  mentions cover RTK routing/live adapters only); no `.skip`/TODO
  introduced. Loop terminated: zero findings.

## 4. Residuals and blockers (not concealed)

1. Live-runtime skill *activation UX* (Claude/OpenCode/Kiro discovering
   and activating the emitted artifacts) remains adapter duty; Slice 7
   proves discovery + activation at rest. → adapter work.
2. Carried: per-command `rtk exec` wrapping, `chrono setup`/installers,
   live runtime hook conformance.
3. Slice 7 files are uncommitted; commit was not requested.

## 5. PO decisions recorded

- Skill pin approved as §1 ( unlocked this slice).
- Slice 7 scope as §2 (metadata + pipeline + verify; live activation deferred).
- No security-policy waivers; all denials fail-closed.

## 6. Files changed (uncommitted, Slice 7 only)

- `packages/domain/src/release.ts` (new), `index.ts` (exports),
  `skill-release.test.ts` (new, 6 tests)
- `packages/persistence/src/repositories.ts` (`latestFull`,
  `SkillAttestationDetail`), `index.ts` (export)
- `packages/core/src/chrono-core.ts` (`describeSkillAttestation`,
  `projectRuntime`)
- `packages/cli/src/index.ts` (`runSkillVerify` pipeline + wiring),
  `skill-verify.test.ts` (new, 6 tests)
- `docs/implementation/SLICE-7.md` (this report)

Prior slices committed (`f437952` and earlier).
