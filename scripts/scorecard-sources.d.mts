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
export type FindingsStatusCategory = "open" | "partlyOpen" | "fixed";

/** Every accepted status value, and the one category it maps to. */
export const FINDINGS_STATUS_VOCABULARY: ReadonlyMap<
  string,
  FindingsStatusCategory
>;

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
  /** Ids with a `## <ID>` section but no status-table row: in no bucket. */
  readonly sectionsWithoutRow: readonly string[];
}

/** Classifies the status table of the given `FINDINGS.md` text. */
export function classifyFindingsRegister(text: string): FindingsRegister;

/** Classifies the committed `tests/validation/FINDINGS.md`. */
export function readFindingsRegister(): FindingsRegister;
