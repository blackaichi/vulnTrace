import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  ModuleResolutionResult,
  ModuleResolver,
} from "../code-intelligence/module-resolver.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import type { CallEdge, CallGraph, GraphNode } from "../domain/graph.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { buildFindingForTest } from "../testing/finding.js";

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
    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "not_affected",
      rule,
      graph: { nodes: [], edges: [] },
      entrypoints: [entrypoint],
      resolver: fakeResolver({}),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      // VT-301B: this suite's graphs are entirely synthetic (fake paths
      // like "/node_modules/fixture-lib/index.js" that never exist on
      // disk) -- production real-file target attribution has no
      // authoritative index to fall back on here, so this explicit
      // test-only opt-in is required. See the dedicated describe block
      // below proving the flag is what gates this, and
      // verdict.integration.test.ts for real-file coverage where this
      // flag is correctly never needed.
      allowSyntheticNameOnlyTargetBinding: true,
    });

    expect(finding).toBeUndefined();
  });
});

describe("buildFinding: indeterminate version match degrades to UNKNOWN", () => {
  it("returns UNKNOWN without checking reachability at all", async () => {
    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "indeterminate",
      rule,
      graph: { nodes: [], edges: [] },
      entrypoints: [entrypoint],
      resolver: fakeResolver({}),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      // VT-301B: this suite's graphs are entirely synthetic (fake paths
      // like "/node_modules/fixture-lib/index.js" that never exist on
      // disk) -- production real-file target attribution has no
      // authoritative index to fall back on here, so this explicit
      // test-only opt-in is required. See the dedicated describe block
      // below proving the flag is what gates this, and
      // verdict.integration.test.ts for real-file coverage where this
      // flag is correctly never needed.
      allowSyntheticNameOnlyTargetBinding: true,
    });

    expect(finding).toEqual({
      vulnerability: "GHSA-fixture-0001",
      package: "fixture-lib",
      version: "1.0.0",
      verdict: "UNKNOWN",
      // FOUNDATION F3: the verdict is unchanged; what is new is that this
      // UNKNOWN now says WHY. Applicability itself was undecidable -- the
      // installed version could not be established, so no advisory range
      // was ever evaluated -- which is an identity fact, not a construct
      // the analyzer declined to model.
      unknownReasons: [
        {
          category: "identity_unresolved",
          reason: "advisory_version_applicability_indeterminate",
          count: 1,
        },
      ],
    });
  });
});

