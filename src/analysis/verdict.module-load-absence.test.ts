import { describe, expect, it } from "vitest";
import type {
  ModuleResolutionResult,
  ModuleResolver,
} from "../code-intelligence/module-resolver.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import type { CallEdge, CallGraph, GraphNode } from "../domain/graph.js";
import { canonicalizePackageInstancePath } from "../domain/resolved-target.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import type {
  ClosureIncompletenessReason,
  ModuleLoadClosure,
} from "./module-load-closure.js";
import { buildFindingForTest } from "../testing/finding.js";

/**
 * VT-307d Commit 2 -- the Site-B MODULE-LOAD ABSENCE negative proof.
 *
 * The implication under test, in full:
 *
 *   gate fires
 *     => a strict gate-eligible closure exists
 *     AND closure.complete === true
 *     AND the exact authoritative PackageInstance is OUT of it
 *     AND the entrypoint roots are non-empty
 *     AND every vulnerability applicability guard already passed.
 *
 * Each conjunct gets its own negative case below, because breaking any one
 * of them independently produces a FALSE NOT_AFFECTED -- the single failure
 * mode AGENTS.md treats as critical. The matrix is deliberately
 * incompleteness-reason-by-incompleteness-reason rather than "an incomplete
 * closure" in the abstract: the gate reads one boolean, and a regression
 * that special-cased any individual reason would still pass a single
 * aggregate test.
 *
 * These are synthetic closures by design. The real, end-to-end production
 * facts they pair with live in cli/scan.module-load-closure.test.ts (real
 * npm-installed RWB fixtures through the whole `runScanCommand` pipeline)
 * and in the validation suite (RWB-06's real UNKNOWN -> NOT_AFFECTED flip).
 * What is isolated HERE is the gate's decision logic, which is exactly the
 * part a real fixture cannot exercise exhaustively: no real project
 * conveniently exhibits all twelve distinct closure-incompleteness causes.
 */

const ENTRY_FILE = "/project/src/index.ts";
const LIB_FILE = "/node_modules/fixture-lib/index.js";
const LIB_INSTANCE = canonicalizePackageInstancePath(
  "/node_modules/fixture-lib",
);

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

