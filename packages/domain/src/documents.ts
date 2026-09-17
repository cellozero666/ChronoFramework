/**
 * User-approved Gaspar document writes (co-architect memos, fix plans).
 *
 * Gaspar petitions the Core to write Markdown documents the Product
 * Owner asked for; each write is authorized by exactly one human
 * approval through the permission-bound ceremony (ADR-007), never by
 * chat text and never by model shell. The ticket binds the canonical
 * path plus the exact proposed content hash; the Core itself performs
 * the write (backup + atomic replace) on finalize.
 *
 * No provider, model, or runtime concepts appear here [FW §22].
 */

import { join, relative, resolve, sep } from "node:path";
import { ChronoError, ErrorCode, Severity } from "./errors.js";
import { PLANNING_MAX_BYTES, PLANNING_MIN_BYTES } from "./planning.js";

/** Approval action recording a user-approved document write. */
export const DOCUMENT_WRITE_ACTION = "document-write" as const;

/** Scope prefix binding a ticket/approval to a project document path. */
export const DOCUMENT_SCOPE_PREFIX = "doc:" as const;

/** Only Markdown documents are writable through this path. */
export const DOCUMENT_WRITE_EXTENSION = ".md" as const;

/** Content bounds mirror planning material (model-generated bodies). */
export const DOCUMENT_MIN_BYTES = PLANNING_MIN_BYTES;
export const DOCUMENT_MAX_BYTES = PLANNING_MAX_BYTES;

/** Backup suffix for replaced documents (single backup, overwritten). */
export const DOCUMENT_BACKUP_SUFFIX = ".chrono-bak" as const;

/** Project roots a document write may never address. */
const FORBIDDEN_ROOTS = [".chrono", ".git", "node_modules"] as const;

export interface ResolvedDocumentScope {
  /** Ticket/approval scope: `doc:<project-relative posix path>`. */
  readonly scopeId: string;
  /** Project-relative path with posix separators. */
  readonly relPath: string;
  /** Absolute resolved path (symlinks resolved, contained in root). */
  readonly absPath: string;
}

/**
 * Resolve a user-named document path to a ticket scope.
 *
 * Rules (all fail closed):
 * - the path must end in `.md`;
 * - it must resolve inside the project root (absolute input, `..`,
 *   and symlink escape all deny);
 * - it must not live under `.chrono/` (Core-governed drafts keep
 *   their revision/approval binding through artifact propose/revise),
 *   `.git/`, or `node_modules/`.
 */
export function resolveDocumentScope(projectRoot: string, userPath: string): ResolvedDocumentScope {
  const trimmed = userPath.trim();
  if (trimmed.length === 0) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: "Document write requires a path",
      invariantRef: "INV §14.4",
      affectedTarget: "(empty)",
      suggestedAction: "Name the Markdown document to write, e.g. docs/FIXES.md",
    });
  }
  if (!trimmed.endsWith(DOCUMENT_WRITE_EXTENSION)) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: `Document write covers Markdown only: '${trimmed}' does not end in '${DOCUMENT_WRITE_EXTENSION}'`,
      invariantRef: "INV §14.4",
      affectedTarget: trimmed,
      suggestedAction: "Write prose documents (.md) through this path; code changes ride dispatched work",
    });
  }
  const root = resolve(projectRoot);
  const abs = resolve(root, trimmed);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || abs !== join(root, rel)) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: `Document write path '${trimmed}' escapes the project root`,
      invariantRef: "INV §14.4",
      affectedTarget: trimmed,
      suggestedAction: "Name a document inside the project",
    });
  }
  const relPosix = rel.split(sep).join("/");
  const first = relPosix.split("/")[0] as string;
  if ((FORBIDDEN_ROOTS as readonly string[]).includes(first)) {
    throw new ChronoError({
      code: ErrorCode.VALIDATION_ERROR,
      severity: Severity.ERROR,
      message: `Document write cannot address '${relPosix}': ${first}/ is ${first === ".chrono" ? "Core-governed (use artifact propose/revise for drafts)" : "not writable through this path"}`,
      invariantRef: "INV §14.4",
      affectedTarget: relPosix,
      suggestedAction:
        first === ".chrono"
          ? "Propose or revise governed drafts through the planning tools"
          : "Write user documents elsewhere in the project",
    });
  }
  return { scopeId: `${DOCUMENT_SCOPE_PREFIX}${relPosix}`, relPath: relPosix, absPath: abs };
}

/** Split a `doc:<rel>` scope back to its relative path (null when foreign). */
export function documentScopePath(scopeId: string): string | null {
  if (!scopeId.startsWith(DOCUMENT_SCOPE_PREFIX)) {
    return null;
  }
  const rel = scopeId.slice(DOCUMENT_SCOPE_PREFIX.length);
  if (rel.length === 0 || rel.startsWith("/") || rel.includes("..")) {
    return null;
  }
  return rel;
}
