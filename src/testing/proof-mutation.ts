import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import {
  createModuleResolver,
  type ModuleResolver,
} from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import {
  buildGateEligibleModuleLoadClosure,
  type ClosureIncompletenessReason,
  type ModuleLoadClosure,
} from "../analysis/module-load-closure.js";
import {
  createAnalysisProofContext,
  type AnalysisProofContext,
} from "../analysis/analysis-context.js";
import { buildFinding } from "../analysis/verdict.js";
import type { DependencyNode } from "../domain/dependency.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import type {
  CallGraph,
  DynamicCallReason,
  GraphNode,
} from "../domain/graph.js";
import {
  buildKnownPackageRoots,
  canonicalizePackageInstancePath,
  type KnownPackageRoots,
} from "../domain/resolved-target.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { UncertaintyClassification } from "../domain/uncertainty.js";
import type { Finding, Verdict } from "../domain/verdict.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import type { VersionMatchResult } from "../vulnerabilities/version-matching.js";

/**
 * FOUNDATION F4 -- THE NEGATIVE-PROOF MUTATION HARNESS (test-only).
 *
 * WHAT THIS IS FOR. `domain/evidence.ts` states the negative-proof
 * contract as a table: three families, each with an enumerated list of
 * prerequisites that must ALL hold. Every one of those prerequisites is
 * protected today by at least one regression test, written when the
 * prerequisite was added, in the shape of the defect that motivated it.
 * That is a collection of point checks, not a statement of the invariant
 * they collectively encode.
 *
 * The invariant is MONOTONICITY WITH RESPECT TO LOST INFORMATION:
 *
 *   a valid NOT_AFFECTED proof
 *   + one mutation that invalidates one of its required prerequisites
 *   = that proof is GONE.
 *
 * Less trusted information must never produce more confidence. This module
 * makes that cheap to state: take a real, valid family A/B/C proof, remove
 * or corrupt exactly one thing it depends on, and assert the original
 * proof did not survive.
 *
 * WHAT IT DELIBERATELY IS NOT. It is not a fuzzer, and it does not assert
 * `UNKNOWN` mechanically. A proof family being invalidated is not the same
 * event as a verdict moving: VulnTrace has three independent families, and
 * one legitimately taking over from another is a SOUND outcome, not a
 * missed downgrade (see {@link MutationOutcome} and the harness's
 * `takeover` classification). Encoding "expected UNKNOWN" as the invariant
 * would force the harness to lie about the architecture. What is never
 * permitted is the mutated, now-unsupported ORIGINAL proof still being
 * reported.
 *
 * WHERE THE MUTATION HAPPENS. Only here, in test code. Nothing in this
 * module is imported by `src/analysis`, `src/cli` or any other production
 * path, and no production file gained a hook for it. Mutations are applied
 * to the INPUTS a scan hands `buildFinding`; the proof itself is then
 * produced by the real production composition
 * (`createAnalysisProofContext` + `buildFinding`), never by a stub that
 * could skip a guard.
 */

/** Which negative proof a finding actually carries, read from the evidence objects. */
export type ProofFamily = "A" | "B" | "C" | "NONE";

/**
 * Every proof-critical input, in one bundle that mutations copy.
 *
 * This is the harness's inventory of "what a negative proof depends on",
 * and it was derived from the code rather than from the documentation:
 * every field below is read by at least one guard in `resolveTargetNodes`,
 * `checkReachability`, `buildFinding` or `createAnalysisProofContext`.
 * A mutation is a function from this bundle to another one.
 */
export interface ProofInputs {
  readonly projectRoot: string;
  readonly resolver: ModuleResolver;
  readonly entrypoints: readonly Entrypoint[];
  readonly knownPackageRoots: KnownPackageRoots | undefined;
  readonly graph: CallGraph;
  readonly graphTruncated: boolean;
  readonly moduleLoadClosure: ModuleLoadClosure | undefined;
  readonly vulnerability: Vulnerability;
  readonly packageName: string;
  readonly packageVersion: string | undefined;
  /** The exact canonical install location this finding is about. */
  readonly packageInstance: string | undefined;
  readonly matchResult: VersionMatchResult;
  readonly rule: VulnerableSymbolRule;
}

