/**
 * I5 adversarial tests — registration validates identity, entry state,
 * required fields, schema, content, and references before persistence.
 * [Remediation §2, CORE §3.1/§12, INV §10/§14.4]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore } from "./chrono-core.js";

const SP = { id: "SP-0001", title: "T", purpose: "P" };
const MOD = { id: "MOD-0001", name: "M", purpose: "P", specs: ["SP-0001"] };

function freshCore(tempDir: string): ChronoCore {
  const core = new ChronoCore({ projectPath: tempDir });
  expect(core.init().ok).toBe(true);
  return core;
}

/**
 * TEST-ONLY enrollment helper: builds a valid ceremony proof with a
 * caller-supplied timestamp (wall clock by default; pass the fixed clock
 * time for clock-injected cores). Production callers MUST use
 * `chrono enroll`, which adds /dev/tty confirmation and keychain custody.
 */
function enrollTestPo(
  core: ChronoCore,
  pair: { publicKeyPem: string; privateKeyPem: string },
  timestamp = new Date().toISOString(),
  rationale = "test enrollment"
): void {
  const nonce = randomBytes(16).toString("hex");
  const fingerprint = fingerprintPublicKey(pair.publicKeyPem);
  const confirmation = buildEnrollmentChallenge("default", fingerprint, nonce);
  const signature = signApprovalPayload(
    buildEnrollmentPayload({
      projectId: "default",
      fingerprint,
      timestamp,
      nonce,
      authority: "PO",
      rationale,
      confirmation,
    }),
    pair.privateKeyPem
  );
  const res = core.enrollPo({
    publicKeyPem: pair.publicKeyPem,
    nonce,
    timestamp,
    rationale,
    confirmation,
    signature,
  });
  expect(res.ok).toBe(true);
  expect(res.value?.fingerprint).toBe(fingerprint);
}

