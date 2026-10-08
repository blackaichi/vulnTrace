import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import type {
  ConfirmedAbsentInstance,
  ConfirmedUnreachableTarget,
} from "../domain/evidence.js";
import type { CallGraph, GraphNode } from "../domain/graph.js";
import type { VulnerableSymbolTarget } from "../domain/target.js";
import {
  buildGateEligibleModuleLoadClosure,
  type ModuleLoadClosure,
} from "./module-load-closure.js";
import {
  attributeTarget,
  confirmedAbsentInstanceEvidence,
  confirmedUnreachableTargetEvidence,
  corroborateClosure,
  corroborateEvaluation,
  type AttributedTarget,
  type ClosureCorroboration,
  type EvaluatedClosureCorroboration,
} from "./verdict.js";

/**
 * ADR 0011 § 2 -- THE PROOF INPUTS ARE UNFORGEABLE TYPES (task V-4,
 * Foundation invariant `VT-INV-V-corroboration`).
 *
 * Families B and C are built only from three branded values, each produced
 * by exactly one function that checks it: `ClosureCorroboration`
 * (predicate 1, both halves, gate-eligible), `EvaluatedClosureCorroboration`
 * (predicate 5 beside it) and `AttributedTarget` (predicate 3). This file
 * owns the producers' refusals, the evidence constructors' refusal of an
 * input no producer made (a cast), and -- through `npm run typecheck`, which
 * checks every `@ts-expect-error` below -- that an object literal of any of
 * the five types does not compile. `buildFinding`'s use of them is owned by
 * `verdict.f2-proof-guards.test.ts` and the F4 matrices.
 */

const TARGET: VulnerableSymbolTarget = {
  module: "vuln-lib",
  export: "vulnerable",
  kind: "function",
  confidence: 1,
};

const INSTANCE = "/project/node_modules/vuln-lib";

function closure(fields: Partial<ModuleLoadClosure> = {}): ModuleLoadClosure {
  return {
    rootFiles: ["/project/src/index.js"],
    loadedFiles: ["/project/src/index.js"],
    loadedPackageInstances: [],
    complete: true,
    incompleteness: [],
    ...fields,
  };
}

function produced(
  value: ClosureCorroboration | undefined,
): ClosureCorroboration {
  expect(value).toBeDefined();
  return value!;
}

describe("V-4: corroborateClosure is ADR 0011 predicate 1, both halves", () => {
  it("refuses an absent closure with module_load_closure_unavailable", () => {
    expect(corroborateClosure(undefined, INSTANCE)).toEqual({
      blockers: ["module_load_closure_unavailable"],
    });
  });

  it("refuses with every reason a closure recorded, traversal_truncated included", () => {
    const result = corroborateClosure(
      closure({
        complete: false,
        incompleteness: [
          { reason: "traversal_truncated", importer: "/project/src/index.js" },
          { reason: "parse_failure", importer: "/project/src/index.js" },
        ],
      }),
      INSTANCE,
    );
    expect(result.corroboration).toBeUndefined();
    expect(result.blockers).toEqual(["traversal_truncated", "parse_failure"]);
  });

  it("refuses a closure marked complete beside a recorded reason (the list half)", () => {
    const result = corroborateClosure(
      closure({
        incompleteness: [
          { reason: "loader_hook_mutation", importer: "/project/src/index.js" },
        ],
      }),
      INSTANCE,
    );
    expect(result.blockers).toEqual(["loader_hook_mutation"]);
  });

  it("refuses a closure marked incomplete with no recorded reason (the complete half)", () => {
    expect(corroborateClosure(closure({ complete: false }), INSTANCE)).toEqual({
      blockers: ["module_load_closure_unavailable"],
    });
  });

  it("refuses a root-less closure: it is not gate-eligible", () => {
    expect(corroborateClosure(closure({ rootFiles: [] }), INSTANCE)).toEqual({
      blockers: ["module_load_closure_unavailable"],
    });
  });

  it("records whether the exact instance is loaded, by install location", () => {
    const unloaded = produced(
      corroborateClosure(
        closure({
          loadedPackageInstances: [
            "/project/node_modules/a/node_modules/vuln-lib",
          ],
        }),
        INSTANCE,
      ).corroboration,
    );
    expect(unloaded.instanceLoaded).toBe(false);
    expect(unloaded.packageInstance).toBe(INSTANCE);

    const loaded = produced(
      corroborateClosure(
        closure({ loadedPackageInstances: [INSTANCE] }),
        INSTANCE,
      ).corroboration,
    );
    expect(loaded.instanceLoaded).toBe(true);

    const none = produced(
      corroborateClosure(closure(), undefined).corroboration,
    );
    expect(none.instanceLoaded).toBeUndefined();
  });

  it("produces a frozen value", () => {
    const corroboration = produced(
      corroborateClosure(closure(), INSTANCE).corroboration,
    );
    expect(Object.isFrozen(corroboration)).toBe(true);
  });
});

