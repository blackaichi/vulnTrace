import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildModuleModel,
  entrypointRootCandidates,
  findExportedClassMembers,
  mapExportsToFunctions,
} from "../code-intelligence/module-model.js";
import type { ModuleResolver } from "../code-intelligence/module-resolver.js";
import { indexSourceFileFromDisk } from "../code-intelligence/source-index.js";
import {
  isClosureWideningReason,
  type CallGraph,
  type GraphNode,
  type GraphNodeId,
} from "../domain/graph.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import {
  identifyModule,
  type KnownPackageRoots,
} from "../domain/resolved-target.js";
import type {
  VulnerableSymbolRule,
  VulnerableSymbolTarget,
} from "../domain/target.js";
import type { Finding } from "../domain/verdict.js";
import {
  type AnalysisProofContext,
  isAnalysisProofContext,
} from "./analysis-context.js";
import type { ConfirmedAbsentFromModuleLoadClosure } from "../domain/evidence.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import type { VersionMatchResult } from "../vulnerabilities/version-matching.js";
import {
  callGraphNegativeProofBlockers,
  closureContainsPackageInstance,
  type ModuleLoadClosure,
} from "./module-load-closure.js";
import {
  analyzeReachability,
  collectReachableUnknownEdges,
} from "./reachability.js";

export interface BuildFindingOptions {
  readonly vulnerability: Vulnerability;
  readonly packageName: string;
  readonly packageVersion: string;
  /**
   * This finding's own installed instance's absolute path (see VT-212,
   * SDD-v0.2.md § 4.3) — the dependency graph's `DependencyNode.locations`,
   * resolved against the project root. Authoritative for which
   * graph-discovered instance's reachability this finding may use: without
   * it, a package with multiple installed instances can have one
   * instance's finding silently inherit a *different* instance's
   * reachability result whenever the call graph happens to have discovered
   * only one of them (confirmed by the independent v2 adversarial suite,
   * ADV2-045). Optional so existing callers/tests that predate VT-212 keep
   * their current (approximate, version-string-based) behavior.
   */
  readonly packageInstance?: string;
  /** From TASK-011's matchVersion/matchVulnerabilities. */
  readonly matchResult: VersionMatchResult;
  /** From TASK-012's indexRulesByVulnerabilityId lookup; `undefined` if no rule targets this vulnerability. */
  readonly rule: VulnerableSymbolRule | undefined;
  /**
   * EVERY per-scan, proof-relevant input, bound together (VT-CONTRACT-03).
   *
   * Replaces what used to be six independent options -- `graph`,
   * `entrypoints`, `resolver`, `projectRoot`, `knownPackageRoots`,
   * `graphTruncated` and `moduleLoadClosure`. Independent options meant a
   * caller could supply most of them from one scan and the rest from
   * another, and a closure from an unrelated project trivially does not
   * contain this project's install paths -- so "absent from a complete
   * closure" was satisfiable with evidence that proved nothing. That was
   * reproduced end-to-end against the pre-fix tree, turning a genuinely
   * loaded-and-called instance's correct UNKNOWN into a false NOT_AFFECTED.
   *
   * Bundling them makes the mixture unrepresentable: there is no argument
   * left to pass from the wrong scan. See
   * `analysis/analysis-context.ts` for the brand and the runtime mark that
   * close the remaining fabricate-a-context route.
   */
  readonly context: AnalysisProofContext;
  /**
   * Test-only escape hatch (VT-301B; see RWF-011,
   * docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 7.3/§ 10, R-6). Allows
   * `findExportNodeInFile`'s same-file bare-name target match as a last
   * resort — a construct that is unsafe against real, indexed production
   * files (a coincidentally same-named function has no real relationship
   * to a rule's target) but is the ONLY resolution mechanism available to
   * synthetic/test graphs that construct `GraphNode`s directly with no
   * real file on disk behind them at all (see verdict.test.ts).
   *
   * Defaults to `false`/unset. No production caller (the real CLI scan
   * path — `src/cli/scan.ts`) sets this; it is not exposed through
   * `vulntrace.yml` or any CLI flag, deliberately — this is an internal
   * API seam for tests, not a configurable analysis behavior. A real file
   * that cannot be read or parsed does NOT implicitly enable this (see
   * `findExportNodeInFile`'s own doc comment): only this explicit flag
   * does, regardless of why structural attribution failed.
   */
  readonly allowSyntheticNameOnlyTargetBinding?: boolean;
}

/**
 * The reason string a NOT_AFFECTED carries when, and only when, it was
 * reached through VT-307d's module-load absence proof.
 *
 * Deliberately its own distinct value, never folded into the ordinary
 * "vulnerable symbol confirmed unreachable from all analyzed entrypoints"
 * text: the two conclusions are established by different evidence, over
 * different traversals, with different preconditions, and a reader must be
 * able to tell them apart. This one says the package's code never runs at
 * all; the ordinary one says the package's code may well run but this
 * symbol is not called.
 */
const MODULE_LOAD_ABSENCE_REASON =
  "package_instance_not_in_complete_module_load_closure";

/**
 * PROOF FAMILY B's own reason (VT-307e, hardened by VT-307e's own final
 * audit).
 *
 * Before VT-307e this proof emitted family C's
 * "vulnerable symbol confirmed unreachable..." string, so two materially
 * different conclusions were indistinguishable in the output: "the call
 * graph never traversed this install location at all" versus "the code was
 * analyzed and no path to the symbol exists". Phase 8's 1:1 reason-to-proof
 * rule requires they be told apart.
 *
 * Renamed from `package_instance_absent_from_complete_call_graph` when the
 * audit reproduced a false NOT_AFFECTED under that exact name: a
 * non-truncated call graph is NOT a complete one -- the call graph never
 * follows a re-export declaration (`export * from "pkg"`) as a discovery
 * edge at all (VT-307c-fix-8 added that traversal to `ModuleLoadClosure`
 * ONLY), so a package instance reached solely through a re-export chain is
 * genuinely loaded and called while remaining entirely invisible to a
 * "complete" (merely non-truncated) call graph. The old name asserted a
 * completeness the call graph never had. This proof is sound only because
 * it now additionally requires independent corroboration from a complete
 * `ModuleLoadClosure` (see the `confirmedAbsentInstance` branch below) --
 * the new name names BOTH sources the conclusion rests on, not just one.
 */
const INSTANCE_ABSENT_FROM_CALL_GRAPH_REASON =
  "package_instance_absent_from_call_graph_and_module_load_closure";

/**
 * PROOF FAMILY C's reason, deliberately UNCHANGED (VT-307e).
 *
 * Kept as the existing human-readable string rather than migrated to a
 * slug: it is already 1:1 with family C once family B has its own reason
 * above, and it is asserted by existing e2e/output/verdict tests whose
 * expectations encode real user-visible output. Family C's machine-readable
 * contract is the new `confirmedUnreachableTarget` evidence object, not
 * this string.
 */
