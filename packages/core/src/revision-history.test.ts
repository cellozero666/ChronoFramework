/**
 * I3 tests — immutable revision history and exact-revision resolution.
 * [DOM §2.3, P3.5, CORE §12, Remediation §4]
 *
 * A new revision must never overwrite the row required to resolve an
 * older `<ID>@<revision>` reference.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChronoCore } from "./chrono-core.js";

describe("Revision history", () => {
  let tempDir: string;
  let core: ChronoCore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-rev-test-"));
    core = new ChronoCore({ projectPath: tempDir });
    expect(core.init().ok).toBe(true);
  });

  afterEach(() => {
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("preserves every revision across transitions without rotating the contract", () => {
    const content = { id: "SP-0001", title: "History", purpose: "I3", revision: "x", status: "DRAFT", inScope: [], dependencies: [] };
    const created = core.registerSpec("SP-0001", "DRAFT", content, "gaspar");
    expect(created.ok).toBe(true);
    const contractRevision = created.value!;

    const moved = core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: "gaspar" });
    expect(moved.ok).toBe(true);

    // Status transitions are audit events, not material changes: the
    // contract revision is stable so revision-bound approvals, Harnesses,
    // and evidence survive the lifecycle [DOM §2.3].
    const current = core.resolveReference("SP-0001");
    expect(current.ok).toBe(true);
    expect(current.value?.status).toBe("REVIEW");
    expect(current.value?.revision).toBe(contractRevision);

    // The registration revision still resolves with its original status,
    // and the transition link is appended to history.
    const old = core.resolveReference("SP-0001", contractRevision);
    expect(old.ok).toBe(true);
    expect(old.value?.status).toBe("DRAFT");
    expect(core.artifactHistory("SP-0001")).toHaveLength(2);
  });

  it("distinguishes unknown artifacts from stale revisions", () => {
    const missing = core.resolveReference("SP-9999", "sha256:dead");
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("ENTITY_NOT_FOUND");

    core.registerSpec("SP-0002", "DRAFT", { id: "SP-0002", title: "T", purpose: "P" }, "gaspar");
    const stale = core.resolveReference(
      "SP-0002",
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe("STALE_REVISION");
  });

  it("rejects non-canonical content instead of hashing it ambiguously", () => {
    expect(core.registerSpec("SP-0003", "DRAFT", undefined, "gaspar").ok).toBe(false);
    expect(core.registerSpec("SP-0004", "DRAFT", { fn: () => 1 }, "gaspar").ok).toBe(false);
    expect(core.registerSpec("SP-0005", "DRAFT", { n: Number.NaN }, "gaspar").ok).toBe(false);
    expect(core.registerSpec("SP-0006", "DRAFT", { when: new Date() }, "gaspar").ok).toBe(false);
  });
});
