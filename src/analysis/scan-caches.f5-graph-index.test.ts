import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CallGraph, GraphNode } from "../domain/graph.js";
import {
  canonicalizePackageInstancePath,
  createScanModuleIdentityCache,
  identifyModule,
  type KnownPackageRoots,
} from "../domain/resolved-target.js";
import {
  buildGraphPackageInstanceIndex,
  createScanAnalysisCaches,
  graphPackageInstancesByName,
} from "./scan-caches.js";

/**
 * FOUNDATION F5 — the per-scan graph package-instance index.
 *
 * `verdict.ts`'s `graphPackageInstances` answers "which installed instances
 * of this package name does the call graph contain, and through which
 * files" by walking EVERY node and identifying each one. It runs once per
 * resolved advisory target, so its cost is `findings × targets × nodes`.
 * The index answers the same question from one pass.
 *
 * This suite asserts the index against the walk it replaces, rather than
 * against expected values — including ORDER, which is load-bearing:
 * `resolveTargetNodes` materializes the result as
 * `[...instances.entries()]` and selects from that sequence, so an index
 * that grouped correctly but ordered differently would be a silent
 * behavior change in instance selection.
 */

/** What one `buildFinding` run produced, reduced to the proof facts. */
interface TwinOutcome {
  readonly verdict: string | undefined;
  readonly family: "A" | "B" | "C" | "NONE";
  readonly proofInstance: string | undefined;
}

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-f5-index-"));
  dirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return canonicalizePackageInstancePath(root);
}

function manifest(name: string, version?: string): string {
  return JSON.stringify(version === undefined ? { name } : { name, version });
}

function graphOf(modules: readonly string[]): CallGraph {
  const nodes: GraphNode[] = modules.map((module, i) => ({
    id: `n${i}`,
    kind: "function",
    module,
    name: `f${i}`,
  }));
  return { nodes, edges: [] };
}

/**
 * The exact walk `graphPackageInstances` performs when no index is
 * available — reproduced here as the ORACLE the index is compared against,
 * so the two can never drift apart silently.
 */
function walkGraphPackageInstances(
  graph: CallGraph,
  packageName: string,
  knownPackageRoots: KnownPackageRoots | undefined,
): Map<string, Set<string>> {
  const byInstance = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    const identity = identifyModule(node.module, knownPackageRoots);
    if (identity.packageName !== packageName || !identity.packageInstance) {
      continue;
    }
    const files = byInstance.get(identity.packageInstance) ?? new Set<string>();
    files.add(node.module);
    byInstance.set(identity.packageInstance, files);
  }
  return byInstance;
}

/** Order-sensitive comparison: entry sequence AND each file set's sequence. */
function shapeOf(
  instances: ReadonlyMap<string, Set<string>> | undefined,
): Array<[string, string[]]> {
  return [...(instances ?? new Map()).entries()].map(([instance, files]) => [
    instance,
    [...files],
  ]);
}

function cachesFor(graph: CallGraph, roots: KnownPackageRoots | undefined) {
  return createScanAnalysisCaches({
    graph,
    knownPackageRoots: roots,
    identity: createScanModuleIdentityCache(roots),
  });
}