describe("V-4: family B's evidence is built only from a ClosureCorroboration", () => {
  const corroboration = produced(
    corroborateClosure(closure(), INSTANCE).corroboration,
  );

  it("builds the evidence for the exact unloaded instance, with the serialized shape unchanged", () => {
    const evidence = confirmedAbsentInstanceEvidence(
      corroboration,
      INSTANCE,
      [
        {
          filePath: "/project/src/index.js",
          source: "configured",
          reason: "t",
        },
      ],
      false,
    );
    expect(JSON.parse(JSON.stringify(evidence))).toEqual({
      packageInstance: INSTANCE,
      entrypointRoots: ["/project/src/index.js"],
      graphTruncated: false,
      moduleLoadClosureComplete: true,
    });
  });

  it("refuses a corroboration showing the instance loaded", () => {
    const loaded = produced(
      corroborateClosure(
        closure({ loadedPackageInstances: [INSTANCE] }),
        INSTANCE,
      ).corroboration,
    );
    expect(
      confirmedAbsentInstanceEvidence(loaded, INSTANCE, [], false),
    ).toBeUndefined();
  });

  it("refuses a corroboration of another instance", () => {
    expect(
      confirmedAbsentInstanceEvidence(
        corroboration,
        "/project/node_modules/b/node_modules/vuln-lib",
        [],
        false,
      ),
    ).toBeUndefined();
  });

  it("refuses a corroboration no producer made (a cast), even with every field right", () => {
    const forged = {
      closure: closure(),
      packageInstance: INSTANCE,
      instanceLoaded: false,
    } as unknown as ClosureCorroboration;
    expect(
      confirmedAbsentInstanceEvidence(forged, INSTANCE, [], false),
    ).toBeUndefined();
  });
});