describe("buildFinding: no known vulnerable target", () => {
  it("returns UNKNOWN when no rule exists for the vulnerability", async () => {
    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule: undefined,
      graph: { nodes: [], edges: [] },
      entrypoints: [entrypoint],
      resolver: fakeResolver({}),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      // VT-301B: this suite's graphs are entirely synthetic (fake paths
      // like "/node_modules/fixture-lib/index.js" that never exist on
      // disk) -- production real-file target attribution has no
      // authoritative index to fall back on here, so this explicit
      // test-only opt-in is required. See the dedicated describe block
      // below proving the flag is what gates this, and
      // verdict.integration.test.ts for real-file coverage where this
      // flag is correctly never needed.
      allowSyntheticNameOnlyTargetBinding: true,
    });

    expect(finding).toEqual({
      vulnerability: "GHSA-fixture-0001",
      package: "fixture-lib",
      version: "1.0.0",
      verdict: "UNKNOWN",
      // FOUNDATION F3: no rule means no model of what this advisory's
      // dangerous behavior IS, so reachability had nothing to search for.
      // A missing precondition of the analysis -- deliberately NOT
      // `unmodeled_construct`, which is reserved for syntax the frontend
      // could learn and is the class P1-B is prioritized from.
      unknownReasons: [
        {
          category: "analysis_precondition_unmet",
          reason: "no_vulnerable_symbol_rule",
          count: 1,
        },
      ],
    });
  });

  it("returns UNKNOWN when the rule has an empty targets array", async () => {
    const emptyRule: VulnerableSymbolRule = { ...rule, targets: [] };

    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule: emptyRule,
      graph: { nodes: [], edges: [] },
      entrypoints: [entrypoint],
      resolver: fakeResolver({}),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      // VT-301B: this suite's graphs are entirely synthetic (fake paths
      // like "/node_modules/fixture-lib/index.js" that never exist on
      // disk) -- production real-file target attribution has no
      // authoritative index to fall back on here, so this explicit
      // test-only opt-in is required. See the dedicated describe block
      // below proving the flag is what gates this, and
      // verdict.integration.test.ts for real-file coverage where this
      // flag is correctly never needed.
      allowSyntheticNameOnlyTargetBinding: true,
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

    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      // VT-301B: this suite's graphs are entirely synthetic (fake paths
      // like "/node_modules/fixture-lib/index.js" that never exist on
      // disk) -- production real-file target attribution has no
      // authoritative index to fall back on here, so this explicit
      // test-only opt-in is required. See the dedicated describe block
      // below proving the flag is what gates this, and
      // verdict.integration.test.ts for real-file coverage where this
      // flag is correctly never needed.
      allowSyntheticNameOnlyTargetBinding: true,
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

    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule: lowConfidenceRule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      // VT-301B: this suite's graphs are entirely synthetic (fake paths
      // like "/node_modules/fixture-lib/index.js" that never exist on
      // disk) -- production real-file target attribution has no
      // authoritative index to fall back on here, so this explicit
      // test-only opt-in is required. See the dedicated describe block
      // below proving the flag is what gates this, and
      // verdict.integration.test.ts for real-file coverage where this
      // flag is correctly never needed.
      allowSyntheticNameOnlyTargetBinding: true,
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

    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypointA, entrypointB],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      // VT-301B: this suite's graphs are entirely synthetic (fake paths
      // like "/node_modules/fixture-lib/index.js" that never exist on
      // disk) -- production real-file target attribution has no
      // authoritative index to fall back on here, so this explicit
      // test-only opt-in is required. See the dedicated describe block
      // below proving the flag is what gates this, and
      // verdict.integration.test.ts for real-file coverage where this
      // flag is correctly never needed.
      allowSyntheticNameOnlyTargetBinding: true,
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

    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule: twoTargetRule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      // VT-301B: this suite's graphs are entirely synthetic (fake paths
      // like "/node_modules/fixture-lib/index.js" that never exist on
      // disk) -- production real-file target attribution has no
      // authoritative index to fall back on here, so this explicit
      // test-only opt-in is required. See the dedicated describe block
      // below proving the flag is what gates this, and
      // verdict.integration.test.ts for real-file coverage where this
      // flag is correctly never needed.
      allowSyntheticNameOnlyTargetBinding: true,
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

    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      // VT-301B: this suite's graphs are entirely synthetic (fake paths
      // like "/node_modules/fixture-lib/index.js" that never exist on
      // disk) -- production real-file target attribution has no
      // authoritative index to fall back on here, so this explicit
      // test-only opt-in is required. See the dedicated describe block
      // below proving the flag is what gates this, and
      // verdict.integration.test.ts for real-file coverage where this
      // flag is correctly never needed.
      allowSyntheticNameOnlyTargetBinding: true,
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
        // VT-307e: proof family C now also carries an explicit, machine-
        // readable evidence object, so a consumer never has to parse the
        // prose reason above to learn WHICH proof produced this verdict,
        // which target it is about, or which roots it is relative to.
        confirmedUnreachableTarget: {
          target: { module: "fixture-lib", export: "vulnerable" },
          entrypointRoots: ["/project/src/index.ts"],
          reachableSubgraphComplete: true,
        },
      },
    });
  });

  it("produces NOT_AFFECTED when the target module resolves but was never discovered anywhere in a clean graph", async () => {
    // fixture-lib is a real, resolvable dependency, but nothing in the
    // analyzed (fully clean, no dynamic constructs) call graph ever
    // imports it at all -- and the module-load closure confirms it is
    // never loaded. Task V-1: that confirmation is the proof (family A);
    // the graph's silence alone is not, because a package loaded only
    // through `export *` has no graph node either (PRM-101). See the
    // Site B describe block below for the same graph with no instance.
    const entryFile = "/project/src/index.ts";
    const libFile = "/node_modules/fixture-lib/index.js";
    const src = moduleNode("src#<module>", entryFile);

    const graph: CallGraph = { nodes: [src], edges: [] };

    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      packageInstance: "/node_modules/fixture-lib",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      // A truthful closure for this synthetic project: the entrypoint is
      // its only member, so fixture-lib is not loaded (F4 § 24 requires
      // stating it beside a `packageInstance`).
      moduleLoadClosure: {
        rootFiles: [entryFile],
        loadedFiles: [entryFile],
        loadedPackageInstances: [],
        complete: true,
        incompleteness: [],
      },
      // VT-301B: this suite's graphs are entirely synthetic (fake paths
      // like "/node_modules/fixture-lib/index.js" that never exist on
      // disk) -- production real-file target attribution has no
      // authoritative index to fall back on here, so this explicit
      // test-only opt-in is required. See the dedicated describe block
      // below proving the flag is what gates this, and
      // verdict.integration.test.ts for real-file coverage where this
      // flag is correctly never needed.
      allowSyntheticNameOnlyTargetBinding: true,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure?.packageInstance,
    ).toBe("/node_modules/fixture-lib");
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

    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      // VT-301B: this suite's graphs are entirely synthetic (fake paths
      // like "/node_modules/fixture-lib/index.js" that never exist on
      // disk) -- production real-file target attribution has no
      // authoritative index to fall back on here, so this explicit
      // test-only opt-in is required. See the dedicated describe block
      // below proving the flag is what gates this, and
      // verdict.integration.test.ts for real-file coverage where this
      // flag is correctly never needed.
      allowSyntheticNameOnlyTargetBinding: true,
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
      // FOUNDATION F3 test-matrix row F. A CONFIGURED bound stopped the
      // work, which is its own category: the analyzer knows exactly how to
      // do this and was told not to, so the fix is a limit rather than
      // code. The prose reason above is retained verbatim alongside it.
      unknownReasons: [
        {
          category: "budget_exceeded",
          reason: "call_graph_truncated",
          count: 1,
        },
      ],
    });
  });

  it("still produces NOT_AFFECTED when graphTruncated is explicitly false", async () => {
    const entryFile = "/project/src/index.ts";
    const libFile = "/node_modules/fixture-lib/index.js";
    const src = moduleNode("src#<module>", entryFile);
    const other = fnNode("src#other@3:1", entryFile, "other", 3);
    // The same real, unreached target as the truncated case above (task
    // V-1: family C needs an attributed target, never a phantom).
    const vulnerableNode = fnNode(
      "lib#vulnerable@1:1",
      libFile,
      "vulnerable",
      1,
    );

    const graph: CallGraph = {
      nodes: [src, other, vulnerableNode],
      edges: [resolvedEdge(src.id, other.id)],
    };

    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      // VT-301B: this suite's graphs are entirely synthetic (fake paths
      // like "/node_modules/fixture-lib/index.js" that never exist on
      // disk) -- production real-file target attribution has no
      // authoritative index to fall back on here, so this explicit
      // test-only opt-in is required. See the dedicated describe block
      // below proving the flag is what gates this, and
      // verdict.integration.test.ts for real-file coverage where this
      // flag is correctly never needed.
      allowSyntheticNameOnlyTargetBinding: true,
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

    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      // VT-301B: this suite's graphs are entirely synthetic (fake paths
      // like "/node_modules/fixture-lib/index.js" that never exist on
      // disk) -- production real-file target attribution has no
      // authoritative index to fall back on here, so this explicit
      // test-only opt-in is required. See the dedicated describe block
      // below proving the flag is what gates this, and
      // verdict.integration.test.ts for real-file coverage where this
      // flag is correctly never needed.
      allowSyntheticNameOnlyTargetBinding: true,
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

    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      // VT-301B: this suite's graphs are entirely synthetic (fake paths
      // like "/node_modules/fixture-lib/index.js" that never exist on
      // disk) -- production real-file target attribution has no
      // authoritative index to fall back on here, so this explicit
      // test-only opt-in is required. See the dedicated describe block
      // below proving the flag is what gates this, and
      // verdict.integration.test.ts for real-file coverage where this
      // flag is correctly never needed.
      allowSyntheticNameOnlyTargetBinding: true,
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
    // A real target the search cannot rule out (task V-1: a target with no
    // graph node is unresolved before any search runs).
    const vulnerableNode = fnNode(
      "lib#vulnerable@1:1",
      libFile,
      "vulnerable",
      1,
    );
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
      nodes: [src, other, vulnerableNode],
      edges: [resolvedEdge(src.id, other.id), dynamicEdge],
    };

    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      // VT-301B: this suite's graphs are entirely synthetic (fake paths
      // like "/node_modules/fixture-lib/index.js" that never exist on
      // disk) -- production real-file target attribution has no
      // authoritative index to fall back on here, so this explicit
      // test-only opt-in is required. See the dedicated describe block
      // below proving the flag is what gates this, and
      // verdict.integration.test.ts for real-file coverage where this
      // flag is correctly never needed.
      allowSyntheticNameOnlyTargetBinding: true,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.target).toEqual(rule.targets[0]);
    expect(finding?.evidence?.reasons).toEqual([
      "dynamic_member_access at " + other.id,
    ]);
  });

  it("produces UNKNOWN when the target's module cannot be resolved at all", async () => {
    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph: { nodes: [], edges: [] },
      entrypoints: [entrypoint],
      resolver: fakeResolver({}), // "fixture-lib" is not in the mapping
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      // VT-301B: this suite's graphs are entirely synthetic (fake paths
      // like "/node_modules/fixture-lib/index.js" that never exist on
      // disk) -- production real-file target attribution has no
      // authoritative index to fall back on here, so this explicit
      // test-only opt-in is required. See the dedicated describe block
      // below proving the flag is what gates this, and
      // verdict.integration.test.ts for real-file coverage where this
      // flag is correctly never needed.
      allowSyntheticNameOnlyTargetBinding: true,
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
  //
  // Task V-3 (ADR 0011 predicate 4): a configured symbol is rooted at the
  // node of the DECLARATION its export binds to, found by position in the
  // real entrypoint file -- never at a node merely named like it. So the
  // entrypoint is a real file (the graph and the library stay synthetic),
  // whose declarations sit exactly where the synthetic nodes say: `main`
  // at 3:1, `unused` at 7:1. Without a file there is nothing to look the
  // symbol up in, which is root incompleteness (ADR 0011 § 3).
  const projectDir = mkdtempSync(path.join(tmpdir(), "vulntrace-vt205-"));
  mkdirSync(path.join(projectDir, "src"));
  const entryFile = path.join(projectDir, "src/index.ts");
  writeFileSync(
    entryFile,
    "declare function safe(): string;\n" +
      "declare function vulnerable(): string;\n" +
      "export function main() {\n  return safe();\n}\n\n" +
      "export function unused() {\n  return vulnerable();\n}\n",
  );
  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });
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

    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph: buildGraph(),
      entrypoints: [symbolScopedEntrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      // VT-301B: this suite's graphs are entirely synthetic (fake paths
      // like "/node_modules/fixture-lib/index.js" that never exist on
      // disk) -- production real-file target attribution has no
      // authoritative index to fall back on here, so this explicit
      // test-only opt-in is required. See the dedicated describe block
      // below proving the flag is what gates this, and
      // verdict.integration.test.ts for real-file coverage where this
      // flag is correctly never needed.
      allowSyntheticNameOnlyTargetBinding: true,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
  });

  it("is UNKNOWN (entrypoint_root_incomplete) when the configured symbol's file cannot be read (task V-3, ADR 0011 § 3)", async () => {
    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      // The same graph, rooted in a file that does not exist: no symbol
      // can be looked up in it, so none materializes.
      graph: {
        nodes: buildGraph().nodes.map((n) =>
          n.module === entryFile
            ? {
                ...n,
                module: "/project/missing/index.ts",
                ...(n.location
                  ? {
                      location: {
                        ...n.location,
                        file: "/project/missing/index.ts",
                      },
                    }
                  : {}),
              }
            : n,
        ),
        edges: buildGraph().edges,
      },
      entrypoints: [
        {
          ...entrypoint,
          filePath: "/project/missing/index.ts",
          symbol: "main",
        },
      ],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      syntheticGraphHasNoRealFiles: true,
      allowSyntheticNameOnlyTargetBinding: true,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.unknownReasons?.map((r) => r.reason)).toContain(
      "entrypoint_root_incomplete",
    );
  });

  // The no-symbol default path roots every export of the same file; see
  // verdict.integration.test.ts's VT-205 block for "no symbol configured
  // still reaches AFFECTED via the sibling export", over a real call graph.

  it("finds AFFECTED when the configured symbol itself is the one that reaches the target", async () => {
    const symbolScopedEntrypoint: Entrypoint = {
      ...entrypoint,
      filePath: entryFile,
      symbol: "unused",
    };

    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph: buildGraph(),
      entrypoints: [symbolScopedEntrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      // VT-301B: this suite's graphs are entirely synthetic (fake paths
      // like "/node_modules/fixture-lib/index.js" that never exist on
      // disk) -- production real-file target attribution has no
      // authoritative index to fall back on here, so this explicit
      // test-only opt-in is required. See the dedicated describe block
      // below proving the flag is what gates this, and
      // verdict.integration.test.ts for real-file coverage where this
      // flag is correctly never needed.
      allowSyntheticNameOnlyTargetBinding: true,
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });
});