describe("F5 graph package-instance index: equivalence with the walk", () => {
  it("matches the walk exactly, entry order and file order included", () => {
    const root = project({
      "node_modules/foo/package.json": manifest("foo", "1.0.0"),
      "node_modules/foo/a.js": "module.exports = {};\n",
      "node_modules/foo/b.js": "module.exports = {};\n",
      "node_modules/bar/node_modules/foo/package.json": manifest(
        "foo",
        "1.0.0",
      ),
      "node_modules/bar/node_modules/foo/a.js": "module.exports = {};\n",
      "node_modules/other/package.json": manifest("other", "1.0.0"),
      "node_modules/other/index.js": "module.exports = {};\n",
      "src/app.js": "module.exports = {};\n",
    });
    // Deliberately interleaved, so first-seen order is not the same as
    // sorted order for either instance.
    const graph = graphOf([
      path.join(root, "src/app.js"),
      path.join(root, "node_modules/bar/node_modules/foo/a.js"),
      path.join(root, "node_modules/other/index.js"),
      path.join(root, "node_modules/foo/b.js"),
      path.join(root, "node_modules/foo/a.js"),
      path.join(root, "node_modules/foo/b.js"),
    ]);

    const caches = cachesFor(graph, undefined);
    for (const name of ["foo", "other", "absent"]) {
      expect(
        shapeOf(graphPackageInstancesByName(caches, graph, undefined, name)),
        `package "${name}"`,
      ).toEqual(shapeOf(walkGraphPackageInstances(graph, name, undefined)));
    }
  });

  it("produces the same grouping under reversed node order as the walk does", () => {
    // Reversing the input must change the index and the walk IDENTICALLY.
    // Asserting they agree under both orderings is what proves the index
    // carries the graph's order rather than one of its own.
    const root = project({
      "node_modules/dup/package.json": manifest("dup", "1.0.0"),
      "node_modules/dup/a.js": "module.exports = {};\n",
      "node_modules/nest/node_modules/dup/package.json": manifest(
        "dup",
        "1.0.0",
      ),
      "node_modules/nest/node_modules/dup/a.js": "module.exports = {};\n",
    });
    const modules = [
      path.join(root, "node_modules/dup/a.js"),
      path.join(root, "node_modules/nest/node_modules/dup/a.js"),
    ];

    const forward = graphOf(modules);
    const reverse = graphOf([...modules].reverse());

    expect(
      shapeOf(
        graphPackageInstancesByName(
          cachesFor(forward, undefined),
          forward,
          undefined,
          "dup",
        ),
      ),
    ).toEqual(shapeOf(walkGraphPackageInstances(forward, "dup", undefined)));
    expect(
      shapeOf(
        graphPackageInstancesByName(
          cachesFor(reverse, undefined),
          reverse,
          undefined,
          "dup",
        ),
      ),
    ).toEqual(shapeOf(walkGraphPackageInstances(reverse, "dup", undefined)));

    // ...and the two orderings really do differ, so the assertion above is
    // not vacuous.
    const forwardShape = shapeOf(
      walkGraphPackageInstances(forward, "dup", undefined),
    );
    const reverseShape = shapeOf(
      walkGraphPackageInstances(reverse, "dup", undefined),
    );
    expect(forwardShape.map(([i]) => i)).toEqual(
      reverseShape.map(([i]) => i).reverse(),
    );
  });
});

describe("F5 graph package-instance index: twins never collide", () => {
  it("keeps same-name same-version twins as two separate entries", () => {
    const root = project({
      "node_modules/twin/package.json": manifest("twin", "1.0.0"),
      "node_modules/twin/index.js": "module.exports = {};\n",
      "node_modules/host/node_modules/twin/package.json": manifest(
        "twin",
        "1.0.0",
      ),
      "node_modules/host/node_modules/twin/index.js": "module.exports = {};\n",
    });
    const graph = graphOf([
      path.join(root, "node_modules/twin/index.js"),
      path.join(root, "node_modules/host/node_modules/twin/index.js"),
    ]);
    const instances = graphPackageInstancesByName(
      cachesFor(graph, undefined),
      graph,
      undefined,
      "twin",
    );
    expect(instances?.size).toBe(2);
    expect([...(instances ?? new Map()).keys()].sort()).toEqual(
      [
        path.join(root, "node_modules/twin"),
        path.join(root, "node_modules/host/node_modules/twin"),
      ].sort(),
    );
  });

  it("does not let a scoped package answer for its unscoped namesake", () => {
    const root = project({
      "node_modules/@scope/pkg/package.json": manifest("@scope/pkg", "1.0.0"),
      "node_modules/@scope/pkg/index.js": "module.exports = {};\n",
      "node_modules/pkg/package.json": manifest("pkg", "1.0.0"),
      "node_modules/pkg/index.js": "module.exports = {};\n",
    });
    const graph = graphOf([
      path.join(root, "node_modules/@scope/pkg/index.js"),
      path.join(root, "node_modules/pkg/index.js"),
    ]);
    const caches = cachesFor(graph, undefined);
    expect([
      ...(
        graphPackageInstancesByName(caches, graph, undefined, "pkg") ??
        new Map()
      ).keys(),
    ]).toEqual([path.join(root, "node_modules/pkg")]);
    expect([
      ...(
        graphPackageInstancesByName(caches, graph, undefined, "@scope/pkg") ??
        new Map()
      ).keys(),
    ]).toEqual([path.join(root, "node_modules/@scope/pkg")]);
  });
});

