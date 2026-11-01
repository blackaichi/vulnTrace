/** Types for `measure-options-lib.mjs` (task BL-120), for its test. */

import type { DiffResult, Summary } from "./differential-lib.mjs";

export const RECORD_FLIPPED: string;
export const RECORD_DRIFTED: string;

/** The parts of a vitest JSON report this library reads. */
export interface VitestJsonReport {
  readonly testResults?: ReadonlyArray<{
    readonly name: string;
    readonly status?: string;
    readonly message?: string;
    readonly assertionResults?: ReadonlyArray<{
      readonly fullName: string;
      readonly status: string;
      readonly failureMessages?: readonly string[];
    }>;
  }>;
}

export interface TestOutcome {
  readonly status: string;
  readonly messages: readonly string[];
}

export function oracleOutcomes(
  report: VitestJsonReport,
  root: string,
): Map<string, TestOutcome>;

export function classifyFailure(
  messages: readonly string[],
): "flipped" | "drifted" | "lost";

export interface OracleComparison {
  readonly run: number;
  readonly passed: number;
  readonly flipped: readonly string[];
  readonly drifted: readonly string[];
  readonly lost: readonly string[];
  readonly gained: readonly string[];
  readonly onlyBase: readonly string[];
  readonly onlyOption: readonly string[];
}

export function compareOracle(
  base: ReadonlyMap<string, TestOutcome>,
  option: ReadonlyMap<string, TestOutcome>,
): OracleComparison;

export function oracleTotals(outcomes: ReadonlyMap<string, TestOutcome>): {
  readonly run: number;
  readonly passed: number;
};

export interface DifferentialSummary {
  readonly summary: Summary;
  readonly verdictsMoved: ReadonlyArray<{
    readonly case: string;
    readonly key: string;
    readonly from: string;
    readonly to: string;
  }>;
  readonly suite: {
    readonly proofs: Readonly<
      Record<
        string,
        {
          readonly held: number;
          readonly lost: ReadonlyArray<{ readonly case: string; readonly to: string }>;
        }
      >
    >;
    readonly intoNotAffected: ReadonlyArray<{
      readonly case: string;
      readonly expected: string;
      readonly from: string;
    }>;
    readonly moved: number;
  };
  readonly unmeasured: readonly string[];
  readonly onlyOneSide: readonly string[];
}

export function summarizeDifferential(diff: DiffResult): DifferentialSummary;

export function packageOf(file: string): string;

export interface CensusTotals {
  readonly files: number;
  readonly flagged: number;
  readonly packages: number;
  readonly packagesFlagged: number;
}

export function aggregateCensus(
  entries: ReadonlyArray<{ readonly file: string; readonly flagged: boolean }>,
): CensusTotals;

export interface MeasuredSide {
  readonly name: string;
  readonly error?: string;
  readonly oracle?: OracleComparison | { readonly run: number; readonly passed: number };
  readonly differential?: DifferentialSummary;
  readonly census?: CensusTotals | { readonly error: string };
}

export function renderReport(input: {
  readonly base: string;
  readonly sides: readonly MeasuredSide[];
  readonly notes?: readonly string[];
}): string;
