/**
 * Key-custody verification tests [OPENCODE-PILOT-GATE.md keychain
 * finding]: the OS keychain round-trip is not byte-identical (macOS
 * `security -w` output drops/adds the trailing newline), so custody
 * is proven cryptographically — the retrieved material must parse as
 * the private key pairing with the expected public key — never by raw
 * PEM string equality.
 */
import { describe, it, expect, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { generateApprovalKeyPair, fingerprintPublicKey } from "@chrono/domain";
import { OsKeychainStore, sanitizeKeychainDetail, verifyKeyCustody } from "./keychain.js";
describe("verifyKeyCustody (canonical rule)", () => {
  const pair = generateApprovalKeyPair();
  const other = generateApprovalKeyPair();

  it("accepts the exact PEM", () => {
    expect(verifyKeyCustody(pair.privateKeyPem, pair.publicKeyPem)).toBe(true);
  });

  it("accepts a trailing newline removed (macOS readKey trim)", () => {
    expect(verifyKeyCustody(pair.privateKeyPem.replace(/\n$/, ""), pair.publicKeyPem)).toBe(true);
  });

  it("accepts CRLF versus LF representation", () => {
    const crlf = pair.privateKeyPem.replace(/\n/g, "\r\n");
    expect(crlf).not.toBe(pair.privateKeyPem);
    expect(verifyKeyCustody(crlf, pair.publicKeyPem)).toBe(true);
  });

  it("accepts surrounding whitespace only when cryptographically equivalent", () => {
    expect(verifyKeyCustody(`  \t\n${pair.privateKeyPem}\n  `, pair.publicKeyPem)).toBe(true);
    // Whitespace around a DIFFERENT key is still rejected.
    expect(verifyKeyCustody(`\n${other.privateKeyPem}\n`, pair.publicKeyPem)).toBe(false);
  });

  it("rejects malformed PEM", () => {
    expect(verifyKeyCustody("not a key", pair.publicKeyPem)).toBe(false);
    expect(verifyKeyCustody("-----BEGIN PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----\n", pair.publicKeyPem)).toBe(false);
  });

  it("rejects a different valid private key", () => {
    expect(verifyKeyCustody(other.privateKeyPem, pair.publicKeyPem)).toBe(false);
  });

  it("rejects a truncated key", () => {
    const truncated = pair.privateKeyPem.slice(0, Math.floor(pair.privateKeyPem.length / 2));
    expect(verifyKeyCustody(truncated, pair.publicKeyPem)).toBe(false);
    const chomped = pair.privateKeyPem.slice(0, -10);
    expect(verifyKeyCustody(chomped, pair.publicKeyPem)).toBe(false);
  });

  it("rejects null, empty, and whitespace-only material", () => {
    expect(verifyKeyCustody(null, pair.publicKeyPem)).toBe(false);
    expect(verifyKeyCustody("", pair.publicKeyPem)).toBe(false);
    expect(verifyKeyCustody("  \n\t\r\n ", pair.publicKeyPem)).toBe(false);
  });

  it("rejects non-Ed25519 keys and garbage expected identities", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const ecPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(verifyKeyCustody(ecPem, pair.publicKeyPem)).toBe(false);
    expect(verifyKeyCustody(pair.privateKeyPem, "not a public key")).toBe(false);
  });

  it("rejects interior corruption", () => {
    const lines = pair.privateKeyPem.split("\n");
    const bodyLine = lines.findIndex((line) => line.length > 20);
    const corrupted = [...lines];
    const original = corrupted[bodyLine] as string;
    const flipped = original.slice(0, 10) + (original[10] === "A" ? "B" : "A") + original.slice(11);
    corrupted[bodyLine] = flipped;
    expect(verifyKeyCustody(corrupted.join("\n"), pair.publicKeyPem)).toBe(false);
  });

  it("accepts the macOS hex transport encoding of the same key", () => {
    // Observed macOS behavior: `security -w` returns multiline
    // passwords as lowercase hex plus a trailing newline.
    const hex = Buffer.from(pair.privateKeyPem, "utf8").toString("hex");
    expect(verifyKeyCustody(`${hex}\n`, pair.publicKeyPem)).toBe(true);
    expect(verifyKeyCustody(hex.toUpperCase(), pair.publicKeyPem)).toBe(true);
  });

  it("rejects hex of a different key and malformed hex", () => {
    const otherHex = Buffer.from(other.privateKeyPem, "utf8").toString("hex");
    expect(verifyKeyCustody(otherHex, pair.publicKeyPem)).toBe(false);
    expect(verifyKeyCustody("abc", pair.publicKeyPem)).toBe(false);
    expect(verifyKeyCustody("zz", pair.publicKeyPem)).toBe(false);
    // A truncated key stays rejected even in hex form.
    const shortHex = Buffer.from(pair.privateKeyPem.slice(0, 40), "utf8").toString("hex");
    expect(verifyKeyCustody(shortHex, pair.publicKeyPem)).toBe(false);
  });

  it("proves custody through the domain fingerprint, not string equality", () => {
    // The trimmed form differs as a string but identifies the same key.
    const trimmed = pair.privateKeyPem.replace(/\n$/, "");
    expect(trimmed).not.toBe(pair.privateKeyPem);
    expect(verifyKeyCustody(trimmed, pair.publicKeyPem)).toBe(true);
    expect(fingerprintPublicKey(pair.publicKeyPem)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("keychain error sanitization (no secret material in messages)", () => {
  const pair = generateApprovalKeyPair();

  it("redacts PEM blocks from tool output", () => {
    const leaked = `Command failed: security add-generic-password -w ${pair.privateKeyPem}`;
    const clean = sanitizeKeychainDetail(leaked);
    expect(clean).not.toContain("PRIVATE KEY");
    expect(clean).not.toContain(pair.privateKeyPem);
    expect(clean).toContain("[redacted-key-material]");
  });

  it("passes ordinary diagnostics through with a length cap", () => {
    expect(sanitizeKeychainDetail("SecKeychainSearchCopyNext: nope")).toContain("SecKeychainSearchCopyNext");
    expect(sanitizeKeychainDetail("")).toBe("no tool output");
    expect(sanitizeKeychainDetail("   \n  ")).toBe("no tool output");
    expect(sanitizeKeychainDetail("x".repeat(500)).length).toBe(300);
  });
});

describe("macOS keychain round-trip (real `security` executable)", () => {
  // Disposable credential: a unique service/account pair created here
  // and deleted in cleanup. Nothing else is touched.
  const service = `chrono-test-${process.pid}`;
  const account = "custody-probe";
  const store = new OsKeychainStore();

  afterEach(() => {
    try {
      store.deleteKey(account, service);
    } catch {
      // Cleanup is best-effort; the assertion below proves deletion.
    }
  });

  it.runIf(process.platform === "darwin")("writes and reads back provable custody", () => {
    const pair = generateApprovalKeyPair();
    store.writeKey(account, pair.privateKeyPem, service);
    const retrieved = store.readKey(account, service);
    expect(retrieved).not.toBeNull();
    // The round-trip may differ textually (trailing newline); custody
    // must still prove cryptographically.
    expect(verifyKeyCustody(retrieved, pair.publicKeyPem)).toBe(true);
    store.deleteKey(account, service);
    expect(store.readKey(account, service)).toBeNull();
  });
});
