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
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { ChronoError, ErrorCode, Severity } from "./errors.js";
import type { PolicyPayload } from "./policy.js";
import { canonicalize } from "./revision.js";

/** Approval actions (module/security decisions). Waivers use action "waiver". */
export const APPROVAL_ACTIONS = [
  "module-approval",
  "planning-approval",
  "architecture-security",
  "implementation-security",
  "adapter-registration",
] as const;

export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

/**
 * Canonical approval payload [ADR-003 §3, ADR-007 §3].
 *
 * `security_implications` is optional and signed when present: classic
 * interactive approvals omit it (identical bytes as before), while
 * permission-bound approvals bind the ticket's recorded security
 * implications into the signature. Absent serializes as absent —
 * existing signatures verify unchanged.
 */
export interface ApprovalPayload {
  readonly action: string;
  readonly scope_artifact_id: string;
  readonly scope_revision: string;
  readonly authority: string;
  readonly rationale: string;
  readonly timestamp: string;
  readonly security_implications?: string;
}

/** Canonical privileged-session bootstrap payload [Remediation §3A]. */
export interface SessionAuthorizationPayload {
  readonly action: "session-open";
  readonly session_role: string;
  readonly adapter: string;
  readonly runtime: string;
  readonly scope_module: string | null;
  readonly scope_wp: string | null;
  readonly ttl_seconds: number;
  readonly nonce: string;
  readonly authority: string;
  readonly rationale: string;
  readonly timestamp: string;
}

/**
 * Canonical PO enrollment payload [SLICE-9 §9.1]. Binds the enrollment
 * action to the project, the enrolled key fingerprint, a fresh nonce, the
 * human-typed confirmation challenge, and a timestamp. Signed with the NEW
 * private key being enrolled, which proves key possession at enrollment.
 */
export interface EnrollmentPayload {
  readonly action: "po-enroll";
  readonly project_id: string;
  readonly fingerprint: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly authority: string;
  readonly rationale: string;
  readonly confirmation: string;
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
export function signApprovalPayload(payload: ApprovalPayload | WaiverPayload | SessionAuthorizationPayload | EnrollmentPayload | PolicyPayload, privateKeyPem: string): string {
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
  payload: ApprovalPayload | WaiverPayload | SessionAuthorizationPayload | EnrollmentPayload | PolicyPayload,
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

/** Build the canonical approval payload from its fields [ADR-003 §3, ADR-007 §3]. */
export function buildApprovalPayload(fields: {
  action: string;
  scopeArtifactId: string;
  scopeRevision: string;
  authority: string;
  rationale: string;
  timestamp: string;
  securityImplications?: string;
}): ApprovalPayload {
  return {
    action: fields.action,
    scope_artifact_id: fields.scopeArtifactId,
    scope_revision: fields.scopeRevision,
    authority: fields.authority,
    rationale: fields.rationale,
    timestamp: fields.timestamp,
    ...(fields.securityImplications !== undefined && fields.securityImplications.length > 0
      ? { security_implications: fields.securityImplications }
      : {}),
  };
}

/** Build the canonical privileged-session bootstrap payload [Remediation §3A]. */
export function buildSessionAuthorizationPayload(fields: {
  sessionRole: string;
  adapter: string;
  runtime: string;
  scopeModule: string | null;
  scopeWp: string | null;
  ttlSeconds: number;
  nonce: string;
  authority: string;
  rationale: string;
  timestamp: string;
}): SessionAuthorizationPayload {
  return {
    action: "session-open",
    session_role: fields.sessionRole,
    adapter: fields.adapter,
    runtime: fields.runtime,
    scope_module: fields.scopeModule,
    scope_wp: fields.scopeWp,
    ttl_seconds: fields.ttlSeconds,
    nonce: fields.nonce,
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

/** Enrollment ceremony liveness window: proof must be at most this fresh. */
export const ENROLLMENT_FRESHNESS_MS = 15 * 60 * 1000;

/** Routing proof submission liveness window: proofs must be submitted live. */
export const ROUTING_PROOF_FRESHNESS_MS = 60 * 60 * 1000;

/**
 * Derive the human-typed confirmation challenge for PO enrollment
 * [SLICE-9 §9.1]. Deterministic from project, key fingerprint, and nonce,
 * so the Core can recompute and verify exactly what the human confirmed.
 */
export function buildEnrollmentChallenge(projectId: string, fingerprint: string, nonce: string): string {
  return `enroll-${projectId}-${fingerprint.slice(0, 8)}-${nonce.slice(0, 8)}`;
}

/** Fingerprint of a candidate PO public key (SPKI PEM). */
export function fingerprintPublicKey(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem, "utf8").digest("hex");
}

/** Build the canonical PO enrollment payload [SLICE-9 §9.1]. */
export function buildEnrollmentPayload(fields: {
  projectId: string;
  fingerprint: string;
  timestamp: string;
  nonce: string;
  authority: string;
  rationale: string;
  confirmation: string;
}): EnrollmentPayload {
  return {
    action: "po-enroll",
    project_id: fields.projectId,
    fingerprint: fields.fingerprint,
    timestamp: fields.timestamp,
    nonce: fields.nonce,
    authority: fields.authority,
    rationale: fields.rationale,
    confirmation: fields.confirmation,
  };
}
