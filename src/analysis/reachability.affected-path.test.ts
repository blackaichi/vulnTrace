import { describe, expect, it } from "vitest";
import type { CallEdge, CallGraph, GraphNode } from "../domain/graph.js";
import { analyzeReachability } from "./reachability.js";

/**
 * SOUNDNESS-CONTRACT § 1, `AFFECTED` (task A-1, ADR 0008 Decision 2): an
 * `AFFECTED` path consists of resolved edges only. `analyzeReachability`'s
 * `reachable` result is the path an `AFFECTED` finding reports, so this
 * owns the rule where the path is made: every hop of a reported path is a
 * resolved edge, and a target that only an unresolved edge names -- even
 * as a potential target -- is never reported reachable.
 *
 * The `possible` edge kind (ADR 0008 § 1) does not exist yet. Task A-2
 * introduces it and must extend this file: a path through a `possible`
 * edge is never `reachable`, and the code behind one is still searched.
 */

function node(id: string): GraphNode {
  return { id, kind: "function", module: "a.ts", name: id };
}

function resolved(from: string, to: string): CallEdge {
  return { from, type: "direct", resolution: { kind: "resolved", target: to } };
}

function unknownNaming(from: string, to: string): CallEdge {
  return {
    from,
    type: "direct",
    resolution: {
      kind: "unknown",
      reason: "dynamic_member_access",
      potentialTargets: [to],
    },
  };
}

/** Every consecutive pair of `path` is joined by a resolved edge of `graph`. */
function everyHopResolved(graph: CallGraph, path: readonly string[]): boolean {
  return path
    .slice(1)
    .every((to, i) =>
      graph.edges.some(
        (edge) =>
          edge.from === path[i] &&
          edge.resolution.kind === "resolved" &&
          edge.resolution.target === to,
      ),
    );
}

describe("an AFFECTED path consists of resolved edges only", () => {
  it("never reports a target reachable through an unresolved edge that names it", () => {
    const graph: CallGraph = {
      nodes: ["entry", "target"].map(node),
      edges: [unknownNaming("entry", "target")],
    };
    const result = analyzeReachability(graph, node("entry"), node("target"));
    expect(result.state).toBe("unknown");
  });

  it("reports only paths whose every hop is a resolved edge, over mixed graphs", () => {
    // A lattice where each node has a resolved and an unresolved edge to
    // the next layer; the only resolved route to the target zig-zags.
    const graph: CallGraph = {
      nodes: ["entry", "a1", "a2", "b1", "b2", "target"].map(node),
      edges: [
        unknownNaming("entry", "target"),
        resolved("entry", "a1"),
        unknownNaming("entry", "a2"),
        unknownNaming("a1", "target"),
        resolved("a1", "b2"),
        resolved("a2", "target"),
        resolved("b2", "target"),
        unknownNaming("b1", "target"),
      ],
    };
    const result = analyzeReachability(graph, node("entry"), node("target"));
    expect(result.state).toBe("reachable");
    if (result.state === "reachable") {
      expect(result.path).toEqual(["entry", "a1", "b2", "target"]);
      expect(everyHopResolved(graph, result.path)).toBe(true);
    }
  });
});