describe("F5 graph package-instance index: refuses to answer for the wrong analysis", () => {
  const root = project({
    "node_modules/x/package.json": manifest("x", "1.0.0"),
    "node_modules/x/index.js": "module.exports = {};\n",
  });
  const graph = graphOf([path.join(root, "node_modules/x/index.js")]);

  it("returns undefined when no caches were supplied", () => {
    expect(
      graphPackageInstancesByName(undefined, graph, undefined, "x"),
    ).toBeUndefined();
  });

  it("returns undefined for a graph the caches were not built from", () => {
    const caches = cachesFor(graph, undefined);
    const otherGraph = graphOf([path.join(root, "node_modules/x/index.js")]);
    expect(
      graphPackageInstancesByName(caches, otherGraph, undefined, "x"),
    ).toBeUndefined();
  });

  it("returns undefined for a registry the caches were not built from", () => {
    const caches = cachesFor(graph, undefined);
    const otherRoots: KnownPackageRoots = new Map();
    expect(
      graphPackageInstancesByName(caches, graph, otherRoots, "x"),
    ).toBeUndefined();
  });

  it("returns undefined, never an empty answer, once the node list changes", () => {
    // The staleness guard. `undefined` means "scan the graph yourself";
    // an empty map would read as "this package instance was never
    // traversed", which is positive evidence in `resolveTargetNodes`.
    const mutable: { nodes: GraphNode[]; edges: [] } = {
      nodes: [...graph.nodes],
      edges: [],
    };
    const caches = cachesFor(mutable as unknown as CallGraph, undefined);
    expect(
      graphPackageInstancesByName(
        caches,
        mutable as unknown as CallGraph,
        undefined,
        "x",
      )?.size,
    ).toBe(1);

    mutable.nodes.push({
      id: "extra",
      kind: "function",
      module: "/elsewhere/z.js",
    });
    expect(
      graphPackageInstancesByName(
        caches,
        mutable as unknown as CallGraph,
        undefined,
        "x",
      ),
    ).toBeUndefined();
  });

  it("distinguishes an absent package name from a refusal", () => {
    const caches = cachesFor(graph, undefined);
    const absent = graphPackageInstancesByName(
      caches,
      graph,
      undefined,
      "never-installed",
    );
    // A real, empty answer — the graph genuinely contains no such package.
    expect(absent).toBeDefined();
    expect(absent?.size).toBe(0);
  });
});

describe("F5 graph package-instance index: operation counts", () => {
  it("identifies each distinct module once, however many names are queried", () => {
    const files: Record<string, string> = {
      "node_modules/big/package.json": manifest("big", "1.0.0"),
    };
    const modules: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      files[`node_modules/big/m${i}.js`] = "module.exports = {};\n";
    }
    const root = project(files);
    // 400 nodes over 40 files — the fan-out shape the baseline measured
    // (one 690-node graph built from two files).
    for (let n = 0; n < 400; n += 1) {
      modules.push(path.join(root, `node_modules/big/m${n % 40}.js`));
    }
    const graph = graphOf(modules);
    const caches = cachesFor(graph, undefined);

    for (let query = 0; query < 25; query += 1) {
      graphPackageInstancesByName(caches, graph, undefined, "big");
    }

    // One pass, 400 identity requests, 40 distinct files, 1 package root.
    expect(caches.identity.operations.identityMisses).toBe(40);
    expect(caches.identity.operations.identityHits).toBe(360);
    expect(caches.identity.operations.realpathCalls).toBe(1);
    expect(caches.identity.operations.manifestReads).toBe(1);

    // The walk it replaces would have identified 400 nodes per query.
    // 25 queries × 400 = 10,000 identifications; the index cost 400.
    expect(
      caches.identity.operations.identityMisses +
        caches.identity.operations.identityHits,
    ).toBe(400);
  });

  it("builds nothing until a query actually arrives", () => {
    const root = project({
      "node_modules/lazy/package.json": manifest("lazy", "1.0.0"),
      "node_modules/lazy/index.js": "module.exports = {};\n",
    });
    const graph = graphOf([path.join(root, "node_modules/lazy/index.js")]);
    const caches = cachesFor(graph, undefined);
    expect(caches.graphPackageIndex).toBeUndefined();
    expect(caches.identity.operations.identityMisses).toBe(0);

    graphPackageInstancesByName(caches, graph, undefined, "lazy");
    expect(caches.graphPackageIndex).toBeDefined();
  });

  it("records the node count it was built at", () => {
    const root = project({
      "node_modules/c/package.json": manifest("c", "1.0.0"),
      "node_modules/c/index.js": "module.exports = {};\n",
    });
    const graph = graphOf([
      path.join(root, "node_modules/c/index.js"),
      path.join(root, "node_modules/c/index.js"),
    ]);
    const index = buildGraphPackageInstanceIndex(
      graph,
      undefined,
      createScanModuleIdentityCache(undefined),
    );
    expect(index.nodeCount).toBe(2);
    expect(index.graph).toBe(graph);
  });
});

