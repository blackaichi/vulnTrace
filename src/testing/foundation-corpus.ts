import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runScanCommand } from "../cli/scan.js";
import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";

/**
 * FOUNDATION F6 — THE OFFLINE SEMANTIC CORPUS.
 *
 * The fixtures, the stubbed provider and the semantic projection that
 * `foundation-differential.test.ts` compares. Separated from the test so
 * the corpus can state what it is for without the assertions getting lost
 * in it.
 *
 * WHY THIS EXISTS AT ALL.
 *
 * F5 shipped with a 15-fixture output differential that compared whole
 * JSON documents byte for byte, and the independent audit found two places
 * where "identical" carried no information (RWF-038 § "Where this
 * differential is NOT non-vacuous"):
 *
 * - all fifteen fixtures produced **zero** `unreportedCandidates`, so the
 *   entire F3 no-finding model was compared against nothing;
 * - all **2,240** diagnostics came from a single source, `call-graph`, so
 *   the workspace and dependency-metadata channels were equally unexercised.
 *
 * That differential also required the real `tests/validation/fixtures/`
 * corpus of vendored npm packages and ran outside the test suite as a
 * one-off script. This one is committed, runs under `npm test` and the
 * Foundation gate, needs no network, and is built from hermetic synthetic
 * projects chosen so that every class it claims to cover is actually
 * produced — asserted, not assumed.
 *
 * WHY SEMANTICS AND NOT A SNAPSHOT.
 *
 * A byte-comparison of a large document fails loudly and says nothing:
 * the diff is thousands of lines and the reader has to work out which of
 * them mattered. {@link projectSemantics} instead reduces a scan to the
 * facts Foundation actually protects — which instance got which verdict,
 * which proof family answered, which candidate classes and diagnostic
 * sources appeared, and in what order — so a failure names the invariant
 * that broke (F6 § 27).
 *
 * NOTHING HERE TOUCHES THE NETWORK. The OSV boundary is stubbed by
 * {@link providerFor}, which answers from the case's own declared
 * advisories and records every query it was asked.
 */

/** One stubbed advisory, paired with the package name it is about. */
export interface StubAdvisory {
  readonly packageName: string;
  readonly id: string;
  /** Versions below this are affected. `undefined` means "every version". */
  readonly fixed?: string;
  /** Lowest affected version; defaults to `0`. */
  readonly introduced?: string;
}

function rawAdvisory(advisory: StubAdvisory): RawVulnerability {
  const events: Record<string, string>[] = [
    { introduced: advisory.introduced ?? "0" },
  ];
  if (advisory.fixed !== undefined) {
    events.push({ fixed: advisory.fixed });
  }
  return {
    id: advisory.id,
    aliases: [],
    affected: [
      {
        package: { ecosystem: "npm", name: advisory.packageName },
        ranges: [{ type: "SEMVER", events }],
      },
    ],
    references: [],
  };
}

/**
 * The stubbed OSV boundary, and a record of what it was asked.
 *
 * The recording matters as much as the answers: "no advisory was evaluated
 * against this instance" is only half a contract, and the other half —
 * that the scan did not invent or borrow a version in order to ask — is
 * visible only in the query log.
 */
export function providerFor(advisories: readonly StubAdvisory[]): {
  readonly provider: VulnerabilityProvider;
  readonly queries: string[];
} {
  const queries: string[] = [];
  return {
    queries,
    provider: {
      queryPackage(query: PackageQuery): Promise<readonly RawVulnerability[]> {
        queries.push(`${query.name}@${query.version ?? "(no version)"}`);
        return Promise.resolve(
          advisories
            .filter((entry) => entry.packageName === query.name)
            .map(rawAdvisory),
        );
      },
    },
  };
}

/** A `rules.yml` entry naming one advisory's vulnerable export. */
export function rule(
  id: string,
  packageName: string,
  exportName = "danger",
  moduleSpecifier = packageName,
): string {
  return (
    `  - id: ${id}\n` +
    `    package:\n` +
    `      name: ${packageName}\n` +
    `    targets:\n` +
    `      - module: ${moduleSpecifier}\n` +
    `        export: ${exportName}\n` +
    `        kind: function\n` +
    `        confidence: 1.0\n`
  );
}