/**
 * The RICH mutation result (F4 § 7).
 *
 * Deliberately more than a verdict. A harness that recorded only
 * "UNKNOWN / not UNKNOWN" could not tell an invalidated family A that
 * correctly degraded from an invalidated family A that a legitimate
 * family C replaced -- and those two outcomes need different assertions.
 */
export interface MutationOutcome {
  readonly verdict: Verdict | undefined;
  readonly family: ProofFamily;
  /** The instance the surviving proof (if any) is ABOUT -- never a package name. */
  readonly proofPackageInstance: string | undefined;
  readonly proofEntrypointRoots: readonly string[] | undefined;
  readonly proofTarget:
    { readonly module: string; readonly export: string } | undefined;
  /** Prose justifications, verbatim from the finding. */
  readonly reasons: readonly string[];
  /** F3's structured taxonomy, carried for OBSERVATION only (F4 § 18). */
  readonly unknownReasons: readonly UncertaintyClassification[];
  /** How many negative-proof evidence objects are present (VT-CONTRACT-01). */
  readonly proofCount: number;
  readonly finding: Finding | undefined;
}

/** Reads the proof family from the evidence OBJECTS, never from prose. */
export function familyOf(finding: Finding | undefined): ProofFamily {
  const evidence = finding?.evidence;
  if (evidence?.confirmedAbsentFromModuleLoadClosure) return "A";
  if (evidence?.confirmedAbsentInstance) return "B";
  if (evidence?.confirmedUnreachableTarget) return "C";
  return "NONE";
}

function outcomeOf(finding: Finding | undefined): MutationOutcome {
  const evidence = finding?.evidence;
  const proofs = [
    evidence?.confirmedAbsentFromModuleLoadClosure,
    evidence?.confirmedAbsentInstance,
    evidence?.confirmedUnreachableTarget,
  ].filter((proof) => proof !== undefined);
  return {
    verdict: finding?.verdict,
    family: familyOf(finding),
    proofPackageInstance:
      evidence?.confirmedAbsentFromModuleLoadClosure?.packageInstance ??
      evidence?.confirmedAbsentInstance?.packageInstance,
    proofEntrypointRoots:
      evidence?.confirmedAbsentFromModuleLoadClosure?.entrypointRoots ??
      evidence?.confirmedAbsentInstance?.entrypointRoots ??
      evidence?.confirmedUnreachableTarget?.entrypointRoots,
    proofTarget: evidence?.confirmedUnreachableTarget?.target,
    reasons: evidence?.reasons ?? [],
    unknownReasons: finding?.unknownReasons ?? [],
    proofCount: proofs.length,
    finding,
  };
}

/** One-line rendering used as the failure context of every matrix assertion. */
export function describeOutcome(outcome: MutationOutcome): string {
  return JSON.stringify(
    {
      verdict: outcome.verdict,
      family: outcome.family,
      proofPackageInstance: outcome.proofPackageInstance,
      proofCount: outcome.proofCount,
      unknownReasons: outcome.unknownReasons.map(
        (reason) => `${reason.category}/${reason.reason}x${reason.count}`,
      ),
      reasons: outcome.reasons,
    },
    undefined,
    2,
  );
}

/**
 * Runs the REAL production composition over `inputs`.
 *
 * Goes through `createAnalysisProofContext` deliberately, not through a
 * hand-built context: the context constructor is itself one of the guards
 * under test (it DROPS a closure whose roots do not match the entrypoints,
 * and one whose graph does not cover them), so a harness that bypassed it
 * would silently stop exercising a prerequisite it claims to mutate.
 */
export async function runProof(inputs: ProofInputs): Promise<MutationOutcome> {
  return runProofWithContext(inputs, contextFor(inputs));
}

/** The context this scan's inputs describe. */
export function contextFor(inputs: ProofInputs): AnalysisProofContext {
  return createAnalysisProofContext({
    projectRoot: inputs.projectRoot,
    resolver: inputs.resolver,
    entrypoints: inputs.entrypoints,
    knownPackageRoots: inputs.knownPackageRoots,
    graph: inputs.graph,
    graphTruncated: inputs.graphTruncated,
    moduleLoadClosure: inputs.moduleLoadClosure,
  });
}

