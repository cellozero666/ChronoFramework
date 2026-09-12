/**
 * PO signing-key custody: OS keychain access for human-only commands.
 * [ADR-003, FW §13, P2.10]
 *
 * The private key MUST live outside the project and agent-accessible
 * context. Production uses the OS keychain; tests inject a fake store.
 * No key material is ever read from the project tree, environment
 * variables, or prompt context.
 */

import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { fingerprintPublicKey } from "@chrono/domain";

export const PO_KEY_SERVICE = "chrono-po-signing-key";
export const PO_KEY_ACCOUNT = "po";

/** Gaspar-entry broker custody: OS keychain service for broker secrets. */
export const BROKER_KEY_SERVICE = "chrono-gaspar-entry";

/** PO signing-key staging account for crash-safe rotation. */
export const PO_KEY_STAGING_ACCOUNT = "po.staging";

export interface KeyStore {
  /** Read the stored secret, or null when absent. Service defaults to the PO key service. */
  readKey(account: string, service?: string): string | null;
  /** Create or replace the stored secret. Service defaults to the PO key service. */
  writeKey(account: string, secret: string, service?: string): void;
  /** Remove a key when present; absent keys are not an error. */
  deleteKey(account: string, service?: string): void;
}

export class KeychainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeychainError";
  }
}

/**
 * Canonical key-custody verification: proves retrieved keychain
 * material is the private key pairing with the expected public key.
 *
 * Transport-equivalent encodings are normalized ONLY at the
 * boundaries — CRLF becomes LF everywhere (CR is meaningless in PEM
 * armor and base64), and ASCII whitespace is trimmed at the very
 * start/end. Interior bytes are never touched, and normalization
 * alone never passes: acceptance additionally requires parsing the
 * material as an Ed25519 private key, deriving its public key, and
 * matching its fingerprint against the expected public key.
 *
 * macOS `security find-generic-password -w` hex-encodes passwords
 * that contain newlines (observed: multiline secrets come back as
 * lowercase hex plus a trailing newline, while single-line secrets
 * come back plain). The hex form is therefore tried as a second
 * transport encoding of the same material — still gated by the same
 * fingerprint proof, never accepted on shape alone. This decoding
 * lives here (PO-key custody only), never in generic `readKey`,
 * because broker secrets are legitimately hex and must pass through
 * byte-identical.
 *
 * Fail-closed results: null/empty/unreadable material, malformed or
 * truncated PEM, a different valid private key, and non-Ed25519 keys
 * all return false. Nothing secret is printed, logged, or persisted
 * here; callers report stable codes only.
 */
