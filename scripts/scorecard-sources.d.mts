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
  /** The Status cell, verbatim: the designated field. */
  readonly status: string;
  /** The status value read from it: the cell's leading phrase, normalised. */
  readonly value: string;
  /** The category `FINDINGS_STATUS_VOCABULARY` maps the value to. */
  readonly category: FindingsStatusCategory;
  /** The Impact cell, verbatim. */
  readonly impact: string;
}

/** The three categories. `partlyOpen` is open: a partial fix is not a fix. */
export type FindingsStatusCategory =
  | "open"
  | "partlyOpen"
  | "fixed"
  | "limitation";

/** Every accepted status value, and the one category it maps to. */
export const FINDINGS_STATUS_VOCABULARY: ReadonlyMap<
  string,
  FindingsStatusCategory
>;

/** The contract's sections that state a trust boundary, and their headings. */
export const TRUST_BOUNDARY_SECTIONS: ReadonlyMap<string, string>;

/** The exact header the status table must carry, in order. */
export const FINDINGS_STATUS_HEADER: readonly string[];

/** The status value of one Status cell. */
export function findingsStatusValue(cell: string): string;

/** The status table, partitioned. Every row lands in exactly one bucket. */
export interface FindingsRegister {
  readonly rows: readonly FindingsRegisterRow[];
  readonly open: readonly FindingsRegisterRow[];
  readonly partlyOpen: readonly FindingsRegisterRow[];
  readonly fixed: readonly FindingsRegisterRow[];
  /** Documented limitations (task BL-113): never open, never fixed. */
  readonly limitation: readonly FindingsRegisterRow[];
}

/**
 * Classifies the status table of the given register text: a `## Status`
 * table, then the sections (`assembleFindingsRegister`).
 */
export function classifyFindingsRegister(text: string): FindingsRegister;

/** Classifies the committed register, `tests/validation/findings/`. */
export function readFindingsRegister(): FindingsRegister;