/**
 * Runs `buildFinding` with an EXPLICIT context -- the entry point the
 * AnalysisProofContext mutations (F4 § 11) use to hand `buildFinding` a
 * context that does not belong to the finding's own scan.
 */
export async function runProofWithContext(
  inputs: ProofInputs,
  context: AnalysisProofContext,
): Promise<MutationOutcome> {
  return outcomeOf(
    await buildFinding({
      vulnerability: inputs.vulnerability,
      packageName: inputs.packageName,
      packageVersion: inputs.packageVersion,
      packageInstance: inputs.packageInstance,
      matchResult: inputs.matchResult,
      rule: inputs.rule,
      context,
    }),
  );
}

/** Replaces named fields of a proof-input bundle; everything else is shared. */
export function mutate(
  inputs: ProofInputs,
  patch: Partial<ProofInputs>,
): ProofInputs {
  return { ...inputs, ...patch };
}

// --------------------------------------------------------------------
// The outcome model and the false-NOT_AFFECTED metric (F4 § 7, § 28).
// --------------------------------------------------------------------

/**
 * What a mutation actually did to the original proof.
 *
 * Exactly one of these is `unsafe`, and that is the whole point: the
 * harness reports a distribution rather than a pass/fail bit, so a
 * legitimate proof-family takeover is counted as what it is instead of
 * being either mistaken for a failure or quietly waved through.
 */
export type MutationClass =
  /** The original proof is gone and nothing replaced it. */
  | "invalidated_to_unknown"
  /** The original proof is gone; an INDEPENDENT family carries the verdict. */
  | "invalidated_by_takeover"
  /** The original proof is gone; a positive path was established instead. */
  | "invalidated_to_affected"
  /** The mutation did not touch a prerequisite of this family; the proof correctly stands. */
  | "not_a_prerequisite"
  /** FORBIDDEN: the mutated, unsupported original proof was still reported. */
  | "unsafe_survival";

/** One row of a family's mutation matrix. */
export interface ProofMutationRow {
  /** Names the single semantic prerequisite this row removes (F4 § 21). */
  readonly mutation: string;
  /** `false` marks a deliberate CONTROL: an input this family does not depend on. */
  readonly invalidates: boolean;
  /** Applied to the baseline inputs; may be async for on-disk work. */
  readonly apply: (inputs: ProofInputs) => ProofInputs | Promise<ProofInputs>;
  /**
   * Optional, OBSERVATIONAL assertion on F3's taxonomy (F4 § 18). The
   * proof invariant never depends on it -- see the record's
   * "taxonomy is observational" note.
   */
  readonly expectUncertaintyReason?: string;
  /** Set for the deliberate multi-prerequisite rows of F4 § 23. */
  readonly composite?: boolean;
}

/** One recorded (family, mutation) result. */
export interface MutationRecord {
  readonly family: ProofFamily;
  readonly mutation: string;
  readonly classification: MutationClass;
  readonly verdict: Verdict | undefined;
  readonly resultingFamily: ProofFamily;
}

/**
 * Classifies one mutation against its baseline.
 *
 * The ONLY unsafe outcome is the original family still being reported
 * after one of its own prerequisites was removed. Everything else is a
 * legitimate shape the architecture genuinely has.
 */
export function classifyMutation(
  baselineFamily: ProofFamily,
  row: Pick<ProofMutationRow, "invalidates">,
  outcome: MutationOutcome,
): MutationClass {
  if (!row.invalidates) {
    return outcome.family === baselineFamily
      ? "not_a_prerequisite"
      : "invalidated_by_takeover";
  }
  if (outcome.family === baselineFamily) {
    return "unsafe_survival";
  }
  if (outcome.verdict === "NOT_AFFECTED") {
    return "invalidated_by_takeover";
  }
  if (outcome.verdict === "AFFECTED") {
    return "invalidated_to_affected";
  }
  return "invalidated_to_unknown";
}

