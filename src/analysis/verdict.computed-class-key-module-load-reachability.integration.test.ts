import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import {
  buildKnownPackageRoots,
  canonicalizePackageInstancePath,
} from "../domain/resolved-target.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { CallGraph, GraphNode } from "../domain/graph.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { fixturePath } from "../testing/fixtures.js";
import { discoverEntrypoints } from "./entrypoints.js";
import { buildFindingForTest } from "../testing/finding.js";

/**
 * RWF-023's permanent end-to-end regression (see
 * fixtures/computed-class-key-module-load-reachability-ground-truth/README.md
 * for the real-Node, asserted proof of every row below).
 *
 * This fixture is deliberately unlike RWF-014 through RWF-022's. It has no
 * conditional export, no `process.env` branch and no second candidate for
 * any module's value. That is the point: every one of those findings is
 * about which export WRITE is authoritative, and this one is about whether
 * the analyzer believes a computed class-element KEY executes at all.
 * Stripping out the export machinery proves the two are orthogonal --
 * `fixture-lib/index.js` was a false NOT_AFFECTED before RWF-023 even
 * though nothing about its exports is ambiguous.
 *
 * Pre-fix, on `86c8669`: the class-definition-time call was attributed to
 * the METHOD's own node, `key`'s body never entered the reachable
 * subgraph, `danger.explode` was left with no incoming edge, and the
 * search returned unreachable WITH a complete subgraph -- a Family C
 * proof, and a false NOT_AFFECTED, for a package that calls the sink on
 * every single load.
 */

const FIXTURE = "commonjs-computed-class-key-module-load-reachability";

async function scan(options: {
  readonly module: string;
  readonly export: string;
  readonly entrypoint: string;
  readonly packageInstance?: string;
}) {
  const root = fixturePath(FIXTURE);
  const entry = path.join(root, ...options.entrypoint.split("/"));
  const resolver = createModuleResolver(loadTsProject(root));
  const knownPackageRoots = buildKnownPackageRoots([], root);

  const [graph, entrypointsResult] = await Promise.all([
    buildCallGraph({ entryFiles: [entry], resolver, knownPackageRoots }),
    discoverEntrypoints({
      projectRoot: root,
      resolver,
      configuredEntrypoints: [options.entrypoint],
    }),
  ]);

  const vulnerability: Vulnerability = {
    id: "GHSA-rwf-023",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-023",
    package: { name: "fixture-lib" },
    targets: [
      { module: options.module, export: options.export, kind: "function" },
    ],
  };

  const finding = await buildFindingForTest({
    vulnerability,
    packageName: "fixture-lib",
    packageVersion: "1.0.0",
    packageInstance: options.packageInstance,
    matchResult: "affected",
    rule,
    graph,
    entrypoints: entrypointsResult.entrypoints,
    resolver,
    projectRoot: root,
    knownPackageRoots,
  });

  return { finding, graph, root };
}

/** Every entrypoint whose module really does reach the sink at load time. */
function sinkScan(entrypoint: string) {
  return scan({
    module: "fixture-lib/danger",
    export: "explode",
    entrypoint,
  });
}

/**
 * `Evidence.path` holds rendered `file:line` strings (verdict.ts's
 * `locationOf`), not raw `GraphNodeId`s. Derive the expected entry from the
 * node itself so the assertion says "the path goes through this function"
 * rather than pinning a line number.
 */
function locationOfNode(node: GraphNode | undefined): string {
  return `${node?.location?.file ?? ""}:${node?.location?.line ?? ""}`;
}

function keyNodeIn(
  graph: CallGraph,
  moduleFile: string,
): GraphNode | undefined {
  return graph.nodes.find(
    (node) =>
      node.name === "key" &&
      node.module.endsWith(path.join("fixture-lib", moduleFile)),
  );
}

const NESTED_INSTALL = path.join(
  fixturePath(FIXTURE),
  "node_modules",
  "fixture-lib",
  "node_modules",
  "nested-vuln",
);
const TOP_LEVEL_INSTALL = path.join(
  fixturePath(FIXTURE),
  "node_modules",
  "nested-vuln",
);

/**
 * Scans the duplicate-install module for `nested-vuln#dangerousOp`, scoped
 * to one specific PackageInstance.
 */
