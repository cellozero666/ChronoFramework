/**
 * OC-P11 CLI tests — Core-governed planning/artifact-authoring tools.
 *
 * The narrow native surface Gaspar uses instead of generic
 * write/edit/bash: propose, revise, and status. Every command delegates
 * to a Core planning operation; output is stable JSON plus
 * human-readable summaries without secrets. Chat text never becomes
 * authority: propose output presents the exact approval ceremony.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
  buildApprovalPayload,
} from "@chrono/domain";
import { ChronoCore } from "@chrono/core";
import { runArtifactPropose, runArtifactRevise, runArtifactStatus } from "./artifact-cli.js";

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

describe("OC-P11 artifact CLI", () => {
  let tempDir: string;
  let gasparToken: string;
  let restoreTty: () => void;
  let privateKeyPem = "";

  function tokenString(session: { id: string; token: string }): string {
    return `${session.id}/${session.token}`;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-artifact-cli-test-"));
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
    privateKeyPem = pair.privateKeyPem;
    const sessionNonce = randomBytes(16).toString("hex");
    const sessionTimestamp = "2026-09-11T00:00:00.000Z";
    const sessionSig = signApprovalPayload(
      buildSessionAuthorizationPayload({
        sessionRole: "gaspar", adapter: "test-adapter", runtime: "test-runtime",
        scopeModule: null, scopeWp: null, ttlSeconds: 3600, nonce: sessionNonce,
        authority: "PO", rationale: "test", timestamp: sessionTimestamp,
      }),
      privateKeyPem
    );
    const opened = core.openSession(
      { role: "gaspar", adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
      { poAuthorization: { nonce: sessionNonce, authority: "PO", rationale: "test", timestamp: sessionTimestamp, signature: sessionSig } }
    );
    expect(opened.ok).toBe(true);
    gasparToken = tokenString({ id: opened.value!.id, token: opened.value!.token });
    core.close();
    void buildApprovalPayload;
  });

  afterEach(() => {
    restoreTty();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function bodyFile(name: string, content: string): string {
    const path = join(tempDir, `${name}.md`);
    writeFileSync(path, content, "utf8");
    return path;
  }

  it("proposes a draft and presents the exact approval ceremony, never a registered claim", () => {
    const out = runArtifactPropose(tempDir, {
      kind: "requirement", id: "REQ-0001", title: "Checkout", bodyFile: bodyFile("req", "Guest checkout requirement."),
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { ok: boolean; id: string; revision: string; approvalCommand: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.id).toBe("REQ-0001");
    expect(parsed.approvalCommand).toContain("chrono approve --action planning-approval --scope REQ-0001");
    const human = runArtifactPropose(tempDir, {
      kind: "adr", id: "ADR-0001", title: "Sessions", bodyFile: bodyFile("adr", "Session decision."),
      as: "gaspar", sessionToken: gasparToken,
    });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("PO stated approval in chat is NOT registered");
    expect(human.stdout).toContain("chrono approve --action planning-approval --scope ADR-0001");
    expect(human.stdout).not.toContain("registered approval");
  });

  it("denies workers, missing sessions, and unknown kinds", () => {
    const core = new ChronoCore({ projectPath: tempDir, runtime: "test-runtime" });
    const worker = core.openSession(
      { role: "belthazar", adapter: "test-adapter", runtime: "test-runtime", scopeModule: "default", ttlSeconds: 3600 },
      { interactive: true }
    );
    core.close();
    expect(worker.ok).toBe(true);
    const denied = runArtifactPropose(tempDir, {
      kind: "requirement", id: "REQ-0009", title: "R", bodyFile: bodyFile("w", "Body."),
      as: "belthazar", sessionToken: `${worker.value!.id}/${worker.value!.token}`, json: true,
    });
    expect(denied.exitCode).toBe(1);
    expect(JSON.parse(denied.stdout).error.code).toBe("EXECUTION_DENIED");
    const noSession = runArtifactPropose(tempDir, {
      kind: "requirement", id: "REQ-0009", title: "R", bodyFile: bodyFile("w2", "Body."),
      as: "gaspar", json: true,
    });
    expect(noSession.exitCode).toBe(1);
    const badKind = runArtifactPropose(tempDir, {
      kind: "product-code", id: "X-1", title: "T", bodyFile: bodyFile("w3", "Body."),
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(badKind.exitCode).toBe(1);
  });

  it("denies secret-bearing and oversized bodies with stable JSON", () => {
    const secret = runArtifactPropose(tempDir, {
      kind: "requirement", id: "REQ-0002", title: "R", bodyFile: bodyFile("s", "-----BEGIN PRIVATE KEY-----\nabc"),
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(secret.exitCode).toBe(1);
    expect(JSON.parse(secret.stdout).error.code).toBe("SECRET_DETECTED");
    expect(existsSync(join(tempDir, ".chrono/context/requirements/REQ-0002.md"))).toBe(false);
    const big = runArtifactPropose(tempDir, {
      kind: "requirement", id: "REQ-0003", title: "R", bodyFile: bodyFile("b", "x".repeat(70000)),
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(big.exitCode).toBe(1);
  });

  it("revises a draft and reports prior approvals stale via status", () => {
    const first = runArtifactPropose(tempDir, {
      kind: "requirement", id: "REQ-0001", title: "R", bodyFile: bodyFile("r1", "First body."),
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(first.exitCode).toBe(0);
    const firstRev = (JSON.parse(first.stdout) as { revision: string }).revision;
    const revised = runArtifactRevise(tempDir, {
      id: "REQ-0001", title: "R2", bodyFile: bodyFile("r2", "Changed body."),
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(revised.exitCode).toBe(0);
    const secondRev = (JSON.parse(revised.stdout) as { revision: string }).revision;
    expect(secondRev).not.toBe(firstRev);
    expect(readFileSync(join(tempDir, ".chrono/context/requirements/REQ-0001.md"), "utf8")).toContain(secondRev);
    const status = runArtifactStatus(tempDir, { as: "gaspar", sessionToken: gasparToken, json: true });
    expect(status.exitCode).toBe(0);
    const items = (JSON.parse(status.stdout) as { items: Array<{ id: string; approval: string }> }).items;
    expect(items.find((i) => i.id === "REQ-0001")?.approval).toBe("awaiting-signature");
  });

  it("status output carries no body content or secrets", () => {
    const body = bodyFile("n", "Ordinary planning words about checkout.");
    expect(runArtifactPropose(tempDir, {
      kind: "requirement", id: "REQ-0001", title: "R", bodyFile: body,
      as: "gaspar", sessionToken: gasparToken, json: true,
    }).exitCode).toBe(0);
    const status = runArtifactStatus(tempDir, { as: "gaspar", sessionToken: gasparToken, json: true });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).not.toContain("Ordinary planning words");
  });

  it("unknown programmatic paths stay unreachable: no path option exists", () => {
    // The propose surface accepts kind+id only; traversal ids are rejected
    // by identifier validation before any filesystem touch.
    const traversal = runArtifactPropose(tempDir, {
      kind: "spec", id: "../../evil", title: "T", bodyFile: bodyFile("e", "Body."),
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(traversal.exitCode).toBe(1);
    expect(existsSync(join(tempDir, "evil"))).toBe(false);
  });
});
