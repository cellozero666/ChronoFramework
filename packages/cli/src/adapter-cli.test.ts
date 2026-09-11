/**
 * Adapter CLI tests — strict RUNTIME §13 file intake plus register /
 * list / activate / revoke through the Core. The YAML subset parser owns
 * no policy: every field is re-validated by the Core.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  buildApprovalPayload,
  buildSessionAuthorizationPayload,
  generateApprovalKeyPair,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore } from "@chrono/core";
import {
  parseAdapterFile,
  runAdapterActivate,
  runAdapterList,
  runAdapterRegister,
  runAdapterRevoke,
} from "./index.js";

const FIXED_TIME = "2026-06-01T00:00:00.000Z";

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

function bootstrapPo(core: ChronoCore, privateKeyPem: string): { actor: string; session: TestSession } {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = "2026-09-11T00:00:00.000Z";
  const rationale = "test privileged-session bootstrap";
  const signature = signApprovalPayload(
    buildSessionAuthorizationPayload({
      sessionRole: "PO",
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
    privateKeyPem
  );
  const res = core.openSession(
    { role: "PO", adapter: "test-adapter", runtime: "test-runtime", ttlSeconds: 3600 },
    { poAuthorization: { nonce, authority: "PO", rationale, timestamp, signature } }
  );
  expect(res.ok).toBe(true);
  return { actor: "PO", session: { id: res.value!.id, token: res.value!.token } };
}

describe("Adapter file intake", () => {
  it("parses a full §13 file", () => {
    const parsed = parseAdapterFile(
      [
        "# comment",
        "id: fixture",
        "name: 'Fixture runtime'",
        'entrypoint: "/usr/local/bin/fixture"',
        "gate_hook: pre-tool",
        "dispatch_proof: fixture --prove",
        "rtk_routing: rtk exec",
        "skill_activation: fixture --skill",
        "conformance_proof:",
        "  - fixture --version",
        "  - fixture --prove",
        "",
      ].join("\n")
    );
    expect(parsed).toEqual({
      id: "fixture",
      name: "Fixture runtime",
      entrypoint: "/usr/local/bin/fixture",
      gateHook: "pre-tool",
      dispatchProof: "fixture --prove",
      rtkRouting: "rtk exec",
      skillActivation: "fixture --skill",
      conformanceProof: ["fixture --version", "fixture --prove"],
    });
  });

  it("rejects unknown keys, duplicates, nesting, and malformed lines", () => {
    expect(() => parseAdapterFile("id: x\nname: X\nentrypoint: /bin/x\nprovider: evil\n")).toThrow(/unknown key/);
    expect(() => parseAdapterFile("id: x\nid: y\nname: X\nentrypoint: /bin/x\n")).toThrow(/duplicate key/);
    expect(() => parseAdapterFile("id: x\n  nested: evil\nname: X\nentrypoint: /bin/x\n")).toThrow(/indentation/);
    expect(() => parseAdapterFile("not a mapping\n")).toThrow(/expected 'key: value'/);
    expect(() => parseAdapterFile("id: x\nname: X\n")).toThrow(/id, name, and entrypoint/);
    expect(() => parseAdapterFile("id: x\nname: 'X\nentrypoint: /bin/x\n")).toThrow(/unbalanced quotes/);
    expect(() => parseAdapterFile("id: x\nname: X\nentrypoint: /bin/x\nconformance_proof: inline\n")).toThrow(/'- item' lines/);
    expect(() => parseAdapterFile("id: x\nname: X\nentrypoint: /bin/x\nconformance_proof:\n  - \n")).toThrow(/empty list item/);
  });
});

describe("CLI adapter registry", () => {
  let tempDir: string;
  let restoreTty: () => void;
  let po: { actor: string; session: TestSession };
  let privateKeyPem: string;
  let entrypoint: string;
  let adapterFile: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-adapter-cli-test-"));
    const core = new ChronoCore({ projectPath: tempDir });
    try {
      expect(core.init().ok).toBe(true);
      const pair = generateApprovalKeyPair();
      restoreTty = fakeInteractiveTerminal();
      expect(core.registerPoPublicKey(pair.publicKeyPem).ok).toBe(true);
      privateKeyPem = pair.privateKeyPem;
      po = bootstrapPo(core, privateKeyPem);
    } finally {
      core.close();
    }
    entrypoint = join(tempDir, "fixture-runtime.sh");
    writeFileSync(entrypoint, "#!/bin/sh\necho fixture-ok\n");
    chmodSync(entrypoint, 0o755);
    adapterFile = join(tempDir, "adapter.yaml");
    writeFileSync(
      adapterFile,
      ["id: fixture", "name: Fixture runtime", `entrypoint: ${entrypoint}`, "conformance_proof:", "  - fixture --version", ""].join("\n"),
      "utf8"
    );
  });

  afterEach(() => {
    restoreTty();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function approveAdapter(adapterId: string): string {
    const setup = new ChronoCore({ projectPath: tempDir });
    try {
      const revision = setup.adapterRegistrationHash(adapterId);
      const signature = signApprovalPayload(
        buildApprovalPayload({
          action: "adapter-registration",
          scopeArtifactId: adapterId,
          scopeRevision: revision,
          authority: "PO",
          rationale: "trust",
          timestamp: FIXED_TIME,
        }),
        privateKeyPem
      );
      const recorded = setup.recordApproval({
        action: "adapter-registration",
        scopeArtifactId: adapterId,
        scopeRevision: revision,
        authority: "PO",
        rationale: "trust",
        timestamp: FIXED_TIME,
        signature,
      });
      expect(recorded.ok).toBe(true);
      return recorded.value!.id;
    } finally {
      setup.close();
    }
  }

  it("registers pending from file, activates with approval, lists, revokes", () => {
    const registered = runAdapterRegister(
      tempDir,
      { file: adapterFile, as: "PO", session: po.session, json: true }
    );
    expect(registered.exitCode).toBe(0);
    const body = JSON.parse(registered.stdout) as { id: string; status: string; registrationHash: string };
    expect(body).toMatchObject({ id: "fixture", status: "pending" });
    expect(body.registrationHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const listed = runAdapterList(tempDir, { json: true });
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("pending");

    const approvalId = approveAdapter("fixture");
    const activated = runAdapterActivate(
      tempDir,
      { id: "fixture", approval: approvalId, as: "PO", session: po.session, json: true }
    );
    expect(activated.exitCode).toBe(0);
    expect(activated.stdout).toContain("active");

    const revoked = runAdapterRevoke(tempDir, { id: "fixture", as: "PO", session: po.session, json: true });
    expect(revoked.exitCode).toBe(0);
    expect(revoked.stdout).toContain("revoked");
  });

  it("refuses malformed and missing files without persisting", () => {
    writeFileSync(adapterFile, "id: fixture\nprovider: evil\n", "utf8");
    const bad = runAdapterRegister(tempDir, { file: adapterFile, as: "PO", session: po.session, json: true });
    expect(bad.exitCode).toBe(1);
    const missing = runAdapterRegister(tempDir, { file: join(tempDir, "nope.yaml"), as: "PO", session: po.session, json: true });
    expect(missing.exitCode).toBe(1);
    expect(runAdapterList(tempDir, { json: true }).stdout).toContain("[]");
  });
});