const TARGET_UNREACHABLE_REASON =
  "vulnerable symbol confirmed unreachable from all analyzed entrypoints";

function locationOf(graph: CallGraph, id: GraphNodeId): string {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) {
    return id;
  }
  if (node.location) {
    return `${node.location.file}:${node.location.line ?? ""}`;
  }
  return node.module;
}

function moduleNode(graph: CallGraph, filePath: string): GraphNode | undefined {
  return graph.nodes.find((n) => n.kind === "module" && n.module === filePath);
}

/**
 * Finds every graph node implementing `{module: resolvedFile, export:
 * exportName}` — usually exactly one, but see the class-member step below
 * for when more than one is a structurally valid answer. Returns `[]`
 * when nothing could be attributed at all — a real, indexed file for
 * which neither structural path below attributes anything is NEVER
 * rescued by a same-file bare-name search (VT-301B; see RWF-011,
 * docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 7.3/§ 10, R-6): a function
 * merely sharing `exportName`'s literal text, with no real export
 * relationship to it, is coincidence, not provenance, and binding a
 * vulnerability target to it can manufacture a false `NOT_AFFECTED` the
 * moment that unrelated function happens to be unreachable.
 *
 * A rule's `export` names the module's *canonical* export (e.g. `"default"`
 * for CommonJS's `module.exports = someNamedFunction;` idiom — extremely
 * common across the real npm ecosystem, e.g. lodash's per-method files),
 * which can differ from the underlying function's own declared name (here,
 * `someNamedFunction`). A GraphNode's `.name` is always the function's own
 * declared name (see call-graph.ts's `prepareFile`), never the canonical
 * export label, so matching `n.name === exportName` directly only works
 * when the two happen to coincide (true for ESM named exports, false for a
 * CJS whole-module default export). Re-deriving the same canonical-export
 * -> function mapping call-graph.ts already builds internally
 * (`mapExportsToFunctions`, see module-model.ts) and matching the graph by
 * that function's real source location fixes this — this was previously a
 * real bug: a rule targeting `export: "default"` against a
 * `module.exports = zipObjectDeep;`-shaped file always fell through to a
 * phantom node and reported NOT_AFFECTED even when genuinely reachable.
 *
 * When `exportName` isn't a canonical module-level export at all (the
 * common shape for `kind: "method"`/`"constructor"` rule targets, e.g.
 * `export: "runDangerous"` naming a *method* of an exported class, not the
 * class itself), falls to structural class-member attribution (VT-301A;
 * see {@link findExportedClassMembers}) — export -> exported class ->
 * class member -> location, never a same-file name search. When more than
 * one exported class legitimately declares a member with that name, every
 * one is returned: this function does not pick a candidate arbitrarily,
 * that is `checkReachability`'s existing OR-across-nodes job.
 *
 * `allowSyntheticNameOnlyTargetBinding` is the ONLY thing that can still
 * reach the bare same-file name match below, and defaults to `false` in
 * every production caller (see `BuildFindingOptions`). It exists purely
 * for synthetic/test graphs that construct `GraphNode`s directly with no
 * real file behind them at all (see verdict.test.ts) — there, the graph
 * itself is the only available source of truth, so a name match is the
 * only mechanism those tests have. Deliberately NOT inferred from whether
 * `indexSourceFileFromDisk` throws: a real, installed production file
 * that happens to be unreadable or unparseable must degrade to an
 * unresolved target (preserving uncertainty), never silently gain the
 * same unsafe name-only binding a synthetic test explicitly opted into.
 */
function findExportNodeInFile(
  graph: CallGraph,
  resolvedFile: string,
  exportName: string,
  allowSyntheticNameOnlyTargetBinding: boolean,
): GraphNode[] {
  const byLocation = (fn: {
    readonly location: { readonly line?: number; readonly column?: number };
  }): GraphNode | undefined =>
    graph.nodes.find(
      (n) =>
        n.module === resolvedFile &&
        n.location?.line === fn.location.line &&
        n.location?.column === fn.location.column,
    );

  try {
    const index = indexSourceFileFromDisk(resolvedFile);
    const model = buildModuleModel(index);
    const exportedFn = mapExportsToFunctions(index, model).get(exportName);
    if (exportedFn) {
      const node = byLocation(exportedFn);
      if (node) {
        return [node];
      }
    }

    const memberCandidates = findExportedClassMembers(index, model, exportName);
    if (memberCandidates.length > 0) {
      const nodes = memberCandidates
        .map(byLocation)
        .filter((n): n is GraphNode => n !== undefined);
      if (nodes.length > 0) {
        return nodes;
      }
    }
  } catch {
    // Target file unreadable/unparsable -- NOT synthetic-mode inference;
    // see this function's own doc comment. Falls through to the same
    // opt-in gate below as a successfully-indexed-but-unattributed file.
  }

  if (!allowSyntheticNameOnlyTargetBinding) {
    return [];
  }

  const fallback = graph.nodes.find(
    (n) => n.module === resolvedFile && n.name === exportName,
  );
  return fallback ? [fallback] : [];
}

/**
 * A phantom placeholder for a target that could not be matched to any real
 * graph node. Not a guess at reachability: nothing in the graph points to
 * it (its id can never collide with a real generated one — see
 * call-graph.ts's `${filePath}#${name}@${line}:${column}` scheme, which
 * this deliberately does not match), so handing it to
 * {@link analyzeReachability} still produces a correct answer. If the
 * target genuinely is reachable, its file would already have been
 * discovered and indexed while building the graph (TASK-018's on-demand
 * traversal discovers every file any resolved call chain passes through);
 * if it was never discovered, the only way it could still be reachable is
 * through a dynamic/unresolved construct somewhere in the searched
 * region — which the same reachability search already detects and reports
 * as `unknown` rather than `unreachable`.
 */
function phantomNode(resolvedFile: string, exportName: string): GraphNode {
  return {
    id: `unresolved-target:${resolvedFile}#${exportName}`,
    kind: "function",
    module: resolvedFile,
    name: exportName,
  };
}

/**
 * Every distinct installed instance of `packageName` the call graph itself
 * already discovered via real resolved imports (see
 * docs/SDD.md § 18; SDD-v0.2.md § 4's `identifyModule`), grouped by
 * `packageInstance` so `node_modules/foo` and
 * `node_modules/bar/node_modules/foo` are never conflated (SDD-v0.2.md
 * § 4.2). Each instance maps to every distinct resolved file the graph
 * discovered within it (there can be more than one, e.g. separate
 * conditional-exports entry files for the same installed package).
 */
function graphPackageInstances(
  graph: CallGraph,
  packageName: string,
  knownPackageRoots: KnownPackageRoots | undefined,
): Map<string, Set<string>> {
  const byInstance = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    const identity = identifyModule(node.module, knownPackageRoots);
    if (identity.packageName !== packageName || !identity.packageInstance) {
      continue;
    }
    const files = byInstance.get(identity.packageInstance) ?? new Set<string>();
    files.add(node.module);
    byInstance.set(identity.packageInstance, files);
  }
  return byInstance;
}

