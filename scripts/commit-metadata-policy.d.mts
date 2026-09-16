/**
 * Types for `commit-metadata-policy.mjs`.
 *
 * The policy itself is plain ESM rather than TypeScript because
 * `validate:history` runs it under bare `node`, with no build step
 * available. This declaration exists so the suite that exercises it
 * (`src/testing/commit-metadata-policy.test.ts`) is type-checked like any
 * other code rather than reaching for `any`.
 */

/** One commit's metadata, as `validate-commit-metadata.mjs` reads it from git. */
export interface CommitRecord {
  readonly sha?: string;
  readonly subject?: string;
  readonly message: string;
  readonly authorName?: string;
  readonly committerName?: string;
}

/** One way a commit violates the policy. */
export interface MetadataViolation {
  /** The rule id, e.g. `claude_model_family`. */
  readonly rule: string;
  /** Where it was found: a named trailer, an identity field, or the message. */
  readonly scope: string;
  readonly detail: string;
  /** What the gate required instead, phrased for a failure message. */
  readonly expected: string;
  /** The offending text, quoted back. */
  readonly evidence: string;
}

export function checkCommitMetadata(
  commit: CommitRecord,
): readonly MetadataViolation[];

export function formatViolations(
  commit: CommitRecord,
  violations: readonly MetadataViolation[],
): string;

export const POLICY_RULE_IDS: readonly string[];
