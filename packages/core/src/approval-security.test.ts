/**
 * I7 adversarial tests — PO authority is cryptographic, never declarative.
 * An arbitrary non-empty signature is never valid.
 * [ADR-003, CORE §8, P2.10, Remediation §3]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildApprovalPayload,
  buildWaiverPayload,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore } from "./chrono-core.js";

const FIXED_TIME = "2026-06-01T00:00:00.000Z";
const SPEC = { id: "SP-0001", title: "T", purpose: "P" };

function freshPo(core: ChronoCore): { privateKeyPem: string } {
  const pair = generateApprovalKeyPair();
  expect(core.registerPoPublicKey(pair.publicKeyPem).ok).toBe(true);
  return { privateKeyPem: pair.privateKeyPem };
}

function approvalFields(revision: string, action = "module-approval") {
  return {
    action,
    scopeArtifactId: "SP-0001",
    scopeRevision: revision,
    authority: "PO",
    rationale: "test",
  };
}

describe("Approval cryptography", () => {
  let restoreTty: () => void;
/**
 * TEST-ONLY terminal simulation. Production authority requires a live
 * human terminal (Core TTY rule); CI processes have none, so tests that
 * exercise the signed-authority path simulate terminal presence locally
 * and restore the real descriptors afterwards. This helper never ships:
 * it lives only in *.test.ts files. Refusal paths are tested WITHOUT it.
 */
