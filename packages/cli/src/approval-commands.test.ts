/**
 * OC-P11 ceremony CLI tests — approval-request, approval-record, and
 * approval-ticket surfaces.
 *
 * Key material never travels through these commands: request creates
 * the ticket, record consumes it with a host-made signature, and the
 * ticket query is a safe projection. Model invocation without a valid
 * PO signature denies at cryptographic verification.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  buildApprovalPayload,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore } from "@chrono/core";
import { checkQuestionSurface, runApprovalRecord, runApprovalRequest, runApprovalTicket } from "./approval-ceremony-cli.js";
import { runArtifactPropose } from "./artifact-cli.js";
import { runDoctor } from "./init-flow.js";
import { MemoryKeyStore } from "./keychain.js";

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

describe("OC-P11 ceremony commands", () => {
  let tempDir: string;
  let gasparToken = "";
  let signingKey = "";
  let draftRev = "";
  let restoreTty: () => void;

  function tokenString(session: { id: string; token: string }): string {
    return `${session.id}/${session.token}`;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-approval-cmd-test-"));
    const core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    expect(core.init().ok).toBe(true);
    const pair = generateApprovalKeyPair();
    restoreTty = fakeTty();
    const nonce = randomBytes(16).toString("hex");
    const fingerprint = fingerprintPublicKey(pair.publicKeyPem);
    const confirmation = buildEnrollmentChallenge("default", fingerprint, nonce);
    const timestamp = new Date().toISOString();
    const signature = signApprovalPayload(
      buildEnrollmentPayload({ projectId: "default", fingerprint, timestamp, nonce, authority: "PO", rationale: "test", confirmation }),
      pair.privateKeyPem
    );
    expect(core.enrollPo({ publicKeyPem: pair.publicKeyPem, nonce, timestamp, rationale: "test", confirmation, signature }).ok).toBe(true);
    signingKey = pair.privateKeyPem;
    const sessionNonce = randomBytes(16).toString("hex");
    const sessionTimestamp = "2026-09-11T00:00:00.000Z";
    const sessionSig = signApprovalPayload(
      buildSessionAuthorizationPayload({
        sessionRole: "gaspar", adapter: "test-adapter", runtime: "test-runtime",
        scopeModule: null, scopeWp: null, ttlSeconds: 3600, nonce: sessionNonce,
        authority: "PO", rationale: "test", timestamp: sessionTimestamp,
      }),
      signingKey
    );
    const opened = core.openSession(
      { role: "gaspar", adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
      { poAuthorization: { nonce: sessionNonce, authority: "PO", rationale: "test", timestamp: sessionTimestamp, signature: sessionSig } }
    );
    expect(opened.ok).toBe(true);
    gasparToken = tokenString({ id: opened.value!.id, token: opened.value!.token });
    const bodyPath = join(tempDir, "draft.md");
    writeFileSync(bodyPath, "Requirement body.", "utf8");
    const proposed = runArtifactPropose(tempDir, {
      kind: "requirement", id: "REQ-0001", title: "R", bodyFile: bodyPath,
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(proposed.exitCode).toBe(0);
    draftRev = (JSON.parse(proposed.stdout) as { revision: string }).revision;
    core.close();
  });

  afterEach(() => {
    restoreTty();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function request(): { ticketId: string; challenge: string } {
    const out = runApprovalRequest(tempDir, {
      action: "planning-approval", scope: "REQ-0001", revision: draftRev,
      rationale: "accept", securityImplications: "none",
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(out.exitCode).toBe(0);
    return JSON.parse(out.stdout) as { ticketId: string; challenge: string };
  }

  it("requests, describes, and records a ticket through the CLI", () => {
    const { ticketId, challenge } = request();
    expect(ticketId).toMatch(/^TICKET-[0-9]{4}$/);
    expect(challenge).toBe(`approve-${ticketId}`);
    const described = runApprovalTicket(tempDir, { ticket: ticketId, as: "gaspar", sessionToken: gasparToken, json: true });
    expect(described.exitCode).toBe(0);
    expect(JSON.parse(described.stdout)).toMatchObject({ ok: true, id: ticketId, live: true });
    const timestamp = new Date().toISOString();
    const signature = signApprovalPayload(buildApprovalPayload({
      action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: draftRev,
      authority: "PO", rationale: "accept", timestamp, securityImplications: "none",
    }), signingKey);
    const recorded = runApprovalRecord(tempDir, {
      ticket: ticketId, timestamp, signature,
      permissionCallId: "call-1", decidedAt: timestamp,
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(recorded.exitCode).toBe(0);
    expect(JSON.parse(recorded.stdout).ok).toBe(true);
  });

  function fixtureBinary(name: string, script: string): string {
    const path = join(tempDir, name);
    writeFileSync(path, script, "utf8");
    chmodSync(path, 0o755);
    return path;
  }

  it("classifies the question surface from the debug-agent oracle", () => {
    const yes = fixtureBinary("opencode-yes.sh", `#!/bin/sh\necho '{"tools":{"question":true}}'\n`);
    expect(checkQuestionSurface(tempDir, yes)).toMatchObject({ available: true });
    const no = fixtureBinary("opencode-no.sh", `#!/bin/sh\necho '{"tools":{"question":false}}'\n`);
    const denied = checkQuestionSurface(tempDir, no);
    expect(denied.available).toBe(false);
    expect(denied.reason).toContain("question: allow");
    const missing = fixtureBinary("opencode-missing.sh", `#!/bin/sh\necho '{"agent":"gaspar"}'\n`);
    expect(checkQuestionSurface(tempDir, missing).available).toBe(false);
    const garbage = fixtureBinary("opencode-garbage.sh", `#!/bin/sh\necho 'not json'\n`);
    expect(checkQuestionSurface(tempDir, garbage).available).toBe(false);
    const failing = fixtureBinary("opencode-failing.sh", `#!/bin/sh\nexit 3\n`);
    expect(checkQuestionSurface(tempDir, failing).available).toBe(false);
  });

  it("refuses requireQuestion tickets unless the question tool is exposed", () => {
    const yes = fixtureBinary("opencode-q-yes.sh", `#!/bin/sh\necho '{"tools":{"question":true}}'\n`);
    const allowed = runApprovalRequest(tempDir, {
      action: "planning-approval", scope: "REQ-0001", revision: draftRev,
      rationale: "accept", securityImplications: "none",
      as: "gaspar", sessionToken: gasparToken, json: true,
      requireQuestion: true, opencodeBinary: yes,
    });
    expect(allowed.exitCode).toBe(0);
    expect(JSON.parse(allowed.stdout)).toMatchObject({ ok: true });
    const no = fixtureBinary("opencode-q-no.sh", `#!/bin/sh\necho '{"tools":{"question":false}}'\n`);
    const refused = runApprovalRequest(tempDir, {
      action: "planning-approval", scope: "REQ-0001", revision: draftRev,
      rationale: "accept", securityImplications: "none",
      as: "gaspar", sessionToken: gasparToken, json: true,
      requireQuestion: true, opencodeBinary: no,
    });
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout).error.message).toContain("approval ticket refused");
  });

  it("reports the question surface in doctor output", () => {
    const yes = fixtureBinary("opencode-doc-yes.sh", `#!/bin/sh\necho '{"tools":{"question":true}}'\n`);
    const saved = process.env["CHRONO_OPENCODE_BIN"];
    process.env["CHRONO_OPENCODE_BIN"] = yes;
    try {
      const out = runDoctor(tempDir, { json: true, store: new MemoryKeyStore() });
      const report = (JSON.parse(out.stdout) as { doctor: { ceremony: { questionSurface: { available: boolean } } } }).doctor;
      expect(report.ceremony.questionSurface.available).toBe(true);
    } finally {
      if (saved === undefined) {
        delete process.env["CHRONO_OPENCODE_BIN"];
      } else {
        process.env["CHRONO_OPENCODE_BIN"] = saved;
      }
    }
  });

  it("denies workers, missing sessions, forged signatures, and unknown tickets", () => {
    const core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    const worker = core.openSession(
      { role: "belthazar", adapter: "test-adapter", runtime: "test-runtime", scopeModule: "default", ttlSeconds: 3600 },
      { interactive: true }
    );
    core.close();
    expect(worker.ok).toBe(true);
    const workerToken = `${worker.value!.id}/${worker.value!.token}`;
    const denied = runApprovalRequest(tempDir, {
      action: "planning-approval", scope: "REQ-0001", revision: draftRev,
      rationale: "r", securityImplications: "s",
      as: "belthazar", sessionToken: workerToken, json: true,
    });
    expect(denied.exitCode).toBe(1);
    expect(JSON.parse(denied.stdout).error.code).toBe("EXECUTION_DENIED");
    const noSession = runApprovalRequest(tempDir, {
      action: "planning-approval", scope: "REQ-0001", revision: draftRev,
      rationale: "r", securityImplications: "s",
      as: "gaspar", json: true,
    });
    expect(noSession.exitCode).toBe(1);
    const { ticketId } = request();
    const timestamp = new Date().toISOString();
    const forged = signApprovalPayload(buildApprovalPayload({
      action: "planning-approval", scopeArtifactId: "REQ-0001", scopeRevision: draftRev,
      authority: "PO", rationale: "accept", timestamp, securityImplications: "none",
    }), generateApprovalKeyPair().privateKeyPem);
    const forgedRecord = runApprovalRecord(tempDir, {
      ticket: ticketId, timestamp, signature: forged,
      permissionCallId: "call-9", decidedAt: timestamp,
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(forgedRecord.exitCode).toBe(1);
    expect(JSON.parse(forgedRecord.stdout).error.code).toBe("SIGNATURE_INVALID");
    const unknown = runApprovalRecord(tempDir, {
      ticket: "TICKET-9999", timestamp, signature: forged,
      permissionCallId: "call-9", decidedAt: timestamp,
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(unknown.exitCode).toBe(1);
    const missingObservation = runApprovalRecord(tempDir, {
      ticket: ticketId, timestamp, signature: forged,
      permissionCallId: "   ", decidedAt: timestamp,
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(missingObservation.exitCode).toBe(1);
  });
});
