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
import { createHash } from "node:crypto";

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
          "OS keychain read failed; refusing to continue without the PO key"
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
          "OS keychain read failed; refusing to continue without the PO key"
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
          `OS keychain write failed: ${shortMessage(e)}. Approve the keychain prompt or check permissions.`
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
        throw new KeychainError(`OS keychain write failed: ${shortMessage(e)}`);
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
          `OS keychain delete failed: ${shortMessage(e)}. Approve the keychain prompt or check permissions.`
        );
      }
    }
    if (process.platform === "linux") {
      try {
        execFileSync(
          "secret-tool",
          ["clear", "service", PO_KEY_SERVICE, "account", account],
          { stdio: ["ignore", "pipe", "pipe"] }
        );
        return;
      } catch (e) {
        if (isMissingBinary(e)) {
          throw new KeychainError(
            "secret-tool is not installed; install libsecret (e.g. apt install libsecret-tools) so the PO key stays in the OS keychain"
          );
        }
        throw new KeychainError(`OS keychain delete failed: ${shortMessage(e)}`);
      }
    }
    throw new KeychainError(
      `PO key storage requires macOS Keychain or Linux Secret Service (platform: ${process.platform})`
    );
  }
}

function isNotFound(e: unknown): boolean {
  const message = shortMessage(e).toLowerCase();
  return (
    message.includes("could not be found") ||
    message.includes("no such") ||
    message.includes("not found") ||
    message.includes("no matching")
  );
}

function isMissingBinary(e: unknown): boolean {
  const code = (e as { code?: string }).code;
  return code === "ENOENT";
}

function shortMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message.split("\n")[0] ?? "unknown error";
  }
  return String(e).split("\n")[0] ?? "unknown error";
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