/**
 * Accumulates every mutation result across the whole F4 suite so the
 * false-NOT_AFFECTED metric (F4 § 28) is MEASURED rather than asserted
 * case by case.
 */
export function createMutationLedger(): {
  readonly record: (record: MutationRecord) => void;
  readonly all: () => readonly MutationRecord[];
  readonly summary: () => Readonly<Record<MutationClass | "total", number>>;
} {
  const records: MutationRecord[] = [];
  return {
    record(record: MutationRecord): void {
      records.push(record);
    },
    all(): readonly MutationRecord[] {
      return records;
    },
    summary(): Readonly<Record<MutationClass | "total", number>> {
      const counts: Record<MutationClass | "total", number> = {
        total: records.length,
        invalidated_to_unknown: 0,
        invalidated_by_takeover: 0,
        invalidated_to_affected: 0,
        not_a_prerequisite: 0,
        unsafe_survival: 0,
      };
      for (const record of records) {
        counts[record.classification] += 1;
      }
      return counts;
    },
  };
}

// --------------------------------------------------------------------
// Closure mutators. Each changes exactly ONE closure property, so a matrix
// row can name the single prerequisite it removed (F4 § 21).
// --------------------------------------------------------------------

/** `complete: true -> false`, carrying a concrete incompleteness reason. */
export function closureIncomplete(
  closure: ModuleLoadClosure,
  reason: ClosureIncompletenessReason,
): ModuleLoadClosure {
  return {
    ...closure,
    complete: false,
    incompleteness: [
      ...closure.incompleteness,
      { reason, importer: closure.rootFiles[0] ?? "<unknown>" },
    ],
  };
}

/**
 * Adds an incompleteness record WITHOUT touching `complete`.
 *
 * Not a shape a real builder produces -- it keeps `complete === true`
 * beside a recorded blocker -- and that is the point: it isolates which of
 * the two fields each guard actually reads. Family A reads `complete`;
 * `callGraphNegativeProofBlockers` reads `incompleteness`.
 */
export function closureWithBlocker(
  closure: ModuleLoadClosure,
  reason: ClosureIncompletenessReason,
): ModuleLoadClosure {
  return {
    ...closure,
    incompleteness: [
      ...closure.incompleteness,
      { reason, importer: closure.rootFiles[0] ?? "<unknown>" },
    ],
  };
}

/** Claims an instance IS loaded, withdrawing every absence claim about it. */
export function closureLoads(
  closure: ModuleLoadClosure,
  instance: string,
): ModuleLoadClosure {
  return {
    ...closure,
    loadedPackageInstances: [...closure.loadedPackageInstances, instance],
  };
}

/** Removes an instance from the loaded set -- the "closure forgot it" direction. */
export function closureForgets(
  closure: ModuleLoadClosure,
  instance: string,
): ModuleLoadClosure {
  return {
    ...closure,
    loadedPackageInstances: closure.loadedPackageInstances.filter(
      (loaded) => loaded !== instance,
    ),
  };
}

/** Strips the roots: a zero-root closure is never gate-eligible. */
export function closureWithoutRoots(
  closure: ModuleLoadClosure,
): ModuleLoadClosure {
  return { ...closure, rootFiles: [] };
}

/** Rebinds the closure to roots it was never traversed over. */
export function closureWithRoots(
  closure: ModuleLoadClosure,
  rootFiles: readonly string[],
): ModuleLoadClosure {
  return { ...closure, rootFiles: [...rootFiles] };
}

/** Rewrites the canonical identity of one loaded file. */
export function closureWithFileRenamed(
  closure: ModuleLoadClosure,
  from: string,
  to: string,
): ModuleLoadClosure {
  return {
    ...closure,
    loadedFiles: closure.loadedFiles.map((file) => (file === from ? to : file)),
  };
}

// --------------------------------------------------------------------
// Call-graph mutators.
// --------------------------------------------------------------------

