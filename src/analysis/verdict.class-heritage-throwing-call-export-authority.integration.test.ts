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
import type { Vulnerability } from "../domain/vulnerability.js";
import { fixturePath } from "../testing/fixtures.js";
import { discoverEntrypoints } from "./entrypoints.js";
import { buildFindingForTest } from "../testing/finding.js";

/**
 * RWF-020's permanent end-to-end regression (see
 * fixtures/commonjs-circular-import-class-heritage-throw-ground-truth/README.md
 * for the real-Node runtime proof that a cyclic `require()` really can
 * retain the earlier, dangerous export this fixture's `bail()` call
 * bypasses -- and, in the same process, that the HARMLESS-heritage and
 * DEFERRED controls genuinely do NOT bypass it).
 *
 * The fixture's `fixture-lib/index.js` is RWF-016/017/018/019's fixture
 * with the call moved into the one position none of them models: the
 * class's `extends` HERITAGE expression, on a class whose body is EMPTY.
 * ClassDefinitionEvaluation evaluates the heritage expression FIRST --
 * before any element exists, because the superclass value is what the
 * prototype chain is built from -- so reaching the class necessarily
 * invokes `bail()` and the class definition never completes.
 * `fixture-lib/class-expression.js` holds the same defect on an anonymous
 * class EXPRESSION, where there is no class binding either.
 *
 * RWF-016 recognised the call as an ExpressionStatement, RWF-017 as a
 * VariableStatement, RWF-018 as a static field INITIALIZER and RWF-019 as
 * an element's COMPUTED KEY -- all four read the call off a STATEMENT or
 * an ELEMENT, and an empty-bodied `class C extends bail() {}` offers
 * neither. So before RWF-020 both files' whole exported value bound to
 * `safeOp`, the entrypoint's `fixture(input)` call got a fully RESOLVED
 * edge to it, `dangerousOp` was left with no incoming edge at all, and the
 * reachability search over `danger.explode` came back unreachable with a
 * complete subgraph -- a Family C proof, and a false NOT_AFFECTED, for a
 * package that reaches the sink on every load that takes the early branch.
 *
 * Post-fix the whole-module export is ambiguous, nothing attributes it,
 * and the call becomes an honest `unknown(unresolved_target)` edge -- so
 * the answer is UNKNOWN.
 */

const FIXTURE = "commonjs-class-heritage-throwing-call-export-authority";
const HERITAGE_ENTRYPOINT = "src/index.cjs";
/** Reaches only the definitely-reached whole-module export — see the fixture's README. */
const STABLE_ENTRYPOINT = "src/stable-only.cjs";
/** Reaches only the harmless-heritage control, for the same subgraph-completeness reason. */
const DEFERRED_ENTRYPOINT = "src/deferred-only.cjs";

async function scan(options: {
  readonly module: string;
  readonly export: string;
  readonly packageInstance?: string;
  readonly entrypoint: string;
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
    id: "GHSA-rwf-020",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-020",
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

describe("RWF-020 fixture: a resolvable local throwing call in a class's `extends` HERITAGE expression bypassing the final whole-module export (fixtures/commonjs-class-heritage-throwing-call-export-authority)", () => {
  it("does not prove the bypassed vulnerable branch unreachable -> UNKNOWN", async () => {
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: HERITAGE_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("issues no Family C negative proof for the branch that survived to the end of the file", async () => {
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: HERITAGE_ENTRYPOINT,
    });

    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("attributes no definitive whole-module target to either branch", async () => {
    const { finding, graph } = await scan({
      module: "fixture-lib",
      export: "default",
      entrypoint: HERITAGE_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");

    const branchNodes = graph.nodes.filter(
      (n) =>
        (n.name === "dangerousOp" || n.name === "safeOp") &&
        n.module.endsWith(path.join("fixture-lib", "index.js")),
    );
    expect(branchNodes).toHaveLength(2);
    for (const node of branchNodes) {
      expect(finding?.evidence?.path ?? []).not.toContain(node.id);
    }
  });

  it("attributes no definitive whole-module target when the heritage sits on an anonymous class EXPRESSION (no class binding, no element, no `static` token)", async () => {
    const { finding } = await scan({
      module: "fixture-lib/class-expression",
      export: "default",
      entrypoint: HERITAGE_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("never substitutes a different PackageInstance for the ambiguous export", async () => {
    const { finding, root } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: HERITAGE_ENTRYPOINT,
      packageInstance: canonicalizePackageInstancePath(
        path.join(
          fixturePath(FIXTURE),
          "node_modules",
          "elsewhere",
          "node_modules",
          "fixture-lib",
        ),
      ),
    });

    expect(root).toBeTruthy();
    expect(finding?.verdict).not.toBe("AFFECTED");
    expect(finding?.evidence?.path ?? []).toHaveLength(0);
  });

  it("keeps the later export attributable when the heritage call RETURNS, is `null`, or is DEFERRED (the control that makes this sound rather than merely conservative)", async () => {
    // `fixture-lib/harmless-heritage` holds `extends baseFactory()` (a call
    // that returns normally), `extends null` (no call at all) and a
    // `class ... extends bail() {}` inside a never-called function. None of
    // them ends module evaluation, so `module.exports = safeOp` really is
    // reached on every load -- proven in-process in the ground-truth
    // fixture's `c.js`. Treating any of them like a definitely-abrupt
    // heritage call would withdraw authority from an export that is
    // genuinely reached, which is a false refusal rather than conservatism.
    const { finding } = await scan({
      module: "fixture-lib/harmless-heritage",
      export: "default",
      entrypoint: DEFERRED_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toMatchObject({
      reachableSubgraphComplete: true,
      target: { module: "fixture-lib/harmless-heritage", export: "default" },
    });
  });

  it("still proves a genuinely unreachable, DEFINITELY REACHED whole-module export -> NOT_AFFECTED (Family C control)", async () => {
    // The control must keep working, or this task would have bought its
    // soundness by disabling negative proofs rather than by narrowing them.
    const { finding } = await scan({
      module: "fixture-lib/stable",
      export: "default",
      entrypoint: STABLE_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toMatchObject({
      reachableSubgraphComplete: true,
      target: { module: "fixture-lib/stable", export: "default" },
    });
  });
});
