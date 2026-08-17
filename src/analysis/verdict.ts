import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildModuleModel,
  mapExportsToFunctions,
} from "../code-intelligence/module-model.js";
import type { ModuleResolver } from "../code-intelligence/module-resolver.js";
import { indexSourceFileFromDisk } from "../code-intelligence/source-index.js";
import type { CallGraph, GraphNode, GraphNodeId } from "../domain/graph.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import { identifyModule } from "../domain/resolved-target.js";
import type {
  VulnerableSymbolRule,
  VulnerableSymbolTarget,
} from "../domain/target.js";
import type { Finding } from "../domain/verdict.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import type { VersionMatchResult } from "../vulnerabilities/version-matching.js";
import { analyzeReachability } from "./reachability.js";

export interface BuildFindingOptions {
  readonly vulnerability: Vulnerability;
  readonly packageName: string;
  readonly packageVersion: string;
  /** From TASK-011's matchVersion/matchVulnerabilities. */
  readonly matchResult: VersionMatchResult;
  /** From TASK-012's indexRulesByVulnerabilityId lookup; `undefined` if no rule targets this vulnerability. */
  readonly rule: VulnerableSymbolRule | undefined;
  readonly graph: CallGraph;
  readonly entrypoints: readonly Entrypoint[];
  readonly resolver: ModuleResolver;
  readonly projectRoot: string;
  /**
   * Whether call-graph construction was truncated by a configured resource
   * limit (`analysis.limits.maxFiles`/`maxGraphNodes`/`maxAnalysisSeconds`
   * — see docs/SDD.md § 26, § 28-29's hardening requirement) before it
   * could discover every file a resolved call chain would otherwise reach.
   * Defaults to `false` so every existing caller that doesn't pass it keeps
   * its current behavior (see VT-202, SDD-v0.2.md § 3.3: "NOT_AFFECTED is
   * valid only when ... analysis coverage is complete"). A truncated graph
   * cannot positively confirm non-reachability -- the untraversed region
   * might have contained the very path being searched for -- so `buildFinding`
   * must not report NOT_AFFECTED against one, even when its own search found
   * no path and no unknown edge along the way it did traverse.
   */
  readonly graphTruncated?: boolean;
}

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
 * Finds the graph node implementing `{module: resolvedFile, export: exportName}`,
 * or `undefined` when it was never discovered while building the graph.
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
 * Falls back to the direct name match (kept for synthetic/test graphs that
 * bypass real file indexing entirely, and as a safety net if the target
 * file can no longer be read).
 */
function findExportNodeInFile(
  graph: CallGraph,
  resolvedFile: string,
  exportName: string,
): GraphNode | undefined {
  try {
    const index = indexSourceFileFromDisk(resolvedFile);
    const model = buildModuleModel(index);
    const exportedFn = mapExportsToFunctions(index, model).get(exportName);
    if (exportedFn) {
      const byLocation = graph.nodes.find(
        (n) =>
          n.module === resolvedFile &&
          n.location?.line === exportedFn.location.line &&
          n.location?.column === exportedFn.location.column,
      );
      if (byLocation) {
        return byLocation;
      }
    }
  } catch {
    // Target file unreadable/unparsable -- fall through to the name-based
    // match below.
  }

  return graph.nodes.find(
    (n) => n.module === resolvedFile && n.name === exportName,
  );
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
): Map<string, Set<string>> {
  const byInstance = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    const identity = identifyModule(node.module);
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
 * When `packageVersion` is known and more than one distinct installed
 * instance is present in the graph, prefers instances whose own
 * `package.json` declares that exact version — so a Finding built against
 * one specific installed version's reachability is never contaminated by
 * a *different* installed version's own reachability. Falls back to every
 * instance found when none match, rather than silently under-including.
 *
 * Only falls back to a fresh, independent resolution (the pre-VT-204
 * behavior) when the graph never discovered ANY instance of the package at
 * all — the common, legitimate case where nothing in the analyzed code
 * ever imports it.
 */
async function resolveTargetNodes(
  graph: CallGraph,
  target: VulnerableSymbolTarget,
  resolver: ModuleResolver,
  referenceFile: string,
  packageVersion: string | undefined,
): Promise<{ nodes: GraphNode[]; unresolvedReason?: string }> {
  const instances = graphPackageInstances(graph, target.module);

  if (instances.size > 0) {
    let selected = [...instances.entries()];
    if (packageVersion && instances.size > 1) {
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
        const node = findExportNodeInFile(graph, file, target.export);
        if (node) {
          nodes.push(node);
        }
      }
    }

    if (nodes.length > 0) {
      return { nodes };
    }

    // The graph found real instance(s) of the package, but none of them
    // implement target.export -- a phantom scoped to a real,
    // graph-confirmed instance, not a fresh independent resolution.
    const [firstFile] = selected[0]?.[1] ?? [];
    return {
      nodes: [phantomNode(firstFile ?? target.module, target.export)],
    };
  }

  const resolution = await resolver.resolve(target.module, referenceFile);
  if (resolution.kind === "unresolved") {
    return { nodes: [], unresolvedReason: resolution.reason };
  }

  const node = findExportNodeInFile(
    graph,
    resolution.resolvedFileName,
    target.export,
  );
  return {
    nodes: [node ?? phantomNode(resolution.resolvedFileName, target.export)],
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

  let model;
  try {
    model = buildModuleModel(indexSourceFileFromDisk(entrypoint.filePath));
  } catch {
    return sources;
  }

  for (const exp of model.exports) {
    const name = exp.localName ?? exp.exportedName;
    if (!name) {
      continue;
    }
    const node = graph.nodes.find(
      (n) => n.module === entrypoint.filePath && n.name === name,
    );
    if (node) {
      sources.push(node);
    }
  }

  return sources;
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
): Promise<{
  reachable?: ReachableEvidence;
  sawUnknown: boolean;
  reasons: string[];
  representativeTarget?: VulnerableSymbolTarget;
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

  for (const target of rule.targets) {
    const { nodes: targetNodes, unresolvedReason } = await resolveTargetNodes(
      graph,
      target,
      resolver,
      referenceFile,
      packageVersion,
    );

    if (unresolvedReason) {
      sawUnknown = true;
      reasons.push(
        `could not resolve module "${target.module}": ${unresolvedReason}`,
      );
      continue;
    }

    representativeTarget ??= target;

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
          }
        }
      }
    }
  }

  return { sawUnknown, reasons, representativeTarget, checkedAny };
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
    matchResult,
    rule,
    graph,
    entrypoints,
    resolver,
    projectRoot,
    graphTruncated = false,
  } = options;

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

  const { reachable, sawUnknown, reasons, representativeTarget, checkedAny } =
    await checkReachability(
      rule,
      graph,
      entrypoints,
      resolver,
      projectRoot,
      packageVersion,
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

  return {
    ...base,
    verdict: "NOT_AFFECTED",
    target: representativeTarget,
    evidence: {
      path: [],
      reasons: [
        "vulnerable symbol confirmed unreachable from all analyzed entrypoints",
      ],
    },
  };
}
