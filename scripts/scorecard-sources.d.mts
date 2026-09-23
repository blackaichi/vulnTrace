/**
 * Types for the part of `scorecard-sources.mjs` that a test exercises.
 *
 * The readers are plain ESM rather than TypeScript because
 * `generate-scorecard.mjs` runs them under bare `node`. This declaration
 * exists so the suite that exercises the FINDINGS status classification
 * (`src/testing/findings-status.test.ts`) is type-checked like any other
 * code rather than reaching for `any`.
 */

/** One row of the FINDINGS.md status table. */
export interface FindingsRegisterRow {
  readonly id: string;
  readonly status: string;
}

/** The status table, partitioned. Every row lands in exactly one bucket. */
export interface FindingsRegister {
  readonly rows: readonly FindingsRegisterRow[];
  readonly open: readonly FindingsRegisterRow[];
  readonly partlyOpen: readonly FindingsRegisterRow[];
  readonly fixed: readonly FindingsRegisterRow[];
}

/** Classifies the status table of the given `FINDINGS.md` text. */
export function classifyFindingsRegister(text: string): FindingsRegister;

/** Classifies the committed `tests/validation/FINDINGS.md`. */
export function readFindingsRegister(): FindingsRegister;
