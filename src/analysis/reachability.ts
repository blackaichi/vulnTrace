import type { Coverage } from "../domain/coverage.js";
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
 */
function computeGraphCoverage(graph: CallGraph): Coverage {
  const files = new Set(graph.nodes.map((node) => node.module)).size;
  const functions = graph.nodes.filter((node) => node.kind !== "module").length;

  const importEdges = graph.edges.filter((edge) => edge.type === "import");
  const modulesResolved = importEdges.filter(
    (edge) => edge.resolution.kind === "resolved",
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

  return {
    files,
    modulesResolved,
    modulesUnresolved,
    functions,
    callsResolved,
    callsDynamic,
  };
}

function describeBlocker(edge: UnresolvedEdge): string {
  return `${edge.reason} at ${edge.from}`;
}

interface QueueItem {
  readonly id: GraphNodeId;
  readonly path: readonly GraphNodeId[];
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
 */
export function analyzeReachability(
  graph: CallGraph,
  source: GraphNode,
  target: GraphNode,
): ReachabilityResult {
  const coverage = computeGraphCoverage(graph);

  if (source.id === target.id) {
    return {
      state: "reachable",
      source: source.id,
      target: target.id,
      path: [source.id],
      coverage,
    };
  }

  const edgesByFrom = new Map<GraphNodeId, CallEdge[]>();
  for (const edge of graph.edges) {
    const list = edgesByFrom.get(edge.from);
    if (list) {
      list.push(edge);
    } else {
      edgesByFrom.set(edge.from, [edge]);
    }
  }

  const visited = new Set<GraphNodeId>([source.id]);
  const unresolvedEdges: UnresolvedEdge[] = [];
  const queue: QueueItem[] = [{ id: source.id, path: [source.id] }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    for (const edge of edgesByFrom.get(current.id) ?? []) {
      if (edge.resolution.kind === "resolved") {
        const nextId = edge.resolution.target;

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
      } else {
        unresolvedEdges.push({
          from: current.id,
          reason: edge.resolution.reason,
        });
      }
    }
  }

  if (unresolvedEdges.length > 0) {
    return {
      state: "unknown",
      source: source.id,
      target: target.id,
      blockers: unresolvedEdges.map(describeBlocker),
      unresolvedEdges,
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

/** Object form of {@link analyzeReachability}, matching SDD § 20's literal `ReachabilityEngine` interface. */
export const reachabilityEngine: ReachabilityEngine = {
  analyze: analyzeReachability,
};