describe("V-4: family C's evidence is built only from predicates 1, 5 and 3", () => {
  let root: string;
  let graph: CallGraph;
  let entrypoints: Entrypoint[];
  let realClosure: ModuleLoadClosure;
  let targetNode: GraphNode;

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-v4-"));
    const write = (rel: string, content: string): void => {
      const full = path.join(root, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    };
    write("package.json", JSON.stringify({ name: "app" }));
    write(
      "src/lib.js",
      "function vulnerable(){ return 1; }\nfunction safe(){ return 2; }\n" +
        "module.exports = { vulnerable, safe };\n",
    );
    write(
      "src/index.js",
      'const { safe } = require("./lib.js");\n' +
        "function main(){ return safe(); }\nmodule.exports = { main };\n",
    );
    const project = loadTsProject(root);
    const resolver = createModuleResolver(project);
    entrypoints = [
      {
        filePath: path.join(root, "src/index.js"),
        source: "configured",
        reason: "test",
      },
    ];
    graph = await buildCallGraph({
      entryFiles: entrypoints.map((entry) => entry.filePath),
      resolver,
      project,
    });
    realClosure = (await buildGateEligibleModuleLoadClosure({
      entrypoints,
      resolver,
      knownPackageRoots: new Map(),
    }))!;
    targetNode = graph.nodes.find(
      (node) =>
        node.module === path.join(root, "src/lib.js") &&
        node.kind === "function" &&
        node.name === "vulnerable",
    )!;
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function evaluated(
    corroboration: ClosureCorroboration,
  ): EvaluatedClosureCorroboration {
    const result = corroborateEvaluation(
      corroboration,
      graph,
      entrypoints,
      undefined,
    );
    expect(result.evaluated).toBeDefined();
    return result.evaluated!;
  }

  function attributed(): AttributedTarget {
    const result = attributeTarget(graph, TARGET, targetNode);
    expect(result).toBeDefined();
    return result!;
  }

  it("the fixture is what it claims: a complete closure and a real, unreached target node", () => {
    expect(realClosure.complete).toBe(true);
    expect(realClosure.loadedFiles).toContain(path.join(root, "src/lib.js"));
    expect(targetNode).toBeDefined();
  });

  it("builds the evidence, rooted at the corroboration's own entrypoints, with the serialized shape unchanged", () => {
    const corroboration = produced(
      corroborateClosure(realClosure, undefined).corroboration,
    );
    const evidence = confirmedUnreachableTargetEvidence(
      evaluated(corroboration),
      attributed(),
    );
    expect(JSON.parse(JSON.stringify(evidence))).toEqual({
      target: { module: "vuln-lib", export: "vulnerable" },
      entrypointRoots: [path.join(root, "src/index.js")],
      reachableSubgraphComplete: true,
    });
  });

  it("predicate 5: lists a loaded module whose top level no entrypoint reaches", () => {
    const unreached = path.join(root, "src/never-evaluated.js");
    const corroboration = produced(
      corroborateClosure(
        {
          ...realClosure,
          loadedFiles: [...realClosure.loadedFiles, unreached],
        },
        undefined,
      ).corroboration,
    );
    expect(
      corroborateEvaluation(corroboration, graph, entrypoints, undefined),
    ).toEqual({ unevaluated: [unreached] });
  });

  it("predicate 3: refuses a node that is not a member of the graph, even with the same id", () => {
    expect(attributeTarget(graph, TARGET, { ...targetNode })).toBeUndefined();
    expect(attributeTarget(graph, TARGET, targetNode)?.node).toBe(targetNode);
  });

  it("refuses an attributed target of another graph", () => {
    const corroboration = produced(
      corroborateClosure(realClosure, undefined).corroboration,
    );
    const otherGraph: CallGraph = {
      nodes: [...graph.nodes],
      edges: [...graph.edges],
    };
    const foreign = attributeTarget(otherGraph, TARGET, targetNode)!;
    expect(foreign).toBeDefined();
    expect(
      confirmedUnreachableTargetEvidence(evaluated(corroboration), foreign),
    ).toBeUndefined();
  });

  it("refuses an evaluated corroboration no producer made (a cast)", () => {
    const corroboration = produced(
      corroborateClosure(realClosure, undefined).corroboration,
    );
    const forged = {
      corroboration,
      graph,
      entrypoints,
    } as unknown as EvaluatedClosureCorroboration;
    expect(
      confirmedUnreachableTargetEvidence(forged, attributed()),
    ).toBeUndefined();
  });

  it("refuses a produced evaluation of a closure corroboration no producer made", () => {
    const forgedCorroboration = {
      closure: realClosure,
      packageInstance: undefined,
      instanceLoaded: undefined,
    } as unknown as ClosureCorroboration;
    expect(
      confirmedUnreachableTargetEvidence(
        evaluated(forgedCorroboration),
        attributed(),
      ),
    ).toBeUndefined();
  });

  it("refuses an attributed target no producer made (a cast)", () => {
    const corroboration = produced(
      corroborateClosure(realClosure, undefined).corroboration,
    );
    const forged = {
      target: TARGET,
      node: targetNode,
      graph,
    } as unknown as AttributedTarget;
    expect(
      confirmedUnreachableTargetEvidence(evaluated(corroboration), forged),
    ).toBeUndefined();
  });
});

describe("V-4: an object literal of a branded proof type does not compile", () => {
  // Each `@ts-expect-error` is checked by `npm run typecheck`: were a brand
  // removed, the literal would compile, the directive would be unused, and
  // the typecheck gate would fail. The runtime assertions only keep the
  // bindings used.
  it("rejects literals of the two evidence types and the three proof inputs", () => {
    // @ts-expect-error -- ConfirmedAbsentInstance is branded (task V-4)
    const b: ConfirmedAbsentInstance = {
      packageInstance: INSTANCE,
      entrypointRoots: [],
      graphTruncated: false,
      moduleLoadClosureComplete: true,
    };
    // @ts-expect-error -- ConfirmedUnreachableTarget is branded (task V-4)
    const c: ConfirmedUnreachableTarget = {
      target: { module: "vuln-lib", export: "vulnerable" },
      entrypointRoots: [],
      reachableSubgraphComplete: true,
    };
    // @ts-expect-error -- ClosureCorroboration is branded (task V-4)
    const p1: ClosureCorroboration = {
      closure: closure(),
      packageInstance: INSTANCE,
      instanceLoaded: false,
    };
    // @ts-expect-error -- EvaluatedClosureCorroboration is branded (task V-4)
    const p5: EvaluatedClosureCorroboration = {
      corroboration: p1,
      graph: { nodes: [], edges: [] },
      entrypoints: [],
    };
    // @ts-expect-error -- AttributedTarget is branded (task V-4)
    const p3: AttributedTarget = {
      target: TARGET,
      node: {
        id: "x",
        kind: "function",
        module: "/m.js",
        name: "vulnerable",
        location: { file: "/m.js", line: 1, column: 1 },
      },
      graph: { nodes: [], edges: [] },
    };
    expect([b, c, p1, p5, p3]).toHaveLength(5);
  });
});
