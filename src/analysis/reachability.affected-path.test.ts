import { describe, expect, it } from "vitest";
import type {
  CallEdge,
  CallGraph,
  GraphNode,
  GraphNodeId,
} from "../domain/graph.js";
import { analyzeReachability } from "./reachability.js";

/**
 * SOUNDNESS-CONTRACT § 1, `AFFECTED` (task A-1, ADR 0008 Decision 2): an
 * `AFFECTED` path consists of resolved edges only. `analyzeReachability`'s
 * `reachable` result is the path an `AFFECTED` finding reports, so this
 * owns the rule where the path is made: every hop of a reported path is a
 * resolved edge, and a target that only an unresolved edge names -- even
 * as a potential target -- is never reported reachable.
 *
 * Task A-2 introduced the `possible` edge kind (ADR 0008 § 1) and added
 * the other two halves of Decision 2, as the invariant map requires:
 *
 * - a path through a `possible` edge is never `reachable`, and a target
 *   reached only through `possible` edges is `unknown`
 *   (`possible_invocation`), never `unreachable`;
 * - the code behind a `possible` edge is searched: its unknown edges
 *   count against completeness, and a clean region that does not reach
 *   the target leaves `unreachable` standing (SOUNDNESS-CONTRACT § 3).
 *
 * The last block checks all three halves together against an independent
 * set-based oracle over seeded random graphs.
 */

function node(id: string): GraphNode {
  return { id, kind: "function", module: "a.ts", name: id };
}

function resolved(from: string, to: string): CallEdge {
  return { from, type: "direct", resolution: { kind: "resolved", target: to } };
}

