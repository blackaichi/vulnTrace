/**
 * Types for `differential-lib.mjs` (BL-029).
 *
 * The library is plain ESM so `scripts/differential.mjs` can run it under
 * bare `node`. These declarations let the collector
 * (`src/testing/differential-collect.ts`) and the library's own suite
 * (`src/testing/differential-lib.test.ts`) be type-checked.
 */

import type { CallGraph } from "../src/domain/graph.js";

export const SNAPSHOT_FORMAT: "vulntrace-differential-snapshot/1";

export interface NormalizationRoot {
  readonly path: string;
  readonly token: string;
}

export type Verdict = "AFFECTED" | "NOT_AFFECTED" | "UNKNOWN";

/** A suite's finding selector, as its oracle file spells it. */
export interface FindingSelector {
  readonly package: string;
  readonly version: string;
  readonly vulnerability?: string;
  readonly packageInstance?: string;
}

export interface CaseOracle {
  readonly expected: string;
  readonly knownFailure?: boolean;
  readonly selector: FindingSelector;
}

export interface GraphRecord {
  readonly truncated: boolean;
  readonly nodes: readonly string[];
  readonly edges: ReadonlyArray<{
    readonly site: string;
    readonly resolution: string;
  }>;
}

export interface ProofRecord {
  readonly family: string | null;
  readonly path: readonly string[];
  readonly reasons: readonly string[];
  readonly negativeProof: {
    readonly A: unknown;
    readonly B: unknown;
    readonly C: unknown;
  };
  readonly unknownReasons: readonly unknown[];
  readonly target: unknown;
  readonly confidence: number | null;
}

export interface FindingRecord {
  readonly key: string;
  readonly vulnerability: string;
  readonly package: string;
  readonly version: string | null;
  readonly packageInstance: string | null;
  readonly verdict: Verdict;
  readonly proof: ProofRecord;
  readonly duplicateKey: boolean;
}

export type OutputStatus = "ok" | "error" | "unparseable";

export interface CaseRecord {
  readonly corpus: string;
  readonly id: string;
  readonly oracle: CaseOracle | null;
  readonly exitCode: number | null;
  readonly outputStatus: OutputStatus;
  readonly error: string | null;
  readonly stderr: string;
  readonly schemaIssueCount: number;
  readonly graph: GraphRecord | null;
  readonly findings: readonly FindingRecord[];
  /** Canonical JSON of each normalized unreported candidate, sorted. */
  readonly unreported: readonly string[];
}

export interface Snapshot {
  readonly format: typeof SNAPSHOT_FORMAT;
  readonly label: string;
  readonly corpora: readonly string[];
  readonly cases: readonly CaseRecord[];
}

export interface CaseInput {
  readonly corpus: string;
  readonly id: string;
  readonly oracle?: CaseOracle | null;
  readonly exitCode?: number | null;
  readonly stdout: string;
  readonly stderr?: string;
  readonly error?: string | null;
  readonly schemaIssueCount?: number;
  readonly observedGraph?: {
    readonly graph: CallGraph;
    readonly truncated: boolean;
  } | null;
  readonly roots: readonly NormalizationRoot[];
}

export interface SiteChange {
  readonly site: string;
  readonly base: readonly string[];
  readonly head: readonly string[];
  readonly change: "withdrawn_to_unknown" | "unknown_to_resolved" | "retargeted";
}

export interface GraphCaseDiff {
  readonly case: string;
  readonly truncated: { readonly base: boolean; readonly head: boolean } | null;
  readonly nodesAdded: readonly string[];
  readonly nodesRemoved: readonly string[];
  readonly sitesAdded: ReadonlyArray<{ site: string; resolutions: string[] }>;
  readonly sitesRemoved: ReadonlyArray<{ site: string; resolutions: string[] }>;
  readonly sitesChanged: readonly SiteChange[];
}

export interface ProofChange {
  readonly case: string;
  readonly key: string;
  readonly verdictBase: Verdict;
  readonly verdictHead: Verdict;
  readonly verdictMoved: boolean;
  readonly fields: ReadonlyArray<{
    readonly field: string;
    readonly base: string;
    readonly head: string;
  }>;
}