/** Reads `<packageInstance>/package.json`'s own declared version, or `undefined` if it can't be read/parsed. */
function readInstalledVersion(packageInstance: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(path.join(packageInstance, "package.json"), "utf-8"),
    );
    const version = (raw as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves a rule target's `{module, export}` to every matching graph node
 * (see docs/SDD.md § 17-18; SDD-v0.2.md § 5 "Single Resolution Source of
 * Truth"). Reuses graph-discovered resolved targets first — every
 * installed instance of `target.module` the call graph itself already
 * traversed to via a real resolved import — instead of independently
 * re-resolving from a single, generic project-root context. That
 * independent resolution can disagree with what the graph actually
 * traversed: a different conditional-exports branch (e.g. `"require"` vs
 * the real `"import"` context a call site actually used), or a different
 * installed instance entirely for a non-hoisted, multiple-version
 * dependency. Both were confirmed, by direct call-graph inspection, to
 * produce a false NOT_AFFECTED before this fix (see VT-204;
 * SDD-v0.2.md § 4's own multiple-version example).
 *
 * When `packageInstance` is known (the finding's own dependency-graph-
 * resolved install path — see VT-212, SDD-v0.2.md § 4.3), it is
 * authoritative: only graph-discovered instances at exactly that path are
 * used, never a different instance merely because it's the only one the
 * call graph happened to traverse. When the graph never traversed that
 * specific instance at all, this returns `confirmedAbsentInstance: true`
 * rather than silently substituting an unrelated instance's nodes — a
 * finding for one installed instance must never inherit another instance's
 * reachability result (confirmed by the independent v2 adversarial suite,
 * ADV2-045: with two installed instances at different versions and only
 * one ever imported, the unreached instance's finding previously inherited
 * the reached instance's AFFECTED verdict).
 *
 * When `packageInstance` is unavailable (callers that predate VT-212) but
 * `packageVersion` is known and more than one distinct installed instance
 * is present in the graph, falls back to the pre-VT-212 heuristic: prefer
 * instances whose own `package.json` declares that exact version. This
 * heuristic is necessarily approximate — it cannot detect a finding whose
 * own instance was never discovered by the graph at all, which is exactly
 * what `packageInstance` fixes.
 *
 * Only falls back to a fresh, independent resolution (the pre-VT-204
 * behavior) when the graph never discovered ANY instance of the package at
 * all — the common, legitimate case where nothing in the analyzed code
 * ever imports it.
 *
 * Two structurally different "target not found" cases exist here (VT-301B;
 * see docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 3/§ 15's Site A/Site B):
 *
 * - **Site A** (`instances.size > 0`, below): the package instance genuinely
 *   IS in the graph — something real touched it — but `target.export`
 *   could not be attributed to any node within it. The module loaded; only
 *   the symbol's own identity is unknown. Returns `unresolvedReason`
 *   directly rather than a phantom: SDD.md § 23's "vulnerable target
 *   known?" is answered NO here, so this must become UNKNOWN, never risk a
 *   reachability search concluding a confident (and false) NOT_AFFECTED
 *   against a target it never actually identified.
 * - **Site B** (`instances.size === 0`, below): the package was never
 *   discovered by the graph at all — genuinely unimported. A phantom fed
 *   into reachability search is correct and intentional here: if nothing
 *   in the entrypoint's reachable code even references this package,
 *   "unreachable" is a positively established conclusion (this is exactly
 *   what VT-212/VT-300 already rely on and guard — see
 *   `confirmedAbsentInstance` above and `hasReachableClosureWideningBlocker`
 *   in `checkReachability`). Deliberately left unchanged by VT-301B.
 */
async function resolveTargetNodes(
  graph: CallGraph,
  target: VulnerableSymbolTarget,
  resolver: ModuleResolver,
  referenceFile: string,
  packageVersion: string | undefined,
  packageInstance: string | undefined,
  allowSyntheticNameOnlyTargetBinding: boolean,
  knownPackageRoots: KnownPackageRoots | undefined,
  moduleLoadClosure: ModuleLoadClosure | undefined,
): Promise<{
  nodes: GraphNode[];
  unresolvedReason?: string;
  confirmedAbsentInstance?: boolean;
  /**
   * VT-307d's positive module-load absence proof. Deliberately a SEPARATE
   * result from `confirmedAbsentInstance`, never an overload of it: that
   * flag means "the CALL GRAPH never traversed this instance", which is
   * evidence only under VT-300's own closure-widening guard. This one
   * means "the complete MODULE-LOAD CLOSURE does not contain this
   * instance", which is a different traversal proving a stronger fact.
   */
  absentFromModuleLoadClosure?: ConfirmedAbsentFromModuleLoadClosure;
}> {
  const instances = graphPackageInstances(
    graph,
    target.module,
    knownPackageRoots,
  );

  if (instances.size > 0) {
    let selected = [...instances.entries()];

    if (packageInstance) {
      const instanceMatched = selected.filter(
        ([instance]) => instance === packageInstance,
      );
      if (instanceMatched.length === 0) {
        // The graph discovered other instance(s) of this package name, but
        // never traversed THIS finding's own instance -- not "traversed
        // the wrong one", genuinely never visited. Under a non-truncated
        // graph, TASK-018's on-demand discovery is complete, so this
        // absence is itself positive evidence of non-reachability
        // (SDD-v0.2.md § 3.3, § 4.3); it must not fall through to using a
        // different instance's nodes.
        return { nodes: [], confirmedAbsentInstance: true };
      }
      selected = instanceMatched;
    } else if (packageVersion && instances.size > 1) {
      const versionMatched = selected.filter(
        ([instance]) => readInstalledVersion(instance) === packageVersion,
      );
      if (versionMatched.length > 0) {
        selected = versionMatched;
      }
    }

    const nodes: GraphNode[] = [];
    for (const [, files] of selected) {
      for (const file of files) {
        nodes.push(
          ...findExportNodeInFile(
            graph,
            file,
            target.export,
            allowSyntheticNameOnlyTargetBinding,
          ),
        );
      }
    }

    if (nodes.length > 0) {
      return { nodes };
    }

    // Site A (VT-301B; see this function's own doc comment above): the
    // package instance is genuinely present in the graph, but
    // target.export could not be attributed to any node within it. NOT a
    // phantom -- an explicit unresolved target, so checkReachability's
    // existing "could not resolve module" handling degrades this straight
    // to UNKNOWN without ever running a reachability search against a
    // target whose own identity was never established.
    return {
      nodes: [],
      unresolvedReason: `export "${target.export}" could not be attributed to any function or class member in the resolved module`,
    };
  }

  const resolution = await resolver.resolve(target.module, referenceFile);
  if (resolution.kind === "unresolved") {
    return { nodes: [], unresolvedReason: resolution.reason };
  }

  // VT-304 (RWF-005/R-4): the module resolved only to a TypeScript
  // declaration file, never a runtime implementation -- there is no
  // concrete runtime target to bind, so this must become UNKNOWN
  // (`unresolvedReason`, unconditionally, same as an outright resolution
  // failure above), never fall through and search a phantom/real node as
  // though genuine runtime evidence were available.
  if (resolution.kind === "declaration") {
    return {
      nodes: [],
      unresolvedReason: `module "${target.module}" resolved only to a TypeScript declaration file (${resolution.resolvedFileName}), not a runtime implementation`,
    };
  }

  // VT-305 (RWF-007): a rule targeting a Node builtin module by name has
  // no filesystem file to bind to (see module-resolver.ts's
  // {@link BuiltinModule}) -- out of this benchmark's practical scope, but
  // handled the same conservative way as a declaration-only resolution
  // rather than left to fall through into a field access that doesn't
  // exist on this variant.
  if (resolution.kind === "builtin") {
    return {
      nodes: [],
      unresolvedReason: `module "${target.module}" is a Node builtin module, not a resolvable runtime file`,
    };
  }

  // VT-307d -- MODULE-LOAD ABSENCE PROOF. Sits here, at Site B, and
  // nowhere else. Everything above has already run: the advisory applied,
  // the installed version matched a vulnerable range (buildFinding returns
  // before this for `not_affected`/`indeterminate`), a rule with targets
  // exists, and this target's module resolved to a real runtime file. Only
  // then is it meaningful to ask whether that file's package can load at
  // all. Placed BEFORE the phantom construction and the reachability BFS
  // below because the answer makes both unnecessary: if the package's code
  // never runs, no search through the call graph can change that.
  //
  // Every conjunct is load-bearing:
  //
  // - `moduleLoadClosure !== undefined`: `undefined` means no proof is
  //   available (no entrypoints, or construction failed). It must never be
  //   read as "an empty closure", which would assert that every installed
  //   package is unloadable.
  // - gate-eligible BY CONSTRUCTION: the only producer is
  //   `buildGateEligibleModuleLoadClosure`, which requires
  //   `knownPackageRoots` at the type level and refuses to return a
  //   root-less closure. `rootFiles.length > 0` is re-asserted here anyway
  //   -- a vacuously complete, zero-root closure contains NO package
  //   instance, so it would "prove" absence for every finding in the
  //   project, and this is the single cheapest place to make that
  //   impossible twice over.
  // - `complete === true`: the entire soundness precondition. Any parse
  //   failure, unresolved or declaration-only module, traversal
  //   truncation, or in-source loader/runtime capability anywhere in the
  //   closure sets this false and withdraws the proof. That is exactly why
  //   this gate may safely ignore unrelated NON-WIDENING call-graph
  //   uncertainty (RWF-002/RWB-06): a construct that could actually load a
  //   new module is closure-widening, and closure-widening constructs make
  //   the closure incomplete, so they disable this gate rather than being
  //   ignored by it.
  // - exact `packageInstance` identity: an install LOCATION, compared
  //   whole. Never a package name, never a version, never name+version --
  //   two same-name same-version installs at different locations get
  //   independent answers.
  // - the resolved target file must genuinely belong to THAT instance.
  //   Without this, a rule target naming a module that resolves into some
  //   OTHER installed package would be answered with a proof about this
  //   finding's package, which is not the same question.
  if (
    packageInstance !== undefined &&
    moduleLoadClosure !== undefined &&
    moduleLoadClosure.complete &&
    moduleLoadClosure.rootFiles.length > 0 &&
    !closureContainsPackageInstance(moduleLoadClosure, packageInstance) &&
    identifyModule(resolution.resolvedFileName, knownPackageRoots)
      .packageInstance === packageInstance
  ) {
    return {
      nodes: [],
      absentFromModuleLoadClosure: {
        packageInstance,
        entrypointRoots: moduleLoadClosure.rootFiles,
        closureComplete: true,
      },
    };
  }

  // Site B (VT-301B; see this function's own doc comment above):
  // deliberately unchanged -- the package was never discovered by the
  // graph at all, so a phantom target feeding a genuinely clean,
  // fully-resolved reachability search to "unreachable" remains correct.
  const nodes = findExportNodeInFile(
    graph,
    resolution.resolvedFileName,
    target.export,
    allowSyntheticNameOnlyTargetBinding,
  );
  return {
    nodes:
      nodes.length > 0
        ? nodes
        : [phantomNode(resolution.resolvedFileName, target.export)],
  };
}

interface ReachableEvidence {
  readonly target: VulnerableSymbolTarget;
  readonly path: readonly GraphNodeId[];
}

/**
 * The graph nodes that count as reachability starting points for one
 * entrypoint.
 *
 * When `entrypoint.symbol` is configured (SDD-v0.2.md § 6's `{file,
 * symbol}` form), sources are exactly the file's `<module>` node (loading
 * a module always runs its top-level code, regardless of which export
 * gets called afterwards -- that much is real JS/Node semantics, not a
 * VulnTrace liberty) plus that one named symbol's own node. Any other
 * export living in the same file is deliberately excluded: SDD-v0.2.md
 * § 6 requires that "only that symbol is an entrypoint source" and that
 * other exports "are not automatically reachable" (see VT-205).
 *
 * Without a configured `symbol` (the pre-VT-205 form, kept for backward
 * compatibility), sources are the `<module>` node plus every one of the
 * file's own exported functions -- unchanged from before VT-205. An
 * entrypoint file's exports are, by definition of being an entrypoint,
 * invocable from outside the analyzed codebase (a CLI's default export, a
 * required module's callable surface, ...) even when the file itself
 * never calls them at module scope — e.g. `export function main() { ... }`
 * with no top-level `main()` call. Without this, `main`'s own body (and
 * anything it calls) would be invisible to reachability analysis purely
 * because nothing *inside the file* happens to invoke it. This is the
 * correct default only when no more precise `symbol` narrows it.
 *
 * Which names those exports contribute is decided by
 * {@link entrypointRootCandidates} (RWF-021), NOT by reading export
 * attribution here. The distinction matters because the two fail in
 * opposite directions: attribution must refuse when it cannot name the
 * exported value, while root selection must widen. Answering both with
 * one expression meant every soundness cutoff that withdrew attribution
 * silently deleted the entrypoint's root as well, hiding the exported
 * function's body from reachability and yielding a COMPLETE Family C
 * proof for a target that is genuinely reachable — a false NOT_AFFECTED,
 * reproduced for all four merged cutoff families.
 *
 * Re-indexes the entrypoint file directly (cheap: entrypoints are few)
 * rather than threading this through `buildCallGraph`'s internals.
 */
function entrypointSourceNodes(
  graph: CallGraph,
  entrypoint: Entrypoint,
): GraphNode[] {
  const sources: GraphNode[] = [];
  const module = moduleNode(graph, entrypoint.filePath);
  if (module) {
    sources.push(module);
  }

  if (entrypoint.symbol) {
    const node = graph.nodes.find(
      (n) => n.module === entrypoint.filePath && n.name === entrypoint.symbol,
    );
    if (node) {
      sources.push(node);
    }
    return sources;
  }

  let index;
  let model;
  try {
    index = indexSourceFileFromDisk(entrypoint.filePath);
    model = buildModuleModel(index);
  } catch {
    return sources;
  }

  // RWF-021: which NAMES count as roots is its own question, answered by
  // `entrypointRootCandidateNames`, not by reading export-attribution
  // provenance inline here. This used to be `exp.localName ??
  // exp.exportedName` over `model.exports`, which meant a soundness cutoff
  // that withdrew export ATTRIBUTION (RWF-014/015/016/017/018/019) also
  // deleted the ROOT — so the exported function's body went untraversed
  // and the target came back unreachable with a COMPLETE Family C proof.
  // Uncertainty about which callable is exported must widen the root set,
  // never empty it; see that function's doc comment for the full argument
  // and the reproduced false NOT_AFFECTED.
  const candidates = entrypointRootCandidates(index, model);
  for (const name of candidates.names) {
    const node = graph.nodes.find(
      (n) => n.module === entrypoint.filePath && n.name === name,
    );
    if (node) {
      sources.push(node);
    }
  }
  for (const location of candidates.locations) {
    const node = graph.nodes.find(
      (n) =>
        n.module === entrypoint.filePath &&
        n.location?.line === location.line &&
        n.location?.column === location.column,
    );
    if (node && !sources.includes(node)) {
      sources.push(node);
    }
  }

  return sources;
}

/**
 * Whether any construct reachable from `entrypoints`' own source nodes
 * could, at runtime, load a module the call graph never discovered (VT-300;
 * see docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 3.6/§ 15, RWF-008).
 *
 * `resolveTargetNodes`'s `confirmedAbsentInstance` result treats a package
 * instance's total absence from the call graph as positive evidence of
 * non-reachability -- correct only when the graph's own on-demand
 * discovery (TASK-018) was actually complete. It is NOT complete when a
 * closure-widening construct (`dynamic_require`, `dynamic_import`, `eval`,
 * `unresolved_module` -- see {@link isClosureWideningReason}) sits
 * somewhere reachable from an entrypoint: such a construct could, at
 * runtime, load exactly the undiscovered instance in question, so its
 * absence from the graph stops being evidence of anything. Reproduced
 * directly: an otherwise-identical fixture with vs. without a reachable
 * `require(variable)` changes the correct verdict for an untouched sibling
 * package instance from `UNKNOWN` to a **false** `NOT_AFFECTED`.
 *
 * Scoped deliberately to each entrypoint's own reachable subgraph, not the
 * whole graph: an unrelated closure-widening construct in code no
 * entrypoint can ever reach says nothing about what THIS entrypoint might
 * load at runtime (the same reachable-subgraph scoping that already
 * protects {@link analyzeReachability}'s own `unreachable` conclusion from
 * unrelated blockers elsewhere in the graph -- see
 * docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 3.3's RWB-07 evidence).
 */
function hasReachableClosureWideningBlocker(
  graph: CallGraph,
  entrypoints: readonly Entrypoint[],
): boolean {
  for (const entrypoint of entrypoints) {
    for (const source of entrypointSourceNodes(graph, entrypoint)) {
      const unresolvedEdges = collectReachableUnknownEdges(graph, source);
      if (
        unresolvedEdges.some((edge) => isClosureWideningReason(edge.reason))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Checks every `{target × entrypoint}` combination for a rule, stopping at
 * the first confirmed-reachable one (see docs/SDD.md § 23's "target
 * reachable?" step). Aggregates the rest: any `unknown` result anywhere
 * means overall reachability cannot be ruled out; only when every
 * combination is confirmed `unreachable` is the target considered
 * confirmed not reachable.
 */
async function checkReachability(
  rule: VulnerableSymbolRule,
  graph: CallGraph,
  entrypoints: readonly Entrypoint[],
  resolver: ModuleResolver,
  projectRoot: string,
  packageVersion: string | undefined,
  packageInstance: string | undefined,
  allowSyntheticNameOnlyTargetBinding: boolean,
  knownPackageRoots: KnownPackageRoots | undefined,
  moduleLoadClosure: ModuleLoadClosure | undefined,
): Promise<{
  reachable?: ReachableEvidence;
  sawUnknown: boolean;
  reasons: string[];
  representativeTarget?: VulnerableSymbolTarget;
  /**
   * VT-307d: set when this finding's own exact package instance was proved
   * absent from a complete, gate-eligible module-load closure. Reported by
   * `buildFinding` ahead of `sawUnknown`, deliberately -- see there.
   */
  absentFromModuleLoadClosure?: ConfirmedAbsentFromModuleLoadClosure;
  /**
   * VT-307e, PROOF FAMILY B: this finding's exact instance was never
   * traversed by the call graph, VT-300's guard found nothing reachable
   * that could load it, AND (hardened after VT-307e's own final audit) a
   * gate-eligible, COMPLETE `ModuleLoadClosure` independently corroborates
   * the absence -- it does not contain this exact instance either. Set
   * ONLY when all three hold; a call-graph absence the closure cannot
   * corroborate becomes `sawUnknown` instead (see the `confirmedAbsentInstance`
   * branch above), never a value here. Carries the instance so
   * `buildFinding` can emit evidence naming exactly what the verdict is
   * about.
   */
  absentInstance?: string;
  /**
   * VT-307e, PROOF FAMILY C: at least one resolved, attributed target was
   * searched to exhaustion and found unreachable, with no unresolved edge
   * anywhere in the reachable subgraph.
   */
  unreachableTarget?: VulnerableSymbolTarget;
  /**
   * Whether at least one reachability search actually ran. `false` means no
   * entrypoint produced a usable source node to search from (e.g. the
   * project has no configured/discoverable entrypoints at all) — a
   * genuinely unchecked target, not a confirmed-unreachable one. Without
   * this, an unreachable-by-default fallthrough would misreport such a
   * target as `NOT_AFFECTED` purely because nothing was ever searched (see
   * AGENTS.md: never infer NOT_AFFECTED merely because resolution failed).
   */
  checkedAny: boolean;
}> {
  const referenceFile = path.join(projectRoot, "package.json");
  let sawUnknown = false;
  let checkedAny = false;
  const reasons: string[] = [];
  let representativeTarget: VulnerableSymbolTarget | undefined;
  let absentFromModuleLoadClosure:
    ConfirmedAbsentFromModuleLoadClosure | undefined;
  let absentInstance: string | undefined;
  let unreachableTarget: VulnerableSymbolTarget | undefined;

  for (const target of rule.targets) {
    const {
      nodes: targetNodes,
      unresolvedReason,
      confirmedAbsentInstance,
      absentFromModuleLoadClosure: targetAbsenceProof,
    } = await resolveTargetNodes(
      graph,
      target,
      resolver,
      referenceFile,
      packageVersion,
      packageInstance,
      allowSyntheticNameOnlyTargetBinding,
      knownPackageRoots,
      moduleLoadClosure,
    );

    if (unresolvedReason) {
      sawUnknown = true;
      reasons.push(
        `could not resolve module "${target.module}": ${unresolvedReason}`,
      );
      continue;
    }

    representativeTarget ??= target;

    if (targetAbsenceProof) {
      // VT-307d: a genuine, positive check ran and concluded -- this
      // instance's code cannot execute at all from the configured
      // entrypoints. `checkedAny` records that, so a finding whose every
      // target resolves this way never falls through to the separate "no
      // entrypoints were available" UNKNOWN below.
      checkedAny = true;
      absentFromModuleLoadClosure ??= targetAbsenceProof;
      continue;
    }

    if (confirmedAbsentInstance) {
      // This finding's own package instance was never traversed by the
      // call graph at all (VT-212) -- a genuine, positive check, not a
      // skipped one. `checkedAny` must reflect that so buildFinding's
      // existing graphTruncated gate (not this function) decides between
      // NOT_AFFECTED and UNKNOWN, instead of falling through to the
      // separate "no entrypoints were available" UNKNOWN below.
      checkedAny = true;

      // VT-300 (docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 3.6/§ 15,
      // RWF-008): the graph's on-demand discovery is complete under a
      // non-truncated graph ONLY WHEN nothing reachable from an
      // entrypoint could still load this exact, undiscovered instance at
      // runtime. A closure-widening construct (dynamic_require,
      // dynamic_import, eval, unresolved_module -- see
      // isClosureWideningReason) reachable from an entrypoint means this
      // instance's absence from the graph is no longer positive evidence
      // of anything: reporting NOT_AFFECTED here would be exactly the
      // false negative AGENTS.md forbids (confirmed reproducible -- see
      // the audit's RWF-008 isolation and the ADV2-047 regression case).
      // Non-widening blockers (unsupported_construct,
      // dynamic_member_access, unresolved_target) do NOT trigger this --
      // their uncertainty is bounded to values/modules already
      // discovered, so they cannot have loaded this undiscovered
      // instance either.
      if (hasReachableClosureWideningBlocker(graph, entrypoints)) {
        sawUnknown = true;
        reasons.push(
          `package instance for module "${target.module}" was never traversed by the call graph, but a closure-widening construct reachable from an entrypoint could load it at runtime`,
        );
      } else if (packageInstance !== undefined) {
        // VT-307e (hardened by VT-307e's own final audit, which
        // reproduced a false NOT_AFFECTED here): VT-300's guard passing
        // means no RESOLVED CALL EDGE reachable from an entrypoint could
        // load this instance. That is not the same claim as "this
        // instance cannot be loaded at all" -- the call graph's own
        // discovery never follows a re-export DECLARATION
        // (`export * from "pkg"`) as an edge in the first place
        // (VT-307c-fix-8 added that traversal to `ModuleLoadClosure`
        // ONLY), so an instance reached solely through a re-export chain
        // is genuinely loaded and called while producing no call-graph
        // edge whatsoever for VT-300 to have inspected. Concretely
        // reproduced: two installs of one package name/version, a
        // `consumer` package doing `export * from "pkg"` to the nested
        // one, an entrypoint that imports the top-level install directly
        // (so the graph discovers THAT instance) and calls the vulnerable
        // export through `consumer` (so the nested instance's code
        // genuinely runs) -- the nested instance was absent from a
        // non-truncated call graph while being both loaded and called.
        //
        // Family B's own "the call graph never traversed this instance"
        // claim is therefore corroborated -- and only corroborated -- by
        // an INDEPENDENT traversal that does follow re-export
        // declarations: a gate-eligible, COMPLETE `ModuleLoadClosure`
        // (the same closure-membership fact Family A relies on, checked
        // here because the call graph discovered some OTHER instance of
        // this package name, not none at all). Absent, incomplete, or
        // containing this exact instance all disqualify Family B outright
        // -- none of them fabricate a replacement proof; each degrades to
        // exactly the same `sawUnknown` uncertainty every other
        // unresolved case in this function already produces, so a finding
        // with another target that IS genuinely proven unreachable is
        // still correctly forced to UNKNOWN as a whole (see `buildFinding`
        // AGENTS.md: never infer NOT_AFFECTED merely because something
        // failed to resolve).
        if (
          moduleLoadClosure !== undefined &&
          moduleLoadClosure.complete &&
          !closureContainsPackageInstance(moduleLoadClosure, packageInstance)
        ) {
          absentInstance ??= packageInstance;
        } else {
          sawUnknown = true;
          reasons.push(
            `package instance for module "${target.module}" was never traversed by the call graph, but its absence could not be corroborated by a complete module-load closure (module-load closure is ${
              moduleLoadClosure === undefined
                ? "unavailable"
                : moduleLoadClosure.complete
                  ? "complete and reports this instance as loaded"
                  : "incomplete"
            })`,
          );
        }
      }
      continue;
    }

    for (const targetNode of targetNodes) {
      for (const entrypoint of entrypoints) {
        for (const source of entrypointSourceNodes(graph, entrypoint)) {
          checkedAny = true;
          const result = analyzeReachability(graph, source, targetNode);

          if (result.state === "reachable") {
            return {
              reachable: { target, path: result.path },
              sawUnknown,
              reasons,
              representativeTarget: target,
              checkedAny,
            };
          }
          if (result.state === "unknown") {
            sawUnknown = true;
            reasons.push(...result.blockers);
          } else if (result.state === "unreachable") {
            // VT-307e: a POSITIVE family-C result -- this search ran to
            // exhaustion and found no unresolved edge anywhere in the
            // reachable subgraph (see analyzeReachability, which returns
            // `unknown` rather than `unreachable` if even one exists).
            unreachableTarget ??= target;
          }
        }
      }
    }
  }

  return {
    sawUnknown,
    reasons,
    representativeTarget,
    checkedAny,
    absentFromModuleLoadClosure,
    absentInstance,
    unreachableTarget,
  };
}

/**
 * Builds a {@link Finding} from an already-matched vulnerability, applying
 * docs/SDD.md § 23's deterministic verdict logic:
 *
 * ```
 * dependency vulnerable?  NO  -> no finding
 *                         YES -> vulnerable target known?  NO  -> UNKNOWN
 *                                                           YES -> target reachable?  YES -> AFFECTED
 *                                                                                     NO -> coverage sufficient?  YES -> NOT_AFFECTED
 *                                                                                                                 NO  -> UNKNOWN
 * ```
 *
 * The "target reachable? / coverage sufficient?" pair collapses onto
 * {@link ReachabilityResult}'s own three states (see TASK-020): `reachable`
 * is AFFECTED; `unreachable` — which TASK-020 only returns once a search
 * is fully exhausted with no blocking uncertainty — is NOT_AFFECTED,
 * *unless* {@link BuildFindingOptions.graphTruncated} is set, in which case
 * "coverage sufficient?" is answered NO regardless (see VT-202,
 * SDD-v0.2.md § 3.3) and the result is UNKNOWN instead; `unknown` is
 * UNKNOWN. Returns `undefined` ("no finding") only when the
 * installed version is confidently outside the vulnerability's affected
 * ranges — never for an `indeterminate` version match, which instead
 * degrades straight to UNKNOWN (see AGENTS.md: never infer NOT_AFFECTED —
 * nor skip a finding entirely — merely because something failed to
 * resolve).
 */
export async function buildFinding(
  options: BuildFindingOptions,
): Promise<Finding | undefined> {
  const {
    vulnerability,
    packageName,
    packageVersion,
    packageInstance,
    matchResult,
    rule,
    context,
    allowSyntheticNameOnlyTargetBinding = false,
  } = options;

  const { graph, entrypoints, resolver, projectRoot, knownPackageRoots } =
    context;

  // FAIL CLOSED on a context this analyzer did not create (VT-CONTRACT-03).
  //
  // The brand on `AnalysisProofContext` already makes an object literal a
  // compile error, so reaching here means someone cast their way past the
  // type system -- exactly what a cross-wiring caller would do once the
  // compiler started objecting. Every negative proof is withdrawn for such
  // a context: the closure is dropped, and `graphTruncated` is forced true
  // so the call-graph-derived proofs (families B and C) are gated off by
  // the existing VT-202 rule rather than by a new code path with its own
  // semantics.
  //
  // It does NOT throw. `buildFinding` is a library entry point whose whole
  // contract is that uncertainty becomes UNKNOWN rather than an exception,
  // and throwing here would convert a caller's mistake into a crashed scan
  // for an end user -- strictly worse than the conservative verdict the
  // analyzer already knows how to produce. It also does not fabricate an
  // AFFECTED: a mismatched context is an absence of information, not
  // evidence of reachability.
  const contextTrusted = isAnalysisProofContext(context);
  const moduleLoadClosure = contextTrusted
    ? context.moduleLoadClosure
    : undefined;
  const graphTruncated = contextTrusted ? context.graphTruncated : true;

  const base = {
    vulnerability: vulnerability.id,
    package: packageName,
    version: packageVersion,
  } as const;

  if (matchResult === "not_affected") {
    return undefined;
  }

  if (matchResult === "indeterminate") {
    return { ...base, verdict: "UNKNOWN" };
  }

  if (!rule || rule.targets.length === 0) {
    return { ...base, verdict: "UNKNOWN" };
  }

  const {
    reachable,
    sawUnknown,
    reasons,
    representativeTarget,
    checkedAny,
    absentFromModuleLoadClosure,
    absentInstance,
    unreachableTarget,
  } = await checkReachability(
    rule,
    graph,
    entrypoints,
    resolver,
    projectRoot,
    packageVersion,
    packageInstance,
    allowSyntheticNameOnlyTargetBinding,
    knownPackageRoots,
    moduleLoadClosure,
  );

  if (reachable) {
    return {
      ...base,
      verdict: "AFFECTED",
      confidence: reachable.target.confidence ?? 1,
      target: reachable.target,
      evidence: {
        path: reachable.path.map((id) => locationOf(graph, id)),
        reasons: [
          "vulnerable symbol resolved",
          "symbol reachable from application entrypoint",
        ],
      },
    };
  }

  // VT-307d -- MODULE-LOAD ABSENCE PROOF, deliberately ahead of
  // `sawUnknown`, `checkedAny` and `graphTruncated` alike.
  //
  // That ordering IS the fix for RWF-002/RWB-06. Those three branches all
  // express one thing: the CALL-GRAPH search could not finish the job. The
  // proof reaching here expresses something the call graph never asked --
  // that this installed instance's code cannot execute at all from the
  // configured entrypoints -- established by a different, independently
  // complete traversal. Unrelated non-widening call-graph uncertainty
  // elsewhere in the project (RWB-06's `String.prototype.trim()` call, an
  // untraversed region behind a resource limit) cannot make an unloadable
  // package load, so it must not veto a conclusion it has no bearing on.
  //
  // This does NOT loosen anything for the routes below. Every existing
  // reachability-derived NOT_AFFECTED still requires `graphTruncated ===
  // false`, VT-300's closure-widening guard on `confirmedAbsentInstance`
  // is untouched, and ordinary `graphTruncated` semantics are unchanged.
  // The guard this route relies on instead is closure COMPLETENESS, which
  // the gate in `resolveTargetNodes` checks and which any construct
  // capable of loading a new module would have falsified.
  //
  // AFFECTED still wins ahead of this (the branch above): a positively
  // reproduced reachable path is the safe direction to prefer if the two
  // could ever disagree.
  if (absentFromModuleLoadClosure) {
    return {
      ...base,
      verdict: "NOT_AFFECTED",
      target: representativeTarget,
      evidence: {
        path: [],
        reasons: [MODULE_LOAD_ABSENCE_REASON],
        confirmedAbsentFromModuleLoadClosure: absentFromModuleLoadClosure,
      },
    };
  }

  if (sawUnknown) {
    return {
      ...base,
      verdict: "UNKNOWN",
      target: representativeTarget,
      evidence: reasons.length > 0 ? { path: [], reasons } : undefined,
    };
  }

  if (!checkedAny) {
    return {
      ...base,
      verdict: "UNKNOWN",
      target: representativeTarget,
      evidence: {
        path: [],
        reasons: ["no entrypoints were available to check reachability from"],
      },
    };
  }

  // VT-202 (SDD-v0.2.md § 3.3): a truncated call graph cannot positively
  // confirm non-reachability. The search above found no path and no
  // unknown edge along whatever it *did* traverse, but a resource limit
  // stopped construction before every file a resolved call chain could
  // reach was necessarily discovered -- the untraversed region might have
  // contained the very path being searched for. Reporting NOT_AFFECTED
  // here would be exactly the "absence of evidence treated as evidence of
  // non-reachability" AGENTS.md forbids; it must degrade to UNKNOWN
  // instead, same as an unresolved edge would.
  if (graphTruncated) {
    return {
      ...base,
      verdict: "UNKNOWN",
      target: representativeTarget,
      evidence: {
        path: [],
        reasons: [
          "call-graph construction was truncated by a configured resource limit (analysis.limits) before every reachable path could be exhaustively searched",
        ],
      },
    };
  }

  // VT-307e -- CALL-GRAPH NEGATIVE-PROOF GUARD.
  //
  // Everything below concludes NOT_AFFECTED from what the CALL GRAPH did
  // not contain (family B: this exact install location was never
  // traversed; family C: no path from any entrypoint to a resolved,
  // attributed target). Both therefore depend on the analyzed code having
  // been modeled faithfully -- and the call graph, unlike
  // `ModuleLoadClosure`, has never checked two conditions that can make it
  // silently unfaithful:
  //
  //  - a member with a SYNTAX ERROR. `indexSourceFileFromDisk` is
  //    error-tolerant, so `prepareFile` builds nodes and edges from a
  //    partial, silently reshaped AST. A `require` and the call that
  //    follows it can both be swallowed by the same error, after which
  //    "no path was found" and "this instance was never traversed" mean
  //    nothing for that file. The closure has refused to trust such an
  //    AST since VT-307c-fix-2; this extends the same rule to the two
  //    proofs that read the graph built from it.
  //  - an in-source loader/runtime capability in a NON-CALL position, e.g.
  //    `Module._extensions['.js'] = ...`. VT-300's own guard
  //    (`hasReachableClosureWideningBlocker`) inspects unresolved CALL
  //    EDGES, so an assignment that rewires module loading produces no
  //    edge for it to see. The closure's whole-file scan does see it.
  //
  // Both were reproduced end-to-end against the pre-VT-307d base
  // (ec7e0c5), so this is legacy-behavior hardening, not a VT-307d
  // regression -- see the VT-307d audit's own "pre-existing finding".
  //
  // Deliberately NOT `closure.complete`: `traversal_truncated` is excluded
  // by `invalidatesCallGraphNegativeProof`, because it bounds the
  // CLOSURE's walk while these proofs' coverage is governed by
  // `graphTruncated` just above. See that function for the per-reason
  // justification.
  //
  // Residual, accepted risk: an ABSENT closure contributes no blockers, so
  // a scan whose closure construction failed keeps exactly its
  // pre-VT-307d behavior here rather than degrading every finding. That is
  // the status quo, not a new exposure.
  const callGraphProofBlockers =
    callGraphNegativeProofBlockers(moduleLoadClosure);
  if (callGraphProofBlockers.length > 0) {
    return {
      ...base,
      verdict: "UNKNOWN",
      target: representativeTarget,
      evidence: {
        path: [],
        reasons: [
          `call-graph-derived non-reachability cannot be confirmed: the module-load closure recorded ${callGraphProofBlockers.join(", ")}, which can hide a call path to the target or the loading of this instance`,
        ],
      },
    };
  }

  // PROOF FAMILY B (VT-212/VT-300, hardened VT-307e): the exact installed
  // instance was never traversed by the call graph, the graph was not
  // truncated, nothing reachable from an entrypoint could have loaded it
  // (VT-300), AND a gate-eligible, COMPLETE `ModuleLoadClosure`
  // independently corroborates the absence. `absentInstance` is set ONLY
  // when all of that already holds -- see `checkReachability`'s own
  // `confirmedAbsentInstance` branch, where an uncorroborated call-graph
  // absence becomes `sawUnknown` instead and is handled by the branch
  // above this one, never here. Checked before family C because it is the
  // more specific claim -- when it holds, no code of this instance was
  // ever analyzed, so "no path to the target" would be a weaker way of
  // saying the same thing.
  if (absentInstance !== undefined) {
    return {
      ...base,
      verdict: "NOT_AFFECTED",
      target: representativeTarget,
      evidence: {
        path: [],
        reasons: [INSTANCE_ABSENT_FROM_CALL_GRAPH_REASON],
        confirmedAbsentInstance: {
          packageInstance: absentInstance,
          entrypointRoots: entrypoints.map((e) => e.filePath),
          // Both literally guaranteed at this point: `graphTruncated` was
          // checked false above, and the corroboration check in
          // `checkReachability` already required `moduleLoadClosure` to
          // be defined with `complete === true` before `absentInstance`
          // could ever be set.
          graphTruncated: false,
          moduleLoadClosureComplete: true,
        },
      },
    };
  }

  // PROOF FAMILY C's PRECONDITION, made structural (VT-CONTRACT-02).
  //
  // Family C's whole claim is carried by `unreachableTarget`: the one
  // target that `analyzeReachability` searched to exhaustion and found
  // unreachable with no unresolved edge in the reachable subgraph. Without
  // it there is no proof, and a NOT_AFFECTED asserting one would be the
  // unproven negative verdict AGENTS.md forbids.
  //
  // This branch is not believed reachable, and that is exactly why it is
  // written as a guard rather than left implicit. Reaching the return
  // below requires `checkedAny === true`, and `checkedAny` is set in only
  // three places, none of which can arrive here without a target:
  //
  //  1. the module-load absence branch -- also sets
  //     `absentFromModuleLoadClosure`, so family A returns above;
  //  2. the `confirmedAbsentInstance` branch -- reachable only when
  //     `packageInstance` is truthy (`resolveTargetNodes` returns that
  //     flag only inside its own `if (packageInstance)` guard), and from
  //     there it either sets `absentInstance` (family B returns above) or
  //     sets `sawUnknown` (UNKNOWN returns above);
  //  3. the reachability loop -- `analyzeReachability` returns exactly one
  //     of three states: `reachable` returns AFFECTED above, `unknown`
  //     sets `sawUnknown`, and `unreachable` sets `unreachableTarget`.
  //
  // So every surviving path sets it. The previous code encoded that
  // argument as a conditional spread, which silently degraded to a
  // NOT_AFFECTED with NO evidence object if the argument ever stopped
  // holding -- the one shape that turns a refactor into a false negative.
  // The invariant is now enforced where it is established: no
  // authoritative unreachable target, no family C verdict. VT-CONTRACT-01's
  // schema would also reject that shape at serialization; this makes the
  // production construction state its own precondition rather than relying
  // on a downstream check to catch a bug it should not be able to express.
  if (!unreachableTarget) {
    return {
      ...base,
      verdict: "UNKNOWN",
      target: representativeTarget,
      evidence: {
        path: [],
        reasons: [
          "no vulnerable target was searched to exhaustion, so unreachability could not be positively established",
        ],
      },
    };
  }

  // PROOF FAMILY C: a resolved, attributed target searched to exhaustion
  // with no unresolved edge anywhere in the reachable subgraph.
  return {
    ...base,
    verdict: "NOT_AFFECTED",
    target: representativeTarget,
    evidence: {
      path: [],
      reasons: [TARGET_UNREACHABLE_REASON],
      confirmedUnreachableTarget: {
        target: {
          module: unreachableTarget.module,
          export: unreachableTarget.export,
        },
        entrypointRoots: entrypoints.map((e) => e.filePath),
        // VT-CONTRACT-02: names the reachable subgraph the search actually
        // exhausted, not the whole call graph (see
        // ConfirmedUnreachableTarget). Renamed from `callGraphComplete`,
        // which overstated the claim.
        reachableSubgraphComplete: true as const,
      },
    },
  };
}
