import { describe, expect, it } from "vitest";
import type {
  ModuleResolutionResult,
  ModuleResolver,
} from "../code-intelligence/module-resolver.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import type {
  CallEdge,
  CallGraph,
  DynamicCallReason,
  GraphNode,
} from "../domain/graph.js";
import { canonicalizePackageInstancePath } from "../domain/resolved-target.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import {
  invalidatesCallGraphNegativeProof,
  type ClosureIncompletenessReason,
  type ModuleLoadClosure,
} from "./module-load-closure.js";
import { buildFinding } from "./verdict.js";

/**
 * VT-307e -- the unified NEGATIVE-PROOF matrix.
 *
 * VulnTrace has exactly three ways to conclude NOT_AFFECTED, and this file
 * pins all three together, because the property that matters is not any one
 * of them in isolation but the rule they share:
 *
 *   every NOT_AFFECTED carries explicit positive evidence, and is blocked
 *   by exactly the uncertainty that can invalidate THAT proof -- no more,
 *   no less.
 *
 * | family | claim                                   | evidence                             |
 * | ------ | --------------------------------------- | ------------------------------------ |
 * | A      | the instance cannot be LOADED at all     | confirmedAbsentFromModuleLoadClosure |
 * | B      | the graph never TRAVERSED the instance   | confirmedAbsentInstance              |
 * | C      | the resolved target is never CALLED      | confirmedUnreachableTarget           |
 *
 * The "no more" half is as load-bearing as the "no less" half: a blanket
 * rule that blocked every proof on every uncertainty would be trivially
 * sound and useless, so each non-blocking decision below is asserted
 * explicitly, with the structural reason it is safe.
 */

const ENTRY = "/project/src/index.ts";
const LIB_FILE = "/node_modules/fixture-lib/index.js";
const LIB = canonicalizePackageInstancePath("/node_modules/fixture-lib");

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

