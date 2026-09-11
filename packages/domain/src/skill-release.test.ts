/**
 * Slice 7 tests — PO-approved skill release pin and deterministic pipeline.
 * [FW §1222, PL Phase 4, CORE §11]
 *
 * CANONICAL_SKILL_MD below is a frozen fixture: the byte-exact
 * `skills/karpathy-guidelines/SKILL.md` at the pinned commit
 * 2c606141936f1eeef17fa3043a72095b4765b9c2. The first test pins the
 * fixture itself to SKILL_RELEASE.sourceHash, so any transcription drift
 * fails loudly instead of silently weakening the suite.
 */
import { describe, it, expect } from "vitest";
import {
  SKILL_RELEASE,
  SKILL_RUNTIME_PATHS,
  convertSkillSource,
  hashSkillSource,
  parseSkillFrontmatter,
  skillGeneratedHashes,
  skillVendorPath,
  verifySkillRelease,
} from "./release.js";

const CANONICAL_SKILL_MD = `---
name: karpathy-guidelines
description: Behavioral guidelines to reduce common LLM coding mistakes. Use when writing, reviewing, or refactoring code to avoid overcomplication, make surgical changes, surface assumptions, and define verifiable success criteria.
license: MIT
---

# Karpathy Guidelines

Behavioral guidelines to reduce common LLM coding mistakes, derived from [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876) on LLM coding pitfalls.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
\`\`\`
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
\`\`\`

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
`;

describe("Skill release pin", () => {
  it("pins the PO-approved commit, path, hash, license, and converter", () => {
    expect(SKILL_RELEASE.upstream).toBe("https://github.com/multica-ai/andrej-karpathy-skills");
    expect(SKILL_RELEASE.pinnedCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(SKILL_RELEASE.sourcePath).toBe("skills/karpathy-guidelines/SKILL.md");
    expect(SKILL_RELEASE.sourceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(SKILL_RELEASE.license).toBe("MIT");
    expect(SKILL_RELEASE.converterVersion.length).toBeGreaterThan(0);
  });

  it("fixture matches the pinned source hash byte-exactly", () => {
    expect(hashSkillSource(CANONICAL_SKILL_MD)).toBe(SKILL_RELEASE.sourceHash);
  });

  it("parses strict frontmatter and rejects malformed sources", () => {
    const parsed = parseSkillFrontmatter(CANONICAL_SKILL_MD);
    expect(parsed).toMatchObject({ name: "karpathy-guidelines", license: "MIT" });
    expect(parsed.description.length).toBeGreaterThan(0);
    expect(() => parseSkillFrontmatter("no frontmatter here")).toThrow(/frontmatter/);
    expect(() => parseSkillFrontmatter("---\nname: x")).toThrow(/never closed/);
    expect(() => parseSkillFrontmatter("---\nname: x\ndescription: y\n---\nbody")).toThrow(/license|non-empty/);
    expect(() => parseSkillFrontmatter("---\nbroken line\n---\nbody")).toThrow(/Malformed frontmatter/);
  });

  it("converts byte-identically for every runtime with deterministic hashes", () => {
    const artifacts = convertSkillSource(CANONICAL_SKILL_MD);
    expect(artifacts.claude).toBe(CANONICAL_SKILL_MD);
    expect(artifacts.opencode).toBe(CANONICAL_SKILL_MD);
    expect(artifacts.kiro).toBe(CANONICAL_SKILL_MD);
    const first = skillGeneratedHashes(artifacts);
    const second = skillGeneratedHashes(convertSkillSource(CANONICAL_SKILL_MD));
    expect(first).toBe(second);
    const parsed = JSON.parse(first) as Record<string, string>;
    expect(Object.keys(parsed).sort()).toEqual(["claude", "kiro", "opencode"]);
    for (const hash of Object.values(parsed)) {
      expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("verifies the release and rejects tampering, renames, and relicensing", () => {
    expect(verifySkillRelease(CANONICAL_SKILL_MD)).toBe(CANONICAL_SKILL_MD);
    expect(() => verifySkillRelease(`${CANONICAL_SKILL_MD}\nrogue line`)).toThrowError(/hash mismatch/);
    const renamed = CANONICAL_SKILL_MD.replace("name: karpathy-guidelines", "name: karpathy-guidelines-evil");
    expect(hashSkillSource(renamed)).not.toBe(SKILL_RELEASE.sourceHash);
    const relicensed = CANONICAL_SKILL_MD.replace("license: MIT", "license: Apache-2.0");
    expect(hashSkillSource(relicensed)).not.toBe(SKILL_RELEASE.sourceHash);
  });

  it("derives vendor and runtime paths from the plan layout", () => {
    expect(skillVendorPath(SKILL_RELEASE.pinnedCommit)).toBe(
      `vendor/karpathy-guidelines/${SKILL_RELEASE.pinnedCommit}/SKILL.md`
    );
    expect(SKILL_RUNTIME_PATHS.claude).toBe(".claude/skills/karpathy-guidelines/SKILL.md");
    expect(SKILL_RUNTIME_PATHS.opencode).toBe(".opencode/skills/karpathy-guidelines/SKILL.md");
    expect(SKILL_RUNTIME_PATHS.kiro).toBe(".kiro/skills/karpathy-guidelines/SKILL.md");
  });
});