/** Drops every node whose module path lies under `instanceRoot`. */
export function graphWithoutInstance(
  graph: CallGraph,
  instanceRoot: string,
): CallGraph {
  const removed = new Set(
    graph.nodes
      .filter((node) => node.module.startsWith(instanceRoot))
      .map((node) => node.id),
  );
  return {
    nodes: graph.nodes.filter((node) => !removed.has(node.id)),
    edges: graph.edges.filter(
      (edge) => !removed.has(edge.from) && !edgeTargets(edge, removed),
    ),
  };
}

function edgeTargets(
  edge: CallGraph["edges"][number],
  ids: ReadonlySet<string>,
): boolean {
  return edge.resolution.kind === "resolved" && ids.has(edge.resolution.target);
}

/** Drops one node by id, plus every edge that touched it. */
export function graphWithoutNode(graph: CallGraph, id: string): CallGraph {
  const removed = new Set([id]);
  return {
    nodes: graph.nodes.filter((node) => node.id !== id),
    edges: graph.edges.filter(
      (edge) => edge.from !== id && !edgeTargets(edge, removed),
    ),
  };
}

/** Adds a node the real analysis never discovered. */
export function graphWithNode(graph: CallGraph, node: GraphNode): CallGraph {
  return { nodes: [...graph.nodes, node], edges: graph.edges };
}

/** Drops every edge into `to` -- severing a call path without touching nodes. */
export function graphWithoutEdgesTo(graph: CallGraph, to: string): CallGraph {
  const removed = new Set([to]);
  return {
    nodes: graph.nodes,
    edges: graph.edges.filter((edge) => !edgeTargets(edge, removed)),
  };
}

/**
 * Inserts an unresolved call edge on every entrypoint module node.
 *
 * `reason` decides WHICH guard the mutation exercises, and the two are
 * deliberately separable:
 *
 * - a CLOSURE-WIDENING reason (`dynamic_require`, ...) is what VT-300's
 *   `hasReachableClosureWideningBlocker` inspects, and therefore what
 *   withdraws family B's call-graph absence;
 * - a NON-widening reason (`unsupported_construct`, ...) cannot load a new
 *   module, so VT-300 ignores it -- but `analyzeReachability` still returns
 *   `unknown` for it, which is precisely the condition
 *   `reachableSubgraphComplete` asserts the absence of.
 *
 * One mutator, two isolated prerequisites, chosen by the caller.
 */
export function graphWithUnresolvedEdge(
  graph: CallGraph,
  entrypointFiles: readonly string[],
  reason: DynamicCallReason,
): CallGraph {
  const roots = new Set(entrypointFiles);
  const edges = [...graph.edges];
  for (const node of graph.nodes) {
    if (node.kind === "module" && roots.has(node.module)) {
      edges.push({
        from: node.id,
        type: "direct",
        resolution: { kind: "unknown", reason, potentialTargets: [] },
        location: { file: node.module, line: 1, column: 1 },
      });
    }
  }
  return { nodes: graph.nodes, edges };
}

/** The VT-300 shape: an unresolved edge that could LOAD a new module. */
export function graphWithWideningEdge(
  graph: CallGraph,
  entrypointFiles: readonly string[],
): CallGraph {
  return graphWithUnresolvedEdge(graph, entrypointFiles, "dynamic_require");
}

// --------------------------------------------------------------------
// The workspace: real on-disk projects, real graphs, real closures.
// --------------------------------------------------------------------

/** A project to materialize. Paths are relative to the generated root. */
export interface ProofProject {
  readonly files: Readonly<Record<string, string>>;
  readonly entries: readonly string[];
  /** Install locations registered as dependency-graph instances. */
  readonly installs: readonly string[];
  /** Which install the FINDING is about. Must be one of `installs`. */
  readonly findingInstall: string;
  readonly packageName?: string;
  readonly packageVersion?: string;
  readonly rule?: VulnerableSymbolRule;
  readonly symlinks?: readonly {
    readonly target: string;
    readonly link: string;
  }[];
}

/** A materialized project plus the canonical identities its tests need. */
export interface MaterializedProof {
  readonly inputs: ProofInputs;
  readonly root: string;
  /** Canonical `PackageInstanceId` per declared install, keyed by relative path. */
  readonly instances: ReadonlyMap<string, string>;
  /** Absolute path of each entrypoint, in declaration order. */
  readonly entryFiles: readonly string[];
}