function fakeInteractiveTerminal(): () => void {
  const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  return () => {
    if (stdinDesc !== undefined) {
      Object.defineProperty(process.stdin, "isTTY", stdinDesc);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    if (stdoutDesc !== undefined) {
      Object.defineProperty(process.stdout, "isTTY", stdoutDesc);
    } else {
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  };
}

  let tempDir: string;
  let core: ChronoCore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-auth-test-"));
    core = new ChronoCore({ projectPath: tempDir });
    expect(core.init().ok).toBe(true);
    restoreTty = fakeInteractiveTerminal();
    expect(core.registerSpec("SP-0001", "DRAFT", SPEC, "gaspar").ok).toBe(true);
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("refuses authority without an interactive terminal, even with a valid key", () => {
    // Drop the TTY fake: this process has redirected stdio, exactly like an
    // agent or script invoking the Core directly. Key custody alone must
    // not suffice without a live human terminal.
    restoreTty();
    expect(process.stdin.isTTY === true && process.stdout.isTTY === true).toBe(false);
    const pair = generateApprovalKeyPair();
    expect(core.registerPoPublicKey(pair.publicKeyPem).error?.code).toBe("NOT_INTERACTIVE");
    const revision = core.getArtifact("SP-0001").revision;
    const signature = signApprovalPayload(
      buildApprovalPayload({ ...approvalFields(revision), timestamp: FIXED_TIME }),
      pair.privateKeyPem
    );
    expect(
      core.recordApproval({ ...approvalFields(revision), timestamp: FIXED_TIME, signature }).error?.code
    ).toBe("NOT_INTERACTIVE");
    expect(core.listEvents().filter((e) => e.eventType === "ApprovalGranted")).toHaveLength(0);
  });

  it("rejects approvals when no PO key is registered", () => {
    const revision = core.getArtifact("SP-0001").revision;
    const pair = generateApprovalKeyPair();
    const signature = signApprovalPayload(
      buildApprovalPayload({ ...approvalFields(revision), timestamp: FIXED_TIME }),
      pair.privateKeyPem
    );
    const res = core.recordApproval({ ...approvalFields(revision), timestamp: FIXED_TIME, signature });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("APPROVAL_REQUIRED");
  });

  it("rejects forged, malformed, and empty signatures", () => {
    const { privateKeyPem } = freshPo(core);
    void privateKeyPem;
    const revision = core.getArtifact("SP-0001").revision;
    const other = generateApprovalKeyPair();
    const forged = signApprovalPayload(
      buildApprovalPayload({ ...approvalFields(revision), timestamp: FIXED_TIME }),
      other.privateKeyPem
    );
    const base = { ...approvalFields(revision), timestamp: FIXED_TIME };
    expect(core.recordApproval({ ...base, signature: forged }).error?.code).toBe("SIGNATURE_INVALID");
    expect(core.recordApproval({ ...base, signature: "not-valid-base64!!!" }).error?.code).toBe(
      "SIGNATURE_INVALID"
    );
    expect(core.recordApproval({ ...base, signature: "" }).error?.code).toBe("SIGNATURE_INVALID");
    expect(core.recordApproval({ ...base, signature: "test-signature" }).error?.code).toBe(
      "SIGNATURE_INVALID"
    );
  });

  it("rejects tampered payloads (signature binds every field)", () => {
    const { privateKeyPem } = freshPo(core);
    const revision = core.getArtifact("SP-0001").revision;
    const signature = signApprovalPayload(
      buildApprovalPayload({ ...approvalFields(revision), timestamp: FIXED_TIME }),
      privateKeyPem
    );
    const base = { ...approvalFields(revision), timestamp: FIXED_TIME, signature };
    // Same signature, altered rationale → invalid.
    expect(core.recordApproval({ ...base, rationale: "forged" }).error?.code).toBe("SIGNATURE_INVALID");
    // Same signature, altered scope → invalid.
    expect(
      core.recordApproval({ ...base, scopeArtifactId: "SP-0002" }).error?.code
    ).toBe("SIGNATURE_INVALID");
  });

  it("accepts a valid signature and replays collide explicitly", () => {
    const { privateKeyPem } = freshPo(core);
    const revision = core.getArtifact("SP-0001").revision;
    const signature = signApprovalPayload(
      buildApprovalPayload({ ...approvalFields(revision), timestamp: FIXED_TIME }),
      privateKeyPem
    );
    const first = core.recordApproval({ ...approvalFields(revision), timestamp: FIXED_TIME, signature });
    expect(first.ok).toBe(true);
    expect(first.value?.id).toMatch(/^APR-\d{4,}$/);
    // Exact replay: the recorded row already exists — explicit duplicate, never a second grant.
    const replay = core.recordApproval({ ...approvalFields(revision), timestamp: FIXED_TIME, signature });
    expect(replay.ok).toBe(false);
    expect(replay.error?.code).toBe("DUPLICATE_IDENTITY");
  });

  it("rejects stale-at-birth scope revisions and unknown scopes", () => {
    const { privateKeyPem } = freshPo(core);
    const signFor = (scopeArtifactId: string, scopeRevision: string) => {
      const timestamp = FIXED_TIME;
      return {
        timestamp,
        signature: signApprovalPayload(
          buildApprovalPayload({ action: "module-approval", scopeArtifactId, scopeRevision, authority: "PO", rationale: "t", timestamp }),
          privateKeyPem
        ),
      };
    };
    // Unknown scope.
    const unknown = signFor("SP-0099", core.getArtifact("SP-0001").revision);
    expect(
      core.recordApproval({ action: "module-approval", scopeArtifactId: "SP-0099", scopeRevision: core.getArtifact("SP-0001").revision, authority: "PO", rationale: "t", ...unknown }).error?.code
    ).toBe("REFERENCE_UNRESOLVABLE");
    // Malformed revision.
    const bad = signFor("SP-0001", "sha256:abc");
    expect(
      core.recordApproval({ action: "module-approval", scopeArtifactId: "SP-0001", scopeRevision: "sha256:abc", authority: "PO", rationale: "t", ...bad }).error?.code
    ).toBe("VALIDATION_ERROR");
    // Stale revision after a transition.
    // Status transitions preserve the contract revision [DOM §2.3], so a
    // well-formed but non-current revision is stale-at-birth.
    expect(core.transitionState("SP-0001", "SpecSubmittedForReview", { actor: "gaspar" }).ok).toBe(true);
    const foreign = `sha256:${"f".repeat(64)}`;
    const stale = signFor("SP-0001", foreign);
    expect(
      core.recordApproval({ action: "module-approval", scopeArtifactId: "SP-0001", scopeRevision: foreign, authority: "PO", rationale: "t", ...stale }).error?.code
    ).toBe("STALE_REVISION");
  });

  it("rejects unknown actions and future timestamps", () => {
    const { privateKeyPem } = freshPo(core);
    const revision = core.getArtifact("SP-0001").revision;
    const future = "2999-01-01T00:00:00.000Z";
    const futureSig = signApprovalPayload(
      buildApprovalPayload({ ...approvalFields(revision), timestamp: future }),
      privateKeyPem
    );
    expect(
      core.recordApproval({ ...approvalFields(revision), timestamp: future, signature: futureSig }).error?.code
    ).toBe("VALIDATION_ERROR");
    const sig = signApprovalPayload(
      buildApprovalPayload({ ...approvalFields(revision, "waiver"), timestamp: FIXED_TIME }),
      privateKeyPem
    );
    expect(
      core.recordApproval({ ...approvalFields(revision, "waiver"), timestamp: FIXED_TIME, signature: sig }).error?.code
    ).toBe("VALIDATION_ERROR");
  });

  it("rejects garbage public keys and guards rotation", () => {
    expect(core.registerPoPublicKey("not-a-key").ok).toBe(false);
    const first = generateApprovalKeyPair();
    expect(core.registerPoPublicKey(first.publicKeyPem).ok).toBe(true);
    const second = generateApprovalKeyPair();
    // Overwrite without rotation proof → refused.
    expect(core.registerPoPublicKey(second.publicKeyPem).error?.code).toBe("APPROVAL_REQUIRED");
    // Rotation signed by the wrong key → refused.
    const wrongSig = signApprovalPayload(
      buildApprovalPayload({
        action: "key-rotation",
        scopeArtifactId: "PO-KEY",
        scopeRevision: "sha256:" + "0".repeat(64),
        authority: "PO",
        rationale: "x",
        timestamp: FIXED_TIME,
      }),
      second.privateKeyPem
    );
    expect(
      core.registerPoPublicKey(second.publicKeyPem, {
        signature: wrongSig,
        authority: "PO",
        rationale: "x",
        timestamp: FIXED_TIME,
      }).error?.code
    ).toBe("SIGNATURE_INVALID");
  });

  it("records waivers only with valid signatures and complete fields", () => {
    const { privateKeyPem } = freshPo(core);
    const revision = core.getArtifact("SP-0001").revision;
    const fields = {
      scopeArtifactId: "SP-0001",
      scopeRevision: revision,
      authority: "PO",
      issue: "known risk",
      rationale: "accepted",
      evidenceRef: null as string | null,
      compensatingControls: "monitor",
      followUpTaskId: null as string | null,
      expiryReviewCondition: "review in 30d",
      timestamp: FIXED_TIME,
    };
    const signature = signApprovalPayload(buildWaiverPayload(fields), privateKeyPem);
    const recorded = core.recordWaiver({ ...fields, signature });
    expect(recorded.ok).toBe(true);
    expect(recorded.value?.id).toMatch(/^WAIVER-\d{4,}$/);

    const forged = signApprovalPayload(
      buildWaiverPayload(fields),
      generateApprovalKeyPair().privateKeyPem
    );
    expect(core.recordWaiver({ ...fields, signature: forged }).error?.code).toBe("SIGNATURE_INVALID");
    expect(core.recordWaiver({ ...fields, issue: "  ", signature }).error?.code).toBe("VALIDATION_ERROR");
  });
});