describe("Registration validation", () => {
  let tempDir: string;
  let core: ChronoCore;
  let restoreTty: () => void;
  let gaspar: { actor: string; session: { id: string; token: string } };

/**
 * TEST-ONLY terminal simulation (session opening is interactive).
 * Never ships; lives only in *.test.ts files.
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

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-reg-test-"));
    restoreTty = fakeInteractiveTerminal();
    core = freshCore(tempDir);
    const pair = generateApprovalKeyPair();
    enrollTestPo(core, pair);
    const nonce = randomBytes(16).toString("hex");
    const timestamp = "2026-09-11T00:00:00.000Z";
    const rationale = "test privileged-session bootstrap";
    const signature = signApprovalPayload(
      buildSessionAuthorizationPayload({
        sessionRole: "gaspar",
        adapter: "test-adapter",
        runtime: "test-runtime",
        scopeModule: null,
        scopeWp: null,
        ttlSeconds: 3600,
        nonce,
        authority: "PO",
        rationale,
        timestamp,
      }),
      pair.privateKeyPem
    );
    const opened = core.openSession(
      { role: "gaspar", adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
      { poAuthorization: { nonce, authority: "PO", rationale, timestamp, signature } }
    );
    expect(opened.ok).toBe(true);
    gaspar = { actor: "gaspar", session: { id: opened.value!.id, token: opened.value!.token } };
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects gated initial states", () => {
    expect(core.registerSpec("SP-0001", "READY", SP, gaspar).error?.code).toBe("INVALID_STATE");
    expect(core.registerSpec("SP-0001", "REVIEW", SP, gaspar).error?.code).toBe("INVALID_STATE");
    expect(core.registerModule("MOD-0001", "APPROVED", MOD, gaspar).error?.code).toBe("INVALID_STATE");
    expect(core.registerModule("MOD-0001", "COMPLETE", MOD, gaspar).error?.code).toBe("INVALID_STATE");
    expect(core.registerModule("MOD-0001", "EXECUTING", MOD, gaspar).error?.code).toBe("INVALID_STATE");
    expect(
      core.registerWorkPackage("WP-0001", "AUTHORIZED", { id: "WP-0001", name: "W", module: "MOD-0001" }, gaspar)
        .error?.code,
    ).toBe("INVALID_STATE");
    // Nothing was persisted by the rejected attempts.
    expect(() => core.getArtifact("SP-0001")).toThrow();
  });

  it("rejects malformed and family-mismatched identities", () => {
    expect(core.registerSpec("SP-001", "DRAFT", SP, gaspar).error?.code).toBe("VALIDATION_ERROR");
    expect(core.registerSpec("XX-0001", "DRAFT", SP, gaspar).error?.code).toBe("VALIDATION_ERROR");
    expect(core.registerModule("SP-0001", "DRAFT", MOD, gaspar).error?.code).toBe("VALIDATION_ERROR");
  });

  it("rejects missing required fields and non-object content", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", { id: "SP-0001", title: "T" }, gaspar).error?.code).toBe(
      "VALIDATION_ERROR",
    );
    expect(
      core.registerModule("MOD-0001", "DRAFT", { id: "MOD-0001", name: "M" }, gaspar).error?.code,
    ).toBe("VALIDATION_ERROR");
    expect(core.registerSpec("SP-0001", "DRAFT", ["not", "an", "object"], gaspar).ok).toBe(false);
    expect(core.registerSpec("SP-0001", "DRAFT", null, gaspar).ok).toBe(false);
  });

  it("rejects embedded content id contradicting the registered id", () => {
    const res = core.registerSpec("SP-0001", "DRAFT", { ...SP, id: "SP-0002" }, gaspar);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INCONSISTENT_REFERENCE");
  });

  it("rejects unresolvable and incompatible references", () => {
    // Module referencing a missing Spec.
    expect(
      core.registerModule("MOD-0001", "DRAFT", { ...MOD, specs: ["SP-0099"] }, gaspar).error?.code,
    ).toBe("REFERENCE_UNRESOLVABLE");
    // Module referencing a non-Spec artifact.
    expect(core.registerSpec("SP-0001", "DRAFT", SP, gaspar).ok).toBe(true);
    expect(
      core.registerModule("MOD-0002", "DRAFT", { id: "MOD-0002", name: "M2", purpose: "P", specs: [] }, gaspar).ok,
    ).toBe(true);
    expect(
      core.registerModule("MOD-0001", "DRAFT", { ...MOD, specs: ["MOD-0002"] }, gaspar).error?.code,
    ).toBe("INCONSISTENT_REFERENCE");
    // WorkPackage with missing owning module.
    expect(
      core.registerWorkPackage("WP-0001", "PLANNED", { id: "WP-0001", name: "W", module: "MOD-0099" }, gaspar)
        .error?.code,
    ).toBe("REFERENCE_UNRESOLVABLE");
    // WorkPackage owned by a Spec instead of a Module.
    expect(
      core.registerWorkPackage("WP-0001", "PLANNED", { id: "WP-0001", name: "W", module: "SP-0001" }, gaspar)
        .error?.code,
    ).toBe("INCONSISTENT_REFERENCE");
  });

  it("rejects dependency cycles", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SP, gaspar).ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", MOD, gaspar).ok).toBe(true);
    const wp = (id: string, dependsOn: string[]): Record<string, unknown> => ({
      id,
      name: id,
      module: "MOD-0001",
      dependsOn,
    });
    // Self-dependency.
    expect(core.registerWorkPackage("WP-0001", "PLANNED", wp("WP-0001", ["WP-0001"]), gaspar).error?.code).toBe(
      "DAG_CYCLE",
    );
    // Two-node cycle.
    expect(core.registerWorkPackage("WP-0001", "PLANNED", wp("WP-0001", ["WP-0002"]), gaspar).error?.code).toBe(
      "REFERENCE_UNRESOLVABLE",
    );
    expect(core.registerWorkPackage("WP-0002", "PLANNED", wp("WP-0002", []), gaspar).ok).toBe(true);
    expect(core.registerWorkPackage("WP-0001", "PLANNED", wp("WP-0001", ["WP-0002"]), gaspar).ok).toBe(true);
    // dependsOn must be an array of identifiers.
    expect(
      core.registerWorkPackage("WP-0003", "PLANNED", { ...wp("WP-0003", []), dependsOn: "WP-0001" }, gaspar).ok,
    ).toBe(false);
  });

  it("rejects duplicate identities", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SP, gaspar).ok).toBe(true);
    expect(core.registerSpec("SP-0001", "DRAFT", SP, gaspar).error?.code).toBe("DUPLICATE_IDENTITY");
  });

  it("accepts valid entry-state registrations with verified references", () => {
    expect(core.registerSpec("SP-0001", "DRAFT", SP, gaspar).ok).toBe(true);
    expect(core.registerModule("MOD-0001", "DRAFT", MOD, gaspar).ok).toBe(true);
    expect(
      core.registerWorkPackage("WP-0001", "PLANNED", {
        id: "WP-0001",
        name: "W",
        module: "MOD-0001",
        dependsOn: [],
      }, gaspar).ok,
    ).toBe(true);
    expect(core.getArtifact("WP-0001").status).toBe("PLANNED");
  });
});
