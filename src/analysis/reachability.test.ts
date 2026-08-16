import { describe, expect, it } from "vitest";
import type {
  CallEdge,
  CallGraph,
  DynamicCallReason,
  GraphNode,
} from "../domain/graph.js";
import { analyzeReachability, reachabilityEngine } from "./reachability.js";

function node(id: string): GraphNode {
  return { id, kind: "function", module: "a.ts", name: id };
}

function resolvedEdge(from: string, to: string): CallEdge {
  return { from, type: "direct", resolution: { kind: "resolved", target: to } };
}

function unknownEdge(from: string, reason: DynamicCallReason): CallEdge {
  return {
    from,
    type: "direct",
    resolution: { kind: "unknown", reason, potentialTargets: [] },
  };
}

describe("analyzeReachability: reachable", () => {
  it("is trivially reachable from a node to itself", () => {
    const a = node("a");
    const graph: CallGraph = { nodes: [a], edges: [] };

    const result = analyzeReachability(graph, a, a);

    expect(result).toMatchObject({ state: "reachable", path: ["a"] });
  });

  it("returns the exact path for a single-hop reachable target", () => {
    const [a, b] = [node("a"), node("b")];
    const graph: CallGraph = { nodes: [a, b], edges: [resolvedEdge("a", "b")] };

    const result = analyzeReachability(graph, a, b);

    expect(result).toMatchObject({ state: "reachable", path: ["a", "b"] });
  });

  it("finds a multi-hop path", () => {
    const [a, b, c] = [node("a"), node("b"), node("c")];
    const graph: CallGraph = {
      nodes: [a, b, c],
      edges: [resolvedEdge("a", "b"), resolvedEdge("b", "c")],
    };

    const result = analyzeReachability(graph, a, c);

    expect(result).toMatchObject({ state: "reachable", path: ["a", "b", "c"] });
  });

  it("returns the shortest path when multiple paths exist (diamond graph)", () => {
    const [a, b, c, d] = [node("a"), node("b"), node("c"), node("d")];
    const graph: CallGraph = {
      nodes: [a, b, c, d],
      edges: [
        resolvedEdge("a", "b"),
        resolvedEdge("b", "d"),
        resolvedEdge("a", "c"),
        resolvedEdge("c", "d"),
      ],
    };

    const result = analyzeReachability(graph, a, d);

    expect(result.state).toBe("reachable");
    if (result.state === "reachable") {
      expect(result.path).toHaveLength(3);
      expect(result.path[0]).toBe("a");
      expect(result.path[2]).toBe("d");
    }
  });

  it("terminates and finds the target even when the graph has a cycle", () => {
    const [a, b, c] = [node("a"), node("b"), node("c")];
    const graph: CallGraph = {
      nodes: [a, b, c],
      edges: [
        resolvedEdge("a", "b"),
        resolvedEdge("b", "a"), // cycle back to a
        resolvedEdge("b", "c"),
      ],
    };

    const result = analyzeReachability(graph, a, c);

    expect(result).toMatchObject({ state: "reachable", path: ["a", "b", "c"] });
  });
});

describe("analyzeReachability: unreachable", () => {
  it("is unreachable when no path exists and no dynamic construct blocked the search", () => {
    const [a, b, target] = [node("a"), node("b"), node("target")];
    const graph: CallGraph = {
      nodes: [a, b, target],
      edges: [resolvedEdge("a", "b")], // b has no outgoing edges; target unreached
    };

    const result = analyzeReachability(graph, a, target);

    expect(result.state).toBe("unreachable");
    if (result.state === "unreachable") {
      expect(result.blockers.length).toBeGreaterThan(0);
    }
  });

  it("is unreachable when the graph has a non-blocking cycle and never reaches the target", () => {
    const [a, b, target] = [node("a"), node("b"), node("target")];
    const graph: CallGraph = {
      nodes: [a, b, target],
      edges: [resolvedEdge("a", "b"), resolvedEdge("b", "a")],
    };

    const result = analyzeReachability(graph, a, target);

    expect(result.state).toBe("unreachable");
  });
});

describe("analyzeReachability: unknown — never coerced into unreachable", () => {
  it("is unknown, not unreachable, when a dynamic edge is encountered along the search", () => {
    const [a, b, target] = [node("a"), node("b"), node("target")];
    const graph: CallGraph = {
      nodes: [a, b, target],
      edges: [
        resolvedEdge("a", "b"),
        unknownEdge("b", "dynamic_member_access"),
      ],
    };

    const result = analyzeReachability(graph, a, target);

    expect(result.state).toBe("unknown");
    if (result.state === "unknown") {
      expect(result.unresolvedEdges).toEqual([
        { from: "b", reason: "dynamic_member_access" },
      ]);
      expect(result.blockers).toEqual(["dynamic_member_access at b"]);
    }
  });

  it("collects every unresolved edge encountered from different nodes", () => {
    const [a, b, c, target] = [node("a"), node("b"), node("c"), node("target")];
    const graph: CallGraph = {
      nodes: [a, b, c, target],
      edges: [
        resolvedEdge("a", "b"),
        resolvedEdge("a", "c"),
        unknownEdge("b", "eval"),
        unknownEdge("c", "dynamic_require"),
      ],
    };

    const result = analyzeReachability(graph, a, target);

    expect(result.state).toBe("unknown");
    if (result.state === "unknown") {
      expect(result.unresolvedEdges).toHaveLength(2);
      expect(result.unresolvedEdges.map((e) => e.reason).sort()).toEqual([
        "dynamic_require",
        "eval",
      ]);
    }
  });

  it("is still reachable via a resolved path even when an unrelated dynamic edge also exists", () => {
    const [a, b, target] = [node("a"), node("b"), node("target")];
    const graph: CallGraph = {
      nodes: [a, b, target],
      edges: [resolvedEdge("a", "target"), unknownEdge("b", "eval")],
    };

    // "b" is not reachable from "a" here, so its dynamic edge should never
    // even be examined — the direct resolved path to target wins outright.
    const result = analyzeReachability(graph, a, target);

    expect(result).toMatchObject({ state: "reachable", path: ["a", "target"] });
  });
});

describe("analyzeReachability: coverage", () => {
  it("derives coverage from the call graph's nodes and edges", () => {
    const [a, b, target] = [node("a"), node("b"), node("target")];
    const importEdge: CallEdge = {
      from: "a",
      type: "import",
      resolution: { kind: "resolved", target: "b" },
    };
    const dynamicImportEdge: CallEdge = {
      from: "b",
      type: "import",
      resolution: {
        kind: "unknown",
        reason: "dynamic_import",
        potentialTargets: [],
      },
    };
    const graph: CallGraph = {
      nodes: [a, b, target],
      edges: [importEdge, dynamicImportEdge],
    };

    const result = analyzeReachability(graph, a, target);

    expect(result.coverage).toEqual({
      files: 1, // all three nodes share module "a.ts" in this synthetic graph
      modulesResolved: 1,
      modulesUnresolved: 1,
      functions: 3,
      callsResolved: 1,
      callsDynamic: 1,
    });
  });
});

describe("reachabilityEngine", () => {
  it("exposes the same behavior as analyzeReachability, matching SDD § 20's interface shape", () => {
    const [a, b] = [node("a"), node("b")];
    const graph: CallGraph = { nodes: [a, b], edges: [resolvedEdge("a", "b")] };

    const result = reachabilityEngine.analyze(graph, a, b);

    expect(result).toMatchObject({ state: "reachable", path: ["a", "b"] });
  });
});