/**
 * FOUNDATION F6 — the CONSUMER's half of "refusal is not absence".
 *
 * Every case above asserts that `graphPackageInstancesByName` RETURNS
 * `undefined` when it cannot answer for an analysis. None of them asserts
 * what `verdict.ts` then DOES with that answer, and those are different
 * properties: the signal can be perfectly correct while the code reading it
 * treats `undefined` as "this package has no instances in the graph".
 *
 * The gap was found by mutation-checking F6's own gates, and what it
 * turned up is worth recording precisely, because it is NOT a latent
 * soundness bug. Replacing `graphPackageInstances`'s fallback with
 *
 *     return indexed ?? new Map();
 *
 * -- reading a refusal as "this package has no instances" -- passes the
 * entire Foundation gate AND the full `npm test` run. It is an EQUIVALENT
 * mutant, and the reason is structural: `resolveTargetNodes` concludes a
 * family-B absence only inside `if (instances.size > 0)`, from "the graph
 * holds other instances of this name but not this one". An EMPTY answer
 * never reaches that conclusion; it falls through to the more conservative
 * instance-anchored resolution. So the defence against a refusal becoming
 * a fabricated `confirmedAbsentInstance` is doubled: the index refuses,
 * and the consumer could not manufacture the proof from an empty answer
 * even if it did not.
 *
 * What was genuinely missing is coverage, not safety. Every case above
 * stops at the index's return value, so nothing exercised the fallback
 * end to end, and an unreachable branch is one the next refactor is free
 * to break silently. This drives a real refusal through the REAL
 * production composition and pins the contract that matters: a stale
 * index costs time and changes no answer. It is a REGRESSION guard for a
 * property that currently holds, which is what a gate is for.
 */