async function duplicateInstanceScan(installPath: string) {
  const root = fixturePath(FIXTURE);
  const entrypoint = "src/duplicate-instance.cjs";
  const entry = path.join(root, ...entrypoint.split("/"));
  const resolver = createModuleResolver(loadTsProject(root));
  const knownPackageRoots = buildKnownPackageRoots([], root);

  const [graph, entrypointsResult] = await Promise.all([
    buildCallGraph({ entryFiles: [entry], resolver, knownPackageRoots }),
    discoverEntrypoints({
      projectRoot: root,
      resolver,
      configuredEntrypoints: [entrypoint],
    }),
  ]);

  const finding = await buildFindingForTest({
    vulnerability: {
      id: "GHSA-rwf-023-dup",
      aliases: [],
      package: "nested-vuln",
      ecosystem: "npm",
      affectedVersions: [{ introduced: "0" }],
      fixedVersions: [],
      references: [],
    },
    packageName: "nested-vuln",
    packageVersion: "1.0.0",
    packageInstance: canonicalizePackageInstancePath(installPath),
    matchResult: "affected",
    rule: {
      id: "GHSA-rwf-023-dup",
      package: { name: "nested-vuln" },
      targets: [
        { module: "nested-vuln", export: "dangerousOp", kind: "function" },
      ],
    },
    graph,
    entrypoints: entrypointsResult.entrypoints,
    resolver,
    projectRoot: root,
    knownPackageRoots,
  });

  return { finding, graph };
}

