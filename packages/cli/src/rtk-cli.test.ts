/**
 * CLI routing-proof tests (FIXES-SL-10.1 C2/C3, ADR-006): `chrono rtk
 * prove` maps the raw pre-routing command through `rtk rewrite` and
 * records a non-authoritative CANDIDATE; `chrono rtk promote` (PO-only)
 * promotes it after signed adapter approval. Identity-only and
 * already-routed inputs, rewrite refusals, mapping escapes, and
 * oversized outputs never record.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  RTK_UPSTREAM,
  buildApprovalPayload,
  buildEnrollmentChallenge,
  buildEnrollmentPayload,
  buildSessionAuthorizationPayload,
  fingerprintPublicKey,
  generateApprovalKeyPair,
  managedAssetInventory,
  signApprovalPayload,
} from "@chrono/domain";
import { ChronoCore } from "@chrono/core";
import {
  RTK_PROOF_OUTPUT_CAP_BYTES,
  createProgram,
  isIdentityOnlyRtkCommand,
  runInit,
  runRtkPromote,
  runRtkProve,
  type SpawnResult,
} from "./index.js";

const RTK_VERSION = "rtk 0.44.0-test";

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

function enrollTestPo(core: ChronoCore, pair: { publicKeyPem: string; privateKeyPem: string }): void {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = new Date().toISOString();
  const fingerprint = fingerprintPublicKey(pair.publicKeyPem);
  const confirmation = buildEnrollmentChallenge("default", fingerprint, nonce);
  const signature = signApprovalPayload(
    buildEnrollmentPayload({ projectId: "default", fingerprint, timestamp, nonce, authority: "PO", rationale: "test", confirmation }),
    pair.privateKeyPem
  );
  const res = core.enrollPo({ publicKeyPem: pair.publicKeyPem, nonce, timestamp, rationale: "test", confirmation, signature });
  expect(res.ok).toBe(true);
}

function openPrivileged(core: ChronoCore, role: "gaspar" | "PO", privateKeyPem: string): { id: string; token: string } {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = new Date().toISOString();
  const signature = signApprovalPayload(
    buildSessionAuthorizationPayload({
      sessionRole: role,
      adapter: "test-adapter",
      runtime: "test-runtime",
      scopeModule: null,
      scopeWp: null,
      ttlSeconds: 3600,
      nonce,
      authority: "PO",
      rationale: "test",
      timestamp,
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

type RewriteMode = "ok" | "empty" | "escape";

function fakeSpawn(opts: { rewrite?: RewriteMode; execStatus?: number; execOutput?: string } = {}): (
  cmd: string,
  args: string[],
  timeoutMs: number,
  env: Record<string, string>
) => SpawnResult {
  const rewrite = opts.rewrite ?? "ok";
  const execStatus = opts.execStatus ?? 0;
  const execOutput = opts.execOutput ?? "routed ok\n";
  return (_cmd, args) => {
    const head = args[0] ?? "";
    if (head === "--version") {
      return { status: 0, stdout: `${RTK_VERSION}\n`, stderr: "", timedOut: false };
    }
    if (head === "gain") {
      return { status: 0, stdout: "Token Killer savings dashboard\n", stderr: "", timedOut: false };
    }
    if (head === "rewrite") {
      if (rewrite === "empty") {
        return { status: 1, stdout: "", stderr: "no route", timedOut: false };
      }
      if (rewrite === "escape") {
        return { status: 0, stdout: "other-bin ls /tmp\n", stderr: "", timedOut: false };
      }
      const mapped = args
        .slice(1)
        .map((word) => `'${word.replace(/'/g, `'"'"'`)}'`)
        .join(" ");
      return { status: 0, stdout: `rtk ${mapped}\n`, stderr: "", timedOut: false };
    }
    return { status: execStatus, stdout: execOutput, stderr: "", timedOut: false };
  };
}

describe("rtk prove/promote (effective routing, candidate authority)", () => {
  let tempDir: string;
  let rtkBin: string;
  let core: ChronoCore;
  let gaspar: { id: string; token: string };
  let po: { id: string; token: string };
  let privateKeyPem: string;
  let restoreTty: () => void;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-rtk-cli-test-"));
    restoreTty = fakeInteractiveTerminal();
    core = new ChronoCore({ projectPath: tempDir });
    expect(core.init().ok).toBe(true);
    const pair = generateApprovalKeyPair();
    privateKeyPem = pair.privateKeyPem;
    enrollTestPo(core, pair);
    gaspar = openPrivileged(core, "gaspar", privateKeyPem);
    po = openPrivileged(core, "PO", privateKeyPem);
    rtkBin = join(tempDir, "fixture-rtk.sh");
    writeFileSync(rtkBin, "#!/bin/sh\necho fixture-rtk\n", "utf8");
    chmodSync(rtkBin, 0o755);
    expect(
      core.recordRtkAttestation(
        { actor: "gaspar", session: gaspar },
        {
          binaryPath: rtkBin,
          binaryIdentity: `rtk gain ok :: ${RTK_VERSION}`,
          version: RTK_VERSION,
          provenance: RTK_UPSTREAM,
          integrationMode: null,
          routingTestPassed: false,
          routingTestLog: "attestation only",
          gained: true,
          savingsEvidence: null,
          ttlSeconds: 3600,
        }
      ).ok
    ).toBe(true);
  });

  afterEach(() => {
    restoreTty();
    core.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function proveOptions(command: string[]): Parameters<typeof runRtkProve>[1] {
    return {
      adapter: "test-adapter",
      as: "gaspar",
      session: gaspar,
      binary: "rtk",
      // Honest resolver: only the rtk name resolves, so mapping
      // escapes to unknown binaries are detectable.
      resolveBinary: (name) => (name === "rtk" ? rtkBin : null),
      ttlSeconds: 3600,
      json: true,
      command,
    };
  }

  function registerTestAdapter(): void {
    const entrypoint = join(tempDir, "test-adapter.sh");
    writeFileSync(entrypoint, "#!/bin/sh\necho ok\n", "utf8");
    chmodSync(entrypoint, 0o755);
    expect(
      core.registerAdapter(
        { id: "test-adapter", name: "Test adapter", entrypoint, conformanceProof: ["test-adapter --version"] },
        { actor: "PO", session: po }
      ).ok
    ).toBe(true);
  }

  function approveTestAdapter(): void {
    registerTestAdapter();
    const revision = core.adapterRegistrationHash("test-adapter");
    const timestamp = new Date().toISOString();
    const signature = signApprovalPayload(
      buildApprovalPayload({
        action: "adapter-registration",
        scopeArtifactId: "test-adapter",
        scopeRevision: revision,
        authority: "PO",
        rationale: "test",
        timestamp,
      }),
      privateKeyPem
    );
    const recorded = core.recordApproval({
      action: "adapter-registration",
      scopeArtifactId: "test-adapter",
      scopeRevision: revision,
      authority: "PO",
      rationale: "test",
      timestamp,
      signature,
    });
    expect(recorded.ok).toBe(true);
    expect(core.approveAdapter("test-adapter", recorded.value!.id, { actor: "PO", session: po }).ok).toBe(true);
    for (const spec of managedAssetInventory("test-adapter")) {
      const target = join(tempDir, spec.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        spec.kind === "marker" ? `fixture-managed ${spec.marker ?? spec.path}\n` : `fixture-managed ${spec.path}\n`,
        "utf8"
      );
    }
  }

  it("classifies identity-only commands without executing them", () => {
    expect(isIdentityOnlyRtkCommand("gain")).toBe(true);
    expect(isIdentityOnlyRtkCommand("--version")).toBe(true);
    expect(isIdentityOnlyRtkCommand("config")).toBe(true);
    expect(isIdentityOnlyRtkCommand("init")).toBe(true);
    expect(isIdentityOnlyRtkCommand("help")).toBe(true);
    expect(isIdentityOnlyRtkCommand("ls")).toBe(false);
    expect(isIdentityOnlyRtkCommand("")).toBe(false);
    expect(RTK_PROOF_OUTPUT_CAP_BYTES).toBe(8 * 1024 * 1024);
  });

  it("rejects already-routed rtk-prefixed input", () => {
    const out = runRtkProve(tempDir, proveOptions(["rtk", "ls", tempDir]), fakeSpawn());
    expect(out.exitCode).toBe(2);
    expect(JSON.parse(out.stdout) as object).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect((JSON.parse(out.stdout) as { error: { message: string } }).error.message).toContain("without the RTK prefix");
  });

  it("rejects identity-only input without recording", () => {
    for (const command of [["gain"], ["--version"], ["config"]]) {
      const out = runRtkProve(tempDir, proveOptions(command), fakeSpawn());
      expect(out.exitCode).toBe(1);
      expect(JSON.parse(out.stdout) as object).toMatchObject({
        ok: false,
        error: { code: "RTK_ROUTING_FAILURE" },
      });
      expect((JSON.parse(out.stdout) as { error: { message: string } }).error.message).toContain("identity-only");
    }
    expect(core.routingProofStatus("test-adapter", "test-runtime").present).toBe(false);
  });

  it("denies when RTK refuses to map the command", () => {
    const out = runRtkProve(tempDir, proveOptions(["ls", tempDir]), fakeSpawn({ rewrite: "empty" }));
    expect(out.exitCode).toBe(1);
    expect((JSON.parse(out.stdout) as { error: { code: string } }).error.code).toBe("RTK_ROUTING_FAILURE");
    expect(core.routingProofStatus("test-adapter", "test-runtime").present).toBe(false);
  });

  it("denies when the mapping escapes the genuine binary", () => {
    const out = runRtkProve(tempDir, proveOptions(["ls", tempDir]), fakeSpawn({ rewrite: "escape" }));
    expect(out.exitCode).toBe(1);
    expect((JSON.parse(out.stdout) as { error: { message: string } }).error.message).toContain("escapes the genuine RTK binary");
  });

  it("denies a mapping with no routed subcommand", () => {
    const bare: (
      _cmd: string,
      args: string[],
      timeoutMs: number,
      env: Record<string, string>
    ) => SpawnResult = (_cmd, args) => {
      if ((args[0] ?? "") === "--version") {
        return { status: 0, stdout: `${RTK_VERSION}\n`, stderr: "", timedOut: false };
      }
      if ((args[0] ?? "") === "gain") {
        return { status: 0, stdout: "Token Killer savings dashboard\n", stderr: "", timedOut: false };
      }
      if ((args[0] ?? "") === "rewrite") {
        return { status: 3, stdout: "rtk\n", stderr: "", timedOut: false };
      }
      return { status: 0, stdout: "ok\n", stderr: "", timedOut: false };
    };
    const out = runRtkProve(tempDir, proveOptions(["ls", tempDir]), bare);
    expect(out.exitCode).toBe(1);
    expect((JSON.parse(out.stdout) as { error: { message: string } }).error.message).toContain("no routed command");
    expect(core.routingProofStatus("test-adapter", "test-runtime").present).toBe(false);
  });

  it("denies when the routed command fails", () => {
    const out = runRtkProve(tempDir, proveOptions(["ls", tempDir]), fakeSpawn({ execStatus: 3 }));
    expect(out.exitCode).toBe(1);
    expect((JSON.parse(out.stdout) as { error: { message: string } }).error.message).toContain("failed with exit 3");
  });

  it("denies oversized routed output without persisting it", () => {
    const out = runRtkProve(
      tempDir,
      proveOptions(["ls", tempDir]),
      fakeSpawn({ execOutput: "x".repeat(RTK_PROOF_OUTPUT_CAP_BYTES + 1) })
    );
    expect(out.exitCode).toBe(1);
    expect((JSON.parse(out.stdout) as { error: { message: string } }).error.message).toContain("provability cap");
    expect(core.routingProofStatus("test-adapter", "test-runtime").present).toBe(false);
  });

  it("records a non-authoritative candidate on effective routing", () => {
    const out = runRtkProve(tempDir, proveOptions(["ls", tempDir]), fakeSpawn());
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { ok: boolean; id: string; authority: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.authority).toBe("candidate");
    const stored = core.routingProofScopes("test-adapter").find((proof) => proof.id === parsed.id);
    expect(stored?.authority).toBe("candidate");
    // Status reports authoritative presence only: a bare candidate
    // authorizes nothing, so status stays absent until promotion.
    expect(core.routingProofStatus("test-adapter", "test-runtime")).toMatchObject({
      present: false,
      id: null,
      expired: false,
      authority: null,
    });
  });

  it("promote is PO-only and denies before adapter approval", () => {
    const proved = runRtkProve(tempDir, proveOptions(["ls", tempDir]), fakeSpawn());
    expect(proved.exitCode).toBe(0);
    const id = (JSON.parse(proved.stdout) as { id: string }).id;
    const gasparPromote = runRtkPromote(tempDir, { proof: id, as: "gaspar", session: gaspar, json: true });
    expect(gasparPromote.exitCode).toBe(1);
    expect((JSON.parse(gasparPromote.stdout) as { error: { code: string } }).error.code).toBe("EXECUTION_DENIED");
    // Registered but pending: promotion executes an approval, never
    // substitutes for one.
    registerTestAdapter();
    const preApproval = runRtkPromote(tempDir, { proof: id, as: "PO", session: po, json: true });
    expect(preApproval.exitCode).toBe(1);
    expect((JSON.parse(preApproval.stdout) as { error: { code: string; message: string } }).error.code).toBe(
      "EXECUTION_DENIED"
    );
    expect((JSON.parse(preApproval.stdout) as { error: { code: string; message: string } }).error.message).toContain(
      "pending"
    );
  });

  it("promotes to authoritative after approval and stays idempotent", () => {
    const proved = runRtkProve(tempDir, proveOptions(["ls", tempDir]), fakeSpawn());
    expect(proved.exitCode).toBe(0);
    const id = (JSON.parse(proved.stdout) as { id: string }).id;
    approveTestAdapter();
    const first = runRtkPromote(tempDir, { proof: id, as: "PO", session: po, json: true });
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout) as object).toMatchObject({ ok: true, id, authority: "authoritative" });
    expect(core.routingProofStatus("test-adapter", "test-runtime")).toMatchObject({
      present: true,
      expired: false,
      authority: "authoritative",
    });
    const second = runRtkPromote(tempDir, { proof: id, as: "PO", session: po, json: true });
    expect(second.exitCode).toBe(0);
  });

  it("validates promote inputs before touching the Core", () => {
    const missing = runRtkPromote(tempDir, { proof: "", as: "PO", session: po, json: true });
    expect(missing.exitCode).toBe(2);
    const noSession = runRtkPromote(tempDir, { proof: "RTE-0001", as: "PO", json: true });
    expect(noSession.exitCode).toBe(2);
    expect((JSON.parse(noSession.stdout) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });
});

describe("rtk verify --json wiring (program level)", () => {
  // Regression: the `rtk verify` program action dropped --json (found by
  // the production-path trace). Exercises the real commander wiring with
  // a genuine executable fixture binary and a real session.
  let tempDir: string;
  let restoreTty: () => void;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "chrono-rtk-wiring-test-"));
    restoreTty = fakeInteractiveTerminal();
    expect(runInit(tempDir).exitCode).toBe(0);
  });

  afterEach(() => {
    restoreTty();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("emits machine-readable JSON through the program action", async () => {
    const core = new ChronoCore({ projectPath: tempDir });
    let token = "";
    let fixtureBin = "";
    try {
      const pair = generateApprovalKeyPair();
      enrollTestPo(core, pair);
      const gaspar = openPrivileged(core, "gaspar", pair.privateKeyPem);
      token = `${gaspar.id}/${gaspar.token}`;
      fixtureBin = join(tempDir, "fixture-rtk.sh");
      writeFileSync(
        fixtureBin,
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'rtk 0.44.0-test'; elif [ \"$1\" = \"gain\" ]; then echo 'dashboard'; else exit 1; fi\n",
        "utf8"
      );
      chmodSync(fixtureBin, 0o755);
    } finally {
      core.close();
    }
    const program = createProgram(tempDir);
    program.exitOverride();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (text: unknown): void => {
      lines.push(String(text));
    };
    try {
      await program.parseAsync(
        ["rtk", "verify", "--path", tempDir, "--session-token", token, "--binary", fixtureBin, "--json"],
        { from: "user" }
      );
    } finally {
      console.log = originalLog;
    }
    const parsed = JSON.parse(lines.join("\n")) as { ok: boolean; version: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.version).toBe("rtk 0.44.0-test");
  });
});
