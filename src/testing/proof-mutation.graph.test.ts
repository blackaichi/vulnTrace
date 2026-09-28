import { describe, expect, it } from "vitest";
import type { CallEdge, CallGraph, GraphNode } from "../domain/graph.js";
import {
  graphWithoutEdgesTo,
  graphWithoutInstance,
  graphWithoutNode,
} from "./proof-mutation.js";

/**
 * The F4 harness's graph mutators and the `possible` edge (task A-2).
 *
 * A mutator that removes a node must remove every edge that names it as
 * its target. A `possible` edge names its target as a resolved edge does;
 * one left behind would point at a node that is gone, and the mutated
 * graph would no longer be the graph the row says it is. An unknown
 * edge's potential targets are not a claim that it points there, so it
 * stays.
 */

function node(id: string, module = "/p/src/index.js"): GraphNode {
  return { id, kind: "function", module, name: id };
}

const edges: CallEdge[] = [
  { from: "a", type: "direct", resolution: { kind: "resolved", target: "b" } },
  {
    from: "a",
    type: "callback",
    resolution: { kind: "possible", target: "b" },
  },
  {
    from: "a",
    type: "direct",
    resolution: {
      kind: "unknown",
      reason: "dynamic_member_access",
      potentialTargets: ["b"],
    },
  },
];

const graph: CallGraph = { nodes: [node("a"), node("b")], edges };

describe("graph mutators drop possible edges into what they remove", () => {
  it("graphWithoutNode", () => {
    expect(
      graphWithoutNode(graph, "b").edges.map((e) => e.resolution.kind),
    ).toEqual(["unknown"]);
  });

  it("graphWithoutEdgesTo", () => {
    expect(
      graphWithoutEdgesTo(graph, "b").edges.map((e) => e.resolution.kind),
    ).toEqual(["unknown"]);
  });

  it("graphWithoutInstance", () => {
    const withInstance: CallGraph = {
      nodes: [node("a"), node("b", "/p/node_modules/lib/index.js")],
      edges,
    };
    expect(
      graphWithoutInstance(withInstance, "/p/node_modules/lib").edges.map(
        (e) => e.resolution.kind,
      ),
    ).toEqual(["unknown"]);
  });
});
