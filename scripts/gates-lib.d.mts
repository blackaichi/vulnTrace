/**
 * Types for `gates-lib.mjs` (BL-089).
 *
 * The library is plain ESM so `scripts/gates.mjs` can run it under bare
 * `node`. These declarations let its suite (`src/testing/gates-lib.test.ts`)
 * be type-checked.
 */

export interface FastGate {
  readonly name: string;
  readonly argv: readonly string[];
}

export interface Suite {
  readonly name: string;
  readonly script: string;
}

export const FAST_GATES: readonly FastGate[];
export const SUITES: readonly Suite[];
export const DIFFERENTIAL: "differential";
export const ALL_GATE_NAMES: readonly string[];

export function vitestArgs(
  scripts: Readonly<Record<string, string>>,
  name: string,
): string[];

export function exactlyOnceProblems(
  lists: Readonly<Record<string, readonly string[]>>,
  fullTest?: readonly string[],
): string[];

export interface VitestFailure {
  readonly file: string;
  readonly title: string;
  readonly fullName: string;
  readonly message: string;
}

export interface VitestReport {
  readonly files: number;
  readonly failedFiles: number;
  readonly tests: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly success: boolean;
  readonly failures: readonly VitestFailure[];
}

export function readVitestReport(text: string): VitestReport;

export interface ValidationComparison {
  readonly known: readonly string[];
  readonly failedIds: readonly string[];
  readonly unexpected: readonly string[];
  readonly nowPassing: readonly string[];
  readonly observed: Readonly<Record<string, string>>;
  readonly matches: boolean;
}

export function compareValidation(
  failures: readonly Pick<VitestFailure, "title" | "fullName" | "message">[],
  cases: readonly { readonly id: string; readonly knownFailure?: boolean }[],
): ValidationComparison;

export function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string;
