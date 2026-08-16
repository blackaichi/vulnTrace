import type { Coverage } from "./coverage.js";

export type GraphNodeId = string;

/**
 * The kinds of code construct a call graph node can represent
 * (see docs/SDD.md § 18).
 */
export type GraphNodeKind =
  "function" | "method" | "constructor" | "callback" | "module";

export interface SourceLocation {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
}

/**
 * A single node in the call graph: a function, method, constructor,
 * callback, or module-level executable region (see docs/SDD.md § 18).
 */
export interface GraphNode {
  readonly id: GraphNodeId;
  readonly kind: GraphNodeKind;
  readonly module: string;
  readonly name?: string;
  readonly location?: SourceLocation;
}

export type CallEdgeType =
  "direct" | "method" | "constructor" | "callback" | "import";

/**
 * Why a call could not be resolved to an exact target
 * (see docs/SDD.md § 18, § 21). Originally just the genuinely-dynamic JS
 * constructs; `unresolved_module` and `unresolved_target` were added by
 * TASK-018 (Call Graph) for two adjacent, equally-real uncertainty cases
 * that surface during graph construction: a statically-known import
 * specifier that could not be resolved to a file (e.g. an uninstalled
 * dependency), and a resolved module whose named export could not be
 * matched to a specific function definition. Kept on this same type
 * rather than a parallel one, since both are still "the call edge
 * resolution is uncertain, and must say why."
 */
export type DynamicCallReason =
  | "dynamic_member_access"
  | "dynamic_require"
  | "dynamic_import"
  | "eval"
  | "unresolved_module"
  | "unresolved_target"
  | "unsupported_construct";

/**
 * A call edge either resolves to an exact node, or is explicitly
 * represented as uncertain. Dynamic constructs (`foo[method]()`,
 * `require(variable)`, `import(variable)`) must never fabricate exact
 * edges (see docs/SDD.md § 18, § 21).
 */
export type CallEdgeResolution =
  | { readonly kind: "resolved"; readonly target: GraphNodeId }
  | {
      readonly kind: "unknown";
      readonly reason: DynamicCallReason;
      readonly potentialTargets: readonly string[];
    };

export interface CallEdge {
  readonly from: GraphNodeId;
  readonly type: CallEdgeType;
  readonly resolution: CallEdgeResolution;
  readonly location?: SourceLocation;
}

/** The structure Reachability operates over (see docs/SDD.md § 18). */
export interface CallGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly CallEdge[];
}

export type ReachabilityState = "reachable" | "unreachable" | "unknown";

export interface UnresolvedEdge {
  readonly from: GraphNodeId;
  readonly reason: DynamicCallReason;
}

/**
 * The result of a reachability query. Modeled as a discriminated union on
 * `state` because the payload genuinely differs per case: only `reachable`
 * has a concrete `path`; only `unknown` carries `unresolvedEdges` (the
 * specific dynamic constructs that blocked a definite answer). This
 * mirrors docs/SDD.md § 20's requirement that the result include "path if
 * known" and "unresolved edges encountered" — i.e. these are conditionally
 * present, not always-empty placeholders. `unreachable` requires the
 * analysis to have positively established non-reachability with sufficient
 * coverage, never merely "no path was found" (see docs/SDD.md § 5, § 23).
 */
export type ReachabilityResult =
  | {
      readonly state: "reachable";
      readonly source: GraphNodeId;
      readonly target: GraphNodeId;
      readonly path: readonly GraphNodeId[];
      readonly coverage: Coverage;
    }
  | {
      readonly state: "unreachable";
      readonly source: GraphNodeId;
      readonly target: GraphNodeId;
      readonly blockers: readonly string[];
      readonly coverage: Coverage;
    }
  | {
      readonly state: "unknown";
      readonly source: GraphNodeId;
      readonly target: GraphNodeId;
      readonly blockers: readonly string[];
      readonly unresolvedEdges: readonly UnresolvedEdge[];
      readonly coverage: Coverage;
    };

/** See docs/SDD.md § 20. */
export interface ReachabilityEngine {
  analyze(
    graph: CallGraph,
    source: GraphNode,
    target: GraphNode,
  ): ReachabilityResult;
}

export function isCallResolved(
  resolution: CallEdgeResolution,
): resolution is Extract<CallEdgeResolution, { kind: "resolved" }> {
  return resolution.kind === "resolved";
}

export function isReachable(
  result: ReachabilityResult,
): result is Extract<ReachabilityResult, { state: "reachable" }> {
  return result.state === "reachable";
}
