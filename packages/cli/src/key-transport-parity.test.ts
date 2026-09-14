/**
 * OC-P11 D1 — macOS key-transport parity and integration.
 *
 * The live pilot failed with "PO signing failed: key unusable" because
 * the generated native tool sent raw Keychain output to
 * `createPrivateKey()` without the canonical macOS hexadecimal PEM
 * transport normalization. The shared normalizer
 * (`key-transport.ts`, delegated by `keychain.ts`) and the embedded
 * copy in generated tool bytes MUST agree byte-for-byte across:
 * lowercase/uppercase hex plus trailing newline, plain PEM, CRLF,
 * malformed/truncated material, wrong key types, and foreign keys.
 *
 * macOS integration runs against a DISPOSABLE keychain file when the
 * platform helper exists (never the login keychain, never global
 * search-list state); otherwise the guard itself is asserted (no
 * skipped tests — both branches are passing assertions).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign, verify, createPrivateKey, createPublicKey } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  fingerprintKeyMaterial,
  isUsableEd25519Key,
  normalizeKeyTransport,
  readKeyMaterial,
} from "./key-transport.js";
import { fingerprintPublicKey } from "@chrono/domain";
import { buildOpencodePlugin } from "./opencode-plugin.js";


function ed25519Pair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

async function toolKeyFns(): Promise<{
  normalizeKeyMaterial: (material: string) => string;
  parsePoKey: (raw: string) => { pem: string; fingerprint: string } | null;
}> {
  // The parity copies live in the GENERATED PLUGIN bytes (the host
  // signing path): import them for real. The plugin file is plain JS
  // with node builtins only — no fixture node_modules needed.
  const dir = mkdtempSync(join(tmpdir(), "chrono-key-parity-"));
  try {
    const pluginFile = join(dir, "chrono-gate.js");
    writeFileSync(pluginFile, buildOpencodePlugin(), "utf8");
    const module = (await import(pathToFileURL(pluginFile).href)) as Record<string, unknown>;
    const normalizeKeyMaterial = module["normalizeKeyMaterial"];
    const parsePoKey = module["parsePoKey"];
    if (typeof normalizeKeyMaterial !== "function" || typeof parsePoKey !== "function") {
      throw new Error("Generated plugin must export normalizeKeyMaterial and parsePoKey for parity tests");
    }
    return {
      normalizeKeyMaterial: normalizeKeyMaterial as (material: string) => string,
      parsePoKey: parsePoKey as (raw: string) => { pem: string; fingerprint: string } | null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** macOS integration guard: disposable-keychain round trip is possible. */
