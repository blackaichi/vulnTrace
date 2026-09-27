import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runScanCommand } from "../cli/scan.js";
import { validateScanOutput } from "../cli/output.js";
import type { CallGraph } from "../domain/graph.js";
import type { VulnerabilityProvider } from "../domain/vulnerability.js";
import {
  adversarialV1Provider,
  adversarialV2Provider,
} from "./adversarial-providers.js";
import { SnapshotOsvProvider } from "./snapshot-osv-provider.js";
// Plain ESM, so `scripts/differential.mjs` can run it under bare `node`;
// its types live in the matching `.d.mts` file.
import {
  buildCaseRecord,
  SNAPSHOT_FORMAT,
  type CaseOracle,
  type CaseRecord,
  type FindingSelector,
  type NormalizationRoot,
  type Snapshot,
} from "../../scripts/differential-lib.mjs";

/**
 * BL-029 — THE DIFFERENTIAL TOOL'S COLLECTOR.
 *
 * Scans every case of the three committed corpora exactly as its own
 * suite scans it, and records one normalized {@link CaseRecord} per case:
 *
 * | corpus           | suite                                          | project scanned              | provider                         |
 * | ---------------- | ---------------------------------------------- | ---------------------------- | -------------------------------- |
 * | `validation`     | `tests/validation/validation.test.ts`          | a fresh OS-temp copy (VT-302) | `SnapshotOsvProvider` (D-03)     |
 * | `adversarial-v1` | `tests/adversarial/v1/adversarial.test.ts`     | the fixture, in place        | `adversarialV1Provider()`        |
 * | `adversarial-v2` | `tests/adversarial/v2/adversarial-v2.test.ts`  | the fixture, in place        | `adversarialV2Provider()`        |
 *
 * TWO ROOTS, DELIBERATELY SEPARATE. The code under measurement is whatever
 * `runScanCommand` this module imports (the checkout it runs in, the
 * "code root"). The corpus — fixtures, cases, expected verdicts and the
 * OSV snapshot — is read from `corpusRoot`, which the driver sets to the
 * head checkout for BOTH sides. So both sides scan the same bytes at the
 * same paths, and a difference between them is attributable to analyzer
 * code alone, not to a fixture, an oracle or an advisory record that moved
 * with it.
 *
 * The call graph is read through `RunScanOptions.onCallGraph` (BL-029).
 * Code that predates the seam never calls it, and the case's graph is
 * then `null` — reported as unavailable, never as an empty graph.
 */

export type CorpusName = "validation" | "adversarial-v1" | "adversarial-v2";

export const CORPORA: readonly CorpusName[] = [
  "validation",
  "adversarial-v1",
  "adversarial-v2",
];

export interface CollectOptions {
  /** The checkout whose corpus (fixtures, cases, oracles, OSV snapshot) is scanned. */
  readonly corpusRoot: string;
  /** The checkout whose analyzer code is running; used only to normalize paths. */
  readonly codeRoot: string;
  readonly corpora: readonly CorpusName[];
  readonly label: string;
  /** Only these case IDs, when given (a case ID is unique within its corpus). */
  readonly only?: readonly string[];
  readonly onProgress?: (message: string) => void;
}

export interface CorpusCase {
  readonly corpus: CorpusName;
  readonly id: string;
  readonly fixtureDir: string;
  readonly copyToTemp: boolean;
  readonly provider: () => VulnerabilityProvider;
  readonly oracle: CaseOracle;
}

interface ValidationCaseFile {
  readonly id: string;
  readonly dir: string;
  readonly expected: string;
  readonly knownFailure: boolean;
  readonly findingSelector: FindingSelector;
}