describe("F5 graph package-instance index: a refusal falls back to the walk", () => {
  /** The real pipeline, run against one project before and after a refusal. */
  async function verdictsAcrossIndexRefusal(): Promise<{
    readonly before: string | undefined;
    readonly after: string | undefined;
    readonly proofAfter: unknown;
    readonly refused: boolean;
  }> {
    const { buildDependencyGraph } =
      await import("../dependencies/dependency-graph.js");
    const { loadPackageJsonFile } =
      await import("../dependencies/package-json.js");
    const { loadPackageLockFile } =
      await import("../dependencies/package-lock.js");
    const { buildCallGraph } =
      await import("../code-intelligence/call-graph.js");
    const { createModuleResolver } =
      await import("../code-intelligence/module-resolver.js");
    const { loadTsProject } =
      await import("../code-intelligence/ts-project.js");
    const { buildKnownPackageRoots } =
      await import("../domain/resolved-target.js");
    const { discoverEntrypoints } = await import("./entrypoints.js");
    const { buildGateEligibleModuleLoadClosure } =
      await import("./module-load-closure.js");
    const { createAnalysisProofContext } =
      await import("./analysis-context.js");
    const { buildFinding } = await import("./verdict.js");

    const root = project({
      "package.json": JSON.stringify({
        name: "refusal-fixture",
        version: "1.0.0",
        dependencies: { "vuln-lib": "1.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        name: "refusal-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": { name: "refusal-fixture", version: "1.0.0" },
          "node_modules/vuln-lib": { version: "1.0.0" },
        },
      }),
      "node_modules/vuln-lib/package.json": JSON.stringify({
        name: "vuln-lib",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/vuln-lib/index.js":
        "function danger(x) { return x; }\nmodule.exports = { danger };\n",
      // The instance IS loaded and the vulnerable export IS called, so the
      // sound answer is AFFECTED under every configuration below.
      "src/index.js":
        'const { danger } = require("vuln-lib");\n' +
        "function main(x) { return danger(x); }\n" +
        "module.exports = { main };\n",
    });

    const dependencyNodes = buildDependencyGraph(
      loadPackageJsonFile(path.join(root, "package.json")),
      loadPackageLockFile(path.join(root, "package-lock.json")),
    );
    const knownPackageRoots = buildKnownPackageRoots(dependencyNodes, root, []);
    const identity = createScanModuleIdentityCache(knownPackageRoots);
    const tsProject = loadTsProject(root);
    const resolver = createModuleResolver(tsProject);
    const entrypointsResult = await discoverEntrypoints({
      projectRoot: root,
      resolver,
      configuredEntrypoints: ["src/index.js"],
    });
    const graph = await buildCallGraph({
      entryFiles: entrypointsResult.entrypoints.map((entry) => entry.filePath),
      resolver,
      maxFiles: 2_000,
      maxGraphNodes: 50_000,
      maxAnalysisSeconds: 120,
      project: tsProject,
      knownPackageRoots,
    });
    const moduleLoadClosure = await buildGateEligibleModuleLoadClosure({
      entrypoints: entrypointsResult.entrypoints,
      resolver,
      maxFiles: 2_000,
      knownPackageRoots,
      moduleIdentityCache: identity,
    });
    const context = createAnalysisProofContext({
      projectRoot: root,
      resolver,
      entrypoints: entrypointsResult.entrypoints,
      knownPackageRoots,
      graph,
      graphTruncated: false,
      moduleLoadClosure,
      moduleIdentityCache: identity,
    });

    const input = {
      vulnerability: {
        id: "GHSA-f6-refusal",
        aliases: [],
        package: "vuln-lib",
        ecosystem: "npm",
        affectedVersions: [{ introduced: "0" }],
        fixedVersions: [],
        references: [],
      },
      packageName: "vuln-lib",
      packageVersion: "1.0.0",
      packageInstance: path.join(root, "node_modules", "vuln-lib"),
      matchResult: "affected",
      rule: {
        id: "GHSA-f6-refusal",
        package: { name: "vuln-lib" },
        targets: [
          {
            module: "vuln-lib",
            export: "danger",
            kind: "function",
            confidence: 1,
          },
        ],
      },
      context,
    } as unknown as Parameters<typeof buildFinding>[0];

    // FIRST run: the index answers, and also gets BUILT -- which is what
    // records the node count the refusal below depends on.
    const before = await buildFinding(input);

    // Now make the index unable to answer for this analysis, using the
    // same condition the unit cases above cover: the graph's node list is
    // no longer the one the index was built at. This changes the ANALYSIS
    // rather than the production code, and it is the state a stale index
    // really would be in.
    (graph.nodes as GraphNode[]).push({
      id: "n-appended",
      kind: "function",
      module: path.join(root, "src", "index.js"),
      name: "appended",
    });
    const refused =
      graphPackageInstancesByName(
        context.caches,
        graph,
        knownPackageRoots,
        "vuln-lib",
      ) === undefined;

    const after = await buildFinding(input);

    return {
      before: before?.verdict,
      after: after?.verdict,
      proofAfter: after?.evidence?.confirmedAbsentInstance,
      refused,
    };
  }

  it("still finds the instance the graph contains, and forges no absence proof", async () => {
    const result = await verdictsAcrossIndexRefusal();

    // The setup has to have actually produced a refusal, or the assertion
    // below is vacuous -- it would pass against the very defect it exists
    // to catch.
    expect(
      result.refused,
      "the index did not refuse, so this case never reached the fallback and " +
        "asserts nothing",
    ).toBe(true);

    expect(
      result.before,
      "baseline: the vulnerable export is called, so this is AFFECTED",
    ).toBe("AFFECTED");

    expect(
      result.after,
      `INDEX REFUSAL CHANGED THE ANSWER\n` +
        `  invariant: an index that cannot answer means "ask the walk", so a\n` +
        `             refusal costs time and changes no verdict\n` +
        `  case:      the index is stale; the instance IS in the call graph\n` +
        `  expected:  AFFECTED (unchanged -- the index is an accelerator,\n` +
        `             never an authority)\n` +
        `  actual:    ${result.after}`,
    ).toBe("AFFECTED");

    expect(
      result.proofAfter,
      `NEGATIVE PROOF FORGED FROM A REFUSAL\n` +
        `  invariant: a refusal never becomes a family-B absence proof\n` +
        `  case:      the index is stale; the call graph demonstrably contains\n` +
        `             this instance\n` +
        `  expected:  no confirmedAbsentInstance evidence\n` +
        `  actual:    ${JSON.stringify(result.proofAfter)}`,
    ).toBeUndefined();
  }, 120_000);
});

/**
 * FOUNDATION F6 REMEDIATION — the case that DISCRIMINATES, found by
 * independent audit.
 *
 * The block above asserts that a refusal does not change the answer when
 * the finding's own instance is REACHED. That case cannot fail, and the
 * audit showed why: when the instance is reached and its target is
 * called, Site A and Site B agree. Site B's independent resolution lands
 * on the very same instance and finds the very same target, so the
 * verdict is `AFFECTED` whether the index answered or not. A test built
 * only on that case reports coverage of the fallback contract while being
 * incapable of detecting its loss.
 *
 * THE STATE THAT DISCRIMINATES is a finding about an UNREACHED TWIN.
 *
 * `resolveTargetNodes` has two structurally different "target not found"
 * sites (VT-301B, documented on that function):
 *
 * - **Site A** runs when `instances.size > 0`. Only here does the
 *   analyzer know "the graph holds other instances of this package name
 *   but never traversed THIS one" — and that sentence is the entire
 *   premise of a family-B `confirmedAbsentInstance` proof. It is the ONLY
 *   place in `verdict.ts` that returns one.
 * - **Site B** runs when `instances.size === 0`. It performs an
 *   independent, instance-blind re-resolution from the reference file. It
 *   has no knowledge of which instances the graph contains, so it cannot
 *   conclude family B at all.
 *
 * So reading a refusal as an empty answer does not merely lose speed: it
 * skips Site A entirely, discards the knowledge family B is made of, and
 * the independent resolution lands on the REACHED twin instead — a
 * different instance from the finding's own, which the proof guards then
 * correctly refuse to certify. The verdict degrades to `UNKNOWN`.
 *
 * MEASURED, on this exact fixture:
 *
 * | source | verdict | proof |
 * | ------ | ------- | ----- |
 * | clean | `NOT_AFFECTED` | family B, naming the unreached twin |
 * | refusal read as absence | `UNKNOWN` | none |
 *
 * That is a CONSERVATIVE change — a proof is lost, never fabricated — so
 * it is a precision regression rather than a soundness one, and normal
 * production does not enter the stale-index state that reaches it. It is
 * nonetheless observable production semantics, which is why it is gated
 * here rather than argued away.
 */
describe("F5 graph package-instance index: a refusal preserves the family-B proof", () => {
  /**
   * Two installs of ONE name at ONE version. The top-level twin is
   * required and called; the nested twin is the finding's subject and is
   * never traversed.
   */
  async function unreachedTwinAcrossIndexRefusal(): Promise<{
    readonly before: TwinOutcome;
    readonly after: TwinOutcome;
    readonly refused: boolean;
    readonly unreachedTwin: string;
    readonly reachedTwin: string;
  }> {
    const { buildDependencyGraph } =
      await import("../dependencies/dependency-graph.js");
    const { loadPackageJsonFile } =
      await import("../dependencies/package-json.js");
    const { loadPackageLockFile } =
      await import("../dependencies/package-lock.js");
    const { buildCallGraph } =
      await import("../code-intelligence/call-graph.js");
    const { createModuleResolver } =
      await import("../code-intelligence/module-resolver.js");
    const { loadTsProject } =
      await import("../code-intelligence/ts-project.js");
    const { buildKnownPackageRoots } =
      await import("../domain/resolved-target.js");
    const { discoverEntrypoints } = await import("./entrypoints.js");
    const { buildGateEligibleModuleLoadClosure } =
      await import("./module-load-closure.js");
    const { createAnalysisProofContext } =
      await import("./analysis-context.js");
    const { buildFinding } = await import("./verdict.js");

    const lib =
      "function danger(x) { return x; }\nfunction safe(x) { return x; }\n" +
      "module.exports = { danger, safe };\n";

    const root = project({
      "package.json": JSON.stringify({
        name: "twin-refusal-fixture",
        version: "1.0.0",
        dependencies: { "vuln-lib": "1.0.0", host: "1.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        name: "twin-refusal-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": { name: "twin-refusal-fixture", version: "1.0.0" },
          "node_modules/vuln-lib": { version: "1.0.0" },
          "node_modules/host": { version: "1.0.0" },
          "node_modules/host/node_modules/vuln-lib": { version: "1.0.0" },
        },
      }),
      "node_modules/vuln-lib/package.json": manifest("vuln-lib", "1.0.0"),
      "node_modules/vuln-lib/index.js": lib,
      "node_modules/host/package.json": manifest("host", "1.0.0"),
      "node_modules/host/index.js":
        "function idle() { return 1; }\nmodule.exports = { idle };\n",
      // SAME name, SAME version, different root. Nothing imports it.
      "node_modules/host/node_modules/vuln-lib/package.json": manifest(
        "vuln-lib",
        "1.0.0",
      ),
      "node_modules/host/node_modules/vuln-lib/index.js": lib,
      "src/index.js":
        'const { danger } = require("vuln-lib");\n' +
        "function main(x) { return danger(x); }\n" +
        "module.exports = { main };\n",
    });

    const dependencyNodes = buildDependencyGraph(
      loadPackageJsonFile(path.join(root, "package.json")),
      loadPackageLockFile(path.join(root, "package-lock.json")),
    );
    const knownPackageRoots = buildKnownPackageRoots(dependencyNodes, root, []);
    const identity = createScanModuleIdentityCache(knownPackageRoots);
    const tsProject = loadTsProject(root);
    const resolver = createModuleResolver(tsProject);
    const entrypointsResult = await discoverEntrypoints({
      projectRoot: root,
      resolver,
      configuredEntrypoints: ["src/index.js"],
    });
    const graph = await buildCallGraph({
      entryFiles: entrypointsResult.entrypoints.map((entry) => entry.filePath),
      resolver,
      maxFiles: 2_000,
      maxGraphNodes: 50_000,
      maxAnalysisSeconds: 120,
      project: tsProject,
      knownPackageRoots,
    });
    const moduleLoadClosure = await buildGateEligibleModuleLoadClosure({
      entrypoints: entrypointsResult.entrypoints,
      resolver,
      maxFiles: 2_000,
      knownPackageRoots,
      moduleIdentityCache: identity,
    });
    const context = createAnalysisProofContext({
      projectRoot: root,
      resolver,
      entrypoints: entrypointsResult.entrypoints,
      knownPackageRoots,
      graph,
      graphTruncated: false,
      moduleLoadClosure,
      moduleIdentityCache: identity,
    });

    const reachedTwin = path.join(root, "node_modules", "vuln-lib");
    const unreachedTwin = path.join(
      root,
      "node_modules",
      "host",
      "node_modules",
      "vuln-lib",
    );

    // THE FINDING IS ABOUT THE UNREACHED TWIN.
    const input = {
      vulnerability: {
        id: "GHSA-f6-twin-refusal",
        aliases: [],
        package: "vuln-lib",
        ecosystem: "npm",
        affectedVersions: [{ introduced: "0" }],
        fixedVersions: [],
        references: [],
      },
      packageName: "vuln-lib",
      packageVersion: "1.0.0",
      packageInstance: unreachedTwin,
      matchResult: "affected",
      rule: {
        id: "GHSA-f6-twin-refusal",
        package: { name: "vuln-lib" },
        targets: [
          {
            module: "vuln-lib",
            export: "danger",
            kind: "function",
            confidence: 1,
          },
        ],
      },
      context,
    } as unknown as Parameters<typeof buildFinding>[0];

    const describeOutcome = (
      finding: Awaited<ReturnType<typeof buildFinding>>,
    ): TwinOutcome => {
      const evidence = finding?.evidence;
      const family = evidence?.confirmedAbsentFromModuleLoadClosure
        ? "A"
        : evidence?.confirmedAbsentInstance
          ? "B"
          : evidence?.confirmedUnreachableTarget
            ? "C"
            : "NONE";
      return {
        verdict: finding?.verdict,
        family,
        proofInstance: evidence?.confirmedAbsentInstance?.packageInstance,
      };
    };

    // FIRST run: the index answers, and is built -- which records the node
    // count the refusal below depends on.
    const before = describeOutcome(await buildFinding(input));

    // Make the index unable to answer for this analysis. This changes the
    // ANALYSIS, never the production code, and is the state a stale index
    // really would be in.
    (graph.nodes as GraphNode[]).push({
      id: "n-appended",
      kind: "function",
      module: path.join(root, "src", "index.js"),
      name: "appended",
    });
    const refused =
      graphPackageInstancesByName(
        context.caches,
        graph,
        knownPackageRoots,
        "vuln-lib",
      ) === undefined;

    const after = describeOutcome(await buildFinding(input));
    return { before, after, refused, unreachedTwin, reachedTwin };
  }

  it("keeps NOT_AFFECTED family B, naming the exact unreached twin", async () => {
    const result = await unreachedTwinAcrossIndexRefusal();

    // Non-vacuity first: without a real refusal this case proves nothing,
    // and would pass against the very defect it exists to catch.
    expect(
      result.refused,
      "the index did not refuse, so the fallback was never reached and this " +
        "case asserts nothing",
    ).toBe(true);

    // The baseline has to be the interesting answer, or the assertion
    // below is about the wrong thing.
    expect(result.before.verdict).toBe("NOT_AFFECTED");
    expect(result.before.family).toBe("B");
    expect(result.before.proofInstance).toBe(result.unreachedTwin);

    // THE INVARIANT. The authoritative walk still knows the graph holds
    // the OTHER twin and never this one -- which is precisely what a
    // family-B proof asserts. An index that cannot answer must not cost
    // the analyzer that knowledge.
    expect(
      result.after.verdict,
      `GRAPH-INDEX FALLBACK: FAMILY-B PRECISION REGRESSION\n` +
        `  invariant: a refusal falls back to the authoritative walk, so the\n` +
        `             proof a full walk would establish is still established\n` +
        `  case:      same-name/same-version twins; the finding is about the\n` +
        `             UNREACHED twin; the index is stale and refuses\n` +
        `  expected:  NOT_AFFECTED (family B, naming the unreached twin)\n` +
        `  actual:    ${result.after.verdict} (family ${result.after.family})\n` +
        `  Reading the refusal as "no instances" skips Site A, which is the\n` +
        `  ONLY place a family-B proof is produced, and routes to Site B's\n` +
        `  instance-blind re-resolution instead.`,
    ).toBe("NOT_AFFECTED");

    expect(
      result.after.family,
      `the refusal cost the finding its negative proof (family ` +
        `${result.after.family} after refusal, B before)`,
    ).toBe("B");

    // EXACT instance identity, not merely "some family B proof": the
    // proof must name the twin the finding is about, never its sibling.
    expect(
      result.after.proofInstance,
      `PROOF NAMES THE WRONG TWIN\n` +
        `  expected:  ${result.unreachedTwin}\n` +
        `  actual:    ${result.after.proofInstance}`,
    ).toBe(result.unreachedTwin);
    expect(result.after.proofInstance).not.toBe(result.reachedTwin);

    // ...and the refusal changed nothing at all.
    expect(result.after).toEqual(result.before);
  }, 120_000);
});
