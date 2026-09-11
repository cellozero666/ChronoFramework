/**
 * Revision hash computation matching docs/core/CORE-SPECIFICATION.md §4
 * [DOM §2.3, P3.5] — deterministic content hash of canonical serialization
 *
 * The exact algorithm is specified in CORE-SPECIFICATION §4.
 * This module provides the deterministic implementation.
 */
import { createHash } from "node:crypto";
import { ChronoError, ErrorCode, Severity } from "./errors.js";

/**
 * Serialize content to canonical JSON (keys sorted lexicographically,
 * UTF-8). Strict: rejects non-JSON values rather than hashing them
 * ambiguously [Remediation §5].
 *
 * Rejected: undefined, functions, symbols, bigints, NaN/±Infinity, and
 * class instances (whose toJSON/prototype would make the hash depend on
 * runtime behavior rather than data). Plain objects, arrays, strings,
 * finite numbers, booleans, and null are accepted.
 */
export function canonicalize(content: unknown): string {
  return JSON.stringify(canonicalValue(content));
}

function canonicalValue(value: unknown): unknown {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw nonCanonical(`non-finite number ${String(value)}`);
      }
      return value;
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw nonCanonical(`unsupported typeof '${typeof value}'`);
    case "object": {
      if (Array.isArray(value)) {
        return value.map((item) => canonicalValue(item));
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw nonCanonical("class instance (non-plain object)");
      }
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        sorted[key] = canonicalValue((value as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    default:
      throw nonCanonical("unreachable typeof branch");
  }
}

function nonCanonical(reason: string): ChronoError {
  return new ChronoError({
    code: ErrorCode.VALIDATION_ERROR,
    severity: Severity.ERROR,
    message: `Non-canonical revision content: ${reason}`,
    invariantRef: "INV §14.4",
    suggestedAction: "Provide plain JSON data (objects, arrays, strings, finite numbers, booleans, null)",
  });
}

/**
 * Compute a revision hash from canonical content.
 * Algorithm [CORE §4]:
 * 1. Canonicalize to sorted-key JSON (strict — rejects non-JSON input)
 * 2. Compute sha256 over the UTF-8 bytes, formatted `sha256:<64 hex>`
 */
export function computeRevisionHash(content: unknown): string {
  const canonicalJson = canonicalize(content);
  const hash = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
  return `sha256:${hash}`;
}

/**
 * Validate the complete revision-hash wire format `sha256:<64 lowercase hex>`
 * [CORE §4.2, Remediation §5]. Used wherever a revision crosses a trust
 * boundary (references, approvals, evidence) before any hash comparison.
 */
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isRevisionHash(value: string): boolean {
  return REVISION_PATTERN.test(value);
}

/**
 * Verify that a revision hash matches the canonical content.
 * [DOM §2.3] — "A material change to artifact content produces a different revision hash"
 */
export function verifyRevisionHash(content: unknown, expectedHash: string): boolean {
  const computed = computeRevisionHash(content);
  return computed === expectedHash;
}

/**
 * Validate that a reference is not stale [DOM §2.3, P7.3]
 * A stale reference points to a non-current revision hash.
 */
export function isStaleReference(
  boundRevision: string,
  currentRevision: string
): boolean {
  return boundRevision !== currentRevision;
}
