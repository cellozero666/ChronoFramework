/**
 * macOS Keychain host-integration gate (CORE_FIX CF-10): exercises the
 * real `security` executable against the developer's login keychain.
 * NEVER part of the default battery — run explicitly with
 * `npm run test:host` and report separately. Uses one disposable
 * service/account pair, created here and deleted in cleanup.
 */
import { describe, it, expect, afterEach } from "vitest";
import { generateApprovalKeyPair } from "@chrono/domain";
import { OsKeychainStore, verifyKeyCustody } from "./keychain.js";

describe("macOS keychain round-trip (real `security` executable)", () => {
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
