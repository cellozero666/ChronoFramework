/**
 * Human-authority cryptography: canonical signed payloads and Ed25519
 * verification [ADR-003, CORE §8, P2.10, FW §13].
 *
 * Every signature binds action, scope, artifact identity, exact
 * revision/hash, signer (authority), and timestamp over canonical JSON.
 * An arbitrary non-empty signature is never valid: verification is
 * cryptographic against the project-registered PO public key.
 *
 * Key generation/verification use node:crypto Ed25519. No provider,
 * model, or runtime concepts appear here [FW §22].
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { ChronoError, ErrorCode, Severity } from "./errors.js";
import { canonicalize } from "./revision.js";

/** Approval actions (module/security decisions). Waivers use action "waiver". */
export const APPROVAL_ACTIONS = [
  "module-approval",
  "architecture-security",
  "implementation-security",
] as const;

export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

/** Canonical approval payload [ADR-003 §3]. */
export interface ApprovalPayload {
  readonly action: string;
  readonly scope_artifact_id: string;
  readonly scope_revision: string;
  readonly authority: string;
  readonly rationale: string;
  readonly timestamp: string;
}

/** Canonical waiver payload [CORE §8.3, DOM §3.24]. */
export interface WaiverPayload {
  readonly action: "waiver";
  readonly scope_artifact_id: string;
  readonly scope_revision: string;
  readonly authority: string;
  readonly issue: string;
  readonly rationale: string;
  readonly evidence_ref: string | null;
  readonly compensating_controls: string | null;
  readonly follow_up_task_id: string | null;
  readonly expiry_review_condition: string;
  readonly timestamp: string;
}

/** Canonical operational trust upstreams (normative constants, not selections). */
export const RTK_UPSTREAM = "https://github.com/rtk-ai/rtk";
export const SKILL_UPSTREAM = "https://github.com/multica-ai/andrej-karpathy-skills";

/** Ed25519 keypair in PEM (SPKI public / PKCS8 private). */
export interface ApprovalKeyPair {
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
}

/** Generate a fresh Ed25519 PO signing keypair. */
export function generateApprovalKeyPair(): ApprovalKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

/** Parse and validate an Ed25519 public key (SPKI PEM). */
export function parseApprovalPublicKey(publicKeyPem: string): KeyObject {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new ChronoError({
        code: ErrorCode.SIGNATURE_INVALID,
        severity: Severity.ERROR,
        message: "PO public key must be Ed25519",
        invariantRef: "INV §4.3",
        suggestedAction: "Generate the PO key with chrono keys generate",
      });
    }
    return key;
  } catch (e) {
    if (e instanceof ChronoError) {
      throw e;
    }
    throw new ChronoError({
      code: ErrorCode.SIGNATURE_INVALID,
      severity: Severity.ERROR,
      message: "PO public key is not a valid PEM public key",
      invariantRef: "INV §4.3",
      suggestedAction: "Register a valid Ed25519 SPKI PEM public key",
    });
  }
}

/** Sign a canonical payload with an Ed25519 private key (PKCS8 PEM). Returns base64. */
export function signApprovalPayload(payload: ApprovalPayload | WaiverPayload, privateKeyPem: string): string {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new ChronoError({
      code: ErrorCode.SIGNATURE_INVALID,
      severity: Severity.ERROR,
      message: "Signing key is not a valid PEM private key",
      invariantRef: "INV §4.3",
      suggestedAction: "Use the PO key from the OS keychain",
    });
  }
  const bytes = Buffer.from(canonicalize(payload), "utf8");
  return sign(null, bytes, key).toString("base64");
}

/**
 * Cryptographically verify a signature against the payload and public key.
 * Returns false (never throws) for malformed signatures; callers map
 * false to SIGNATURE_INVALID / APPROVAL_REQUIRED.
 */
export function verifyApprovalSignature(
  payload: ApprovalPayload | WaiverPayload,
  signatureBase64: string,
  publicKey: KeyObject
): boolean {
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureBase64, "base64");
  } catch {
    return false;
  }
  if (signature.length === 0) {
    return false;
  }
  try {
    return verify(null, Buffer.from(canonicalize(payload), "utf8"), publicKey, signature);
  } catch {
    return false;
  }
}

/** Build the canonical approval payload from its fields [ADR-003 §3]. */
export function buildApprovalPayload(fields: {
  action: string;
  scopeArtifactId: string;
  scopeRevision: string;
  authority: string;
  rationale: string;
  timestamp: string;
}): ApprovalPayload {
  return {
    action: fields.action,
    scope_artifact_id: fields.scopeArtifactId,
    scope_revision: fields.scopeRevision,
    authority: fields.authority,
    rationale: fields.rationale,
    timestamp: fields.timestamp,
  };
}

/** Build the canonical waiver payload [CORE §8.3]. */
export function buildWaiverPayload(fields: {
  scopeArtifactId: string;
  scopeRevision: string;
  authority: string;
  issue: string;
  rationale: string;
  evidenceRef: string | null;
  compensatingControls: string | null;
  followUpTaskId: string | null;
  expiryReviewCondition: string;
  timestamp: string;
}): WaiverPayload {
  return {
    action: "waiver",
    scope_artifact_id: fields.scopeArtifactId,
    scope_revision: fields.scopeRevision,
    authority: fields.authority,
    issue: fields.issue,
    rationale: fields.rationale,
    evidence_ref: fields.evidenceRef,
    compensating_controls: fields.compensatingControls,
    follow_up_task_id: fields.followUpTaskId,
    expiry_review_condition: fields.expiryReviewCondition,
    timestamp: fields.timestamp,
  };
}
