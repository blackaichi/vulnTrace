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
 * RWF-018's permanent end-to-end regression (see
 * fixtures/commonjs-circular-import-static-field-throw-ground-truth/README.md
 * for the real-Node runtime proof that a cyclic `require()` really can
 * retain the earlier, dangerous export this fixture's `bail()` call
 * bypasses -- and, in the same process, that the INSTANCE-field control
 * genuinely does NOT bypass it).
 *
 * The fixture's `fixture-lib/index.js` is RWF-016/017's fixture with the
 * call moved into the one position neither of them models: the initializer
 * of a class STATIC FIELD. Evaluating a class definition runs its static
 * elements -- `static { ... }` blocks and `static x = ...` field
 * initializers alike -- in declaration order, as part of that evaluation,
 * which is itself part of module evaluation. So reaching the class
 * necessarily invokes `bail()` and the class definition never completes.
 * The runtime consequence is identical to RWF-016's and RWF-017's; only
 * the position of the CallExpression differs.
 *
 * RWF-016 recognised the call as an ExpressionStatement and RWF-017 as a
 * VariableStatement, so before RWF-018 this file's whole exported value
 * bound to `safeOp`, the entrypoint's `fixture(input)` call got a fully
 * RESOLVED edge to it, `dangerousOp` was left with no incoming edge at
 * all, and the reachability search over `danger.explode` came back
 * unreachable with a complete subgraph -- a Family C proof, and a false
 * NOT_AFFECTED, for a package that reaches the sink on every load that
 * takes the early branch.
 *
 * Post-fix the whole-module export is ambiguous, nothing attributes it,
 * and the call becomes an honest `unknown(unresolved_target)` edge -- so
 * the answer is UNKNOWN.
 */

const FIXTURE = "commonjs-static-field-throwing-call-export-authority";
const STATIC_FIELD_ENTRYPOINT = "src/index.cjs";
/** Reaches only the definitely-reached whole-module export — see the fixture's README. */
const STABLE_ENTRYPOINT = "src/stable-only.cjs";
/** Reaches only the INSTANCE-field module, for the same subgraph-completeness reason. */
const INSTANCE_FIELD_ENTRYPOINT = "src/instance-field-only.cjs";

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
    id: "GHSA-rwf-018",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-018",
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

describe("RWF-018 fixture: a resolvable local throwing call in a class STATIC FIELD initializer bypassing the final whole-module export (fixtures/commonjs-static-field-throwing-call-export-authority)", () => {
  it("does not prove the bypassed vulnerable branch unreachable -> UNKNOWN", async () => {
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: STATIC_FIELD_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("issues no Family C negative proof for the branch that survived to the end of the file", async () => {
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: STATIC_FIELD_ENTRYPOINT,
    });

    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("attributes no definitive whole-module target to either branch", async () => {
    const { finding, graph } = await scan({
      module: "fixture-lib",
      export: "default",
      entrypoint: STATIC_FIELD_ENTRYPOINT,
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

  it("never substitutes a different PackageInstance for the ambiguous export", async () => {
    const { finding, root } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: STATIC_FIELD_ENTRYPOINT,
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

  it("keeps the later export attributable when the field is an INSTANCE field (the control that makes this sound rather than merely conservative)", async () => {
    // `fixture-lib/instance-field` is `index.js`'s early branch with the
    // `static` modifier removed. Evaluating that class definition installs
    // an initializer and runs nothing, so `module.exports = safeOp` really
    // is reached on every load -- proven in-process in the ground-truth
    // fixture's `c.js`. Treating it like a static field would withdraw
    // authority from an export that is genuinely reached, which is a false
    // refusal rather than conservatism.
    const { finding } = await scan({
      module: "fixture-lib/instance-field",
      export: "default",
      entrypoint: INSTANCE_FIELD_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toMatchObject({
      reachableSubgraphComplete: true,
      target: { module: "fixture-lib/instance-field", export: "default" },
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