export function verifyKeyCustody(retrieved: string | null, expectedPublicKeyPem: string): boolean {
  if (retrieved === null || retrieved.length === 0) {
    return false;
  }
  const candidates = [retrieved];
  const trimmed = retrieved.trim();
  if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0 && trimmed.length >= 2) {
    try {
      candidates.push(Buffer.from(trimmed, "hex").toString("utf8"));
    } catch {
      // Not decodable hex: the raw form below still gets its chance.
    }
  }
  for (const candidate of candidates) {
    const normalized = candidate.replace(/\r\n/g, "\n").replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
    if (normalized.length === 0) {
      continue;
    }
    try {
      const privateKey = createPrivateKey(normalized);
      if (privateKey.asymmetricKeyType !== "ed25519") {
        continue;
      }
      const derivedPublicPem = createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString();
      if (fingerprintPublicKey(derivedPublicPem) === fingerprintPublicKey(expectedPublicKeyPem)) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * OS keychain backing store.
 * - macOS: `security` CLI (Keychain).
 * - Linux: `secret-tool` (libsecret / Secret Service).
 * - Other platforms: fail closed with actionable instructions.
 */
export class OsKeychainStore implements KeyStore {
  readKey(account: string, service: string = PO_KEY_SERVICE): string | null {
    if (process.platform === "darwin") {
      try {
        const out = execFileSync(
          "security",
          ["find-generic-password", "-s", service, "-a", account, "-w"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        );
        const pem = out.trim();
        return pem.length === 0 ? null : pem;
      } catch (e) {
        if (isNotFound(e)) {
          return null;
        }
        throw new KeychainError(
          `OS keychain read failed (${execDetail(e)}); refusing to continue without the PO key`
        );
      }
    }
    if (process.platform === "linux") {
      try {
        const out = execFileSync(
          "secret-tool",
          ["lookup", "service", service, "account", account],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        );
        const pem = out.trim();
        return pem.length === 0 ? null : pem;
      } catch (e) {
        if (isNotFound(e) || isMissingBinary(e)) {
          return null;
        }
        throw new KeychainError(
          `OS keychain read failed (${execDetail(e)}); refusing to continue without the PO key`
        );
      }
    }
    throw new KeychainError(
      `PO key storage requires macOS Keychain or Linux Secret Service (platform: ${process.platform}); refusing to fall back to files or environment variables`
    );
  }

  writeKey(account: string, secret: string, service: string = PO_KEY_SERVICE): void {
    if (process.platform === "darwin") {
      try {
        execFileSync(
          "security",
          ["add-generic-password", "-s", service, "-a", account, "-w", secret, "-U"],
          { stdio: ["ignore", "pipe", "pipe"] }
        );
        return;
      } catch (e) {
        throw new KeychainError(
          `OS keychain write failed (${execDetail(e)}). Approve the keychain prompt or check permissions.`
        );
      }
    }
    if (process.platform === "linux") {
      try {
        execFileSync(
          "secret-tool",
          ["store", "--label=CHRONO secret", "service", service, "account", account],
          { input: secret, stdio: ["pipe", "pipe", "pipe"] }
        );
        return;
      } catch (e) {
        if (isMissingBinary(e)) {
          throw new KeychainError(
            "secret-tool is not installed; install libsecret (e.g. apt install libsecret-tools) so the PO key stays in the OS keychain"
          );
        }
        throw new KeychainError(`OS keychain write failed (${execDetail(e)})`);
      }
    }
    throw new KeychainError(
      `PO key storage requires macOS Keychain or Linux Secret Service (platform: ${process.platform})`
    );
  }

  deleteKey(account: string, service: string = PO_KEY_SERVICE): void {
    if (process.platform === "darwin") {
      try {
        execFileSync(
          "security",
          ["delete-generic-password", "-s", service, "-a", account],
          { stdio: ["ignore", "pipe", "pipe"] }
        );
        return;
      } catch (e) {
        if (isNotFound(e)) {
          return;
        }
        throw new KeychainError(
          `OS keychain delete failed (${execDetail(e)}). Approve the keychain prompt or check permissions.`
        );
      }
    }
    if (process.platform === "linux") {
      try {
        execFileSync(
          "secret-tool",
          ["clear", "service", service, "account", account],
          { stdio: ["ignore", "pipe", "pipe"] }
        );
        return;
      } catch (e) {
        if (isMissingBinary(e)) {
          throw new KeychainError(
            "secret-tool is not installed; install libsecret (e.g. apt install libsecret-tools) so the PO key stays in the OS keychain"
          );
        }
        throw new KeychainError(`OS keychain delete failed (${execDetail(e)})`);
      }
    }
    throw new KeychainError(
      `PO key storage requires macOS Keychain or Linux Secret Service (platform: ${process.platform})`
    );
  }
}

function isNotFound(e: unknown): boolean {
  const text = `${execStderr(e)} ${(e as { message?: unknown }).message ?? ""}`.toLowerCase();
  return (
    text.includes("could not be found") ||
    text.includes("no such") ||
    text.includes("not found") ||
    text.includes("no matching")
  );
}

function isMissingBinary(e: unknown): boolean {
  const code = (e as { code?: string }).code;
  return code === "ENOENT";
}

/**
 * Secret-safe exec failure detail for user-facing messages. Uses the
 * child STDERR only — never the command line, which may carry secrets
 * as arguments (e.g. `security ... -w <private key>`). PEM-shaped
 * content is scrubbed defensively and the text is length-capped.
 */
function execStderr(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const raw = (e as { stderr?: unknown }).stderr;
    const text =
      typeof raw === "string" ? raw : raw instanceof Uint8Array ? Buffer.from(raw).toString("utf8") : "";
    return text.trim();
  }
  return "";
}

/**
 * Scrub key material from tool output before it reaches user-facing
 * messages. Exported for direct unit tests; production callers go
 * through `execDetail`.
 */
export function sanitizeKeychainDetail(text: string): string {
  const scrubbed = text
    .replace(/-----BEGIN [^-]*-----[\s\S]*?-----END [^-]*-----/g, "[redacted-key-material]")
    .split("\n")[0]
    ?.trim();
  return scrubbed !== undefined && scrubbed.length > 0 ? scrubbed.slice(0, 300) : "no tool output";
}

function execDetail(e: unknown): string {
  return sanitizeKeychainDetail(execStderr(e));
}

/** Interactive-terminal probe: stdin AND stdout must be TTYs [ADR-003]. */
export function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * Broker keychain account for a project root [SLICE-10 §5.2]. The account
 * NAME is non-secret (persisted in `.chrono/broker-account` for hook
 * scripts); only the secret it addresses stays in the keychain.
 */
export function brokerAccountFor(projectRoot: string): string {
  return `gaspar-entry-${createHash("sha256").update(projectRoot, "utf8").digest("hex").slice(0, 16)}`;
}

/** In-memory KeyStore for tests only. Never used by production paths. */
export class MemoryKeyStore implements KeyStore {
  private readonly keys = new Map<string, string>();

  readKey(account: string): string | null {
    return this.keys.get(account) ?? null;
  }

  writeKey(account: string, privateKeyPem: string): void {
    this.keys.set(account, privateKeyPem);
  }

  deleteKey(account: string): void {
    this.keys.delete(account);
  }
}
