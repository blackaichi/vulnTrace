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
