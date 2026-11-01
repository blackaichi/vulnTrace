/**
 * Types for `findings-register.mjs`, the findings register's layout (task
 * BL-119): one file per finding under `tests/validation/findings/`. The
 * module is plain ESM because `generate-scorecard.mjs` runs it under bare
 * `node`; this declaration lets the tests and `open-soundness-defect.ts`
 * use it type-checked.
 */

export const FINDINGS_DIR: string;
export const FINDINGS_NOTES_DIR: string;
export const FINDINGS_INDEX: string;
export const SECTION_ID: RegExp;
export const STATUS_HEADER_LINE: string;
export const STATUS_SEPARATOR_LINE: string;

/** One finding's file, parsed. */
export interface FindingRecord {
  readonly id: string;
  readonly file: string;
  /** The status row, verbatim. */
  readonly row: string;
  /** Everything from the first `## <ID>` heading on. */
  readonly body: string;
  readonly headings: readonly string[];
}

/** One note's file, parsed: a section that records no finding. */
export interface FindingNote {
  readonly file: string;
  readonly body: string;
  readonly headings: readonly string[];
}

export interface FindingRecords {
  readonly records: readonly FindingRecord[];
  readonly notes: readonly FindingNote[];
}

export function recordFileText(row: string, sections: readonly string[]): string;
export function compareFindingIds(a: string, b: string): number;
export function parseRecordFile(
  file: string,
  text: string,
): (FindingRecord & { readonly problems: readonly string[] }) | { readonly problems: readonly string[] };
export function parseNoteFile(
  file: string,
  text: string,
): (FindingNote & { readonly problems: readonly string[] }) | { readonly problems: readonly string[] };
export function readFindingRecords(root?: string): FindingRecords;
export function assembleFindingsRegister(records: FindingRecords): string;
export function readFindingsRegisterText(root?: string): string;
export function renderFindingsIndex(records: FindingRecords): string;
