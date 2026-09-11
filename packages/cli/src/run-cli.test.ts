/**
 * Slice 6 CLI tests — authorized dispatch through a registered adapter.
 * The fixture runtime is a real executable script (not a mock of the
 * product path): authorize → enact → spawn → evidence → advance.
 * Every denial leaves lifecycle state untouched.
 * [RUNTIME §4, PL Phase 5]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  RTK_UPSTREAM,
  SKILL_UPSTREAM,
  buildApprovalPayload,
  buildSessionAuthorizationPayload,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore } from "@chrono/core";
import { runDispatch, type RunOptions, type SpawnResult } from "./index.js";

const FIXED_TIME = "2026-06-01T00:00:00.000Z";
const SPEC = {
  id: "SP-0001",
  title: "T",
  purpose: "P",
  inScope: ["a"],
  acceptanceCriteria: ["ac1"],
};
const MOD = { id: "MOD-0001", name: "M", purpose: "P", specs: ["SP-0001"] };

type TestSession = { id: string; token: string };

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

function signedSession(
  core: ChronoCore,
  role: "gaspar" | "PO" | "belthazar" | "glenn",
  privateKeyPem: string,
  scopeModule?: string
): TestSession {
  const input = {
    role,
    adapter: "test-adapter",
    runtime: "test-runtime",
    ...(scopeModule !== undefined ? { scopeModule } : {}),
    ttlSeconds: 3600,
  };
  if (role !== "gaspar" && role !== "PO") {
    const res = core.openSession(input, { interactive: true });
    expect(res.ok).toBe(true);
    return { id: res.value!.id, token: res.value!.token };
  }
  const nonce = randomBytes(16).toString("hex");
  const timestamp = "2026-09-11T00:00:00.000Z";
  const rationale = "test privileged-session bootstrap";
  const signature = signApprovalPayload(
    buildSessionAuthorizationPayload({
      sessionRole: role,
      adapter: "test-adapter",
      runtime: "test-runtime",
      scopeModule: scopeModule ?? null,
      scopeWp: null,
      ttlSeconds: 3600,
      nonce,
      authority: "PO",
      rationale,
      timestamp,
    }),
    privateKeyPem
  );
  const res = core.openSession(input, {
    poAuthorization: { nonce, authority: "PO", rationale, timestamp, signature },
  });
  expect(res.ok).toBe(true);
  return { id: res.value!.id, token: res.value!.token };
}

function approve(
  core: ChronoCore,
  privateKeyPem: string,
  action: string,
  scopeArtifactId: string,
  scopeRevision: string
): void {
  const signature = signApprovalPayload(
    buildApprovalPayload({
      action,
      scopeArtifactId,
      scopeRevision,
      authority: "PO",
      rationale: "test approval",
      timestamp: FIXED_TIME,
    }),
    privateKeyPem
  );
  const res = core.recordApproval({
    action,
    scopeArtifactId,
    scopeRevision,
    authority: "PO",
    rationale: "test approval",
    timestamp: FIXED_TIME,
    signature,
  });
  expect(res.ok).toBe(true);
}

describe("CLI dispatch", () => {
  let tempDir: string;
  let restoreTty: () => void;
  let privateKeyPem: string;
  let gaspar: { actor: string; session: TestSession };
  let po: { actor: string; session: TestSession };
  let worker: { actor: string; session: TestSession };
  let entrypoint: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-run-cli-test-"));
    const core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    try {
      expect(core.init().ok).toBe(true);
      const pair = generateApprovalKeyPair();
      restoreTty = fakeInteractiveTerminal();
      expect(core.registerPoPublicKey(pair.publicKeyPem).ok).toBe(true);
      privateKeyPem = pair.privateKeyPem;
      gaspar = { actor: "gaspar", session: signedSession(core, "gaspar", privateKeyPem) };
      po = { actor: "PO", session: signedSession(core, "PO", privateKeyPem) };
      // Architecture + spec + module to APPROVED.
      const proposed = core.proposeArchitecture({ title: "A" }, gaspar);
      expect(proposed.ok).toBe(true);
      expect(core.submitArchitectureForReview(gaspar).ok).toBe(true);
      approve(core, privateKeyPem, "architecture-security", "ARCH", proposed.value!);
      expect(core.approveArchitecture(gaspar).ok).toBe(true);
      expect(core.registerSpec("SP-0001", "DRAFT", SPEC, gaspar).ok).toBe(true);
      expect(core.transitionState("SP-0001", "SpecSubmittedForReview", gaspar).ok).toBe(true);
      const specRev = core.getArtifact("SP-0001").revision;
      approve(core, privateKeyPem, "architecture-security", "SP-0001", specRev);
      expect(core.recordHarness(specRev, `sha256:${"a".repeat(64)}`, "# h", gaspar).ok).toBe(true);
      expect(core.transitionState("SP-0001", "SpecApprovedReady", gaspar).ok).toBe(true);
      expect(core.registerModule("MOD-0001", "DRAFT", MOD, gaspar).ok).toBe(true);
      expect(core.transitionState("MOD-0001", "ModulePlanned", gaspar).ok).toBe(true);
      const modRev = core.getArtifact("MOD-0001").revision;
      approve(core, privateKeyPem, "module-approval", "MOD-0001", modRev);
      expect(core.transitionState("MOD-0001", "ModuleApproved", gaspar).ok).toBe(true);
      // Attestations + security posture for execution.
      expect(
        core.recordRtkAttestation(gaspar, {
          binaryPath: "/usr/local/bin/rtk",
          binaryIdentity: "rtk-test",
          version: "1.0.0-test",
          provenance: RTK_UPSTREAM,
          integrationMode: "test",
          routingTestPassed: true,
          routingTestLog: "fixture",
          gained: true,
          savingsEvidence: null,
          ttlSeconds: 86400,
        }).ok
      ).toBe(true);
      expect(
        core.recordSkillAttestation(gaspar, {
          upstream: SKILL_UPSTREAM,
          pinnedCommit: "a".repeat(40),
          sourceHash: `sha256:${"b".repeat(64)}`,
          generatedHashes: "{}",
          converterVersion: "test-1",
          licenseStatus: "MIT",
          attribution: "MIT",
          runtimeIdentity: "test",
          agentIdentity: "test",
          discoveryResult: "found",
          permissionResult: "granted",
          activationTestPassed: true,
          ttlSeconds: 86400,
        }).ok
      ).toBe(true);
      const glenn = { actor: "glenn", session: signedSession(core, "glenn", privateKeyPem, "MOD-0001") };
      expect(core.recordSecurityProfile({ title: "P", threats: [] }, glenn).ok).toBe(true);
      approve(core, privateKeyPem, "implementation-security", "MOD-0001", modRev);
      // Fixture runtime + registration.
      entrypoint = join(tempDir, "fixture-runtime.sh");
      writeFileSync(entrypoint, "#!/bin/sh\necho fixture-ok\n");
      chmodSync(entrypoint, 0o755);
      expect(
        core.registerAdapter({ id: "fixture", name: "Fixture", entrypoint }, po).ok
      ).toBe(true);
      worker = { actor: "belthazar", session: signedSession(core, "belthazar", privateKeyPem, "MOD-0001") };
    } finally {
      core.close();
    }
  });

  afterEach(() => {
    restoreTty();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function baseOptions(overrides: Partial<RunOptions> = {}): RunOptions {
    return {
      module: "MOD-0001",
      adapter: "fixture",
      as: "gaspar",
      requesterToken: `${gaspar.session.id}/${gaspar.session.token}`,
      role: "belthazar",
      sessionToken: `${worker.session.id}/${worker.session.token}`,
      command: [entrypoint, "--work"],
      ...overrides,
    };
  }

  const okSpawn = (seen: { env?: Record<string, string> }) =>
    (cmd: string, args: string[], _timeoutMs: number, env: Record<string, string>): SpawnResult => {
      seen.env = env;
      expect(cmd).toBe(entrypoint);
      expect(args).toEqual(["--work"]);
      return { status: 0, stdout: "fixture-ok", stderr: "", timedOut: false };
    };

  it("dispatches an approved module to VERIFYING with recorded evidence", () => {
    const seen: { env?: Record<string, string> } = {};
    const out = runDispatch(tempDir, baseOptions(), okSpawn(seen));
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("VERIFYING");
    expect(seen.env?.["CHRONO_MODULE"]).toBe("MOD-0001");
    expect(seen.env?.["CHRONO_ADAPTER"]).toBe("fixture");
    expect(seen.env?.["CHRONO_GRANT_ID"]).toMatch(/^GRANT-\d{4,}$/);
    const check = new ChronoCore({ projectPath: tempDir });
    try {
      expect(check.getArtifact("MOD-0001").status).toBe("VERIFYING");
      expect(check.validate().value?.valid).toBe(true);
    } finally {
      check.close();
    }
  });

  it("leaves state EXECUTING when the command fails", () => {
    const out = runDispatch(
      tempDir,
      baseOptions(),
      () => ({ status: 3, stdout: "", stderr: "boom", timedOut: false })
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("boom");
    const check = new ChronoCore({ projectPath: tempDir });
    try {
      expect(check.getArtifact("MOD-0001").status).toBe("EXECUTING");
    } finally {
      check.close();
    }
  });

  it("denies unregistered adapters and smuggled binaries", () => {
    const ghost = runDispatch(tempDir, baseOptions({ adapter: "ghost" }), okSpawn({}));
    expect(ghost.exitCode).toBe(1);
    const smuggled = runDispatch(
      tempDir,
      baseOptions({ command: ["/bin/sh", "-c", "echo pwned"] }),
      okSpawn({})
    );
    expect(smuggled.exitCode).toBe(2);
    expect(smuggled.stderr).toContain("entrypoint");
  });

  it("requires explicit requester and executor sessions", () => {
    const noRequester = runDispatch(tempDir, baseOptions({ requesterToken: "" }), okSpawn({}));
    expect(noRequester.exitCode).toBe(2);
    const noExecutor = runDispatch(tempDir, baseOptions({ sessionToken: "" }), okSpawn({}));
    expect(noExecutor.exitCode).toBe(2);
  });
});
