import { describe, expect, it } from "vitest";
import type {
  ModuleResolutionResult,
  ModuleResolver,
} from "../code-intelligence/module-resolver.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import type { CallEdge, CallGraph, GraphNode } from "../domain/graph.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { buildFinding } from "./verdict.js";

function fakeResolver(mapping: Record<string, string>): ModuleResolver {
  return {
    resolve(specifier, importer): Promise<ModuleResolutionResult> {
      const resolvedFileName = mapping[specifier];
      if (resolvedFileName) {
        return Promise.resolve({
          kind: "resolved",
          resolvedFileName,
          isExternalLibraryImport: true,
        });
      }
      return Promise.resolve({
        kind: "unresolved",
        specifier,
        importer,
        reason: `no mapping for "${specifier}"`,
      });
    },
  };
}

function vulnerability(id: string): Vulnerability {
  return {
    id,
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [],
    fixedVersions: [],
    references: [],
  };
}

function moduleNode(id: string, file: string): GraphNode {
  return { id, kind: "module", module: file };
}

function fnNode(
  id: string,
  file: string,
  name: string,
  line: number,
): GraphNode {
  return {
    id,
    kind: "function",
    module: file,
    name,
    location: { file, line, column: 1 },
  };
}

function resolvedEdge(from: string, to: string): CallEdge {
  return { from, type: "import", resolution: { kind: "resolved", target: to } };
}

const entrypoint: Entrypoint = {
  filePath: "/project/src/index.ts",
  source: "configured",
  reason: "analysis.entrypoints[0]: src/index.ts",
};

const rule: VulnerableSymbolRule = {
  id: "GHSA-fixture-0001",
  package: { name: "fixture-lib" },
  targets: [
    {
      module: "fixture-lib",
      export: "vulnerable",
      kind: "function",
      confidence: 1.0,
    },
  ],
};

describe("buildFinding: dependency not vulnerable", () => {
  it("produces no finding when the version match is confidently not_affected", async () => {
    const finding = await buildFinding({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "not_affected",
      rule,
      graph: { nodes: [], edges: [] },
      entrypoints: [entrypoint],
      resolver: fakeResolver({}),
      projectRoot: "/project",
    });

    expect(finding).toBeUndefined();
  });
});

describe("buildFinding: indeterminate version match degrades to UNKNOWN", () => {
  it("returns UNKNOWN without checking reachability at all", async () => {
    const finding = await buildFinding({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "indeterminate",
      rule,
      graph: { nodes: [], edges: [] },
      entrypoints: [entrypoint],
      resolver: fakeResolver({}),
      projectRoot: "/project",
    });

    expect(finding).toEqual({
      vulnerability: "GHSA-fixture-0001",
      package: "fixture-lib",
      version: "1.0.0",
      verdict: "UNKNOWN",
    });
  });
});