/** A package whose `danger` export is what advisories target. */
export function installedLib(
  name: string,
  version?: string,
): Record<string, string> {
  return {
    "package.json": JSON.stringify(
      version === undefined
        ? { name, main: "index.js" }
        : { name, version, main: "index.js" },
    ),
    "index.js":
      "function danger(input) {\n  return input;\n}\n" +
      "function safe(input) {\n  return input;\n}\n" +
      "module.exports = { danger, safe };\n",
  };
}

/** Re-roots a file map under `prefix`. */
export function under(
  prefix: string,
  files: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [relativePath, content] of Object.entries(files)) {
    out[`${prefix}/${relativePath}`] = content;
  }
  return out;
}

export function config(entrypoints: readonly string[]): string {
  return (
    "analysis:\n  entrypoints:\n" +
    entrypoints.map((entry) => `    - ${entry}\n`).join("") +
    "rules:\n  files:\n    - rules.yml\n"
  );
}

// ====================================================================
// THE SEMANTIC PROJECTION
// ====================================================================

/** Which negative-proof family answered, or `null` for a non-NOT_AFFECTED. */
export type ProofFamily = "A" | "B" | "C" | null;

/**
 * The finding's own resolved target, compared WHOLE.
 *
 * Kept as a structure rather than flattened into a string so that no
 * field can be silently dropped: `module`, `symbol` and `kind` are the
 * advisory's identity as the report states it, and `confidence` here is
 * the RULE's confidence in that target, which is a different number from
 * the finding-level confidence beside it.
 */
export interface SemanticTarget {
  readonly module: string;
  readonly symbol: string;
  readonly kind: string | null;
  readonly confidence: number | null;
}

export interface SemanticFinding {
  readonly vulnerability: string;
  readonly package: string;
  readonly version: string | null;
  /** Project-root-relative, so it is stable across temp roots AND exact. */
  readonly packageInstance: string | null;
  readonly verdict: string;
  /**
   * The finding's confidence, compared and NEVER normalized.
   *
   * Omitted from this projection until an independent audit pointed out
   * that `JsonFinding` carries it and nothing here looked at it, so a
   * change that moved every confidence score would have left the
   * differential green.
   */
  readonly confidence: number | null;
  /** The finding's own target -- not family C's proof target, which is separate. */
  readonly target: SemanticTarget | null;
  readonly family: ProofFamily;
  /**
   * The instance the negative proof itself names — families A and B only.
   *
   * Emitted as the raw canonical `PackageInstanceId` (absolute), where the
   * finding's own `packageInstance` is project-root-RELATIVE. That is not
   * an inconsistency to paper over: the proof is evidence that must stand
   * alone, so it names the instance unambiguously. The differential
   * compares them after stripping the normalized root token, which is what
   * makes "the proof names the finding's own instance" checkable.
   *
   * `null` for family C, which by design names no instance at all.
   */
  readonly proofInstance: string | null;
  /**
   * What family C's proof names instead: the resolved target, as
   * `module#export`. Family C's claim is about a TARGET's unreachability,
   * not about an instance's presence — see `ConfirmedUnreachableTarget`.
   */
  readonly proofTarget: string | null;
  /** Family C's completeness fact. Must be `true` wherever C answered. */
  readonly reachableSubgraphComplete: boolean | null;
  readonly unknownReasons: readonly string[];
  readonly unknownCategories: readonly string[];
  /** Whether an AFFECTED carried a witness path, and how long it was. */
  readonly pathLength: number | null;
}

export interface SemanticCandidate {
  readonly stage: string;
  readonly disposition: string;
  readonly reason: string;
  readonly category: string | null;
  readonly package: string | null;
  readonly packageInstance: string | null;
  readonly version: string | null;
}

export interface Semantics {
  readonly findings: readonly SemanticFinding[];
  readonly candidates: readonly SemanticCandidate[];
  /** `source -> count`, which is what makes single-source coverage visible. */
  readonly diagnosticSources: Readonly<Record<string, number>>;
  readonly queries: readonly string[];
  readonly schemaVersion: string;
}