export interface DiffResult {
  readonly base: { readonly label: string; readonly cases: number };
  readonly head: { readonly label: string; readonly cases: number };
  readonly cases: {
    readonly total: number;
    readonly onlyBase: readonly string[];
    readonly onlyHead: readonly string[];
    readonly unmeasured: ReadonlyArray<{
      case: string;
      base: OutputStatus;
      head: OutputStatus;
      baseError: string | null;
      headError: string | null;
    }>;
    readonly duplicateKeys: ReadonlyArray<{
      case: string;
      side: "base" | "head";
      key: string;
    }>;
    readonly schemaIssues: ReadonlyArray<{
      case: string;
      side: "base" | "head";
      count: number;
    }>;
  };
  readonly graph: {
    readonly measured: number;
    readonly unavailable: ReadonlyArray<{
      case: string;
      base: boolean;
      head: boolean;
    }>;
    readonly changed: readonly GraphCaseDiff[];
  };
  readonly proof: {
    readonly measured: number;
    readonly changed: readonly ProofChange[];
  };
  readonly verdict: {
    readonly measured: number;
    readonly changed: ReadonlyArray<{
      case: string;
      key: string;
      from: Verdict;
      to: Verdict;
      intoNotAffected: boolean;
    }>;
    readonly added: ReadonlyArray<{ case: string; key: string; verdict: Verdict }>;
    readonly removed: ReadonlyArray<{
      case: string;
      key: string;
      verdict: Verdict;
      nowUnreported: readonly string[];
    }>;
    readonly unreportedAdded: ReadonlyArray<{ case: string; entry: string }>;
    readonly unreportedRemoved: ReadonlyArray<{ case: string; entry: string }>;
  };
  readonly suite: ReadonlyArray<{
    case: string;
    expected: string;
    knownFailure: boolean | null;
    base: string;
    head: string;
    moved: boolean;
  }>;
}

export interface Summary {
  readonly graph: {
    readonly measured: number;
    readonly unavailable: number;
    readonly casesChanged: number;
    readonly nodesAdded: number;
    readonly nodesRemoved: number;
    readonly sitesAdded: number;
    readonly sitesRemoved: number;
    readonly sitesChanged: number;
    readonly withdrawnToUnknown: number;
    readonly unknownToResolved: number;
    readonly retargeted: number;
    readonly truncationChanged: number;
  };
  readonly proof: {
    readonly measured: number;
    readonly changed: number;
    readonly changedWithVerdictUnchanged: number;
  };
  readonly verdict: {
    readonly measured: number;
    readonly changed: number;
    readonly intoNotAffected: number;
    readonly added: number;
    readonly addedNotAffected: number;
    readonly removed: number;
    readonly unreportedAdded: number;
    readonly unreportedRemoved: number;
  };
  readonly suiteMoved: number;
  readonly unmeasured: number;
  readonly onlyOneSide: number;
}

export function canonicalJson(value: unknown): string;
export function createPathNormalizer(
  roots: readonly NormalizationRoot[],
): (text: string) => string;
export function deepNormalize<T>(value: T, normalize: (text: string) => string): T;
export function graphRecord(
  observed: { readonly graph: CallGraph; readonly truncated: boolean } | null,
  normalize: (text: string) => string,
): GraphRecord | null;
export function findingKey(
  vulnerability: string,
  pkg: string,
  version: string | null | undefined,
  packageInstance: string | null | undefined,
): string;
export function findingRecords(
  findings: readonly unknown[],
  normalize: (text: string) => string,
): FindingRecord[];
export function unreportedRecords(
  candidates: readonly unknown[],
  normalize: (text: string) => string,
): string[];
export function buildCaseRecord(input: CaseInput): CaseRecord;
export function caseKey(record: CaseRecord): string;
export function selectFinding(
  findings: readonly FindingRecord[],
  selector: FindingSelector,
): string;
export function diffSnapshots(base: Snapshot, head: Snapshot): DiffResult;
export function summarize(diff: DiffResult): Summary;
export function renderReport(
  diff: DiffResult,
  context?: { readonly notes?: readonly string[] },
): string;