export const DEFAULT_PACKAGE = "vuln-lib";

export function defaultVulnerability(
  packageName: string = DEFAULT_PACKAGE,
): Vulnerability {
  return {
    id: "GHSA-f4-0001",
    aliases: [],
    package: packageName,
    ecosystem: "npm",
    affectedVersions: [],
    fixedVersions: [],
    references: [],
  };
}

export function defaultRule(
  packageName: string = DEFAULT_PACKAGE,
): VulnerableSymbolRule {
  return {
    id: "GHSA-f4-0001",
    package: { name: packageName },
    targets: [
      {
        module: packageName,
        export: "vulnerable",
        kind: "function",
        confidence: 1,
      },
    ],
  };
}

/**
 * Creates real projects on disk and tears them down.
 *
 * Real files rather than synthetic graphs, deliberately: a mutation
 * harness that can only mutate hand-written closures proves things about
 * hand-written closures. Every baseline here is produced by
 * `loadTsProject` + `buildCallGraph` + `buildGateEligibleModuleLoadClosure`
 * -- the same three calls `cli/scan.ts` makes.
 */
export function createProofWorkspace(): {
  readonly materialize: (project: ProofProject) => Promise<MaterializedProof>;
  readonly cleanup: () => void;
} {
  const roots: string[] = [];

  async function materialize(
    project: ProofProject,
  ): Promise<MaterializedProof> {
    const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-f4-"));
    roots.push(root);

    const write = (relativePath: string, content: string): void => {
      const full = path.join(root, relativePath);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    };
    if (!("package.json" in project.files)) {
      write("package.json", JSON.stringify({ name: "app" }));
    }
    for (const [relativePath, content] of Object.entries(project.files)) {
      write(relativePath, content);
    }
    for (const link of project.symlinks ?? []) {
      mkdirSync(path.dirname(path.join(root, link.link)), { recursive: true });
      symlinkSync(
        path.join(root, link.target),
        path.join(root, link.link),
        "dir",
      );
    }

    const packageName = project.packageName ?? DEFAULT_PACKAGE;
    const packageVersion = project.packageVersion ?? "1.0.0";
    const tsProject = loadTsProject(root);
    const resolver = createModuleResolver(tsProject);
    const dependencyNodes: DependencyNode[] = project.installs.map(
      (relativePath, index) => ({
        id: `${packageName}@${index}`,
        name: packageName,
        version: packageVersion,
        ecosystem: "npm",
        direct: index === 0,
        locations: [path.join(root, relativePath)],
        dependencyPaths: [],
      }),
    );
    const knownPackageRoots = buildKnownPackageRoots(dependencyNodes, root);
    const entrypoints: Entrypoint[] = project.entries.map((relativePath) => ({
      filePath: path.join(root, relativePath),
      source: "configured",
      reason: "f4-proof-mutation",
    }));
    const moduleLoadClosure = await buildGateEligibleModuleLoadClosure({
      entrypoints,
      resolver,
      maxFiles: 5000,
      knownPackageRoots,
    });
    const graph = await buildCallGraph({
      entryFiles: entrypoints.map((entry) => entry.filePath),
      resolver,
      project: tsProject,
    });

    const instances = new Map<string, string>(
      project.installs.map((relativePath) => [
        relativePath,
        canonicalizePackageInstancePath(path.join(root, relativePath)),
      ]),
    );

    return {
      root,
      instances,
      entryFiles: entrypoints.map((entry) => entry.filePath),
      inputs: {
        projectRoot: root,
        resolver,
        entrypoints,
        knownPackageRoots,
        graph,
        graphTruncated: false,
        moduleLoadClosure,
        vulnerability: defaultVulnerability(packageName),
        packageName,
        packageVersion,
        packageInstance: instances.get(project.findingInstall),
        matchResult: "affected",
        rule: project.rule ?? defaultRule(packageName),
      },
    };
  }

  return {
    materialize,
    cleanup(): void {
      while (roots.length > 0) {
        const root = roots.pop();
        if (root) {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  };
}
