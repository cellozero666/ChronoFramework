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
import Database from "better-sqlite3";
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
import { runArtifactPropose, runArtifactRevise, runArtifactStatus, runArtifactSupersede } from "./artifact-cli.js";

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

  it("supersedes drafts and heals missing files through the CLI (D3)", () => {
    const first = runArtifactPropose(tempDir, {
      kind: "spec", id: "SP-0003", title: "Old", bodyFile: bodyFile("old", "Old contract."),
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(first.exitCode).toBe(0);
    const second = runArtifactPropose(tempDir, {
      kind: "spec", id: "SP-0004", title: "New", bodyFile: bodyFile("new", "New contract."),
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(second.exitCode).toBe(0);
    const done = runArtifactSupersede(tempDir, { id: "SP-0003", supersededBy: "SP-0004", as: "gaspar", sessionToken: gasparToken, json: true });
    expect(done.exitCode).toBe(0);
    expect(JSON.parse(done.stdout)).toMatchObject({ ok: true, id: "SP-0003", supersededBy: "SP-0004" });
    const status = runArtifactStatus(tempDir, { as: "gaspar", sessionToken: gasparToken, json: true });
    const items = (JSON.parse(status.stdout) as { items: Array<{ id: string; lifecycle: string; supersededBy: string | null }> }).items;
    expect(items.find((i) => i.id === "SP-0003")).toMatchObject({ lifecycle: "superseded", supersededBy: "SP-0004" });
    // Missing file heals with identical content, same revision.
    rmSync(join(tempDir, ".chrono/specs/SP-0004.md"));
    const healed = runArtifactRevise(tempDir, {
      id: "SP-0004", title: "New", bodyFile: bodyFile("new2", "New contract."),
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(healed.exitCode).toBe(0);
    expect(JSON.parse(healed.stdout)).toMatchObject({ ok: true, healed: true });
  });

  it("recovers a registry row lost with its file (SP-0003/SP-0004 repair)", () => {
    const first = runArtifactPropose(tempDir, {
      kind: "spec", id: "SP-0003", title: "Old", bodyFile: bodyFile("old", "Old contract."),
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(first.exitCode).toBe(0);
    // Pilot inconsistency: the index and revision key survive while the
    // canonical file AND the structured registry row are gone.
    rmSync(join(tempDir, ".chrono/specs/SP-0003.md"));
    const raw = new Database(join(tempDir, ".chrono", "chrono.db"));
    try {
      raw.prepare("DELETE FROM artifact WHERE id = 'SP-0003'").run();
    } finally {
      raw.close();
    }
    const statusBefore = runArtifactStatus(tempDir, { as: "gaspar", sessionToken: gasparToken, json: true });
    const before = (JSON.parse(statusBefore.stdout) as { items: Array<{ id: string; filePresent: boolean; lifecycle: string }> }).items;
    expect(before.find((i) => i.id === "SP-0003")).toMatchObject({ filePresent: false, lifecycle: "active" });
    // Non-identical content denies toward formal supersession (CF-8):
    // rebuilt defaults cannot prove the registered semantics, so no
    // invented row inherits the identity. The file stays absent until
    // a replacement is proposed and supersedes the lost draft.
    const recovered = runArtifactRevise(tempDir, {
      id: "SP-0003", title: "Old rebuilt", bodyFile: bodyFile("rebuilt", "Old contract, rebuilt after loss."),
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(recovered.exitCode).toBe(1);
    const rec = JSON.parse(recovered.stdout) as { error: { code: string; message: string; suggestedAction: string } };
    expect(rec.error.code).toBe("ENTITY_NOT_FOUND");
    expect(rec.error.message).toMatch(/does not reproduce the registered semantics/);
    expect(rec.error.suggestedAction).toMatch(/supersede/);
    expect(existsSync(join(tempDir, ".chrono/specs/SP-0003.md"))).toBe(false);
    // Formal supersession recovers the workflow: propose the
    // replacement, supersede the lost draft, keep harness history.
    const replacement = runArtifactPropose(tempDir, {
      kind: "spec", id: "SP-0005", title: "Old rebuilt", bodyFile: bodyFile("rebuilt", "Old contract, rebuilt after loss."),
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(replacement.exitCode).toBe(0);
    const superseded = runArtifactSupersede(tempDir, { id: "SP-0003", supersededBy: "SP-0005", as: "gaspar", sessionToken: gasparToken, json: true });
    expect(superseded.exitCode).toBe(0);
    expect(JSON.parse(superseded.stdout)).toMatchObject({ ok: true, id: "SP-0003", supersededBy: "SP-0005" });
  });

  it("recovers with the recorded revision intact when content is identical", () => {
    const first = runArtifactPropose(tempDir, {
      kind: "spec", id: "SP-0004", title: "Same", bodyFile: bodyFile("same", "Same contract."),
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(first.exitCode).toBe(0);
    const firstRev = (JSON.parse(first.stdout) as { revision: string }).revision;
    rmSync(join(tempDir, ".chrono/specs/SP-0004.md"));
    const raw = new Database(join(tempDir, ".chrono", "chrono.db"));
    try {
      raw.prepare("DELETE FROM artifact WHERE id = 'SP-0004'").run();
    } finally {
      raw.close();
    }
    // Identical title+body reproduces the recorded revision: the row
    // returns, the file returns, approvals stand.
    const recovered = runArtifactRevise(tempDir, {
      id: "SP-0004", title: "Same", bodyFile: bodyFile("same2", "Same contract."),
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(recovered.exitCode).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({ revision: firstRev, healed: false, recovered: true });
    expect(existsSync(join(tempDir, ".chrono/specs/SP-0004.md"))).toBe(true);
  });

  it("module/work-package rows that cannot be rebuilt fail toward supersede, not a bare NOT_FOUND", () => {
    const spec = runArtifactPropose(tempDir, {
      kind: "spec", id: "SP-0009", title: "S", bodyFile: bodyFile("sp9", "Spec contract."),
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(spec.exitCode).toBe(0);
    const first = runArtifactPropose(tempDir, {
      kind: "module", id: "MOD-0009", title: "M", bodyFile: bodyFile("mod", "Module plan."),
      references: ["SP-0009"],
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(first.exitCode).toBe(0);
    const raw = new Database(join(tempDir, ".chrono", "chrono.db"));
    try {
      raw.prepare("DELETE FROM artifact WHERE id = 'MOD-0009'").run();
    } finally {
      raw.close();
    }
    const denied = runArtifactRevise(tempDir, {
      id: "MOD-0009", title: "M2", bodyFile: bodyFile("mod2", "Changed."),
      as: "gaspar", sessionToken: gasparToken, json: true,
    });
    expect(denied.exitCode).toBe(1);
    expect(JSON.parse(denied.stdout).error.message).toMatch(/supersede/);
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