describe(`RWF-023 fixture: a vulnerable target invoked from a COMPUTED CLASS-ELEMENT KEY during module evaluation (fixtures/${FIXTURE})`, () => {
  describe("the canonical reproducer", () => {
    it("reports AFFECTED for a target reached only through a computed method key", async () => {
      const { finding } = await sinkScan("src/index.cjs");

      expect(finding?.verdict).toBe("AFFECTED");
    });

    it("issues no Family C negative proof over a target that really executes", async () => {
      const { finding } = await sinkScan("src/index.cjs");

      // The pre-fix answer was NOT_AFFECTED carrying exactly this evidence
      // with `reachableSubgraphComplete: true`. A complete negative proof
      // over a sink that runs on every load is the single most dangerous
      // output this analyzer can produce.
      expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
    });

    it("reports a concrete path through the key's wrapper into the sink", async () => {
      const { finding, graph } = await sinkScan("src/index.cjs");

      // AFFECTED is preferred over UNKNOWN here precisely because a
      // concrete path exists: module -> key -> danger.explode. The
      // evidence has to show it, or the verdict is an assertion rather
      // than an explanation.
      expect(finding?.evidence?.path ?? []).toContain(
        locationOfNode(keyNodeIn(graph, "index.js")),
      );
    });

    it("matches the top-level control, which differs only in CALL POSITION", async () => {
      const computedKey = await sinkScan("src/index.cjs");
      const topLevel = await sinkScan("src/top-level.cjs");

      // `top-level.js` is byte-for-byte the same call, the same wrapper and
      // the same sink, moved out of the key and into an ExpressionStatement.
      // It was already AFFECTED before RWF-023 while the key spelling was
      // NOT_AFFECTED, which is what isolates the defect to call position.
      expect(topLevel.finding?.verdict).toBe("AFFECTED");
      expect(computedKey.finding?.verdict).toBe(topLevel.finding?.verdict);
    });
  });

  describe("every computed-key element form runs at class-definition time", () => {
    it("reaches the sink from all eight forms in one module", async () => {
      // Instance field, static field, instance method, static method,
      // getter, setter, async method and generator method. Four of these
      // (the MethodDeclarations) were lost before RWF-023; the other four
      // already worked, because a field and an accessor are not
      // function-like and so were never made the walk's owner.
      const { finding } = await sinkScan("src/forms.cjs");

      expect(finding?.verdict).toBe("AFFECTED");
      expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
    });
  });

  describe("key EXPRESSION shapes go through ordinary call-graph traversal", () => {
    it("reaches the sink from wrappers, nesting, short-circuits and class expressions", async () => {
      // Parenthesized, nested, sequence, template, `||`, `&&`, `?:`, a
      // direct imported member call, a class expression, a class expression
      // in an object literal, and a class inside a top-level `if`. None of
      // these needed a shape-specific rule: the fix hands the key to the
      // same traversal every other expression already uses.
      const { finding } = await sinkScan("src/expressions.cjs");

      expect(finding?.verdict).toBe("AFFECTED");
      expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
    });

    it("goes through the key's wrapper, not around it", async () => {
      const { finding, graph } = await sinkScan("src/expressions.cjs");

      expect(finding?.evidence?.path ?? []).toContain(
        locationOfNode(keyNodeIn(graph, "expressions.js")),
      );
    });

    it("does not treat a CONDITIONAL class as unreachable", async () => {
      // `conditional.js` is scanned on its own: the class inside the
      // top-level `if` is the ONLY route to the sink in that module, so
      // AFFECTED here cannot be earned by some other statement.
      //
      // Reachability is a MAY-execute question. `if (flag) { class C {...} }`
      // runs the key whenever the branch is taken, and nothing proves it is
      // not. RWF-019's cutoff needs the opposite (a call that ALWAYS runs),
      // and the two must not borrow each other's predicates.
      const { finding, graph } = await sinkScan("src/conditional.cjs");

      expect(finding?.verdict).toBe("AFFECTED");
      expect(finding?.evidence?.path ?? []).toContain(
        locationOfNode(keyNodeIn(graph, "conditional.js")),
      );
    });

    it("resolves an imported member call written directly as the key", async () => {
      // `direct-call.js` has no local wrapper at all: `[danger.explode(...)]`
      // IS the key. Isolated for the same reason -- there is nothing else in
      // that module that could reach the sink.
      const { finding } = await sinkScan("src/direct-call.cjs");

      expect(finding?.verdict).toBe("AFFECTED");
      expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
    });
  });

  describe("heritage interaction", () => {
    it("reaches a key's sink under a VALID heritage clause", async () => {
      const { finding } = await sinkScan("src/heritage.cjs");

      expect(finding?.verdict).toBe("AFFECTED");
    });

    it("does not lose the sink because RWF-022 withdrew a later export's authority", async () => {
      const { finding } = await sinkScan("src/heritage.cjs");

      // `heritage.js` also declares `class Invalid extends makeInvalid()`,
      // whose heritage value is `1`. RWF-022 correctly refuses to let any
      // export written below that statement claim authority -- but the
      // computed keys have ALREADY RUN by the time the definition throws
      // (asserted in the ground-truth fixture). A cutoff firing further
      // down the same statement must not erase a sink the key reached.
      expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
    });
  });

  describe("class-definition-time hosts for a nested class", () => {
    it("reaches a nested class's key through a STATIC field initializer and a STATIC block", async () => {
      // Both run during class definition, so the nested class really is
      // defined at module load. This falls out of the same ancestor walk
      // that refuses the instance-field spelling -- it is not a separate
      // rule.
      const { finding } = await sinkScan("src/class-definition-time.cjs");

      expect(finding?.verdict).toBe("AFFECTED");
    });
  });

  describe("the deferral controls -- what must NOT become reachable", () => {
    it("proves the sink unreachable when every class definition is deferred", async () => {
      // `deferred.js` carries the IDENTICAL computed key in eleven deferred
      // positions: inside an uncalled function, arrow and callback; inside
      // a method, getter and constructor body; held by an instance field
      // and by an object literal in an instance field; and in a method and
      // a setter parameter default. None runs at load time (asserted in the
      // ground-truth fixture), so a complete negative proof here is CORRECT
      // -- and issuing it is what makes RWF-023 a fix rather than a
      // widening.
      const { finding } = await scan({
        module: "fixture-lib/danger",
        export: "explode",
        entrypoint: "src/deferred.cjs",
      });

      expect(finding?.verdict).toBe("NOT_AFFECTED");
      expect(finding?.evidence?.confirmedUnreachableTarget).toMatchObject({
        reachableSubgraphComplete: true,
      });
    });

    it("keeps a nested class in an INSTANCE FIELD unreachable (the critical false-AFFECTED control)", async () => {
      const { finding, graph } = await scan({
        module: "fixture-lib/danger",
        export: "explode",
        entrypoint: "src/deferred.cjs",
      });

      const keyNode = graph.nodes.find(
        (node) =>
          node.name === "key" &&
          node.module.endsWith(path.join("fixture-lib", "deferred.js")),
      );

      // `class Host { field = class Nested { [key()]() {} }; }`. The
      // ENCLOSING class is genuinely being defined at module load, so a
      // rule that stopped at "the class is at module scope" would root
      // this key and manufacture a false AFFECTED. The field's VALUE is
      // per-instance -- RWF-018's line, reproduced rather than moved.
      expect(finding?.verdict).toBe("NOT_AFFECTED");
      expect(finding?.evidence?.path ?? []).not.toContain(keyNode?.id);
    });
  });

  describe("identity and provenance are untouched", () => {
    it("attributes the reached sink to the exact PackageInstance the key loads", async () => {
      // Two installs of nested-vuln@1.0.0 exist, identical in name, version
      // and export name, distinguishable only by install path. The require
      // inside `duplicate-instance.js` resolves to the NESTED one.
      const { finding } = await duplicateInstanceScan(NESTED_INSTALL);

      expect(finding?.verdict).toBe("AFFECTED");
    });

    it("does not let the class-definition-time edge answer for the TOP-LEVEL twin", async () => {
      // The decisive identity control. A new reachability edge must not
      // become a licence to answer for an install the edge does not belong
      // to -- the top-level nested-vuln is never loaded by this key.
      const { finding } = await duplicateInstanceScan(TOP_LEVEL_INSTALL);

      expect(finding?.verdict).not.toBe("AFFECTED");
      expect(finding?.evidence?.path ?? []).toHaveLength(0);
    });

    it("does not make the module's own exported value reachable through the key", async () => {
      // The key's side effect is a side effect. It publishes nothing, and
      // must not fabricate export provenance for `module.exports = C`.
      const { finding } = await scan({
        module: "fixture-lib",
        export: "default",
        entrypoint: "src/index.cjs",
      });

      expect(finding?.verdict).not.toBe("AFFECTED");
    });
  });
});
