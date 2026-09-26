import type { JsonFinding, ScanOutput, UnreportedCandidate } from "../../cli/output.js";
import type { Coverage } from "../../domain/coverage.js";
import { runScanCommand } from "../../cli/scan.js";
import type { VulnerabilityProvider } from "../../domain/vulnerability.js";
import type { VerdictObservation } from "../open-soundness-defect.js";

export interface OracleScanOptions {
  readonly configPathOverride?: string;
  readonly cveFilter?: string;
  readonly format?: "json" | "html";
  readonly outputPath?: string;
  /** Defaults to `true` -- HERMETIC (task H-0 step 2): every scan is cache-free unless a case is specifically about caching. */
  readonly noCache?: boolean;
  readonly cacheDir?: string;
}

/**
 * One scan, reduced to exactly the fields task H-0 step 1 asks for --
 * "exit code, verdict, proof family (A/B/C or none), unknownReasons,
 * finding count, unreportedCandidates" -- plus the full parsed
 * {@link ScanOutput} for anything a case needs beyond that summary (HTML
 * cases, where there is no JSON to parse, leave `output` undefined and
 * keep raw `stdout`/`stderr`).
 */
export interface ScanObservation {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Parsed `ScanOutput`, when `format` was `"json"` (the default) and stdout parsed as JSON. */
  readonly output: ScanOutput | undefined;
  readonly findings: readonly JsonFinding[];
  readonly unreportedCandidates: readonly UnreportedCandidate[];
}

/**
 * Runs the REAL `runScanCommand` pipeline against `projectDir` -- never a
 * hand-assembled call into any lower-level analyzer function -- exactly
 * as every audit in docs/audits/ did, so a reproduction measures the same
 * production wiring VT-307d's own tests insist on (scan.module-load-
 * closure.test.ts's comment: "a hand-assembled builder call would
 * silently keep passing through" a broken production wiring fact).
 */
export async function runOracleScan(
  projectDir: string,
  provider: VulnerabilityProvider,
  options?: OracleScanOptions,
): Promise<ScanObservation> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const exitCode = await runScanCommand({
    projectPathArg: projectDir,
    noCache: options?.noCache ?? true,
    provider,
    configPathOverride: options?.configPathOverride,
    cveFilter: options?.cveFilter,
    format: options?.format,
    outputPath: options?.outputPath,
    cacheDir: options?.cacheDir,
    io: {
      stdout: (text) => stdoutChunks.push(text),
      stderr: (text) => stderrChunks.push(text),
    },
  });
  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");

  let output: ScanOutput | undefined;
  if ((options?.format ?? "json") === "json" && !options?.outputPath) {
    try {
      output = JSON.parse(stdout) as ScanOutput;
    } catch {
      output = undefined;
    }
  }

  return {
    exitCode,
    stdout,
    stderr,
    output,
    findings: output?.findings ?? [],
    unreportedCandidates: output?.unreportedCandidates ?? [],
  };
}

export interface FindingMatcher {
  readonly vulnerability?: string;
  readonly package?: string;
  readonly packageInstance?: string;
}

/** The first finding matching every field given in `matcher`. */
export function findFinding(
  observation: ScanObservation,
  matcher: FindingMatcher,
): JsonFinding | undefined {
  return observation.findings.find(
    (finding) =>
      (matcher.vulnerability === undefined ||
        finding.vulnerability === matcher.vulnerability) &&
      (matcher.package === undefined || finding.package === matcher.package) &&
      (matcher.packageInstance === undefined ||
        finding.packageInstance === matcher.packageInstance),
  );
}

/**
 * OPEN-DEFECT INTEGRATION (task H-0 step 2): turns one scan's finding into
 * the {@link VerdictObservation} shape
 * `src/testing/open-soundness-defect.ts` already defines and
 * `openSoundnessDefectProblems` already checks -- ONE domain, reused, not
 * a second parallel "observed outcome" shape for scan-level
 * reproductions to drift against.
 *
 * `unknownEdges` cannot be the call-graph-internal count
 * `verdict.require-member-write-authority.integration.test.ts` computes
 * (that test builds the `CallGraph` directly; a scan-level reproduction
 * only ever sees `runScanCommand`'s JSON output). `coverage.callsDynamic`
 * is the honest scan-level analog: the same "how much of the graph is
 * unresolved" fact, aggregated over the whole scan rather than one
 * finding's own subgraph, and equally sufficient to catch the drift this
 * field exists to catch (a fix that changes how much of the graph goes
 * unresolved changes this number).
 *
 * A later task creates no record here (task H-0 boundary): this function
 * only makes doing so possible without re-deriving the shape by hand.
 */
export function toVerdictObservation(
  finding: JsonFinding | undefined,
  coverage: Coverage,
): VerdictObservation {
  const evidence = finding?.evidence;
  const proofFamily: VerdictObservation["proofFamily"] =
    evidence?.confirmedAbsentFromModuleLoadClosure
      ? "A"
      : evidence?.confirmedAbsentInstance
        ? "B"
        : evidence?.confirmedUnreachableTarget
          ? "C"
          : "-";
  const target = finding?.target
    ? `${finding.target.module}#${finding.target.symbol}`
    : finding?.unknownReasons && finding.unknownReasons.length > 0
      ? `UNKNOWN ${finding.unknownReasons[0]!.reason}`
      : "-";
  return {
    verdict: finding?.verdict,
    proofFamily,
    target,
    reachableSubgraphComplete:
      evidence?.confirmedUnreachableTarget?.reachableSubgraphComplete ?? false,
    unknownEdges: coverage.callsDynamic,
  };
}