interface RawFinding {
  readonly vulnerability: string;
  readonly package: string;
  readonly version?: string;
  readonly packageInstance?: string;
  readonly verdict: string;
  readonly confidence?: number;
  readonly target?: {
    readonly module: string;
    readonly symbol: string;
    readonly kind?: string;
    readonly confidence?: number;
  };
  readonly unknownReasons?: readonly {
    readonly reason: string;
    readonly category?: string;
  }[];
  readonly evidence?: {
    readonly path?: readonly string[];
    readonly confirmedAbsentFromModuleLoadClosure?: {
      readonly packageInstance?: string;
    };
    readonly confirmedAbsentInstance?: { readonly packageInstance?: string };
    readonly confirmedUnreachableTarget?: {
      readonly target?: { readonly module: string; readonly export: string };
      readonly reachableSubgraphComplete?: boolean;
    };
  };
}

export interface RawScanOutput {
  readonly schemaVersion: string;
  readonly findings: readonly RawFinding[];
  readonly diagnostics: readonly {
    readonly source: string;
    readonly message: string;
  }[];
  readonly unreportedCandidates: readonly {
    readonly stage: string;
    readonly disposition: string;
    readonly reason: string;
    readonly category?: string;
    readonly package?: string;
    readonly packageInstance?: string;
    readonly version?: string;
  }[];
}

/**
 * Which family a finding's evidence establishes.
 *
 * Reads the three mutually-exclusive proof fields directly rather than
 * trusting a label, because the F4 contract being protected here is
 * precisely that exactly one of them is ever present.
 */
function familyOf(finding: RawFinding): {
  readonly family: ProofFamily;
  readonly proofInstance: string | null;
  readonly proofTarget: string | null;
  readonly reachableSubgraphComplete: boolean | null;
  readonly proofCount: number;
} {
  const evidence = finding.evidence;
  const familyA = evidence?.confirmedAbsentFromModuleLoadClosure;
  const familyB = evidence?.confirmedAbsentInstance;
  const familyC = evidence?.confirmedUnreachableTarget;
  const proofCount = (familyA ? 1 : 0) + (familyB ? 1 : 0) + (familyC ? 1 : 0);

  const none = {
    family: null,
    proofInstance: null,
    proofTarget: null,
    reachableSubgraphComplete: null,
  } as const;

  // Exactly one, or the contract is already broken and no family may be
  // reported -- reporting one here would hide a double proof.
  if (proofCount !== 1) {
    return { ...none, proofCount };
  }
  if (familyA) {
    return {
      ...none,
      family: "A",
      proofInstance: familyA.packageInstance ?? null,
      proofCount,
    };
  }
  if (familyB) {
    return {
      ...none,
      family: "B",
      proofInstance: familyB.packageInstance ?? null,
      proofCount,
    };
  }
  return {
    ...none,
    family: "C",
    proofTarget:
      familyC?.target === undefined
        ? null
        : `${familyC.target.module}#${familyC.target.export}`,
    reachableSubgraphComplete: familyC?.reachableSubgraphComplete ?? null,
    proofCount,
  };
}

/** How many negative-proof objects a finding carries (VT-CONTRACT-01). */
export function proofCountOf(finding: RawFinding): number {
  return familyOf(finding).proofCount;
}

/**
 * Reduces a scan's JSON to the facts Foundation protects.
 *
 * Deliberately keeps ORDER: `findings`, `candidates` and `queries` are
 * arrays, not sets, because F6 § 16 makes deterministic ordering an
 * invariant in its own right. Diagnostics are reduced to per-source COUNTS
 * instead, because their messages embed absolute paths and their ordering
 * contract is owned elsewhere; the count per source is the fact this
 * corpus exists to make non-vacuous.
 */
