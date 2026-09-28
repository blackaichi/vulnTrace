import type { Coverage, Diagnostic } from "../domain/coverage.js";
import type {
  CallEdge,
  CallGraph,
  GraphNode,
  GraphNodeId,
  ReachabilityEngine,
  ReachabilityResult,
  UnresolvedEdge,
} from "../domain/graph.js";

/**
 * Derives a coverage snapshot from the call graph itself (see
 * docs/SDD.md § 8). This is scoped to what a single graph traversal can
 * observe — distinct files/functions present, and resolved vs. dynamic
 * edges — not the full project-wide scan coverage (file parsing success,
 * dependency resolution, etc.), which is a broader concern owned by
 * TASK-026 (Coverage / Diagnostics). `import`-typed edges stand in for
 * "modules": each one represents an attempted cross-module resolution,
 * resolved or not.
 *
 * Exported (not just used internally by {@link analyzeReachability}) so the
 * CLI's top-level JSON `coverage` field (docs/SDD.md § 24) can reuse this
 * same derivation for a whole scan's call graph rather than duplicating it.
 */
export function computeCoverage(graph: CallGraph): Coverage {
  const files = new Set(graph.nodes.map((node) => node.module)).size;
  const functions = graph.nodes.filter((node) => node.kind !== "module").length;

  // A `possible` import edge names its target, so the cross-module
  // resolution it stands for succeeded; whether the call happens is what
  // it leaves open, and that is counted in `callsPossible`.
  const importEdges = graph.edges.filter((edge) => edge.type === "import");
  const modulesResolved = importEdges.filter(
    (edge) =>
      edge.resolution.kind === "resolved" ||
      edge.resolution.kind === "possible",
  ).length;
  const modulesUnresolved = importEdges.filter(
    (edge) => edge.resolution.kind === "unknown",
  ).length;

  const callsResolved = graph.edges.filter(
    (edge) => edge.resolution.kind === "resolved",
  ).length;
  const callsDynamic = graph.edges.filter(
    (edge) => edge.resolution.kind === "unknown",
  ).length;
  const callsPossible = graph.edges.filter(
    (edge) => edge.resolution.kind === "possible",
  ).length;

  return {
    files,
    modulesResolved,
    modulesUnresolved,
    functions,
    callsResolved,
    callsDynamic,
    callsPossible,
  };
}

/**
 * Explains every unresolved/dynamic edge anywhere in the call graph (see
 * docs/SDD.md § 8, TASK-026's "diagnostics explain blockers" acceptance
 * criterion) — the per-blocker complement to {@link computeCoverage}'s
 * aggregate `modulesUnresolved`/`callsDynamic` counts. Unlike a single
 * {@link analyzeReachability} call's `blockers` (only the edges a specific
 * source-to-target search actually traversed), this covers the whole
 * graph: every file the graph builder discovered is already within the
 * analyzed region (on-demand traversal only walks files a resolved call
 * chain reaches — see call-graph.ts), so every one of its unresolved edges
 * is a genuine, in-scope blocker worth surfacing, not just the ones that
 * happened to lie on a path some rule's target was searched for.
 *
 * A `possible` edge is not a blocker by itself (ADR 0008 § 1): it blocks
 * a search only when the target is reached through it, which is a fact
 * about one search, reported by {@link analyzeReachability}.
 */
export function collectGraphDiagnostics(graph: CallGraph): Diagnostic[] {
  return graph.edges
    .filter(
      (edge): edge is CallEdge & { resolution: { kind: "unknown" } } =>
        edge.resolution.kind === "unknown",
    )
    .map((edge) => ({
      source: "call-graph",
      message: describeBlocker({
        from: edge.from,
        reason: edge.resolution.reason,
      }),
    }));
}

function describeBlocker(edge: UnresolvedEdge): string {
  return `${edge.reason} at ${edge.from}`;
}

interface QueueItem {
  readonly id: GraphNodeId;
  readonly path: readonly GraphNodeId[];
}

/**
 * A node of phase 2, linked to how it was reached instead of carrying a
 * copied path. Phase 2 may meet every edge of the region behind the
 * `possible` edges, so it allocates only when it enters an unvisited node,
 * and materializes one path only: the witness, if there is one.
 */
interface BehindItem {
  readonly id: GraphNodeId;
  /** The phase-2 node this was reached from; `undefined` for the target of a set-aside `possible` edge. */
  readonly parent: BehindItem | undefined;
  /**
   * The phase-1 node whose `possible` edge starts this chain: its path is
   * all-resolved, and it is the `from` of the chain's first `possible` hop.
   */
  readonly root: QueueItem;
}