interface AdversarialCaseFile {
  readonly id: string;
  readonly dir: string;
  readonly expected: string;
  readonly findingSelector: FindingSelector;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

/** Every case of the named corpora, in corpus order and then file order. */
export function loadCorpusCases(
  corpusRoot: string,
  corpora: readonly CorpusName[],
): CorpusCase[] {
  const cases: CorpusCase[] = [];
  for (const corpus of corpora) {
    if (corpus === "validation") {
      const suite = path.join(corpusRoot, "tests", "validation");
      const snapshotPath = path.join(suite, "osv-snapshot.json");
      for (const c of readJson<ValidationCaseFile[]>(
        path.join(suite, "cases", "cases.json"),
      )) {
        cases.push({
          corpus,
          id: c.id,
          fixtureDir: path.join(suite, "fixtures", c.dir),
          copyToTemp: true,
          provider: () => new SnapshotOsvProvider(snapshotPath),
          oracle: {
            expected: c.expected,
            knownFailure: c.knownFailure,
            selector: c.findingSelector,
          },
        });
      }
    } else {
      const version = corpus === "adversarial-v1" ? "v1" : "v2";
      const suite = path.join(corpusRoot, "tests", "adversarial", version);
      for (const c of readJson<AdversarialCaseFile[]>(
        path.join(suite, "expected.json"),
      )) {
        cases.push({
          corpus,
          id: c.id,
          fixtureDir: path.join(suite, "fixtures", c.dir),
          copyToTemp: false,
          provider:
            version === "v1" ? adversarialV1Provider : adversarialV2Provider,
          oracle: { expected: c.expected, selector: c.findingSelector },
        });
      }
    }
  }
  return cases;
}

function spellings(dir: string): string[] {
  const out = [path.resolve(dir)];
  try {
    const real = realpathSync(dir);
    if (!out.includes(real)) out.push(real);
  } catch {
    // A root that does not exist has no second spelling.
  }
  return out;
}

function rootsFor(
  projectDir: string,
  options: CollectOptions,
): NormalizationRoot[] {
  const named: Array<[string, string]> = [
    [projectDir, "<project>"],
    [options.corpusRoot, "<corpus>"],
    [options.codeRoot, "<code>"],
    [tmpdir(), "<tmp>"],
  ];
  return named.flatMap(([dir, token]) =>
    spellings(dir).map((p) => ({ path: p, token })),
  );
}

export async function collectCase(
  c: CorpusCase,
  options: CollectOptions,
): Promise<CaseRecord> {
  // VT-302: the validation suite scans a fresh OS-temp copy, never the
  // fixture in place; the adversarial suites scan in place. Mirrored.
  const projectDir = c.copyToTemp
    ? mkdtempSync(path.join(tmpdir(), `vulntrace-differential-${c.id}-`))
    : c.fixtureDir;
  const stdout: string[] = [];
  const stderr: string[] = [];
  let observedGraph: { graph: CallGraph; truncated: boolean } | null = null;
  let observations = 0;
  let exitCode: number | null = null;
  let error: string | null = null;
  try {
    if (c.copyToTemp) {
      cpSync(c.fixtureDir, projectDir, { recursive: true, dereference: false });
    }
    exitCode = await runScanCommand({
      projectPathArg: projectDir,
      configPathOverride: path.join(projectDir, "vulntrace.yml"),
      noCache: true,
      provider: c.provider(),
      io: {
        stdout: (t: string) => stdout.push(t),
        stderr: (t: string) => stderr.push(t),
      },
      onCallGraph: (observed) => {
        observations += 1;
        observedGraph = {
          graph: observed.graph,
          truncated: observed.truncated,
        };
      },
    });
    if (observations > 1) {
      // The seam's contract is exactly once; a second graph would make the
      // record ambiguous, so the case is not measured rather than guessed.
      error = `onCallGraph fired ${observations} times (contract: once)`;
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  } finally {
    if (c.copyToTemp) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }

  const text = stdout.join("");
  let schemaIssueCount = 0;
  try {
    schemaIssueCount = validateScanOutput(JSON.parse(text)).length;
  } catch {
    // Unparseable output is recorded as such by buildCaseRecord.
  }
  return buildCaseRecord({
    corpus: c.corpus,
    id: c.id,
    oracle: c.oracle,
    exitCode,
    stdout: text,
    stderr: stderr.join(""),
    error,
    schemaIssueCount,
    observedGraph,
    roots: rootsFor(projectDir, options),
  });
}

/**
 * The cases `options` selects, in corpus order. Throws on a requested case
 * ID that no corpus has, rather than collecting nothing for it.
 */
export function selectCases(options: CollectOptions): CorpusCase[] {
  const all = loadCorpusCases(options.corpusRoot, options.corpora);
  if (options.only === undefined) return all;
  const selected = all.filter((c) => options.only?.includes(c.id));
  const missing = options.only.filter(
    (id) => !selected.some((c) => c.id === id),
  );
  if (missing.length > 0) {
    throw new Error(`no such case in the corpora: ${missing.join(", ")}`);
  }
  return selected;
}

export function snapshotOf(
  options: CollectOptions,
  cases: readonly CaseRecord[],
): Snapshot {
  return {
    format: SNAPSHOT_FORMAT,
    label: options.label,
    corpora: [...options.corpora],
    cases: [...cases],
  };
}

/** Scans every selected case, one at a time, and returns the snapshot. */
export async function collectSnapshot(
  options: CollectOptions,
): Promise<Snapshot> {
  const selected = selectCases(options);
  const cases: CaseRecord[] = [];
  for (const [index, c] of selected.entries()) {
    options.onProgress?.(
      `[${options.label}] ${index + 1}/${selected.length} ${c.corpus}/${c.id}`,
    );
    cases.push(await collectCase(c, options));
  }
  return snapshotOf(options, cases);
}
