import { describe, expect, it } from "vitest";
import {
  type CallEdgeResolution,
  type CallGraph,
  type ReachabilityResult,
  isCallResolved,
  isReachable,
} from "./graph.js";

describe("CallEdgeResolution", () => {
  it("represents a resolved call", () => {
    const resolution: CallEdgeResolution = {
      kind: "resolved",
      target: "fixture-lib#vulnerable",
    };

    expect(isCallResolved(resolution)).toBe(true);
    if (isCallResolved(resolution)) {
      expect(resolution.target).toBe("fixture-lib#vulnerable");
    }
  });

  it("never fabricates an exact edge for a dynamic call (see docs/SDD.md § 21)", () => {
    const resolution: CallEdgeResolution = {
      kind: "unknown",
      reason: "dynamic_member_access",
      potentialTargets: ["foo.parseUnsafe", "foo.parseSafe"],
    };

    expect(isCallResolved(resolution)).toBe(false);
    expect(resolution.potentialTargets).toContain("foo.parseUnsafe");
  });
});

describe("ReachabilityResult", () => {
  const coverage = {
    files: 4,
    modulesResolved: 4,
    modulesUnresolved: 0,
    functions: 12,
    callsResolved: 10,
    callsDynamic: 1,
  };

  it("carries a path only when reachable", () => {
    const result: ReachabilityResult = {
      state: "reachable",
      source: "src/index.ts#main",
      target: "fixture-lib#vulnerable",
      path: ["src/index.ts#main", "fixture-lib#vulnerable"],
      coverage,
    };

    expect(isReachable(result)).toBe(true);
    if (isReachable(result)) {
      expect(result.path).toHaveLength(2);
    }
  });

  it("requires blockers, not just an absent path, to be unreachable", () => {
    const result: ReachabilityResult = {
      state: "unreachable",
      source: "src/index.ts#main",
      target: "fixture-lib#vulnerable",
      blockers: ["no call edge reaches the target"],
      coverage,
    };

    expect(isReachable(result)).toBe(false);
  });

  it("carries unresolvedEdges only when unknown", () => {
    const result: ReachabilityResult = {
      state: "unknown",
      source: "src/index.ts#main",
      target: "fixture-lib#vulnerable",
      blockers: ["dynamic call may or may not reach target"],
      unresolvedEdges: [
        { from: "src/index.ts#main", reason: "dynamic_member_access" },
      ],
      coverage,
    };

    expect(result.unresolvedEdges).toHaveLength(1);
  });
});

describe("CallGraph", () => {
  it("is composed of nodes and edges", () => {
    const graph: CallGraph = {
      nodes: [
        { id: "src/index.ts#main", kind: "function", module: "src/index.ts" },
        {
          id: "fixture-lib#vulnerable",
          kind: "function",
          module: "fixture-lib",
        },
      ],
      edges: [
        {
          from: "src/index.ts#main",
          type: "direct",
          resolution: { kind: "resolved", target: "fixture-lib#vulnerable" },
        },
      ],
    };

    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges[0]?.resolution.kind).toBe("resolved");
  });
});