function pathOf(item: BehindItem): GraphNodeId[] {
  const tail: GraphNodeId[] = [];
  for (let at: BehindItem | undefined = item; at; at = at.parent) {
    tail.push(at.id);
  }
  return [...item.root.path, ...tail.reverse()];
}

function describePossibleOnly(
  path: readonly GraphNodeId[],
  from: GraphNodeId,
): string {
  return `possible_invocation at ${from} (the target is reached only through a possible edge: ${path.join(" -> ")})`;
}

function indexEdgesByFrom(graph: CallGraph): Map<GraphNodeId, CallEdge[]> {
  const edgesByFrom = new Map<GraphNodeId, CallEdge[]>();
  for (const edge of graph.edges) {
    const list = edgesByFrom.get(edge.from);
    if (list) {
      list.push(edge);
    } else {
      edgesByFrom.set(edge.from, [edge]);
    }
  }
  return edgesByFrom;
}

/**
 * Determines whether `target` is reachable from `source` within `graph`
 * (see docs/SDD.md § 20). Breadth-first, so a `reachable` result's `path`
 * is always a shortest path. Visiting each node at most once also makes
 * this safe against cycles in the call graph.
 *
 * An `unknown`/dynamic edge encountered along the way is never treated as
 * leading (or not leading) anywhere specific — it is recorded, and
 * traversal simply does not continue through it, since fabricating a
 * destination would violate docs/SDD.md § 18/§ 21.
 *
 * `unreachable` is only returned when the search space is fully exhausted
 * with NO unresolved edges encountered anywhere along the way: this is
 * what makes it a positively established conclusion rather than merely
 * "no path was found" (see docs/SDD.md § 5, § 23; AGENTS.md: never infer
 * NOT_AFFECTED merely because resolution failed — the reachability
 * analogue of that rule is never inferring `unreachable` merely because a
 * dynamic construct stood in the way). Any unresolved edge encountered
 * during the search instead yields `unknown`.
 *
 * `possible` EDGES (ADR 0008 § 1, Decision 2; SOUNDNESS-CONTRACT § 1 and
 * § 3; task A-2). The search runs in two phases over one visited set:
 *
 * 1. Resolved edges only, exactly as before `possible` existed. This is
 *    the only phase that can return `reachable`, so every hop of a
 *    reported path is a resolved edge. A `possible` edge met here is set
 *    aside, not followed.
 * 2. Only if phase 1 found no path: the region behind the set-aside
 *    `possible` edges, over resolved and `possible` edges alike. It can
 *    never return `reachable`. Its unknown edges are blockers like any
 *    other (the code behind a `possible` edge belongs to the searched
 *    region), and reaching the target here yields `unknown` with a
 *    `possibleOnlyPath` witness. A region that neither reaches the
 *    target nor meets an unknown edge leaves `unreachable` standing: an
 *    over-approximated invocation that provably cannot reach the target
 *    does not withhold family C.
 *
 * On a graph with no `possible` edge, phase 2 has nothing to do, and the
 * result is the one phase 1 alone always produced.
 */
