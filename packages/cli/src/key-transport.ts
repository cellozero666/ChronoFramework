/**
 * Shared PO-key transport normalization and validation (OC-P11 D1).
 *
 * Single source for every PO signing path: the CLI keychain flows
 * (`keychain.ts` delegates here) and the generated native tool module
 * (which embeds a byte-parity copy because it runs standalone in the
 * OpenCode host — parity is locked by `key-transport-parity.test.ts`
 * across lowercase/uppercase hex, trailing newlines, plain PEM, CRLF,
 * malformed/truncated material, wrong key types, and foreign keys).
 *
 * Pure and secret-safe: functions return canonical material or null
 * and never log, print, or persist key text. Callers report stable
 * codes only.
 */

import { createPrivateKey, createPublicKey } from "node:crypto";
import { fingerprintPublicKey } from "@chrono/domain";

/**
 * Normalize keychain-read material to canonical PEM form. CRLF becomes
 * LF; ASCII whitespace is trimmed at the boundaries; lowercase or
 * UPPERCASE hex of even length that decodes to PEM-armored bytes is
 * decoded (macOS `security -w` hex transport for multiline secrets,
 * plus trailing-newline variance). Interior bytes are never touched.
 * Non-PEM material passes through trimmed (callers validate after).
 */
export function normalizeKeyTransport(material: string): string {
  const edge = material.replace(/\r\n/g, "\n").replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
  if (/^[0-9a-f]+$/i.test(edge) && edge.length % 2 === 0 && edge.length >= 2) {
    try {
      const decoded = Buffer.from(edge, "hex").toString("utf8");
      if (decoded.startsWith("-----BEGIN")) {
        return decoded;
      }
    } catch {
      // Not decodable hex: fall through to the edge-trimmed form.
    }
  }
  return edge;
}

/** True when the material parses as an Ed25519 private key. */
export function isUsableEd25519Key(normalizedPem: string): boolean {
  try {
    return createPrivateKey(normalizedPem).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

/**
 * Read one private key from raw keychain/helper output: normalize,
 * then require a parseable Ed25519 private key. Returns the canonical
 * PEM or null. Malformed, truncated, wrong-type, and empty material
 * all yield null (fail closed, secret-safe).
 */
export function readKeyMaterial(raw: string | null): string | null {
  if (raw === null || raw.length === 0) {
    return null;
  }
  const normalized = normalizeKeyTransport(raw);
  if (normalized.length === 0 || !isUsableEd25519Key(normalized)) {
    return null;
  }
  return normalized;
}

/**
 * Fingerprint binding for a canonical private key: derives the public
 * key and hashes it (same fingerprint the Core enrolls). Lets a host
 * prove WHICH key it holds without exposing material — a foreign but
 * valid Ed25519 key yields a non-matching fingerprint instead of a
 * silent substitution. Returns null when the material is unusable.
 */
export function fingerprintKeyMaterial(normalizedPem: string): string | null {
  try {
    const publicPem = createPublicKey(createPrivateKey(normalizedPem))
      .export({ format: "pem", type: "spki" })
      .toString();
    return fingerprintPublicKey(publicPem);
  } catch {
    return null;
  }
}