export function projectSemantics(
  output: RawScanOutput,
  queries: readonly string[],
): Semantics {
  const diagnosticSources: Record<string, number> = {};
  for (const diagnostic of output.diagnostics) {
    diagnosticSources[diagnostic.source] =
      (diagnosticSources[diagnostic.source] ?? 0) + 1;
  }

  return {
    schemaVersion: output.schemaVersion,
    findings: output.findings.map((finding) => {
      const { family, proofInstance, proofTarget, reachableSubgraphComplete } =
        familyOf(finding);
      return {
        proofTarget,
        reachableSubgraphComplete,
        confidence: finding.confidence ?? null,
        target:
          finding.target === undefined
            ? null
            : {
                module: finding.target.module,
                symbol: finding.target.symbol,
                kind: finding.target.kind ?? null,
                confidence: finding.target.confidence ?? null,
              },
        vulnerability: finding.vulnerability,
        package: finding.package,
        version: finding.version ?? null,
        packageInstance: finding.packageInstance ?? null,
        verdict: finding.verdict,
        family,
        proofInstance,
        unknownReasons: (finding.unknownReasons ?? []).map(
          (entry) => entry.reason,
        ),
        unknownCategories: (finding.unknownReasons ?? []).map(
          (entry) => entry.category ?? "(none)",
        ),
        pathLength: finding.evidence?.path?.length ?? null,
      };
    }),
    candidates: output.unreportedCandidates.map((candidate) => ({
      stage: candidate.stage,
      disposition: candidate.disposition,
      reason: candidate.reason,
      category: candidate.category ?? null,
      package: candidate.package ?? null,
      packageInstance: candidate.packageInstance ?? null,
      version: candidate.version ?? null,
    })),
    diagnosticSources,
    queries: [...queries].sort(),
  };
}

// ====================================================================
// MATERIALIZATION
// ====================================================================

const roots: string[] = [];

export function cleanupCorpus(): void {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots.length = 0;
}

export function materialize(
  name: string,
  files: Readonly<Record<string, string>>,
): string {
  const root = mkdtempSync(path.join(os.tmpdir(), `vulntrace-f6-${name}-`));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return root;
}

export async function scanProject(
  root: string,
  provider: VulnerabilityProvider,
): Promise<{ readonly output: RawScanOutput; readonly stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  await runScanCommand({
    projectPathArg: root,
    configPathOverride: path.join(root, "vulntrace.yml"),
    provider,
    noCache: true,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  });
  return {
    output: JSON.parse(stdout.join("")) as RawScanOutput,
    stderr: stderr.join(""),
  };
}

// ====================================================================
// PATH NORMALIZATION (F6 § 17)
// ====================================================================

/**
 * Rewrites the one genuinely environmental thing in a scan's output — the
 * `mkdtemp` root the fixture happens to live under — and NOTHING else.
 *
 * F6 § 17 is a warning drawn from an earlier harness: normalization that
 * "strips paths" to make two runs comparable destroys the very identity
 * the analyzer exists to establish. If every path collapsed to a
 * placeholder, two distinct `PackageInstance`s would normalize to the same
 * token and a cache that merged them would compare EQUAL — the differential
 * would certify the defect it exists to catch.
 *
 * So this mapping is BIJECTIVE on everything below the root: only the
 * root PREFIX is replaced, by a token derived from the case name, and
 * every suffix survives byte for byte.
 * `node_modules/vuln-lib` and `node_modules/host/node_modules/vuln-lib`
 * remain two different strings, in both runs, always.
 *
 * Note that this is belt and braces for the fields that matter most:
 * `packageInstance` is already emitted RELATIVE to the project root by
 * `describePackageInstance`, so instance identity never depended on this
 * function. It is applied to diagnostic messages and witness paths, which
 * do embed absolute paths.
 */
export function normalizeRoot(
  text: string,
  root: string,
  token: string,
): string {
  // The realpath form too: macOS temp dirs are symlinked, so the analyzer's
  // canonicalized output and the root we created differ by `/private`.
  const variants = [root, root.replace(/^\/private/, "")];
  let out = text;
  for (const variant of variants) {
    out = out.split(variant).join(`<${token}>`);
  }
  return out;
}

/** Applies {@link normalizeRoot} across a whole JSON document. */
export function normalizeDeep<T>(value: T, root: string, token: string): T {
  return JSON.parse(normalizeRoot(JSON.stringify(value), root, token)) as T;
}