export function analyzeReachability(
  graph: CallGraph,
  source: GraphNode,
  target: GraphNode,
): ReachabilityResult {
  const coverage = computeCoverage(graph);

  if (source.id === target.id) {
    return {
      state: "reachable",
      source: source.id,
      target: target.id,
      path: [source.id],
      coverage,
    };
  }

  const edgesByFrom = indexEdgesByFrom(graph);

  const visited = new Set<GraphNodeId>([source.id]);
  const unresolvedEdges: UnresolvedEdge[] = [];
  const setAside: { readonly id: GraphNodeId; readonly root: QueueItem }[] = [];
  const queue: QueueItem[] = [{ id: source.id, path: [source.id] }];

  // Phase 1: resolved edges only.
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    for (const edge of edgesByFrom.get(current.id) ?? []) {
      const resolution = edge.resolution;
      if (resolution.kind === "resolved") {
        const nextId = resolution.target;

        if (nextId === target.id) {
          return {
            state: "reachable",
            source: source.id,
            target: target.id,
            path: [...current.path, nextId],
            coverage,
          };
        }

        if (!visited.has(nextId)) {
          visited.add(nextId);
          queue.push({ id: nextId, path: [...current.path, nextId] });
        }
      } else if (resolution.kind === "possible") {
        setAside.push({ id: resolution.target, root: current });
      } else {
        unresolvedEdges.push({
          from: current.id,
          reason: resolution.reason,
        });
      }
    }
  }

  // Phase 2: the region behind the `possible` edges phase 1 set aside.
  let possibleOnly: BehindItem | undefined;
  const behind: BehindItem[] = [];
  const enter = (
    id: GraphNodeId,
    parent: BehindItem | undefined,
    root: QueueItem,
  ): void => {
    if (id === target.id) {
      possibleOnly ??= { id, parent, root };
      return;
    }
    if (!visited.has(id)) {
      visited.add(id);
      behind.push({ id, parent, root });
    }
  };
  for (const { id, root } of setAside) {
    enter(id, undefined, root);
  }

  while (behind.length > 0) {
    const current = behind.shift();
    if (!current) {
      break;
    }

    for (const edge of edgesByFrom.get(current.id) ?? []) {
      const resolution = edge.resolution;
      if (resolution.kind === "resolved" || resolution.kind === "possible") {
        enter(resolution.target, current, current.root);
      } else {
        unresolvedEdges.push({
          from: current.id,
          reason: resolution.reason,
        });
      }
    }
  }

  if (unresolvedEdges.length > 0 || possibleOnly !== undefined) {
    const blockers = unresolvedEdges.map(describeBlocker);
    const witness =
      possibleOnly === undefined ? undefined : pathOf(possibleOnly);
    if (possibleOnly !== undefined && witness !== undefined) {
      blockers.push(describePossibleOnly(witness, possibleOnly.root.id));
    }
    return {
      state: "unknown",
      source: source.id,
      target: target.id,
      blockers,
      unresolvedEdges,
      ...(witness === undefined ? {} : { possibleOnlyPath: witness }),
      coverage,
    };
  }

  return {
    state: "unreachable",
    source: source.id,
    target: target.id,
    blockers: [
      `no resolved call path from ${source.id} to ${target.id} exists in the analyzed call graph`,
    ],
    coverage,
  };
}

/**
 * Every unresolved/dynamic edge reachable from `source` via resolved and
 * `possible` edges — the same reachable-subgraph definition
 * {@link analyzeReachability} itself traverses, without requiring a
 * specific target node to search for. Used by verdict.ts's `confirmedAbsentInstance` guard (VT-300; see
 * docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 3.6/§ 15, RWF-008) to
 * determine whether *anything* reachable from an entrypoint could, at
 * runtime, load a package instance the call graph itself never
 * discovered — a question with no fixed target, so
 * {@link analyzeReachability} cannot answer it directly.
 *
 * Deliberately a separate, minimal traversal rather than a refactor of
 * {@link analyzeReachability} itself: the two functions have different
 * termination conditions (stop at the first match for one; visit
 * everything for the other) and different correctness requirements
 * (a passing regression suite already depends on
 * {@link analyzeReachability}'s exact behavior) — sharing state between
 * them risks coupling two functions that should be able to evolve
 * independently. No path tracking, no coverage computation: callers here
 * only need the unresolved-edge set, not a full {@link ReachabilityResult}.
 *
 * `possible` edges are followed (ADR 0008 § 1, task A-2): the code behind
 * one may run, so a closure-widening construct in it may load exactly the
 * undiscovered instance VT-300 asks about. Following only resolved edges
 * here would let family B stand past it.
 */
export function collectReachableUnknownEdges(
  graph: CallGraph,
  source: GraphNode,
): readonly UnresolvedEdge[] {
  const edgesByFrom = indexEdgesByFrom(graph);

  const visited = new Set<GraphNodeId>([source.id]);
  const unresolvedEdges: UnresolvedEdge[] = [];
  const queue: GraphNodeId[] = [source.id];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    for (const edge of edgesByFrom.get(current) ?? []) {
      if (
        edge.resolution.kind === "resolved" ||
        edge.resolution.kind === "possible"
      ) {
        const nextId = edge.resolution.target;
        if (!visited.has(nextId)) {
          visited.add(nextId);
          queue.push(nextId);
        }
      } else {
        unresolvedEdges.push({ from: current, reason: edge.resolution.reason });
      }
    }
  }

  return unresolvedEdges;
}

/** Object form of {@link analyzeReachability}, matching SDD § 20's literal `ReachabilityEngine` interface. */
export const reachabilityEngine: ReachabilityEngine = {
  analyze: analyzeReachability,
};
