/**
 * Single authoritative release version.
 * The root package.json `version` is authoritative; `version.test.ts`
 * enforces that every workspace package.json and this constant agree.
 * CLI output derives from here — never a second hardcoded literal.
 */
export const CHRONO_VERSION = "0.1.0";
