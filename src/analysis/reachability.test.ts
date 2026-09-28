import { describe, expect, it } from "vitest";
import type {
  CallEdge,
  CallGraph,
  DynamicCallReason,
  GraphNode,
} from "../domain/graph.js";
import {
  analyzeReachability,
  collectGraphDiagnostics,
  collectReachableUnknownEdges,
  computeCoverage,
  reachabilityEngine,
} from "./reachability.js";

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
      callsPossible: 0,
    });
  });
});

describe("collectGraphDiagnostics", () => {
  it("returns one diagnostic per unresolved/dynamic edge anywhere in the graph", () => {
    const [a, b, c] = [node("a"), node("b"), node("c")];
    const graph: CallGraph = {
      nodes: [a, b, c],
      edges: [
        resolvedEdge("a", "b"),
        unknownEdge("b", "eval"),
        unknownEdge("c", "dynamic_require"),
      ],
    };

    const diagnostics = collectGraphDiagnostics(graph);

    expect(diagnostics).toEqual([
      { source: "call-graph", message: "eval at b" },
      { source: "call-graph", message: "dynamic_require at c" },
    ]);
  });

  it("returns an empty array for a fully resolved graph", () => {
    const [a, b] = [node("a"), node("b")];
    const graph: CallGraph = { nodes: [a, b], edges: [resolvedEdge("a", "b")] };

    expect(collectGraphDiagnostics(graph)).toEqual([]);
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

function possibleEdge(from: string, to: string): CallEdge {
  return {
    from,
    type: "callback",
    resolution: { kind: "possible", target: to },
  };
}

describe("analyzeReachability: possible edges (task A-2)", () => {
  it("a target named only by a possible edge is unknown, with a possible_invocation blocker", () => {
    const [a, target] = [node("a"), node("target")];
    const graph: CallGraph = {
      nodes: [a, target],
      edges: [possibleEdge("a", "target")],
    };

    const result = analyzeReachability(graph, a, target);

    expect(result).toMatchObject({
      state: "unknown",
      possibleOnlyPath: ["a", "target"],
      unresolvedEdges: [],
    });
    if (result.state === "unknown") {
      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0]).toMatch(/^possible_invocation at a /);
    }
  });

  it("lists every unknown edge of the searched region alongside the possible-only witness", () => {
    const [a, b, target] = [node("a"), node("b"), node("target")];
    const graph: CallGraph = {
      nodes: [a, b, target],
      edges: [
        unknownEdge("a", "eval"),
        possibleEdge("a", "b"),
        possibleEdge("b", "target"),
        unknownEdge("b", "dynamic_member_access"),
      ],
    };

    const result = analyzeReachability(graph, a, target);

    expect(result.state).toBe("unknown");
    if (result.state === "unknown") {
      // Phase 1's blockers first, then phase 2's, then the witness.
      expect(result.unresolvedEdges).toEqual([
        { from: "a", reason: "eval" },
        { from: "b", reason: "dynamic_member_access" },
      ]);
      expect(result.possibleOnlyPath).toEqual(["a", "b", "target"]);
      expect(result.blockers).toEqual([
        "eval at a",
        "dynamic_member_access at b",
        "possible_invocation at a (the target is reached only through a possible edge: a -> b -> target)",
      ]);
    }
  });
});

/**
 * `analyzeReachability` exactly as it was before task A-2 (base
 * `b7c8f57`), kept verbatim apart from formatting, so the claim "on a
 * graph with no `possible` edge the result is unchanged" is checked
 * against the old code rather than restated. Only `coverage` comes from
 * the current `computeCoverage`, which A-2 extended with a count.
 */
function baseAnalyzeReachability(
  graph: CallGraph,
  source: GraphNode,
  target: GraphNode,
): unknown {
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
  const edgesByFrom = new Map<string, CallEdge[]>();
  for (const edge of graph.edges) {
    const list = edgesByFrom.get(edge.from);
    if (list) {
      list.push(edge);
    } else {
      edgesByFrom.set(edge.from, [edge]);
    }
  }
  const visited = new Set<string>([source.id]);
  const unresolvedEdges: { from: string; reason: DynamicCallReason }[] = [];
  const queue: { id: string; path: string[] }[] = [
    { id: source.id, path: [source.id] },
  ];
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
      } else if (edge.resolution.kind === "unknown") {
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
      blockers: unresolvedEdges.map((e) => `${e.reason} at ${e.from}`),
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

describe("analyzeReachability: unchanged on graphs without possible edges", () => {
  it("serializes byte-identically to the base algorithm on 3,000 seeded graphs", () => {
    let seed = 0x5eed;
    const random = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296;
    };
    const ids = ["s", "a", "b", "c", "d", "t"];
    const reasons: DynamicCallReason[] = ["eval", "dynamic_require"];
    const states = new Set<string>();
    for (let i = 0; i < 3000; i += 1) {
      const edges: CallEdge[] = [];
      const count = Math.floor(random() * 10);
      for (let j = 0; j < count; j += 1) {
        const from = ids[Math.floor(random() * ids.length)] as string;
        const to = ids[Math.floor(random() * ids.length)] as string;
        edges.push(
          random() < 0.7
            ? resolvedEdge(from, to)
            : unknownEdge(from, reasons[j % 2] as DynamicCallReason),
        );
      }
      const graph: CallGraph = { nodes: ids.map(node), edges };
      const head = analyzeReachability(graph, node("s"), node("t"));
      states.add(head.state);
      expect(JSON.stringify(head), JSON.stringify(edges)).toBe(
        JSON.stringify(baseAnalyzeReachability(graph, node("s"), node("t"))),
      );
    }
    expect([...states].sort()).toEqual(["reachable", "unknown", "unreachable"]);
  });
});

describe("collectReachableUnknownEdges: possible edges (task A-2, VT-300)", () => {
  it("follows a possible edge to the unknown edges behind it", () => {
    const [a, b, c] = [node("a"), node("b"), node("c")];
    const graph: CallGraph = {
      nodes: [a, b, c],
      edges: [
        possibleEdge("a", "b"),
        resolvedEdge("b", "c"),
        unknownEdge("c", "dynamic_require"),
      ],
    };

    expect(collectReachableUnknownEdges(graph, a)).toEqual([
      { from: "c", reason: "dynamic_require" },
    ]);
  });

  it("does not reach an unknown edge no resolved or possible edge leads to", () => {
    const [a, b, c] = [node("a"), node("b"), node("c")];
    const graph: CallGraph = {
      nodes: [a, b, c],
      edges: [possibleEdge("a", "b"), unknownEdge("c", "dynamic_require")],
    };

    expect(collectReachableUnknownEdges(graph, a)).toEqual([]);
  });
});

describe("computeCoverage: possible edges (task A-2)", () => {
  it("counts possible edges apart from resolved and dynamic ones", () => {
    const graph: CallGraph = {
      nodes: ["a", "b", "c"].map(node),
      edges: [
        resolvedEdge("a", "b"),
        possibleEdge("a", "c"),
        possibleEdge("b", "c"),
        unknownEdge("c", "eval"),
      ],
    };

    expect(computeCoverage(graph)).toMatchObject({
      callsResolved: 1,
      callsPossible: 2,
      callsDynamic: 1,
    });
  });

  it("counts a possible import edge as a resolved module: its target is known", () => {
    const graph: CallGraph = {
      nodes: ["a", "b"].map(node),
      edges: [
        {
          from: "a",
          type: "import",
          resolution: { kind: "possible", target: "b" },
        },
      ],
    };

    expect(computeCoverage(graph)).toMatchObject({
      modulesResolved: 1,
      modulesUnresolved: 0,
      callsResolved: 0,
      callsPossible: 1,
    });
  });

  it("does not report a possible edge as a graph diagnostic", () => {
    const graph: CallGraph = {
      nodes: ["a", "b"].map(node),
      edges: [possibleEdge("a", "b")],
    };

    expect(collectGraphDiagnostics(graph)).toEqual([]);
  });
});