describe("buildFinding: no known vulnerable target", () => {
  it("returns UNKNOWN when no rule exists for the vulnerability", async () => {
    const finding = await buildFinding({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule: undefined,
      graph: { nodes: [], edges: [] },
      entrypoints: [entrypoint],
      resolver: fakeResolver({}),
      projectRoot: "/project",
    });

    expect(finding).toEqual({
      vulnerability: "GHSA-fixture-0001",
      package: "fixture-lib",
      version: "1.0.0",
      verdict: "UNKNOWN",
    });
  });

  it("returns UNKNOWN when the rule has an empty targets array", async () => {
    const emptyRule: VulnerableSymbolRule = { ...rule, targets: [] };

    const finding = await buildFinding({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule: emptyRule,
      graph: { nodes: [], edges: [] },
      entrypoints: [entrypoint],
      resolver: fakeResolver({}),
      projectRoot: "/project",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });
});

describe("buildFinding: AFFECTED requires sufficient reachable evidence", () => {
  it("produces AFFECTED with the exact path and standard reasons when the target is reachable", async () => {
    const entryFile = "/project/src/index.ts";
    const libFile = "/node_modules/fixture-lib/index.js";
    const src = moduleNode("src#<module>", entryFile);
    const main = fnNode("src#main@3:1", entryFile, "main", 3);
    const vulnerableNode = fnNode(
      "lib#vulnerable@1:1",
      libFile,
      "vulnerable",
      1,
    );

    const graph: CallGraph = {
      nodes: [src, main, vulnerableNode],
      edges: [
        resolvedEdge(src.id, main.id),
        resolvedEdge(main.id, vulnerableNode.id),
      ],
    };

    const finding = await buildFinding({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
    });

    expect(finding).toEqual({
      vulnerability: "GHSA-fixture-0001",
      package: "fixture-lib",
      version: "1.0.0",
      verdict: "AFFECTED",
      confidence: 1.0,
      target: rule.targets[0],
      evidence: {
        path: [entryFile, `${entryFile}:3`, `${libFile}:1`],
        reasons: [
          "vulnerable symbol resolved",
          "symbol reachable from application entrypoint",
        ],
      },
    });
  });

  it("uses the target's own declared confidence when it is below 1", async () => {
    const lowConfidenceRule: VulnerableSymbolRule = {
      ...rule,
      targets: [{ ...rule.targets[0]!, confidence: 0.8 }],
    };
    const entryFile = "/project/src/index.ts";
    const libFile = "/node_modules/fixture-lib/index.js";
    const src = moduleNode("src#<module>", entryFile);
    const vulnerableNode = fnNode(
      "lib#vulnerable@1:1",
      libFile,
      "vulnerable",
      1,
    );

    const graph: CallGraph = {
      nodes: [src, vulnerableNode],
      edges: [resolvedEdge(src.id, vulnerableNode.id)],
    };

    const finding = await buildFinding({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule: lowConfidenceRule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
    });

    expect(finding?.confidence).toBe(0.8);
  });

  it("finds AFFECTED via a second entrypoint when the first does not reach the target", async () => {
    const entryFileA = "/project/src/a.ts";
    const entryFileB = "/project/src/b.ts";
    const libFile = "/node_modules/fixture-lib/index.js";
    const srcA = moduleNode("a#<module>", entryFileA);
    const srcB = moduleNode("b#<module>", entryFileB);
    const vulnerableNode = fnNode(
      "lib#vulnerable@1:1",
      libFile,
      "vulnerable",
      1,
    );

    const graph: CallGraph = {
      nodes: [srcA, srcB, vulnerableNode],
      edges: [resolvedEdge(srcB.id, vulnerableNode.id)], // only B reaches it
    };

    const entrypointA: Entrypoint = { ...entrypoint, filePath: entryFileA };
    const entrypointB: Entrypoint = { ...entrypoint, filePath: entryFileB };

    const finding = await buildFinding({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypointA, entrypointB],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("finds AFFECTED via a second target when the first target's module fails to resolve", async () => {
    const entryFile = "/project/src/index.ts";
    const libFile = "/node_modules/fixture-lib/index.js";
    const src = moduleNode("src#<module>", entryFile);
    const vulnerableNode = fnNode(
      "lib#vulnerable@1:1",
      libFile,
      "vulnerable",
      1,
    );

    const graph: CallGraph = {
      nodes: [src, vulnerableNode],
      edges: [resolvedEdge(src.id, vulnerableNode.id)],
    };

    const twoTargetRule: VulnerableSymbolRule = {
      ...rule,
      targets: [
        { module: "unresolvable-lib", export: "danger" },
        { module: "fixture-lib", export: "vulnerable" },
      ],
    };

    const finding = await buildFinding({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule: twoTargetRule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });
});

describe("buildFinding: NOT_AFFECTED requires adequate coverage", () => {
  it("produces NOT_AFFECTED when the target is confirmed unreachable with no blocking uncertainty", async () => {
    const entryFile = "/project/src/index.ts";
    const libFile = "/node_modules/fixture-lib/index.js";
    const src = moduleNode("src#<module>", entryFile);
    const other = fnNode("src#other@3:1", entryFile, "other", 3);
    const vulnerableNode = fnNode(
      "lib#vulnerable@1:1",
      libFile,
      "vulnerable",
      1,
    );

    const graph: CallGraph = {
      nodes: [src, other, vulnerableNode],
      edges: [resolvedEdge(src.id, other.id)], // never reaches vulnerable
    };

    const finding = await buildFinding({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
    });

    expect(finding).toEqual({
      vulnerability: "GHSA-fixture-0001",
      package: "fixture-lib",
      version: "1.0.0",
      verdict: "NOT_AFFECTED",
      target: rule.targets[0],
      evidence: {
        path: [],
        reasons: [
          "vulnerable symbol confirmed unreachable from all analyzed entrypoints",
        ],
      },
    });
  });

  it("produces NOT_AFFECTED when the target module resolves but was never discovered anywhere in a clean graph", async () => {
    // fixture-lib is a real, resolvable dependency, but nothing in the
    // analyzed (fully clean, no dynamic constructs) call graph ever
    // imports it at all.
    const entryFile = "/project/src/index.ts";
    const libFile = "/node_modules/fixture-lib/index.js";
    const src = moduleNode("src#<module>", entryFile);

    const graph: CallGraph = { nodes: [src], edges: [] };

    const finding = await buildFinding({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
  });
});

describe("buildFinding: graphTruncated downgrades NOT_AFFECTED to UNKNOWN (VT-202)", () => {
  it("produces UNKNOWN instead of NOT_AFFECTED when the graph was truncated by a resource limit", async () => {
    const entryFile = "/project/src/index.ts";
    const libFile = "/node_modules/fixture-lib/index.js";
    const src = moduleNode("src#<module>", entryFile);
    const other = fnNode("src#other@3:1", entryFile, "other", 3);
    const vulnerableNode = fnNode(
      "lib#vulnerable@1:1",
      libFile,
      "vulnerable",
      1,
    );

    // Same shape as the "confirmed unreachable" NOT_AFFECTED case above --
    // the search itself finds no path and no unknown edge -- but the
    // graph is flagged as truncated, so the untraversed region could have
    // held the real path.
    const graph: CallGraph = {
      nodes: [src, other, vulnerableNode],
      edges: [resolvedEdge(src.id, other.id)],
    };

    const finding = await buildFinding({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      graphTruncated: true,
    });

    expect(finding).toEqual({
      vulnerability: "GHSA-fixture-0001",
      package: "fixture-lib",
      version: "1.0.0",
      verdict: "UNKNOWN",
      target: rule.targets[0],
      evidence: {
        path: [],
        reasons: [
          "call-graph construction was truncated by a configured resource limit (analysis.limits) before every reachable path could be exhaustively searched",
        ],
      },
    });
  });

  it("still produces NOT_AFFECTED when graphTruncated is explicitly false", async () => {
    const entryFile = "/project/src/index.ts";
    const libFile = "/node_modules/fixture-lib/index.js";
    const src = moduleNode("src#<module>", entryFile);
    const other = fnNode("src#other@3:1", entryFile, "other", 3);

    const graph: CallGraph = {
      nodes: [src, other],
      edges: [resolvedEdge(src.id, other.id)],
    };

    const finding = await buildFinding({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      graphTruncated: false,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
  });

  it("does not affect AFFECTED even when the graph was truncated elsewhere", async () => {
    const entryFile = "/project/src/index.ts";
    const libFile = "/node_modules/fixture-lib/index.js";
    const src = moduleNode("src#<module>", entryFile);
    const vulnerableNode = fnNode(
      "lib#vulnerable@1:1",
      libFile,
      "vulnerable",
      1,
    );

    const graph: CallGraph = {
      nodes: [src, vulnerableNode],
      edges: [resolvedEdge(src.id, vulnerableNode.id)],
    };

    const finding = await buildFinding({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      graphTruncated: true,
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });
});

describe("buildFinding: UNKNOWN when reachability was never actually checked (regression)", () => {
  // Discovered while wiring the CLI (TASK-022) to real projects: a project
  // with no configured/discoverable entrypoints at all produces an empty
  // `entrypoints` array. Previously this fell through to NOT_AFFECTED —
  // "confirmed unreachable" — even though no reachability search ever ran,
  // which is exactly the false-certainty AGENTS.md forbids.
  it("produces UNKNOWN, not NOT_AFFECTED, when there are no entrypoints to search from", async () => {
    const libFile = "/node_modules/fixture-lib/index.js";
    const vulnerableNode = fnNode(
      "lib#vulnerable@1:1",
      libFile,
      "vulnerable",
      1,
    );

    const graph: CallGraph = { nodes: [vulnerableNode], edges: [] };

    const finding = await buildFinding({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.reasons).toEqual([
      "no entrypoints were available to check reachability from",
    ]);
  });
});

describe("buildFinding: UNKNOWN is preserved for unresolved cases", () => {
  it("produces UNKNOWN, not NOT_AFFECTED, when a dynamic construct blocks the search", async () => {
    const entryFile = "/project/src/index.ts";
    const libFile = "/node_modules/fixture-lib/index.js";
    const src = moduleNode("src#<module>", entryFile);
    const other = fnNode("src#other@3:1", entryFile, "other", 3);
    const dynamicEdge: CallEdge = {
      from: other.id,
      type: "direct",
      resolution: {
        kind: "unknown",
        reason: "dynamic_member_access",
        potentialTargets: [],
      },
    };

    const graph: CallGraph = {
      nodes: [src, other],
      edges: [resolvedEdge(src.id, other.id), dynamicEdge],
    };

    const finding = await buildFinding({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.target).toEqual(rule.targets[0]);
    expect(finding?.evidence?.reasons).toEqual([
      "dynamic_member_access at " + other.id,
    ]);
  });

  it("produces UNKNOWN when the target's module cannot be resolved at all", async () => {
    const finding = await buildFinding({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph: { nodes: [], edges: [] },
      entrypoints: [entrypoint],
      resolver: fakeResolver({}), // "fixture-lib" is not in the mapping
      projectRoot: "/project",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.reasons?.[0]).toContain(
      'could not resolve module "fixture-lib"',
    );
  });
});

describe("buildFinding: {file, symbol} entrypoints scope reachability to only that symbol (VT-205)", () => {
  // SDD-v0.2.md § 6's own example: main() calls safe(); a sibling export,
  // unused(), calls vulnerable() but is never called by main(). With a
  // plain file-only entrypoint both exports count as sources (unchanged,
  // backward-compatible default); with {file, symbol: "main"}, unused()'s
  // own edge to vulnerable() must not make this AFFECTED merely because
  // unused() happens to live in the same file.
  const entryFile = "/project/src/index.ts";
  const libFile = "/node_modules/fixture-lib/index.js";

  function buildGraph(): CallGraph {
    const src = moduleNode("src#<module>", entryFile);
    const main = fnNode("src#main@3:1", entryFile, "main", 3);
    const unused = fnNode("src#unused@7:1", entryFile, "unused", 7);
    const safeNode = fnNode("lib#safe@5:1", libFile, "safe", 5);
    const vulnerableNode = fnNode(
      "lib#vulnerable@1:1",
      libFile,
      "vulnerable",
      1,
    );

    return {
      nodes: [src, main, unused, safeNode, vulnerableNode],
      edges: [
        resolvedEdge(main.id, safeNode.id),
        resolvedEdge(unused.id, vulnerableNode.id),
      ],
    };
  }

  it('does not become AFFECTED via a sibling export\'s own call when symbol: "main" is configured', async () => {
    const symbolScopedEntrypoint: Entrypoint = {
      ...entrypoint,
      filePath: entryFile,
      symbol: "main",
    };

    const finding = await buildFinding({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph: buildGraph(),
      entrypoints: [symbolScopedEntrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
  });

  // The no-symbol default path enumerates every export by reading the
  // entrypoint file from disk (unchanged, pre-VT-205 behavior) -- unlike
  // the symbol-scoped path above, which needs no file I/O at all. That
  // makes it untestable against these synthetic, non-existent file paths;
  // see verdict.integration.test.ts's VT-205 block for the real-file
  // equivalent of "no symbol configured still reaches AFFECTED via the
  // sibling export."

  it("finds AFFECTED when the configured symbol itself is the one that reaches the target", async () => {
    const symbolScopedEntrypoint: Entrypoint = {
      ...entrypoint,
      filePath: entryFile,
      symbol: "unused",
    };

    const finding = await buildFinding({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph: buildGraph(),
      entrypoints: [symbolScopedEntrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });
});
