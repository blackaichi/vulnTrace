import type { CallGraph } from "../domain/graph.js";

/**
 * REMEDIATION-PLAN § 5a, "A-2 additions", obligation 1 (task A-3a): every
 * `possible` edge a producer emits points at a node of the graph whose
 * file the walk WALKED, exactly as a resolved edge does. Reachability
 * reads "no outgoing edges" as "searched, calls nothing", so a `possible`
 * edge into a body the walk never reached would make an unsearched region
 * look complete -- a false family C.
 *
 * `buildCallGraph` enforces this after the walk (it withdraws such an edge
 * to an unknown one); this check is what the corpora suites and the oracle
 * harness assert on every scan they run, through `runScanCommand`'s
 * `onCallGraph` seam, so the enforcement itself cannot silently regress.
 * Returns one line per violation; an empty list when the graph complies.
 */
export function possibleEdgeProblems(observed: {
  readonly graph: CallGraph;
  readonly walkedFiles: readonly string[];
}): string[] {
  const nodes = new Map(observed.graph.nodes.map((node) => [node.id, node]));
  const walked = new Set(observed.walkedFiles);
  const problems: string[] = [];
  for (const edge of observed.graph.edges) {
    if (edge.resolution.kind !== "possible") {
      continue;
    }
    const target = nodes.get(edge.resolution.target);
    if (!target) {
      problems.push(
        `possible edge ${edge.from} -> ${edge.resolution.target}: the target is not a node of the graph`,
      );
    } else if (!walked.has(target.module)) {
      problems.push(
        `possible edge ${edge.from} -> ${edge.resolution.target}: the target's file ${target.module} was not walked`,
      );
    }
  }
  return problems;
}