const vulnerability: Vulnerability = {
  id: "GHSA-fixture-0001",
  aliases: [],
  package: "fixture-lib",
  ecosystem: "npm",
  affectedVersions: [],
  fixedVersions: [],
  references: [],
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

const entrypoint: Entrypoint = {
  filePath: ENTRY,
  source: "configured",
  reason: "analysis.entrypoints[0]",
};

const moduleNode = (id: string, file: string): GraphNode => ({
  id,
  kind: "module",
  module: file,
});
const fnNode = (
  id: string,
  file: string,
  name: string,
  line: number,
): GraphNode => ({
  id,
  kind: "function",
  module: file,
  name,
  location: { file, line, column: 1 },
});

/** A closure rooted at a real entrypoint; `reasons` drive `complete`. */
function closure(
  reasons: readonly ClosureIncompletenessReason[] = [],
  loadedPackageInstances: readonly string[] = [],
): ModuleLoadClosure {
  return {
    rootFiles: [ENTRY],
    loadedFiles: [ENTRY],
    loadedPackageInstances,
    complete: reasons.length === 0,
    incompleteness: reasons.map((reason) => ({ reason, importer: ENTRY })),
  };
}

/** Nothing in the graph touches fixture-lib: Site B. */
const siteB = (): CallGraph => ({
  nodes: [moduleNode("src#<module>", ENTRY)],
  edges: [],
});

/** fixture-lib IS in the graph, but only as a non-target function: Site A. */
const siteA = (): CallGraph => ({
  nodes: [
    moduleNode("src#<module>", ENTRY),
    moduleNode("lib#<module>", LIB_FILE),
    fnNode("lib#other", LIB_FILE, "somethingElse", 9),
  ],
  edges: [],
});

const unknownEdge = (reason: DynamicCallReason): CallEdge => ({
  from: "src#<module>",
  type: "direct",
  resolution: { kind: "unknown", reason, potentialTargets: [] },
});

async function verdictFor(options: {
  graph?: CallGraph;
  moduleLoadClosure?: ModuleLoadClosure;
  packageInstance?: string | undefined;
  graphTruncated?: boolean;
  resolverMap?: Record<string, string>;
  rule?: VulnerableSymbolRule | undefined;
  allowSyntheticNameOnlyTargetBinding?: boolean;
}) {
  return buildFinding({
    vulnerability,
    packageName: "fixture-lib",
    packageVersion: "1.0.0",
    packageInstance:
      "packageInstance" in options ? options.packageInstance : LIB,
    matchResult: "affected",
    rule: "rule" in options ? options.rule : rule,
    graph: options.graph ?? siteB(),
    entrypoints: [entrypoint],
    resolver: fakeResolver(options.resolverMap ?? { "fixture-lib": LIB_FILE }),
    projectRoot: "/project",
    moduleLoadClosure: options.moduleLoadClosure,
    graphTruncated: options.graphTruncated,
    allowSyntheticNameOnlyTargetBinding:
      options.allowSyntheticNameOnlyTargetBinding,
  });
}

/** Which proof family (if any) produced this finding. */
function familyOf(f: Awaited<ReturnType<typeof buildFinding>>): string {
  const e = f?.evidence;
  if (e?.confirmedAbsentFromModuleLoadClosure) return "A";
  if (e?.confirmedAbsentInstance) return "B";
  if (e?.confirmedUnreachableTarget) return "C";
  return "-";
}

describe("VT-307e case 1-2: module-load absence proof (family A)", () => {
  it("case 1: exact instance OUT + complete closure -> NOT_AFFECTED via family A", async () => {
    const f = await verdictFor({ moduleLoadClosure: closure() });
    expect(f?.verdict).toBe("NOT_AFFECTED");
    expect(familyOf(f)).toBe("A");
    expect(f?.evidence?.reasons).toEqual([
      "package_instance_not_in_complete_module_load_closure",
    ]);
  });

  it("case 2: exact instance OUT + incomplete closure -> UNKNOWN", async () => {
    const f = await verdictFor({
      moduleLoadClosure: closure(["dynamic_require"]),
      graphTruncated: true,
    });
    expect(f?.verdict).toBe("UNKNOWN");
    expect(familyOf(f)).toBe("-");
  });
});

describe("VT-307e case 3-4: package IN (families B and C are the only options)", () => {
  it("case 3: package IN + unresolved target -> UNKNOWN, never any negative proof", async () => {
    const f = await verdictFor({
      graph: siteA(),
      moduleLoadClosure: closure([], [LIB]),
    });
    expect(f?.verdict).toBe("UNKNOWN");
    expect(familyOf(f)).toBe("-");
  });

  it("case 4: target resolved + attributed + unreachable -> NOT_AFFECTED via family C", async () => {
    // A real, attributable target node with no path to it.
    const graph: CallGraph = {
      nodes: [
        moduleNode("src#<module>", ENTRY),
        fnNode("lib#vulnerable", LIB_FILE, "vulnerable", 1),
      ],
      edges: [],
    };
    const f = await verdictFor({
      graph,
      moduleLoadClosure: closure([], [LIB]),
      allowSyntheticNameOnlyTargetBinding: true,
    });
    expect(f?.verdict).toBe("NOT_AFFECTED");
    expect(familyOf(f)).toBe("C");
    const proof = f?.evidence?.confirmedUnreachableTarget;
    expect(proof?.target).toEqual({
      module: "fixture-lib",
      export: "vulnerable",
    });
    expect(proof?.entrypointRoots).toEqual([ENTRY]);
    // VT-CONTRACT-02: the completeness fact names the reachable subgraph
    // the search exhausted, never the whole call graph.
    expect(proof?.reachableSubgraphComplete).toBe(true);
    expect(
      (proof as unknown as Record<string, unknown>)["callGraphComplete"],
    ).toBeUndefined();
  });
});

describe("VT-307e case 5-7: coverage and target-establishment guards", () => {
  it("case 5: graphTruncated blocks families B and C", async () => {
    const f = await verdictFor({
      graph: siteB(),
      moduleLoadClosure: undefined,
      graphTruncated: true,
    });
    expect(f?.verdict).toBe("UNKNOWN");
  });

  it("case 6: target module unresolved -> UNKNOWN", async () => {
    const f = await verdictFor({
      resolverMap: {},
      moduleLoadClosure: closure(),
    });
    expect(f?.verdict).toBe("UNKNOWN");
    expect(familyOf(f)).toBe("-");
  });

  it("case 7: target unattributed inside a discovered instance -> UNKNOWN (Site A)", async () => {
    const f = await verdictFor({
      graph: siteA(),
      moduleLoadClosure: closure([], [LIB]),
      graphTruncated: false,
    });
    expect(f?.verdict).toBe("UNKNOWN");
    expect(familyOf(f)).toBe("-");
  });
});

/**
 * Cases 8-10 + 16: the PRE-EXISTING legacy behavior the VT-307d audit
 * surfaced, now adjudicated per proof family. Each was reproduced against
 * the pre-VT-307d base (ec7e0c5) returning NOT_AFFECTED.
 */
describe("VT-307e case 8-10, 16: legacy call-graph proofs vs closure conditions", () => {
  it("case 8: parse_failure blocks the call-graph proofs (recovered AST is untrustworthy)", async () => {
    // The call graph does NOT check hasSyntaxErrors; it builds nodes and
    // edges from TypeScript's error-recovered AST. A require and the call
    // that follows it can both be swallowed by one syntax error.
    const f = await verdictFor({
      moduleLoadClosure: closure(["parse_failure"]),
    });
    expect(f?.verdict).toBe("UNKNOWN");
    expect(f?.evidence?.reasons?.[0]).toContain("parse_failure");
  });

  it("case 9: loader_hook_mutation blocks every family", async () => {
    // `Module._extensions['.js'] = ...` is an ASSIGNMENT: it produces no
    // call edge, so VT-300's edge-based guard cannot see it at all.
    for (const graphTruncated of [false, true]) {
      const f = await verdictFor({
        moduleLoadClosure: closure(["loader_hook_mutation"]),
        graphTruncated,
      });
      expect(f?.verdict).toBe("UNKNOWN");
      expect(familyOf(f)).toBe("-");
    }
  });

  it("case 10: traversal_truncated blocks family A", async () => {
    const f = await verdictFor({
      moduleLoadClosure: closure(["traversal_truncated"]),
      graphTruncated: true,
    });
    expect(f?.verdict).toBe("UNKNOWN");
    expect(familyOf(f)).toBe("-");
  });

  it("case 10b: traversal_truncated ALONE does NOT block families B/C -- the one deliberate exclusion", async () => {
    // The non-blanket half of the contract. traversal_truncated bounds the
    // CLOSURE's own walk; the call graph's coverage is governed by
    // graphTruncated, which is false here. In production both share
    // analysis.limits.maxFiles, so a truncated closure comes with a
    // truncated graph and the correct guard engages anyway.
    const f = await verdictFor({
      graph: siteB(),
      moduleLoadClosure: closure(["traversal_truncated"]),
      graphTruncated: false,
    });
    expect(f?.verdict).toBe("NOT_AFFECTED");
    // Family A is blocked (closure incomplete), so this is a call-graph proof.
    expect(["B", "C"]).toContain(familyOf(f));
  });

  it("case 16: every closure-widening reason blocks the call-graph proofs", async () => {
    const reasons: ClosureIncompletenessReason[] = [
      "dynamic_require",
      "dynamic_import",
      "eval",
      "aliased_eval",
      "function_constructor",
      "create_require",
      "aliased_require",
      "module_require",
      "module_internal_load",
      "loader_hook_mutation",
      "loader_capability_escape",
      "vm_execution",
      "worker_execution",
      "child_process_execution",
      "unresolved_module",
      "declaration_only_resolution",
      "parse_failure",
    ];
    for (const reason of reasons) {
      expect(
        invalidatesCallGraphNegativeProof(reason),
        `${reason} must invalidate a call-graph-derived negative proof`,
      ).toBe(true);
      const f = await verdictFor({
        graph: siteB(),
        moduleLoadClosure: closure([reason]),
        graphTruncated: false,
      });
      expect(f?.verdict, `${reason} must force UNKNOWN`).toBe("UNKNOWN");
    }
    expect(invalidatesCallGraphNegativeProof("traversal_truncated")).toBe(
      false,
    );
  });
});

describe("VT-307e case 11-12: proof-specific, not blanket", () => {
  it("case 11: unrelated NON-widening graph uncertainty + OUT + complete closure -> NOT_AFFECTED (family A)", async () => {
    const graph: CallGraph = {
      nodes: [moduleNode("src#<module>", ENTRY)],
      edges: [unknownEdge("unsupported_construct")],
    };
    const f = await verdictFor({ graph, moduleLoadClosure: closure() });
    expect(f?.verdict).toBe("NOT_AFFECTED");
    expect(familyOf(f)).toBe("A");
  });

  it("case 12: module-load uncertainty + package IN + otherwise-clean reachability -> UNKNOWN", async () => {
    // Per the matrix, not per blanket policy: a dynamic_require can load a
    // module that calls the target, so it invalidates family C even though
    // the package itself is present and the search found no path.
    const graph: CallGraph = {
      nodes: [
        moduleNode("src#<module>", ENTRY),
        fnNode("lib#vulnerable", LIB_FILE, "vulnerable", 1),
      ],
      edges: [],
    };
    const f = await verdictFor({
      graph,
      moduleLoadClosure: closure(["dynamic_require"], [LIB]),
      allowSyntheticNameOnlyTargetBinding: true,
    });
    expect(f?.verdict).toBe("UNKNOWN");
    expect(familyOf(f)).toBe("-");
  });

  it("documents the accepted precision cost: a widening construct in call-unreachable code still blocks", async () => {
    // The closure's whole-file scan cannot prove a function is dead, and
    // this guard deliberately does NOT re-scope itself by call-graph
    // reachability: the very conditions it exists to catch (a non-call
    // loader assignment, a recovered AST) are ones the call graph cannot
    // see, so trusting graph reachability to excuse them would be
    // circular. Pinned so the trade-off stays visible; measured cost on
    // the real-world benchmark is zero.
    const f = await verdictFor({
      graph: siteB(),
      moduleLoadClosure: closure(["dynamic_require"]),
      graphTruncated: false,
    });
    expect(f?.verdict).toBe("UNKNOWN");
  });
});

/**
 * PROOF FAMILY B in isolation. Reached when the call graph HAS discovered
 * some instance of the package name, but never this finding's own install
 * location -- so `resolveTargetNodes` takes the `confirmedAbsentInstance`
 * path and the Site-B module-load gate (family A) is never consulted.
 */
/**
 * VT-307e Family B -- hardened by VT-307e's own final audit.
 *
 * The audit reproduced a false NOT_AFFECTED: `graphTruncated === false`
 * proves only that the call graph's OWN traversal did not hit a resource
 * limit, never that every statically loaded module was represented in it.
 * The call graph's discovery never follows a re-export DECLARATION
 * (`export * from "pkg"`) as an edge at all, so a package instance reached
 * solely through a re-export chain can be genuinely loaded and called
 * while the call graph reports it "absent" from a "complete" (merely
 * non-truncated) graph.
 *
 * Family B is therefore no longer sufficient on the call graph alone: it
 * now ALSO requires a gate-eligible, COMPLETE `ModuleLoadClosure` that
 * independently corroborates the absence (does not contain this exact
 * instance either) -- see `matrix items 1-8` below, matching the fix's
 * own required regression matrix. Items 9-14 of that matrix (re-export-
 * only, TS `import=require`, workspace, pnpm, alias, multiple entrypoints)
 * are real-source loading shapes and live in
 * verdict.family-b-soundness.test.ts, which also pins the exact
 * end-to-end counterexample the audit reproduced.
 */
describe("VT-307e: proof family B requires ModuleLoadClosure corroboration", () => {
  const OTHER_FILE = "/other/node_modules/fixture-lib/index.js";
  const graphWithOtherInstance = (): CallGraph => ({
    nodes: [
      moduleNode("src#<module>", ENTRY),
      moduleNode("other#<module>", OTHER_FILE),
    ],
    edges: [],
  });

  it("matrix item 1: CallGraph OUT + closure complete + instance OUT -> NOT_AFFECTED via family B", async () => {
    const f = await verdictFor({
      graph: graphWithOtherInstance(),
      // closure() defaults loadedPackageInstances to [] -- LIB is absent
      // from the closure too, so the corroboration holds.
      moduleLoadClosure: closure(),
      graphTruncated: false,
    });
    expect(f?.verdict).toBe("NOT_AFFECTED");
    expect(familyOf(f)).toBe("B");
    expect(f?.evidence?.reasons).toEqual([
      "package_instance_absent_from_call_graph_and_module_load_closure",
    ]);
    const proof = f?.evidence?.confirmedAbsentInstance;
    // Names THIS finding's instance -- never the sibling the graph did find.
    expect(proof?.packageInstance).toBe(LIB);
    expect(proof?.entrypointRoots).toEqual([ENTRY]);
    expect(proof?.graphTruncated).toBe(false);
    expect(proof?.moduleLoadClosureComplete).toBe(true);
    // Never conflated with the module-load proof, and the retired field
    // must not silently reappear.
    expect(f?.evidence?.confirmedAbsentFromModuleLoadClosure).toBeUndefined();
    expect(
      (proof as unknown as Record<string, unknown>)["callGraphComplete"],
    ).toBeUndefined();
    // VT-CONTRACT-02: family C's own completeness field must not leak onto
    // family B either -- the two proofs establish different things.
    expect(
      (proof as unknown as Record<string, unknown>)[
        "reachableSubgraphComplete"
      ],
    ).toBeUndefined();
  });

  it("matrix item 2: CallGraph OUT + closure complete + instance IN -> family B blocked (THE audit's exact counterexample shape)", async () => {
    // This is the synthetic pin of the audit's blocker: the closure says
    // this exact instance IS loaded (complete=true, LIB present) while the
    // call graph never traversed it. Pre-fix, this produced a false
    // Family-B NOT_AFFECTED. Post-fix it must degrade to UNKNOWN --
    // NEVER fall through to a bare, uncorroborated NOT_AFFECTED via any
    // other branch either.
    const f = await verdictFor({
      graph: graphWithOtherInstance(),
      moduleLoadClosure: closure([], [LIB]),
      graphTruncated: false,
    });
    expect(
      f?.verdict,
      "a package instance the closure says IS loaded must never be declared call-graph-absent",
    ).toBe("UNKNOWN");
    expect(familyOf(f)).toBe("-");
    expect(f?.evidence?.confirmedAbsentInstance).toBeUndefined();
  });

  it("matrix item 3: CallGraph OUT + closure incomplete -> family B blocked", async () => {
    for (const reason of [
      "parse_failure",
      "loader_hook_mutation",
      "dynamic_require",
    ] as const) {
      const f = await verdictFor({
        graph: graphWithOtherInstance(),
        moduleLoadClosure: closure([reason]),
        graphTruncated: false,
      });
      expect(f?.verdict, `${reason} must block family B`).toBe("UNKNOWN");
      expect(familyOf(f)).toBe("-");
    }
  });

  it("matrix item 4: CallGraph OUT + closure unavailable -> family B blocked", async () => {
    // The audit upgraded this from an accepted compatibility risk to
    // UNSOUND for family B specifically: with no closure to corroborate
    // against, family B has no protection at all.
    const f = await verdictFor({
      graph: graphWithOtherInstance(),
      moduleLoadClosure: undefined,
      graphTruncated: false,
    });
    expect(
      f?.verdict,
      "an unavailable closure must disqualify family B, not preserve its old uncorroborated verdict",
    ).toBe("UNKNOWN");
    expect(familyOf(f)).toBe("-");
  });

  it("matrix item 5: CallGraph OUT + graphTruncated=true -> family B blocked (unchanged)", async () => {
    const f = await verdictFor({
      graph: graphWithOtherInstance(),
      moduleLoadClosure: closure(),
      graphTruncated: true,
    });
    expect(f?.verdict).toBe("UNKNOWN");
  });

  it("matrix item 7: every invalidatesCallGraphNegativeProof reason blocks family B", async () => {
    // Exhaustive per Section 8 of the audit -- every reason the partition
    // says blocks a call-graph-derived proof must also block family B's
    // NEW corroboration check, not just its old graph-only check.
    const reasons: ClosureIncompletenessReason[] = [
      "dynamic_require",
      "dynamic_import",
      "eval",
      "aliased_eval",
      "function_constructor",
      "create_require",
      "aliased_require",
      "module_require",
      "module_internal_load",
      "loader_hook_mutation",
      "loader_capability_escape",
      "vm_execution",
      "worker_execution",
      "child_process_execution",
      "unresolved_module",
      "declaration_only_resolution",
      "parse_failure",
    ];
    for (const reason of reasons) {
      const f = await verdictFor({
        graph: graphWithOtherInstance(),
        moduleLoadClosure: closure([reason]),
        graphTruncated: false,
      });
      expect(f?.verdict, `${reason} must block family B`).toBe("UNKNOWN");
      expect(familyOf(f)).toBe("-");
    }
  });

  it("never fires without an authoritative packageInstance", async () => {
    const f = await verdictFor({
      graph: graphWithOtherInstance(),
      packageInstance: undefined,
      moduleLoadClosure: closure(),
      graphTruncated: false,
    });
    expect(familyOf(f)).not.toBe("B");
  });

  it("matrix item 8: duplicate same-name/same-version instances -- corroboration applies per exact canonical PackageInstance", async () => {
    // X is genuinely absent from BOTH the call graph and a complete
    // closure -- family B may fire for X. Y is the sibling the graph
    // happened to discover; the closure says Y IS loaded. A finding about
    // Y must never borrow X's corroborated absence, and vice versa.
    // Both must resolve package name "fixture-lib" via identifyModule's
    // own "segment right after the LAST node_modules/" rule -- distinct
    // installs of the SAME package name, not two different package names.
    const X = canonicalizePackageInstancePath(
      "/dup-x-root/node_modules/fixture-lib",
    );
    const Y = canonicalizePackageInstancePath(
      "/dup-y-root/node_modules/fixture-lib",
    );
    const graph: CallGraph = {
      nodes: [
        moduleNode("src#<module>", ENTRY),
        moduleNode("y#<module>", `${Y}/index.js`),
      ],
      edges: [],
    };

    const findingForX = await verdictFor({
      graph,
      packageInstance: X,
      resolverMap: { "fixture-lib": `${X}/index.js` },
      // X absent from the closure too -- corroborated.
      moduleLoadClosure: closure([], [Y]),
      graphTruncated: false,
    });
    expect(findingForX?.verdict).toBe("NOT_AFFECTED");
    expect(familyOf(findingForX)).toBe("B");
    expect(
      findingForX?.evidence?.confirmedAbsentInstance?.packageInstance,
    ).toBe(X);

    const findingForY = await verdictFor({
      graph,
      packageInstance: Y,
      resolverMap: { "fixture-lib": `${Y}/index.js` },
      // Y IS in the closure -- corroboration fails for Y specifically.
      moduleLoadClosure: closure([], [Y]),
      graphTruncated: false,
    });
    expect(
      findingForY?.verdict,
      "Y's own presence in the closure must block family B for Y, independent of X's result",
    ).toBe("UNKNOWN");
    expect(familyOf(findingForY)).toBe("-");
  });
});

describe("VT-307e case 13: exact-instance semantics survive unification", () => {
  it("same name + same version at two locations stay independent", async () => {
    const loaded = canonicalizePackageInstancePath(
      "/node_modules/consumer/node_modules/fixture-lib",
    );
    const unused = LIB;
    expect(loaded).not.toBe(unused);

    const loadedFinding = await verdictFor({
      packageInstance: loaded,
      moduleLoadClosure: closure([], [loaded]),
      resolverMap: {
        "fixture-lib":
          "/node_modules/consumer/node_modules/fixture-lib/index.js",
      },
      graphTruncated: true,
    });
    expect(loadedFinding?.verdict).toBe("UNKNOWN");
    expect(familyOf(loadedFinding)).toBe("-");

    const unusedFinding = await verdictFor({
      packageInstance: unused,
      moduleLoadClosure: closure([], [loaded]),
      graphTruncated: true,
    });
    expect(unusedFinding?.verdict).toBe("NOT_AFFECTED");
    expect(familyOf(unusedFinding)).toBe("A");
    expect(
      unusedFinding?.evidence?.confirmedAbsentFromModuleLoadClosure
        ?.packageInstance,
    ).toBe(unused);
  });
});

describe("VT-307e case 14-15: Site A and VT-300 are unchanged", () => {
  it("case 14: Site A unresolved/unattributed target stays UNKNOWN under every closure state", async () => {
    for (const c of [
      closure([], [LIB]),
      closure(["dynamic_require"], [LIB]),
      undefined,
    ]) {
      const f = await verdictFor({ graph: siteA(), moduleLoadClosure: c });
      expect(f?.verdict).toBe("UNKNOWN");
      expect(familyOf(f)).toBe("-");
    }
  });

  it("case 15: VT-300's guard still blocks a reachable closure-widening call edge", async () => {
    // Site A shape so resolveTargetNodes takes the confirmedAbsentInstance
    // path for a DIFFERENT instance, with a reachable widening edge.
    const other = canonicalizePackageInstancePath("/node_modules/other-copy");
    const graph: CallGraph = {
      nodes: [
        moduleNode("src#<module>", ENTRY),
        moduleNode("other#<module>", `${other}/index.js`),
      ],
      edges: [unknownEdge("dynamic_require")],
    };
    const f = await verdictFor({
      graph,
      packageInstance: LIB,
      moduleLoadClosure: undefined,
      graphTruncated: false,
    });
    expect(f?.verdict).toBe("UNKNOWN");
    expect(familyOf(f)).toBe("-");
  });
});

describe("VT-307e: every NOT_AFFECTED carries exactly one proof evidence", () => {
  it("family A, B and C evidences are mutually exclusive and reason strings are 1:1", async () => {
    const seen = new Map<string, string>();

    const a = await verdictFor({ moduleLoadClosure: closure() });
    seen.set("A", a?.evidence?.reasons?.[0] ?? "");

    const cGraph: CallGraph = {
      nodes: [
        moduleNode("src#<module>", ENTRY),
        fnNode("lib#vulnerable", LIB_FILE, "vulnerable", 1),
      ],
      edges: [],
    };
    const c = await verdictFor({
      graph: cGraph,
      moduleLoadClosure: closure([], [LIB]),
      allowSyntheticNameOnlyTargetBinding: true,
    });
    seen.set("C", c?.evidence?.reasons?.[0] ?? "");

    for (const f of [a, c]) {
      const e = f?.evidence;
      const count = [
        e?.confirmedAbsentFromModuleLoadClosure,
        e?.confirmedAbsentInstance,
        e?.confirmedUnreachableTarget,
      ].filter((x) => x !== undefined).length;
      expect(count, "exactly one negative-proof evidence per finding").toBe(1);
    }

    // 1:1 reason-to-proof (Phase 8): no string serves two families.
    expect(new Set(seen.values()).size).toBe(seen.size);
    expect(seen.get("A")).toBe(
      "package_instance_not_in_complete_module_load_closure",
    );
  });
});