describe("buildFinding: allowSyntheticNameOnlyTargetBinding gates the bare-name fallback (VT-301B)", () => {
  // Same fixture used throughout this file: a synthetic graph node named
  // "vulnerable" in libFile, reachable from the entrypoint, with no real
  // file on disk behind it at all -- indexSourceFileFromDisk always
  // throws for this path, so this exercises exactly the "catch" branch
  // of findExportNodeInFile.
  function buildSyntheticAffectedGraph() {
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
    return { graph, libFile };
  }

  it("does NOT bind via bare-name match when the flag is omitted (production default), even though the reachable edge would otherwise make this AFFECTED", async () => {
    const { graph, libFile } = buildSyntheticAffectedGraph();

    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      // Deliberately omitted -- proves the flag, not something else,
      // gates the fallback.
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.reasons?.[0]).toContain(
      "could not be attributed to any function or class member",
    );
  });

  it("does NOT bind via bare-name match when the flag is explicitly false", async () => {
    const { graph, libFile } = buildSyntheticAffectedGraph();

    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      allowSyntheticNameOnlyTargetBinding: false,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("DOES bind via bare-name match, and reports AFFECTED, only when the flag is explicitly true", async () => {
    const { graph, libFile } = buildSyntheticAffectedGraph();

    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      allowSyntheticNameOnlyTargetBinding: true,
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });
});

describe("buildFinding: Site B (package never discovered by the graph at all) proves only through family A (task V-1)", () => {
  // Distinct from Site A above: here NOTHING in the graph touches
  // fixture-lib at all, so resolveTargetNodes takes the fresh-resolution
  // branch. Until task V-1 it fell through to a phantom target, and a
  // clean reachability search over it was family C. That was not a proof:
  // the call graph follows no re-export declaration, so a package loaded
  // only through `export *` has no graph node either, and runs (PRM-101;
  // ADR 0011 § 6 reopens VT-301B). Site B now proves non-reachability only
  // through family A -- a complete module-load closure that does not
  // contain the finding's instance -- and is UNKNOWN otherwise. Both pass
  // flag: false (the production default): neither depends on the
  // synthetic opt-in.
  const entryFile = "/project/src/index.ts";
  const libFile = "/node_modules/fixture-lib/index.js";
  // No node anywhere in this graph belongs to fixture-lib, matching Site B
  // exactly.
  const graph: CallGraph = {
    nodes: [moduleNode("src#<module>", entryFile)],
    edges: [],
  };

  it("produces NOT_AFFECTED through family A when the closure shows the instance unloaded", async () => {
    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      packageInstance: "/node_modules/fixture-lib",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      moduleLoadClosure: {
        rootFiles: [entryFile],
        loadedFiles: [entryFile],
        loadedPackageInstances: [],
        complete: true,
        incompleteness: [],
      },
      allowSyntheticNameOnlyTargetBinding: false,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure?.packageInstance,
    ).toBe("/node_modules/fixture-lib");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("produces UNKNOWN, never a phantom-backed family C, when nothing proves the instance unloaded", async () => {
    // No instance at all, so family A has nothing to prove absent.
    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      // Every graph, path and resolver in this suite is synthetic; no real
      // closure can be built over files that do not exist (F2-A).
      syntheticGraphHasNoRealFiles: true,
      allowSyntheticNameOnlyTargetBinding: false,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
    expect(finding?.unknownReasons?.map((reason) => reason.reason)).toEqual([
      "vulnerable_target_unresolved",
    ]);
  });

  it("keeps the reachable blockers the phantom search used to report", async () => {
    // A dynamic `require` reachable from the entrypoint may be what loads
    // fixture-lib. Until V-1 the search over the phantom reported it; it is
    // still reported, typed, beside the unresolved target.
    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      matchResult: "affected",
      rule,
      graph: {
        nodes: graph.nodes,
        edges: [
          {
            from: "src#<module>",
            type: "direct",
            resolution: {
              kind: "unknown",
              reason: "dynamic_require",
              potentialTargets: [],
            },
          },
        ],
      },
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      syntheticGraphHasNoRealFiles: true,
      allowSyntheticNameOnlyTargetBinding: false,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.reasons).toContain(
      "dynamic_require at src#<module>",
    );
    expect(finding?.unknownReasons?.map((reason) => reason.reason)).toEqual(
      expect.arrayContaining([
        "vulnerable_target_unresolved",
        "dynamic_require",
      ]),
    );
  });

  it("produces UNKNOWN when the closure shows the instance LOADED with no graph node (PRM-101's shape)", async () => {
    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      packageInstance: "/node_modules/fixture-lib",
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": libFile }),
      projectRoot: "/project",
      moduleLoadClosure: {
        rootFiles: [entryFile],
        loadedFiles: [entryFile, libFile],
        loadedPackageInstances: ["/node_modules/fixture-lib"],
        complete: true,
        incompleteness: [],
      },
      allowSyntheticNameOnlyTargetBinding: false,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
    expect(finding?.unknownReasons?.map((reason) => reason.reason)).toEqual([
      "vulnerable_target_unresolved",
    ]);
    expect(
      finding?.evidence?.reasons?.some((reason) =>
        reason.includes("shows this package instance loaded"),
      ),
    ).toBe(true);
  });
});
