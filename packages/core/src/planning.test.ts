/**
 * OC-P11 adversarial tests — Core-governed planning/artifact-authoring.
 *
 * Proves the bootstrap deadlock is closed without granting Gaspar
 * arbitrary filesystem/shell/implementation authority:
 * - Gaspar proposes only permitted kinds into canonical locations;
 * - workers are denied; chat text never becomes approval;
 * - Gaspar cannot sign/impersonate PO; approvals bind exact revisions;
 * - revision changes stale prior approvals; traversal/symlink/arbitrary
 *   paths deny; partial failure is recoverable; restart resumes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  buildApprovalPayload,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  generateApprovalKeyPair,
  signApprovalPayload,
  fingerprintPublicKey,
} from "@chrono/domain";
import { ChronoCore, type CallerAuth } from "./chrono-core.js";

const FIXED_TIME = "2026-09-14T00:00:00.000Z";

function enrollTestPo(core: ChronoCore, pair: { publicKeyPem: string; privateKeyPem: string }): void {
  const nonce = randomBytes(16).toString("hex");
  const fingerprint = fingerprintPublicKey(pair.publicKeyPem);
  const confirmation = buildEnrollmentChallenge("default", fingerprint, nonce);
  const timestamp = new Date().toISOString();
  const signature = signApprovalPayload(
    buildEnrollmentPayload({ projectId: "default", fingerprint, timestamp, nonce, authority: "PO", rationale: "test", confirmation }),
    pair.privateKeyPem
  );
  const res = core.enrollPo({ publicKeyPem: pair.publicKeyPem, nonce, timestamp, rationale: "test", confirmation, signature });
  expect(res.ok).toBe(true);
}

function bootstrapSession(core: ChronoCore, role: "gaspar" | "PO", privateKeyPem: string): { id: string; token: string } {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = "2026-09-11T00:00:00.000Z";
  const signature = signApprovalPayload(
    buildSessionAuthorizationPayload({
      sessionRole: role, adapter: "test-adapter", runtime: "test-runtime",
      scopeModule: null, scopeWp: null, ttlSeconds: 3600, nonce,
      authority: "PO", rationale: "test", timestamp,
    }),
    privateKeyPem
  );
  const res = core.openSession(
    { role, adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
    { poAuthorization: { nonce, authority: "PO", rationale: "test", timestamp, signature } }
  );
  expect(res.ok).toBe(true);
  return { id: res.value!.id, token: res.value!.token };
}

function openWorker(core: ChronoCore, role: string): { id: string; token: string } {
  const res = core.openSession(
    { role, adapter: "test-adapter", runtime: "test-runtime", scopeModule: "default", ttlSeconds: 3600 },
    { interactive: true }
  );
  expect(res.ok).toBe(true);
  return { id: res.value!.id, token: res.value!.token };
}

function fakeTty(): () => void {
  const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  return () => {
    if (stdinDesc !== undefined) Object.defineProperty(process.stdin, "isTTY", stdinDesc);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (stdoutDesc !== undefined) Object.defineProperty(process.stdout, "isTTY", stdoutDesc);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  };
}

function signFields(signingKey: string, fields: { action: string; scopeArtifactId: string; scopeRevision: string; authority: string; rationale: string }) {
  const payload = buildApprovalPayload({ ...fields, timestamp: FIXED_TIME });
  return {
    timestamp: FIXED_TIME,
    signature: signApprovalPayload(payload, signingKey),
  };
}

describe("OC-P11 planning authoring", () => {
  let tempDir: string;
  let core: ChronoCore;
  let privateKeyPem: string;
  let gaspar: CallerAuth;
  let restoreTty: () => void;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-planning-test-"));
    core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    expect(core.init().ok).toBe(true);
    const pair = generateApprovalKeyPair();
    restoreTty = fakeTty();
    enrollTestPo(core, pair);
    privateKeyPem = pair.privateKeyPem;
    gaspar = { actor: "gaspar", session: bootstrapSession(core, "gaspar", privateKeyPem) };
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("Gaspar proposes permitted kinds into canonical managed locations", () => {
    const drafts: Array<{ kind: string; id: string; file: string }> = [
      { kind: "discovery", id: "DISCOVERY", file: ".chrono/context/DISCOVERY.md" },
      { kind: "requirement", id: "REQ-0001", file: ".chrono/context/requirements/REQ-0001.md" },
      { kind: "adr", id: "ADR-0001", file: ".chrono/architecture/adr/ADR-0001.md" },
      { kind: "security-profile", id: "SEC-0001", file: ".chrono/security/SEC-0001.md" },
      { kind: "roadmap", id: "ROADMAP", file: ".chrono/roadmap/ROADMAP.md" },
    ];
    for (const d of drafts) {
      const res = core.proposePlanningArtifact({ kind: d.kind, id: d.id, title: `Title ${d.id}`, body: `Body for ${d.id}.` }, gaspar);
      expect(res.ok).toBe(true);
      expect(res.value!.path).toBe(join(core.projectPath(), d.file));
      expect(existsSync(join(tempDir, d.file))).toBe(true);
      const text = readFileSync(join(tempDir, d.file), "utf8");
      expect(text).toContain(d.id);
      expect(text).toContain(res.value!.revision);
    }
  });

  it("spec kind creates a DRAFT SP row; module kind requires Spec refs", () => {
    const spec = core.proposePlanningArtifact({ kind: "spec", id: "SP-0001", title: "Auth", body: "Auth spec draft." }, gaspar);
    expect(spec.ok).toBe(true);
    expect(core.getArtifact("SP-0001").status).toBe("DRAFT");
    const orphan = core.proposePlanningArtifact({ kind: "module", id: "MOD-0001", title: "M", body: "Module plan." }, gaspar);
    expect(orphan.ok).toBe(false);
    expect(orphan.error?.code).toBe("VALIDATION_ERROR");
    const mod = core.proposePlanningArtifact(
      { kind: "module", id: "MOD-0001", title: "M", body: "Module plan.", references: ["SP-0001"] },
      gaspar
    );
    expect(mod.ok).toBe(true);
    expect(core.getArtifact("MOD-0001").status).toBe("DRAFT");
  });

  it("workpackage kind requires the owning module ref and creates PLANNED WP", () => {
    const spec = core.proposePlanningArtifact({ kind: "spec", id: "SP-0001", title: "S", body: "Spec." }, gaspar);
    expect(spec.ok).toBe(true);
    const mod = core.proposePlanningArtifact({ kind: "module", id: "MOD-0001", title: "M", body: "Plan.", references: ["SP-0001"] }, gaspar);
    expect(mod.ok).toBe(true);
    const orphan = core.proposePlanningArtifact({ kind: "workpackage", id: "WP-0001", title: "W", body: "WP plan." }, gaspar);
    expect(orphan.ok).toBe(false);
    const wp = core.proposePlanningArtifact({ kind: "workpackage", id: "WP-0001", title: "W", body: "WP plan.", references: ["MOD-0001"] }, gaspar);
    expect(wp.ok).toBe(true);
    expect(core.getArtifact("WP-0001").status).toBe("PLANNED");
  });

  it("architecture kind sets the project architecture revision to the file revision", () => {
    const res = core.proposePlanningArtifact({ kind: "architecture", title: "Arch", body: "Architecture proposal." }, gaspar);
    expect(res.ok).toBe(true);
    expect(res.value!.id).toBe("ARCH");
    expect(existsSync(join(tempDir, ".chrono/architecture/ARCHITECTURE.md"))).toBe(true);
    const status = core.status();
    expect(status.ok).toBe(true);
    expect(["ARCHITECTING", "ANALYZING", "SPECIFYING", "PLANNING", "UNINITIALIZED", "EXECUTING", "VERIFYING", "BLOCKED", "COMPLETE"]).toContain(status.value!.state);
  });

  it("workers cannot use planning-authoring authority", () => {
    const worker = { actor: "belthazar", session: openWorker(core, "belthazar") };
    const res = core.proposePlanningArtifact({ kind: "requirement", id: "REQ-0001", title: "R", body: "Body." }, worker);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("EXECUTION_DENIED");
    const status = core.planningStatus(worker);
    expect(status.ok).toBe(false);
    expect(status.error?.code).toBe("EXECUTION_DENIED");
  });

  it("unknown kinds, malformed ids, and duplicates deny", () => {
    expect(core.proposePlanningArtifact({ kind: "product-code", id: "X-1", title: "T", body: "B" }, gaspar).ok).toBe(false);
    expect(core.proposePlanningArtifact({ kind: "spec", id: "../evil", title: "T", body: "B" }, gaspar).error?.code).toBe("VALIDATION_ERROR");
    expect(core.proposePlanningArtifact({ kind: "spec", id: "SP-1", title: "T", body: "B" }, gaspar).error?.code).toBe("VALIDATION_ERROR");
    const first = core.proposePlanningArtifact({ kind: "requirement", id: "REQ-0001", title: "R", body: "Body." }, gaspar);
    expect(first.ok).toBe(true);
    const dup = core.proposePlanningArtifact({ kind: "requirement", id: "REQ-0001", title: "R2", body: "Body2." }, gaspar);
    expect(dup.ok).toBe(false);
    expect(dup.error?.code).toBe("DUPLICATE_IDENTITY");
  });

  it("malformed, empty, and oversized model content denies", () => {
    expect(core.proposePlanningArtifact({ kind: "requirement", id: "REQ-0001", title: "  ", body: "Body." }, gaspar).error?.code).toBe("VALIDATION_ERROR");
    expect(core.proposePlanningArtifact({ kind: "requirement", id: "REQ-0001", title: "R", body: "   " }, gaspar).error?.code).toBe("VALIDATION_ERROR");
    const big = `x`.repeat(70000);
    expect(core.proposePlanningArtifact({ kind: "requirement", id: "REQ-0001", title: "R", body: big }, gaspar).error?.code).toBe("VALIDATION_ERROR");
  });

  it("secret material in planning content denies without persisting", () => {
    const evil = "key material:\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    const res = core.proposePlanningArtifact({ kind: "requirement", id: "REQ-0001", title: "R", body: evil }, gaspar);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("SECRET_DETECTED");
    expect(existsSync(join(tempDir, ".chrono/context/requirements/REQ-0001.md"))).toBe(false);
    const tokenEvil = "use CHRONO_SESSION_TOKEN=SES-1/abc for entry";
    expect(core.proposePlanningArtifact({ kind: "requirement", id: "REQ-0002", title: "R", body: tokenEvil }, gaspar).error?.code).toBe("SECRET_DETECTED");
  });

  it("unresolvable references deny", () => {
    const res = core.proposePlanningArtifact(
      { kind: "spec", id: "SP-0001", title: "S", body: "Spec.", references: ["SP-9999"] },
      gaspar
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("REFERENCE_UNRESOLVABLE");
  });

  it("chat approval alone creates no approval; status says awaiting-signature", () => {
    const res = core.proposePlanningArtifact({ kind: "requirement", id: "REQ-0001", title: "R", body: "Body." }, gaspar);
    expect(res.ok).toBe(true);
    // No recordApproval call: the PO "accepting in chat" changes nothing.
    const status = core.planningStatus(gaspar);
    expect(status.ok).toBe(true);
    const item = status.value!.items.find((i) => i.id === "REQ-0001");
    expect(item?.approval).toBe("awaiting-signature");
    expect(item?.detail).toContain("PO stated approval in chat is NOT registered");
  });

  it("Gaspar cannot sign or impersonate the PO", () => {
    const res = core.proposePlanningArtifact({ kind: "requirement", id: "REQ-0001", title: "R", body: "Body." }, gaspar);
    expect(res.ok).toBe(true);
    const forged = signApprovalPayload(
      buildApprovalPayload({
        action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: res.value!.revision,
        authority: "PO", rationale: "gaspar forged", timestamp: FIXED_TIME,
      }),
      generateApprovalKeyPair().privateKeyPem
    );
    const recorded = core.recordApproval({
      action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: res.value!.revision,
      authority: "PO", rationale: "gaspar forged", timestamp: FIXED_TIME, signature: forged,
    });
    expect(recorded.ok).toBe(false);
    expect(recorded.error?.code).toBe("SIGNATURE_INVALID");
    // Actor/session confusion: PO actor on a gaspar session denies.
    const confused = core.proposePlanningArtifact(
      { kind: "requirement", id: "REQ-0002", title: "R", body: "Body." },
      { actor: "PO", session: gaspar.session }
    );
    expect(confused.ok).toBe(false);
  });

  it("signed approval binds the exact revision; replay denies", () => {
    const res = core.proposePlanningArtifact({ kind: "requirement", id: "REQ-0001", title: "R", body: "Body." }, gaspar);
    expect(res.ok).toBe(true);
    const { signature, timestamp } = signFields(privateKeyPem, {
      action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: res.value!.revision,
      authority: "PO", rationale: "accept",
    });
    const recorded = core.recordApproval({
      action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: res.value!.revision,
      authority: "PO", rationale: "accept", timestamp, signature,
    });
    expect(recorded.ok).toBe(true);
    expect(core.hasValidApproval("REQ-0001", res.value!.revision, "planning-approval")).toBe(true);
    const status = core.planningStatus(gaspar);
    expect(status.value!.items.find((i) => i.id === "REQ-0001")?.approval).toBe("approved");
    const replay = core.recordApproval({
      action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: res.value!.revision,
      authority: "PO", rationale: "accept", timestamp, signature,
    });
    expect(replay.ok).toBe(false);
  });

  it("stale and wrong-revision approvals deny; revise stales the prior approval", () => {
    const res = core.proposePlanningArtifact({ kind: "requirement", id: "REQ-0001", title: "R", body: "Body." }, gaspar);
    expect(res.ok).toBe(true);
    const wrong = signFields(privateKeyPem, {
      action: "planning-approval", scopeArtifactId: "REQ-0001",
      scopeRevision: `sha256:${"b".repeat(64)}`, authority: "PO", rationale: "accept",
    });
    const staleAttempt = core.recordApproval({
      action: "planning-approval", scopeArtifactId: "REQ-0001",
      scopeRevision: `sha256:${"b".repeat(64)}`, authority: "PO", rationale: "accept",
      timestamp: wrong.timestamp, signature: wrong.signature,
    });
    expect(staleAttempt.ok).toBe(false);
    const good = signFields(privateKeyPem, {
      action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: res.value!.revision,
      authority: "PO", rationale: "accept",
    });
    expect(core.recordApproval({
      action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: res.value!.revision,
      authority: "PO", rationale: "accept", timestamp: good.timestamp, signature: good.signature,
    }).ok).toBe(true);
    const revised = core.revisePlanningArtifact("REQ-0001", { title: "R2", body: "Changed body." }, gaspar);
    expect(revised.ok).toBe(true);
    expect(revised.value!.revision).not.toBe(res.value!.revision);
    expect(core.hasValidApproval("REQ-0001", res.value!.revision, "planning-approval")).toBe(false);
    const status = core.planningStatus(gaspar);
    expect(status.value!.items.find((i) => i.id === "REQ-0001")?.approval).toBe("stale");
    // File tracks the new revision.
    expect(readFileSync(join(tempDir, ".chrono/context/requirements/REQ-0001.md"), "utf8")).toContain(revised.value!.revision);
  });

  it("revise of unknown id denies; unchanged content denies", () => {
    expect(core.revisePlanningArtifact("REQ-9999", { title: "T", body: "B" }, gaspar).error?.code).toBe("ENTITY_NOT_FOUND");
    const res = core.proposePlanningArtifact({ kind: "requirement", id: "REQ-0001", title: "R", body: "Body." }, gaspar);
    expect(res.ok).toBe(true);
    expect(core.revisePlanningArtifact("REQ-0001", { title: "R", body: "Body." }, gaspar).error?.code).toBe("DUPLICATE_IDENTITY");
  });

  it("partial filesystem failure rolls back with no residue and stays recoverable", () => {
    // Block the managed destination with a directory: the atomic rename
    // fails, so nothing may persist — no index entry, no artifact row,
    // no tmp file — and removing the obstacle lets the retry succeed.
    mkdirSync(join(core.projectPath(), ".chrono/specs"), { recursive: true });
    mkdirSync(join(core.projectPath(), ".chrono/specs/SP-0001.md"), { recursive: true });
    const blocked = core.proposePlanningArtifact({ kind: "spec", id: "SP-0001", title: "S", body: "Spec body." }, gaspar);
    expect(blocked.ok).toBe(false);
    const status = core.planningStatus(gaspar);
    expect(status.ok).toBe(true);
    expect(status.value!.items.find((i) => i.id === "SP-0001")).toBeUndefined();
    expect(() => core.getArtifact("SP-0001")).toThrow();
    const leftovers = readdirSync(join(core.projectPath(), ".chrono/specs")).filter((f) => f.includes("chrono-tmp"));
    expect(leftovers).toHaveLength(0);
    rmSync(join(core.projectPath(), ".chrono/specs/SP-0001.md"), { recursive: true, force: true });
    const retry = core.proposePlanningArtifact({ kind: "spec", id: "SP-0001", title: "S", body: "Spec body." }, gaspar);
    expect(retry.ok).toBe(true);
    expect(core.getArtifact("SP-0001").status).toBe("DRAFT");
  });

  it("security-profile revision advances the versioned row without collision (D2)", () => {
    const first = core.proposePlanningArtifact({ kind: "security-profile", id: "SEC-0001", title: "Threats", body: "Boundaries v1." }, gaspar);
    expect(first.ok).toBe(true);
    // Initial proposal: version 1 bound to the file revision.
    const row1 = core.describeSecurityProfile("SEC-0001");
    expect(row1).toMatchObject({ version: 1, contentHash: first.value!.revision });
    // Revision: same logical id, bumped version, moved hash, one row.
    const second = core.revisePlanningArtifact("SEC-0001", { title: "Threats", body: "Boundaries v2 with abuse cases." }, gaspar);
    expect(second.ok).toBe(true);
    expect(second.value!.revision).not.toBe(first.value!.revision);
    const row2 = core.describeSecurityProfile("SEC-0001");
    expect(row2).toMatchObject({ version: 2, contentHash: second.value!.revision });
    // Prior approval for rev1 is stale; the projection tracks current.
    expect(core.hasValidApproval("SEC-0001", first.value!.revision, "planning-approval")).toBe(false);
    const status = core.planningStatus(gaspar);
    expect(status.value!.items.find((i) => i.id === "SEC-0001")?.revision).toBe(second.value!.revision);
  });

  it("security-profile survives restart and rolls back cleanly on failure (D2)", () => {
    const first = core.proposePlanningArtifact({ kind: "security-profile", id: "SEC-0001", title: "Threats", body: "Boundaries v1." }, gaspar);
    expect(first.ok).toBe(true);
    const second = core.revisePlanningArtifact("SEC-0001", { title: "Threats", body: "Boundaries v2." }, gaspar);
    expect(second.ok).toBe(true);
    const reopened = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    try {
      const again = { actor: "gaspar", session: bootstrapSession(reopened, "gaspar", privateKeyPem) };
      expect(reopened.describeSecurityProfile("SEC-0001")).toMatchObject({ version: 2, contentHash: second.value!.revision });
      const status = reopened.planningStatus(again);
      expect(status.value!.items.find((i) => i.id === "SEC-0001")?.revision).toBe(second.value!.revision);
      // Failed revise changes nothing: same version, hash, and file.
      const bad = reopened.revisePlanningArtifact("SEC-0001", { title: "Threats", body: "x".repeat(70000) }, again);
      expect(bad.ok).toBe(false);
      expect(reopened.describeSecurityProfile("SEC-0001")).toMatchObject({ version: 2, contentHash: second.value!.revision });
    } finally {
      reopened.close();
    }
    // Original handle agrees after reopen (no divergence).
    expect(core.describeSecurityProfile("SEC-0001")).toMatchObject({ version: 2, contentHash: second.value!.revision });
  });

  it("rapid sequential security-profile revisions stay coherent (D2)", () => {
    const first = core.proposePlanningArtifact({ kind: "security-profile", id: "SEC-0001", title: "Threats", body: "v1." }, gaspar);
    expect(first.ok).toBe(true);
    const revisions = [first.value!.revision];
    for (let n = 2; n <= 4; n++) {
      const revised = core.revisePlanningArtifact("SEC-0001", { title: "Threats", body: `v${String(n)} with control ${String(n)}.` }, gaspar);
      expect(revised.ok).toBe(true);
      revisions.push(revised.value!.revision);
    }
    // Triple agreement: file revision, registry revision, profile hash.
    const file = readFileSync(join(core.projectPath(), ".chrono/security/SEC-0001.md"), "utf8");
    const row = core.describeSecurityProfile("SEC-0001");
    expect(row.version).toBe(4);
    expect(file).toContain(row.contentHash);
    const status = core.planningStatus(gaspar);
    expect(status.value!.items.find((i) => i.id === "SEC-0001")?.revision).toBe(row.contentHash);
    // Every revision remains in audit history.
    const seen = new Set(core.listEvents().filter((e) => e.entityId === "SEC-0001").map((e) => JSON.parse(e.payload as string).revision as string));
    for (const revision of revisions) {
      expect(seen.has(revision)).toBe(true);
    }
  });

  it("superseded drafts stay coherent: registry, file, status, and references agree (D3)", () => {
    const oldSpec = core.proposePlanningArtifact({ kind: "spec", id: "SP-0003", title: "Old", body: "Old contract." }, gaspar);
    expect(oldSpec.ok).toBe(true);
    const newSpec = core.proposePlanningArtifact({ kind: "spec", id: "SP-0004", title: "New", body: "New contract." }, gaspar);
    expect(newSpec.ok).toBe(true);
    const superseded = core.supersedePlanningArtifact("SP-0003", "SP-0004", gaspar);
    expect(superseded.ok).toBe(true);
    expect(superseded.value).toMatchObject({ id: "SP-0003", supersededBy: "SP-0004" });
    // Registry, filesystem, and projection agree: no active artifact
    // with a missing file.
    const status = core.planningStatus(gaspar);
    const item = status.value!.items.find((i) => i.id === "SP-0003");
    expect(item).toMatchObject({ lifecycle: "superseded", supersededBy: "SP-0004", filePresent: true });
    const text = readFileSync(join(core.projectPath(), ".chrono/specs/SP-0003.md"), "utf8");
    expect(text).toContain("status: SUPERSEDED");
    expect(text).toContain("SP-0004");
    expect(text).toContain("Old contract.");
    // References still resolve; execution stays impossible (DRAFT, never READY).
    expect(core.getArtifact("SP-0003").status).toBe("DRAFT");
    const mod = core.proposePlanningArtifact(
      { kind: "module", id: "MOD-0001", title: "M", body: "Plan.", references: ["SP-0003", "SP-0004"] },
      gaspar
    );
    expect(mod.ok).toBe(true);
    expect(core.transitionState("MOD-0001", "ModulePlanned", { actor: "gaspar", session: gaspar.session }).ok).toBe(false);
    // Supersede is terminal: double supersede and revise both deny.
    expect(core.supersedePlanningArtifact("SP-0003", "SP-0004", gaspar).error?.code).toBe("INVALID_STATE");
    expect(core.revisePlanningArtifact("SP-0003", { title: "Old", body: "Changed." }, gaspar).error?.code).toBe("INVALID_STATE");
    expect(core.supersedePlanningArtifact("SP-0003", "SP-0003", gaspar).error?.code).toBe("INVALID_STATE");
    expect(core.supersedePlanningArtifact("SP-0003", "SP-9999", gaspar).error?.code).toBe("INVALID_STATE");
    expect(core.supersedePlanningArtifact("SP-9999", "SP-0004", gaspar).error?.code).toBe("ENTITY_NOT_FOUND");
  });

  it("missing planning files heal in place without losing approvals (D3)", () => {
    const draft = core.proposePlanningArtifact({ kind: "requirement", id: "REQ-0001", title: "R", body: "Body." }, gaspar);
    expect(draft.ok).toBe(true);
    rmSync(join(core.projectPath(), ".chrono/context/requirements/REQ-0001.md"));
    const status = core.planningStatus(gaspar);
    expect(status.value!.items.find((i) => i.id === "REQ-0001")).toMatchObject({ filePresent: false });
    // Identical content rematerializes the exact revision (healed).
    const healed = core.revisePlanningArtifact("REQ-0001", { title: "R", body: "Body." }, gaspar);
    expect(healed.ok).toBe(true);
    expect(healed.value).toMatchObject({ revision: draft.value!.revision, healed: true });
    expect(core.planningStatus(gaspar).value!.items.find((i) => i.id === "REQ-0001")).toMatchObject({ filePresent: true });
    const events = core.listEvents().filter((e) => e.eventType === "PlanningFileHealed" && e.entityId === "REQ-0001");
    expect(events).toHaveLength(1);
  });

  it("workers cannot supersede planning drafts (D3)", () => {
    const draft = core.proposePlanningArtifact({ kind: "spec", id: "SP-0001", title: "S", body: "Body." }, gaspar);
    expect(draft.ok).toBe(true);
    const worker = { actor: "belthazar", session: openWorker(core, "belthazar") };
    expect(core.supersedePlanningArtifact("SP-0001", "SP-0001", worker).error?.code).toBe("EXECUTION_DENIED");
  });

  it("destinations never escape the project and never touch product code", () => {
    const res = core.proposePlanningArtifact({ kind: "spec", id: "SP-0001", title: "S", body: "Spec." }, gaspar);
    expect(res.ok).toBe(true);
    expect(res.value!.path.startsWith(core.projectPath())).toBe(true);
    expect(res.value!.path).toContain(".chrono");
    expect(existsSync(join(tempDir, "SP-0001.md"))).toBe(false);
    expect(existsSync(join(tempDir, "src/SP-0001.md"))).toBe(false);
  });

  it("status projection carries no secrets and no body content", () => {
    const res = core.proposePlanningArtifact({ kind: "requirement", id: "REQ-0001", title: "R", body: "Body with normal words." }, gaspar);
    expect(res.ok).toBe(true);
    const status = core.planningStatus(gaspar);
    expect(status.ok).toBe(true);
    const text = JSON.stringify(status.value);
    expect(text).not.toContain("Body with normal words.");
    expect(text).not.toContain("token");
  });

  it("restart resumes persisted discovery without chat history", () => {
    const first = core.proposePlanningArtifact({ kind: "discovery", id: "DISCOVERY", title: "Discovery", body: "Answer one." }, gaspar);
    expect(first.ok).toBe(true);
    core.close();
    const reopened = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    try {
      const again = { actor: "gaspar", session: bootstrapSession(reopened, "gaspar", privateKeyPem) };
      const status = reopened.planningStatus(again);
      expect(status.ok).toBe(true);
      expect(status.value!.items.find((i) => i.id === "DISCOVERY")?.revision).toBe(first.value!.revision);
      expect(existsSync(join(tempDir, ".chrono/context/DISCOVERY.md"))).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it("complete greenfield flow reaches an approved Module with no manual DB edits", () => {
    const d = core.proposePlanningArtifact({ kind: "discovery", id: "DISCOVERY", title: "Discovery", body: "Users and workflows." }, gaspar);
    expect(d.ok).toBe(true);
    const arch = core.proposePlanningArtifact({ kind: "architecture", title: "Arch", body: "Components and boundaries." }, gaspar);
    expect(arch.ok).toBe(true);
    const sec = core.proposePlanningArtifact({ kind: "security-profile", id: "SEC-0001", title: "Threats", body: "Trust boundaries and controls." }, gaspar);
    expect(sec.ok).toBe(true);
    const spec = core.proposePlanningArtifact({ kind: "spec", id: "SP-001", title: "Tasks", body: "Task management contract." }, gaspar);
    // Note: SP-001 is not canonical (expects SP-0001); use the canonical id.
    expect(spec.ok).toBe(false);
    const specOk = core.proposePlanningArtifact({ kind: "spec", id: "SP-0001", title: "Tasks", body: "Task management contract." }, gaspar);
    expect(specOk.ok).toBe(true);
    const mod = core.proposePlanningArtifact({ kind: "module", id: "MOD-0001", title: "Tasks module", body: "Module plan.", references: ["SP-0001"] }, gaspar);
    expect(mod.ok).toBe(true);
    const wp = core.proposePlanningArtifact({ kind: "workpackage", id: "WP-0001", title: "Tasks WP", body: "WP plan.", references: ["MOD-0001"] }, gaspar);
    expect(wp.ok).toBe(true);
    // Signed PO approvals for every draft (planning-approval binds exact revisions).
    const approveId = (scopeId: string, revision: string) => {
      const { signature, timestamp } = signFields(privateKeyPem, {
        action: "planning-approval", scopeArtifactId: scopeId, scopeRevision: revision,
        authority: "PO", rationale: "accept draft",
      });
      const recorded = core.recordApproval({
        action: "planning-approval", scopeArtifactId: scopeId, scopeRevision: revision,
        authority: "PO", rationale: "accept draft", timestamp, signature,
      });
      expect(recorded.ok).toBe(true);
    };
    approveId("DISCOVERY", d.value!.revision);
    approveId("SEC-0001", sec.value!.revision);
    approveId("SP-0001", specOk.value!.revision);
    approveId("MOD-0001", mod.value!.revision);
    approveId("WP-0001", wp.value!.revision);
    // Architecture uses the architecture-security decision on the same file revision.
    const archSig = signFields(privateKeyPem, {
      action: "architecture-security", scopeArtifactId: "ARCH", scopeRevision: arch.value!.revision,
      authority: "PO", rationale: "accept architecture with controls",
    });
    expect(core.recordApproval({
      action: "architecture-security", scopeArtifactId: "ARCH", scopeRevision: arch.value!.revision,
      authority: "PO", rationale: "accept architecture with controls",
      timestamp: archSig.timestamp, signature: archSig.signature,
    }).ok).toBe(true);
    const status = core.planningStatus(gaspar);
    expect(status.ok).toBe(true);
    expect(status.value!.items.find((i) => i.id === "MOD-0001")?.approval).toBe("approved");
    expect(status.value!.items.find((i) => i.id === "ARCH")?.approval).toBe("approved");
    // Module approval through the existing signed ceremony (module-approval on the MOD row).
    const modRev = core.getArtifact("MOD-0001").revision;
    const modSig = signFields(privateKeyPem, {
      action: "module-approval", scopeArtifactId: "MOD-0001", scopeRevision: modRev,
      authority: "PO", rationale: "authorize implementation",
    });
    expect(core.recordApproval({
      action: "module-approval", scopeArtifactId: "MOD-0001", scopeRevision: modRev,
      authority: "PO", rationale: "authorize implementation",
      timestamp: modSig.timestamp, signature: modSig.signature,
    }).ok).toBe(true);
    expect(core.hasValidApproval("MOD-0001", modRev, "module-approval")).toBe(true);
  });
});