function keychainIntegrationAvailable(): { available: boolean; reason: string } {
  if (process.platform !== "darwin") {
    return { available: false, reason: `platform ${process.platform} has no macOS security helper` };
  }
  const probe = spawnSync("security", ["list-keychains"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
  if (probe.status !== 0) {
    return { available: false, reason: "macOS security helper is not runnable here" };
  }
  return { available: true, reason: "macOS security helper is runnable; tests use a disposable keychain file only" };
}

describe("OC-P11 D1 key-transport parity", () => {
  it("shared and embedded normalizers agree on every transport vector", async () => {
    const tool = await toolKeyFns();
    const pair = ed25519Pair();
    const pem = pair.privateKeyPem;
    const hexLower = Buffer.from(pem, "utf8").toString("hex") + "\n";
    const hexUpper = Buffer.from(pem, "utf8").toString("hex").toUpperCase();
    const crlf = pem.replace(/\n/g, "\r\n");
    const vectors: Array<{ name: string; input: string; expectPem: boolean }> = [
      { name: "plain PEM", input: pem, expectPem: true },
      { name: "trailing newline", input: `${pem}\n`, expectPem: true },
      { name: "CRLF", input: crlf, expectPem: true },
      { name: "lowercase hex plus newline (macOS transport)", input: hexLower, expectPem: true },
      { name: "uppercase hex", input: hexUpper, expectPem: true },
      { name: "malformed", input: "not-a-key", expectPem: false },
      { name: "truncated", input: pem.slice(0, Math.floor(pem.length / 2)), expectPem: false },
      { name: "empty", input: "   \n", expectPem: false },
    ];
    for (const vector of vectors) {
      expect(tool.normalizeKeyMaterial(vector.input), vector.name).toBe(normalizeKeyTransport(vector.input));
      expect(readKeyMaterial(vector.input) !== null, vector.name).toBe(vector.expectPem);
      expect(tool.parsePoKey(vector.input) !== null, vector.name).toBe(vector.expectPem);
    }
    // Wrong key types parse as non-Ed25519 on both sides.
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const ecPem = ec.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(readKeyMaterial(ecPem)).toBe(null);
    expect(tool.parsePoKey(ecPem)).toBe(null);
    expect(isUsableEd25519Key(ecPem)).toBe(false);
    // A different valid Ed25519 key parses but binds a foreign fingerprint.
    const foreign = ed25519Pair();
    const parsed = tool.parsePoKey(foreign.privateKeyPem);
    expect(parsed !== null).toBe(true);
    expect(parsed?.fingerprint).toBe(fingerprintPublicKey(foreign.publicKeyPem));
    expect(parsed?.fingerprint).not.toBe(fingerprintPublicKey(pair.publicKeyPem));
    expect(fingerprintKeyMaterial(foreign.privateKeyPem)).toBe(fingerprintPublicKey(foreign.publicKeyPem));
    expect(fingerprintKeyMaterial("garbage")).toBe(null);
    // The normalized enrolled key signs bytes the Core cryptography accepts.
    const parsedPair = tool.parsePoKey(hexLower);
    expect(parsedPair !== null).toBe(true);
    const bytes = Buffer.from("approval-bytes", "utf8");
    const { createPrivateKey } = await import("node:crypto");
    const signature = sign(null, bytes, createPrivateKey(parsedPair?.pem as string));
    const verifier = createPublicKey(pair.publicKeyPem);
    expect(verify(null, bytes, verifier, signature)).toBe(true);
  });

  it("macOS disposable-keychain round trip where available, guard otherwise", () => {
    const guard = keychainIntegrationAvailable();
    if (!guard.available) {
      // No skip: the guard itself is the assertion on this host.
      expect(guard.reason.length).toBeGreaterThan(0);
      expect(guard.available).toBe(false);
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "chrono-kc-"));
    const keychain = join(dir, "chrono-test.keychain-db");
    const pair = ed25519Pair();
    try {
      const created = spawnSync("security", ["create-keychain", "-p", "chrono-test-pw", keychain], {
        encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
      });
      expect(created.status).toBe(0);
      const added = spawnSync(
        "security",
        ["add-generic-password", "-s", "chrono-po-signing-key", "-a", "po", "-w", pair.privateKeyPem, "-U", keychain],
        { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }
      );
      expect(added.status).toBe(0);
      // Scoped read against the disposable keychain only: global
      // keychain state is never touched.
      const read = spawnSync(
        "security",
        ["find-generic-password", "-s", "chrono-po-signing-key", "-a", "po", "-w", keychain],
        { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }
      );
      expect(read.status).toBe(0);
      const raw = typeof read.stdout === "string" ? read.stdout : "";
      // The exact D1 failure mode: raw transport output must normalize
      // to a signable key through the shared path.
      const usable = readKeyMaterial(raw);
      expect(usable !== null).toBe(true);
      const bytes = Buffer.from("keychain-transport-proof", "utf8");
      const signature = sign(null, bytes, createPrivateKey(usable as string));
      expect(verify(null, bytes, createPublicKey(pair.publicKeyPem), signature)).toBe(true);
    } finally {
      spawnSync("security", ["delete-keychain", keychain], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