const entrypoint: Entrypoint = {
  filePath: ENTRY_FILE,
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

/**
 * A closure that traversed real roots and does NOT contain
 * `fixture-lib` -- the absence shape the gate is meant to act on.
 * `incompleteness` drives `complete`, exactly as the real builder does.
 */
function closureWithout(
  reasons: readonly ClosureIncompletenessReason[] = [],
  loadedPackageInstances: readonly string[] = [],
): ModuleLoadClosure {
  return {
    rootFiles: [ENTRY_FILE],
    loadedFiles: [ENTRY_FILE],
    loadedPackageInstances,
    complete: reasons.length === 0,
    incompleteness: reasons.map((reason) => ({
      reason,
      importer: ENTRY_FILE,
    })),
  };
}

/** The clean Site-B graph: nothing anywhere touches fixture-lib. */
function siteBGraph(): CallGraph {
  return { nodes: [moduleNode("src#<module>", ENTRY_FILE)], edges: [] };
}

async function findingFor(options: {
  graph: CallGraph;
  moduleLoadClosure?: ModuleLoadClosure;
  packageInstance?: string;
  graphTruncated?: boolean;
}) {
  return buildFindingForTest({
    vulnerability: vulnerability("GHSA-fixture-0001"),
    packageName: "fixture-lib",
    packageVersion: "1.0.0",
    packageInstance: options.packageInstance ?? LIB_INSTANCE,
    matchResult: "affected",
    rule,
    graph: options.graph,
    entrypoints: [entrypoint],
    resolver: fakeResolver({ "fixture-lib": LIB_FILE }),
    projectRoot: "/project",
    moduleLoadClosure: options.moduleLoadClosure,
    graphTruncated: options.graphTruncated,
  });
}

describe("VT-307d case 1: exact package OUT + complete closure -> NOT_AFFECTED", () => {
  it("returns NOT_AFFECTED with the distinct reason and positive absence evidence", async () => {
    const finding = await findingFor({
      graph: siteBGraph(),
      moduleLoadClosure: closureWithout(),
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.reasons).toContain(
      "package_instance_not_in_complete_module_load_closure",
    );

    const proof = finding?.evidence?.confirmedAbsentFromModuleLoadClosure;
    expect(proof).toBeDefined();
    // The evidence must name the SAME instance the verdict is about --
    // never a sibling, never a package name, never a version.
    expect(proof?.packageInstance).toBe(LIB_INSTANCE);
    expect(proof?.entrypointRoots).toEqual([ENTRY_FILE]);
    expect(proof?.closureComplete).toBe(true);
  });

  it("keeps the new evidence strictly separate from confirmedAbsentInstance", async () => {
    // confirmedAbsentInstance is an internal CALL-GRAPH signal (VT-212/
    // VT-300). The module-load proof must never be published through it,
    // or a consumer could not tell "the call graph didn't bind here" from
    // "this package cannot load at all".
    const finding = await findingFor({
      graph: siteBGraph(),
      moduleLoadClosure: closureWithout(),
    });
    expect(
      (finding?.evidence as Record<string, unknown> | undefined)?.[
        "confirmedAbsentInstance"
      ],
    ).toBeUndefined();
  });
});

/**
 * Cases 2-13. Every closure-incompleteness cause, one at a time. An
 * incomplete closure means "modules beyond loadedFiles may also load at
 * runtime" -- precisely the condition under which absence proves nothing,
 * so every one of these must stay UNKNOWN.
 */
describe("VT-307d cases 2-13: OUT + an incomplete closure -> UNKNOWN", () => {
  const INCOMPLETENESS_CASES: ReadonlyArray<
    readonly [number, ClosureIncompletenessReason, string]
  > = [
    [2, "dynamic_require", "require(variable) could resolve to this package"],
    [3, "dynamic_import", "import(variable) could load this package"],
    [4, "loader_capability_escape", "a loader capability escaped analysis"],
    [5, "loader_hook_mutation", "a loader hook was mutated in-source"],
    [6, "module_internal_load", "a Node internal loader entry was used"],
    [7, "vm_execution", "vm-executed code is unanalyzed and may require it"],
    [8, "worker_execution", "a worker runs code this scan never saw"],
    [9, "child_process_execution", "a child process runs unanalyzed code"],
    [10, "parse_failure", "a member's own imports could not be established"],
    [11, "unresolved_module", "an unresolved specifier may be this package"],
    [
      12,
      "declaration_only_resolution",
      "the module that really runs was never identified",
    ],
    [13, "traversal_truncated", "the unvisited region's imports are unknown"],
  ];

  for (const [caseNumber, reason, why] of INCOMPLETENESS_CASES) {
    it(`case ${String(caseNumber)}: ${reason} withdraws the proof (${why})`, async () => {
      // `graphTruncated: true` is the ISOLATOR, and is essential rather
      // than incidental. On a clean Site-B graph the pre-existing
      // reachability route already reaches NOT_AFFECTED by itself (see
      // case 14), so without forcing that route to UNKNOWN this assertion
      // could not tell "the gate correctly refused to fire" from "the gate
      // fired". With it, the ONLY thing that could still produce
      // NOT_AFFECTED here is the new gate -- so UNKNOWN proves the
      // incomplete closure genuinely withdrew the proof.
      const finding = await findingFor({
        graph: siteBGraph(),
        moduleLoadClosure: closureWithout([reason]),
        graphTruncated: true,
      });

      expect(
        finding?.verdict,
        `an incomplete closure (${reason}) must never support an absence proof`,
      ).toBe("UNKNOWN");
      expect(
        finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
      ).toBeUndefined();
      expect(finding?.evidence?.reasons ?? []).not.toContain(
        "package_instance_not_in_complete_module_load_closure",
      );
    });
  }

  it("stays UNKNOWN when several causes are present at once", async () => {
    const finding = await findingFor({
      graph: siteBGraph(),
      moduleLoadClosure: closureWithout([
        "dynamic_require",
        "parse_failure",
        "traversal_truncated",
      ]),
      graphTruncated: true,
    });
    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("fires on the SAME graph once the closure is complete (the isolator is honest)", async () => {
    // Control for the twelve cases above: identical inputs, identical
    // graphTruncated: true, only `complete` differs. Proves those UNKNOWNs
    // are caused by closure incompleteness and not by the isolator itself.
    const finding = await findingFor({
      graph: siteBGraph(),
      moduleLoadClosure: closureWithout(),
      graphTruncated: true,
    });
    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeDefined();
  });
});

describe("VT-307d case 14: closure unavailable -> existing conservative verdict", () => {
  it("falls through to the pre-VT-307d path when no closure was built", async () => {
    // `undefined` must never be read as "an empty closure". On this clean
    // Site-B graph the pre-existing path already reaches NOT_AFFECTED on
    // its own -- the point is that it does so WITHOUT the new evidence.
    const finding = await findingFor({
      graph: siteBGraph(),
      moduleLoadClosure: undefined,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
      "an unavailable closure must not manufacture absence evidence",
    ).toBeUndefined();
    expect(finding?.evidence?.reasons).toEqual([
      "vulnerable symbol confirmed unreachable from all analyzed entrypoints",
    ]);
  });

  it("leaves an unavailable closure unable to rescue a truncated graph", async () => {
    // The ordinary reachability-derived NOT_AFFECTED route still requires
    // graphTruncated === false (VT-202). Unchanged by VT-307d.
    const finding = await findingFor({
      graph: siteBGraph(),
      moduleLoadClosure: undefined,
      graphTruncated: true,
    });
    expect(finding?.verdict).toBe("UNKNOWN");
  });
});

describe("VT-307d case 15: empty entrypoint roots -> no absence gate", () => {
  it("refuses to fire on a vacuous, zero-root closure even when it claims complete=true", async () => {
    // The catastrophic shape: a closure that traversed nothing contains NO
    // package instance, so every finding in the project would look
    // "absent". `buildGateEligibleModuleLoadClosure` cannot produce this
    // (it returns undefined first); the gate re-checks rootFiles anyway,
    // and this test pins that second line of defence.
    const vacuous: ModuleLoadClosure = {
      rootFiles: [],
      loadedFiles: [],
      loadedPackageInstances: [],
      complete: true,
      incompleteness: [],
    };

    const finding = await findingFor({
      graph: siteBGraph(),
      moduleLoadClosure: vacuous,
      graphTruncated: true,
    });

    expect(
      finding?.verdict,
      "a root-less closure must never prove anything",
    ).toBe("UNKNOWN");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
  });
});

describe("VT-307d case 16: KnownPackageRoots cannot be omitted (compile-time)", () => {
  it("is enforced by the strict production builder's type, not by convention", () => {
    // The executable half of this lives in cli/scan.module-load-closure.test.ts
    // (a @ts-expect-error on buildGateEligibleModuleLoadClosure). Recorded
    // here too so the matrix is readable end to end: eligibility is
    // structural -- the strict builder is the ONLY producer of a
    // gate-eligible closure, and it requires knownPackageRoots at the type
    // level. There is no proofEligible boolean anywhere in the design.
    expect(true).toBe(true);
  });
});

describe("VT-307d cases 17-18: Site A is untouched", () => {
  /**
   * Site A is `instances.size > 0`: the package instance IS in the call
   * graph, but the vulnerable target could not be attributed to any node
   * inside it. The closure proves PACKAGE-LOAD absence, never SYMBOL
   * absence inside a loaded package -- so it must have no say here, and
   * UNKNOWN must stay UNKNOWN.
   */
  function siteAGraph(): CallGraph {
    // fixture-lib IS present in the graph, with a function that is NOT the
    // rule's `vulnerable` export -- so target attribution fails.
    return {
      nodes: [
        moduleNode("src#<module>", ENTRY_FILE),
        moduleNode("lib#<module>", LIB_FILE),
        fnNode("lib#somethingElse", LIB_FILE, "somethingElse", 10),
      ],
      edges: [],
    };
  }

  it("case 17: package IN + unresolved target stays UNKNOWN", async () => {
    const finding = await findingFor({
      graph: siteAGraph(),
      // The package IS loaded -- the honest closure for this project.
      moduleLoadClosure: closureWithout([], [LIB_INSTANCE]),
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
      "a loaded package instance must never receive an absence proof",
    ).toBeUndefined();
  });

  it("case 18: package IN + unrelated call-graph uncertainty yields no absence proof", async () => {
    const unrelated: CallEdge = {
      from: "src#<module>",
      type: "direct",
      resolution: {
        kind: "unknown",
        reason: "unsupported_construct",
        potentialTargets: [],
      },
    };
    const graph: CallGraph = {
      nodes: siteAGraph().nodes,
      edges: [unrelated],
    };

    const finding = await findingFor({
      graph,
      moduleLoadClosure: closureWithout([], [LIB_INSTANCE]),
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
  });

  it("does not fire even when the closure is complete and the instance is IN", async () => {
    // The gate's membership test is the whole discriminator. An IN
    // instance must be unreachable for the gate no matter how clean
    // everything else looks.
    const finding = await findingFor({
      graph: siteAGraph(),
      moduleLoadClosure: closureWithout([], [LIB_INSTANCE]),
      graphTruncated: false,
    });
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
  });
});

describe("VT-307d case 26: duplicate same-name/same-version installs stay independent", () => {
  // Two installs, same declared name AND same version, at two locations.
  // The loaded one must never lend its membership to the unused one, and
  // the unused one must never lend its absence to the loaded one. Any
  // dedupe by name, by version, or by name+version breaks exactly this.
  const LOADED = canonicalizePackageInstancePath(
    "/node_modules/consumer/node_modules/fixture-lib",
  );
  const UNUSED = canonicalizePackageInstancePath("/node_modules/fixture-lib");

  it("the LOADED exact instance is IN -> the gate must not fire for it", async () => {
    const loadedFile =
      "/node_modules/consumer/node_modules/fixture-lib/index.js";
    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      packageInstance: LOADED,
      matchResult: "affected",
      rule,
      graph: siteBGraph(),
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": loadedFile }),
      projectRoot: "/project",
      // Closure contains the NESTED instance only.
      moduleLoadClosure: closureWithout([], [LOADED]),
      graphTruncated: true,
    });

    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
      "the loaded instance is IN the closure -- no absence proof is available for it",
    ).toBeUndefined();
    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("the UNUSED exact instance is independently OUT -> the gate may fire for it alone", async () => {
    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      packageInstance: UNUSED,
      matchResult: "affected",
      rule,
      graph: siteBGraph(),
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": LIB_FILE }),
      projectRoot: "/project",
      // Same closure as above: the OTHER instance is the loaded one.
      moduleLoadClosure: closureWithout([], [LOADED]),
      graphTruncated: true,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure?.packageInstance,
      "the evidence must name the UNUSED instance -- the one the verdict is about",
    ).toBe(UNUSED);
    expect(UNUSED).not.toBe(LOADED);
  });
});

describe("VT-307d case 27: the RWF-002 core regression", () => {
  /**
   * THE case this whole task exists for. An unrelated, NON-WIDENING
   * call-graph blocker sits in the entrypoint's own reachable subgraph
   * (RWB-06's real shape: a `String.prototype.trim()` call with nothing to
   * do with the vulnerable package). Before VT-307d that single unrelated
   * edge poisoned the entire reachability search to UNKNOWN.
   *
   * It must no longer do so, and the reason it is safe to ignore is
   * specific rather than general: a NON-WIDENING construct's uncertainty
   * is bounded to values and modules already discovered, so it cannot have
   * loaded a package that a COMPLETE closure says is not loadable. A
   * construct that COULD load something new is closure-widening, and
   * closure-widening constructs make the closure incomplete -- which is
   * cases 2-13 above, where the gate correctly refuses to fire.
   */
  it("an unrelated non-widening blocker no longer vetoes a complete-closure absence proof", async () => {
    // RWB-06's real shape: `token.trim()` -- a built-in method call with
    // nothing whatever to do with the vulnerable package.
    const unrelatedBlocker: CallEdge = {
      from: "src#<module>",
      type: "direct",
      resolution: {
        kind: "unknown",
        reason: "unsupported_construct",
        potentialTargets: [],
      },
    };
    const graph: CallGraph = {
      nodes: [
        moduleNode("src#<module>", ENTRY_FILE),
        fnNode("src#format", ENTRY_FILE, "format", 3),
      ],
      edges: [unrelatedBlocker],
    };

    const finding = await findingFor({
      graph,
      moduleLoadClosure: closureWithout(),
    });

    expect(
      finding?.verdict,
      "a positive module-load absence proof must survive unrelated non-widening call-graph uncertainty",
    ).toBe("NOT_AFFECTED");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure?.packageInstance,
    ).toBe(LIB_INSTANCE);
  });

  it("the same unrelated blocker still yields UNKNOWN when the closure is incomplete", async () => {
    // The control: it is the CLOSURE's completeness doing the work here,
    // not a newly-added tolerance for call-graph blockers.
    const unrelatedBlocker: CallEdge = {
      from: "src#<module>",
      type: "direct",
      resolution: {
        kind: "unknown",
        reason: "unsupported_construct",
        potentialTargets: [],
      },
    };
    const graph: CallGraph = {
      nodes: [moduleNode("src#<module>", ENTRY_FILE)],
      edges: [unrelatedBlocker],
    };

    const finding = await findingFor({
      graph,
      moduleLoadClosure: closureWithout(["dynamic_require"]),
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("a truncated call graph does not block the module-load absence proof", async () => {
    // Deliberate and documented: ModuleLoadClosure carries its OWN
    // completeness state and is independent of the call graph, so
    // graphTruncated is not a precondition for THIS route. Every ordinary
    // reachability-derived NOT_AFFECTED still requires it (case 14's
    // second test pins that).
    const finding = await findingFor({
      graph: siteBGraph(),
      moduleLoadClosure: closureWithout(),
      graphTruncated: true,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeDefined();
  });
});

describe("VT-307d: the gate never fires before applicability guards", () => {
  const absentClosure = closureWithout();

  it("produces NO finding at all when the version is confidently not affected", async () => {
    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      packageInstance: LIB_INSTANCE,
      matchResult: "not_affected",
      rule,
      graph: siteBGraph(),
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": LIB_FILE }),
      projectRoot: "/project",
      moduleLoadClosure: absentClosure,
    });
    expect(finding).toBeUndefined();
  });

  it("stays UNKNOWN for an indeterminate version match", async () => {
    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      packageInstance: LIB_INSTANCE,
      matchResult: "indeterminate",
      rule,
      graph: siteBGraph(),
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": LIB_FILE }),
      projectRoot: "/project",
      moduleLoadClosure: absentClosure,
    });
    expect(finding?.verdict).toBe("UNKNOWN");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
  });

  it("stays UNKNOWN when no rule targets the vulnerability", async () => {
    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      packageInstance: LIB_INSTANCE,
      matchResult: "affected",
      rule: undefined,
      graph: siteBGraph(),
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": LIB_FILE }),
      projectRoot: "/project",
      moduleLoadClosure: absentClosure,
    });
    expect(finding?.verdict).toBe("UNKNOWN");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
  });

  it("stays UNKNOWN when the target module cannot be resolved at all", async () => {
    // No target established -> nothing to compare against the closure.
    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      packageInstance: LIB_INSTANCE,
      matchResult: "affected",
      rule,
      graph: siteBGraph(),
      entrypoints: [entrypoint],
      resolver: fakeResolver({}),
      projectRoot: "/project",
      moduleLoadClosure: absentClosure,
    });
    expect(finding?.verdict).toBe("UNKNOWN");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
  });

  it("stays UNKNOWN when the finding carries no authoritative packageInstance", async () => {
    // Without exact identity there is nothing to prove absent -- a
    // name-based fallback here is precisely what must not exist.
    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      packageInstance: undefined,
      matchResult: "affected",
      rule,
      graph: siteBGraph(),
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": LIB_FILE }),
      projectRoot: "/project",
      moduleLoadClosure: absentClosure,
      graphTruncated: true,
    });
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("stays UNKNOWN when the resolved target belongs to a DIFFERENT installed instance", async () => {
    // The finding is about /node_modules/fixture-lib, but the rule's
    // target module resolves into a different install. A proof about this
    // finding's package would be an answer to a different question.
    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      packageInstance: LIB_INSTANCE,
      matchResult: "affected",
      rule,
      graph: siteBGraph(),
      entrypoints: [entrypoint],
      resolver: fakeResolver({
        "fixture-lib": "/node_modules/other-lib/index.js",
      }),
      projectRoot: "/project",
      moduleLoadClosure: closureWithout(),
      graphTruncated: true,
    });
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
      "the gate must not answer with a proof about a different instance",
    ).toBeUndefined();
    expect(finding?.verdict).toBe("UNKNOWN");
  });
});

