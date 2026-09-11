/**
 * Revision hash computation matching docs/core/CORE-SPECIFICATION.md §4
 * [DOM §2.3, P3.5] — deterministic content hash of canonical serialization
 *
 * The exact algorithm is specified in CORE-SPECIFICATION §4.
 * This module provides the deterministic implementation.
 */
import { createHash } from "node:crypto";

/**
 * Compute a revision hash from canonical content.
 * Algorithm [CORE §4]:
 * 1. Parse content into structured representation
 * 2. Serialize to canonical JSON (keys sorted, UTF-8)
 * 3. Compute sha256
 */
export function computeRevisionHash(content: unknown): string {
  const canonicalJson = JSON.stringify(sortKeys(content));
  const hash = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
  return `sha256:${hash}`;
}

/**
 * Recursively sort object keys for canonical serialization.
 * Arrays are preserved in order (they are not dictionaries).
 */
function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => sortKeys(item));
  }
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
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