function possible(from: string, to: string): CallEdge {
  return {
    from,
    type: "callback",
    resolution: { kind: "possible", target: to },
  };
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

function graphOf(
  ids: readonly string[],
  edges: readonly CallEdge[],
): CallGraph {
  return { nodes: ids.map(node), edges };
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

describe("a path through a possible edge is never an AFFECTED path", () => {
  it("a target a possible edge names directly is unknown, with the witness", () => {
    const graph = graphOf(["entry", "target"], [possible("entry", "target")]);
    const result = analyzeReachability(graph, node("entry"), node("target"));

    expect(result.state).toBe("unknown");
    if (result.state === "unknown") {
      expect(result.possibleOnlyPath).toEqual(["entry", "target"]);
      expect(result.unresolvedEdges).toEqual([]);
      expect(result.blockers).toEqual([
        "possible_invocation at entry (the target is reached only through a possible edge: entry -> target)",
      ]);
    }
  });

  it("resolved hops after a possible hop do not make the path resolved", () => {
    const graph = graphOf(
      ["entry", "a", "b", "target"],
      [resolved("entry", "a"), possible("a", "b"), resolved("b", "target")],
    );
    const result = analyzeReachability(graph, node("entry"), node("target"));

    expect(result.state).toBe("unknown");
    if (result.state === "unknown") {
      expect(result.possibleOnlyPath).toEqual(["entry", "a", "b", "target"]);
      expect(result.blockers).toEqual([
        "possible_invocation at a (the target is reached only through a possible edge: entry -> a -> b -> target)",
      ]);
    }
  });

  it("a longer all-resolved path wins over a shorter one through a possible edge", () => {
    // Breadth-first over every edge kind would report the one-hop path.
    const graph = graphOf(
      ["entry", "a", "b", "target"],
      [
        possible("entry", "target"),
        resolved("entry", "a"),
        resolved("a", "b"),
        resolved("b", "target"),
      ],
    );
    const result = analyzeReachability(graph, node("entry"), node("target"));

    expect(result.state).toBe("reachable");
    if (result.state === "reachable") {
      expect(result.path).toEqual(["entry", "a", "b", "target"]);
      expect(everyHopResolved(graph, result.path)).toBe(true);
    }
  });

  it("a resolved path found only behind a possible edge is still not reachable", () => {
    // `a` is first met through the possible edge; the resolved edge into
    // it comes from a node the resolved search never reaches.
    const graph = graphOf(
      ["entry", "a", "orphan", "target"],
      [
        possible("entry", "a"),
        resolved("orphan", "a"),
        resolved("a", "target"),
      ],
    );
    const result = analyzeReachability(graph, node("entry"), node("target"));

    expect(result.state).toBe("unknown");
    if (result.state === "unknown") {
      expect(result.possibleOnlyPath).toEqual(["entry", "a", "target"]);
    }
  });
});

describe("the code behind a possible edge is searched", () => {
  it("an unknown edge behind a possible edge withholds unreachable", () => {
    const graph = graphOf(
      ["entry", "a", "b", "target"],
      [
        possible("entry", "a"),
        resolved("a", "b"),
        {
          from: "b",
          type: "direct",
          resolution: {
            kind: "unknown",
            reason: "unsupported_construct",
            potentialTargets: [],
          },
        },
      ],
    );
    const result = analyzeReachability(graph, node("entry"), node("target"));

    expect(result.state).toBe("unknown");
    if (result.state === "unknown") {
      expect(result.unresolvedEdges).toEqual([
        { from: "b", reason: "unsupported_construct" },
      ]);
      // The target was not reached; this is incompleteness, not a witness.
      expect(result.possibleOnlyPath).toBeUndefined();
    }
  });

  it("a clean region behind a possible edge that never reaches the target leaves unreachable standing", () => {
    const graph = graphOf(
      ["entry", "a", "b", "c", "target"],
      [
        resolved("entry", "c"),
        possible("entry", "a"),
        resolved("a", "b"),
        possible("b", "a"),
      ],
    );
    const result = analyzeReachability(graph, node("entry"), node("target"));

    expect(result.state).toBe("unreachable");
  });

  it("possible edges chain: the region behind a possible edge behind a possible edge is searched", () => {
    const graph = graphOf(
      ["entry", "a", "b", "target"],
      [
        possible("entry", "a"),
        possible("a", "b"),
        {
          from: "b",
          type: "direct",
          resolution: {
            kind: "unknown",
            reason: "dynamic_require",
            potentialTargets: [],
          },
        },
      ],
    );
    const result = analyzeReachability(graph, node("entry"), node("target"));

    expect(result.state).toBe("unknown");
    if (result.state === "unknown") {
      expect(result.unresolvedEdges).toEqual([
        { from: "b", reason: "dynamic_require" },
      ]);
    }
  });
});

// --------------------------------------------------------------------
// All three halves, against an independent oracle.
// --------------------------------------------------------------------

/** mulberry32: a small, deterministic PRNG, so a failure reproduces. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDS = ["s", "n1", "n2", "n3", "n4", "t"] as const;

function randomGraph(random: () => number): CallGraph {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(random() * list.length)] as T;
  const edges: CallEdge[] = [];
  const count = Math.floor(random() * 11);
  for (let i = 0; i < count; i += 1) {
    const from = pick(IDS);
    const to = pick(IDS);
    const roll = random();
    if (roll < 0.45) {
      edges.push(resolved(from, to));
    } else if (roll < 0.8) {
      edges.push(possible(from, to));
    } else {
      edges.push(unknownNaming(from, to));
    }
  }
  return graphOf(IDS, edges);
}

/**
 * The expected answer, computed from sets rather than from a search order:
 *
 * - `reachable` iff the target is reachable from the source over resolved
 *   edges alone, at that shortest distance;
 * - otherwise the searched region is every node reachable from the source
 *   over resolved and possible edges without passing through the target;
 *   the answer is `unknown` iff a node of it has a resolved or possible
 *   edge to the target (a possible-only reach, with a witness) or any
 *   unknown edge (listed, as a multiset), and `unreachable` otherwise.
 */
function oracle(graph: CallGraph, source: GraphNodeId, target: GraphNodeId) {
  const out = (id: GraphNodeId) => graph.edges.filter((e) => e.from === id);
  const distance = new Map<GraphNodeId, number>([[source, 0]]);
  const frontier = [source];
  while (frontier.length > 0) {
    const id = frontier.shift() as GraphNodeId;
    if (id === target) continue;
    for (const edge of out(id)) {
      if (edge.resolution.kind !== "resolved") continue;
      const next = edge.resolution.target;
      if (!distance.has(next)) {
        distance.set(next, (distance.get(id) ?? 0) + 1);
        frontier.push(next);
      }
    }
  }
  if (distance.has(target)) {
    return { state: "reachable" as const, distance: distance.get(target) };
  }

  const region = new Set<GraphNodeId>([source]);
  const pending = [source];
  let targetHit = false;
  const unknown: string[] = [];
  while (pending.length > 0) {
    const id = pending.shift() as GraphNodeId;
    for (const edge of out(id)) {
      if (edge.resolution.kind === "unknown") {
        unknown.push(`${id}:${edge.resolution.reason}`);
        continue;
      }
      const next = edge.resolution.target;
      if (next === target) {
        targetHit = true;
      } else if (!region.has(next)) {
        region.add(next);
        pending.push(next);
      }
    }
  }
  return {
    state:
      targetHit || unknown.length > 0
        ? ("unknown" as const)
        : ("unreachable" as const),
    targetHit,
    unknown: unknown.sort(),
  };
}

/** `path` is a walk of `graph` over resolved and possible edges using at least one possible hop. */
function isPossibleWitness(graph: CallGraph, path: readonly string[]): boolean {
  const hops = path
    .slice(1)
    .map((to, i) =>
      graph.edges
        .filter(
          (edge) =>
            edge.from === path[i] &&
            edge.resolution.kind !== "unknown" &&
            edge.resolution.target === to,
        )
        .map((edge) => edge.resolution.kind),
    );
  return (
    hops.every((kinds) => kinds.length > 0) &&
    hops.some((kinds) => kinds.every((kind) => kind === "possible"))
  );
}

describe("the three halves hold together on seeded random graphs", () => {
  it("agrees with the set-based oracle on 3,000 graphs", () => {
    const random = prng(0xa2);
    // How often each outcome occurred: a sample that never produced one
    // would check nothing about it.
    const seen = {
      reachable: 0,
      reachableWithPossibleEdges: 0,
      possibleOnly: 0,
      incompleteBehindPossible: 0,
      unreachableWithPossibleEdges: 0,
    };
    for (let i = 0; i < 3000; i += 1) {
      const graph = randomGraph(random);
      const context = `graph #${i}: ${JSON.stringify(graph.edges)}`;
      const result = analyzeReachability(graph, node("s"), node("t"));
      const expected = oracle(graph, "s", "t");
      const hasPossible = graph.edges.some(
        (edge) => edge.resolution.kind === "possible",
      );
      if (result.state === "reachable") {
        seen.reachable += 1;
        if (hasPossible) seen.reachableWithPossibleEdges += 1;
      } else if (result.state === "unknown") {
        if (result.possibleOnlyPath !== undefined) {
          seen.possibleOnly += 1;
        } else if (hasPossible) {
          seen.incompleteBehindPossible += 1;
        }
      } else if (hasPossible) {
        seen.unreachableWithPossibleEdges += 1;
      }

      expect(result.state, context).toBe(expected.state);
      if (result.state === "reachable") {
        expect(result.path[0], context).toBe("s");
        expect(result.path.at(-1), context).toBe("t");
        expect(everyHopResolved(graph, result.path), context).toBe(true);
        expect(result.path.length - 1, context).toBe(
          "distance" in expected ? expected.distance : -1,
        );
      } else if (result.state === "unknown" && "unknown" in expected) {
        expect(
          result.unresolvedEdges.map((e) => `${e.from}:${e.reason}`).sort(),
          context,
        ).toEqual(expected.unknown);
        expect(result.possibleOnlyPath !== undefined, context).toBe(
          expected.targetHit,
        );
        if (result.possibleOnlyPath !== undefined) {
          const path = result.possibleOnlyPath;
          expect(path[0], context).toBe("s");
          expect(path.at(-1), context).toBe("t");
          expect(isPossibleWitness(graph, path), context).toBe(true);
          expect(
            result.blockers.filter((b) => b.startsWith("possible_invocation")),
            context,
          ).toHaveLength(1);
        }
      }
    }
    for (const [outcome, count] of Object.entries(seen)) {
      expect(
        count,
        `outcome "${outcome}" was sampled too rarely`,
      ).toBeGreaterThan(50);
    }
  });
});