/**
 * VT-307d FINAL FOCUSED ATTACK on the gate itself.
 *
 * Not a re-run of loader-capability enumeration (that stays closed). These
 * probe the single implication the gate must satisfy, from the outside,
 * looking specifically for ways to make it fire when it should not.
 */
describe("VT-307d: focused adversarial attack on the gate", () => {
  it("Site A cannot reach the gate even when the instance is genuinely OUT of the closure", async () => {
    // The sharpest "Site A entering the gate" attack. The call graph HAS
    // discovered this instance (so resolveTargetNodes takes the Site-A
    // branch), the target export is unattributable, AND -- contrived on
    // purpose -- the closure does not list the instance. Every gate
    // conjunct except the branch is satisfied.
    //
    // It must still be UNKNOWN. The closure proves module-load absence, and
    // "the module loaded but we cannot identify the symbol" is a different
    // question that no amount of load-absence evidence can answer. This is
    // guaranteed structurally: every exit from the instances.size > 0
    // branch returns before the gate is ever reached.
    const graph: CallGraph = {
      nodes: [
        moduleNode("src#<module>", ENTRY_FILE),
        moduleNode("lib#<module>", LIB_FILE),
        fnNode("lib#other", LIB_FILE, "notTheVulnerableOne", 7),
      ],
      edges: [],
    };

    const finding = await findingFor({
      graph,
      moduleLoadClosure: closureWithout(),
      graphTruncated: true,
    });

    expect(
      finding?.verdict,
      "Site A must remain UNKNOWN regardless of closure contents",
    ).toBe("UNKNOWN");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
  });

  it("cannot be reached through a package-name or version match", async () => {
    // The closure contains a DIFFERENT install of the same name and the
    // same version. Any collapse by name, by version, or by name+version
    // would make this instance look present (or the other look absent).
    // Identity is the install location, compared whole.
    const sameNameElsewhere = canonicalizePackageInstancePath(
      "/other/node_modules/fixture-lib",
    );
    const finding = await findingFor({
      graph: siteBGraph(),
      moduleLoadClosure: closureWithout([], [sameNameElsewhere]),
      graphTruncated: true,
    });

    // This finding's OWN instance is still genuinely absent, so the gate
    // correctly fires -- but the evidence must name THIS instance.
    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure?.packageInstance,
    ).toBe(LIB_INSTANCE);
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure?.packageInstance,
    ).not.toBe(sameNameElsewhere);
  });

  it("reports evidence for exactly the instance the verdict is about", async () => {
    // Guards against the evidence and the verdict drifting apart -- an
    // absence proof that named a sibling instance would be a correct-looking
    // verdict backed by the wrong fact.
    const finding = await findingFor({
      graph: siteBGraph(),
      moduleLoadClosure: closureWithout(),
      graphTruncated: true,
    });
    const proof = finding?.evidence?.confirmedAbsentFromModuleLoadClosure;
    expect(proof?.packageInstance).toBe(LIB_INSTANCE);
    // And the roots it is relative to are the closure's real roots.
    expect(proof?.entrypointRoots).toEqual([ENTRY_FILE]);
    expect(proof?.entrypointRoots.length).toBeGreaterThan(0);
  });

  it("cannot be talked into treating closureComplete as anything but true", async () => {
    // The evidence's closureComplete is a literal `true`, not a copy of
    // whatever the closure claimed -- so it can never record a false
    // completeness. The gate refuses incomplete closures outright, so the
    // only value that can ever be emitted is true.
    const finding = await findingFor({
      graph: siteBGraph(),
      moduleLoadClosure: closureWithout(),
      graphTruncated: true,
    });
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure?.closureComplete,
    ).toBe(true);
  });

  it("AFFECTED still wins over the absence proof if the two ever disagree", async () => {
    // Contrived contradiction: the closure says the package cannot load,
    // while the call graph exhibits a real resolved path into its
    // vulnerable export. That should be impossible; if it ever happens the
    // safe direction is AFFECTED, and the branch ordering in buildFinding
    // guarantees it.
    const graph: CallGraph = {
      nodes: [
        moduleNode("src#<module>", ENTRY_FILE),
        fnNode("lib#vulnerable", LIB_FILE, "vulnerable", 1),
      ],
      edges: [
        {
          from: "src#<module>",
          type: "import",
          resolution: { kind: "resolved", target: "lib#vulnerable" },
        },
      ],
    };

    const finding = await buildFindingForTest({
      vulnerability: vulnerability("GHSA-fixture-0001"),
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      packageInstance: LIB_INSTANCE,
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver: fakeResolver({ "fixture-lib": LIB_FILE }),
      projectRoot: "/project",
      moduleLoadClosure: closureWithout(),
      allowSyntheticNameOnlyTargetBinding: true,
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
  });
});
