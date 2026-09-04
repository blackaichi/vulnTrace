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
 * RWF-017's permanent end-to-end regression (see
 * fixtures/commonjs-circular-import-initializer-throw-ground-truth/README.md
 * for the real-Node runtime proof that a cyclic `require()` really can
 * retain the earlier, dangerous export this fixture's `bail()` call
 * bypasses).
 *
 * The fixture's `fixture-lib/index.js` is RWF-016's fixture with ONE
 * change: the resolvable, always-throwing local call is not a bare
 * `bail();` expression statement, it is the INITIALIZER of a variable
 * declaration, `const result = bail();`. JavaScript evaluates a
 * declarator's initializer as part of executing the declaration, so
 * reaching the statement necessarily invokes `bail()` and the declaration
 * never completes -- the runtime consequence is identical, and only the
 * syntactic position of the CallExpression differs.
 *
 * RWF-016 recognised the call only in the ExpressionStatement position, so
 * before RWF-017 this file's whole exported value bound to `safeOp`, the
 * entrypoint's `fixture(input)` call got a fully RESOLVED edge to it,
 * `dangerousOp` was left with no incoming edge at all, and the
 * reachability search over `danger.explode` came back unreachable with a
 * complete subgraph -- a Family C proof, and a false NOT_AFFECTED, for a
 * package that reaches the sink on every load that takes the early branch.
 *
 * Post-fix the whole-module export is ambiguous, nothing attributes it,
 * and the call becomes an honest `unknown(unresolved_target)` edge -- so
 * the answer is UNKNOWN.
 */

const FIXTURE = "commonjs-initializer-throwing-call-export-authority";
const INITIALIZER_CALL_ENTRYPOINT = "src/index.cjs";
/** Reaches only the definitely-reached whole-module export — see the fixture's README. */
const STABLE_ENTRYPOINT = "src/stable-only.cjs";

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
    id: "GHSA-rwf-017",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-017",
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

describe("RWF-017 fixture: a resolvable local throwing call in a VARIABLE INITIALIZER bypassing the final whole-module export (fixtures/commonjs-initializer-throwing-call-export-authority)", () => {
  it("does not prove the bypassed vulnerable branch unreachable -> UNKNOWN", async () => {
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: INITIALIZER_CALL_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("issues no Family C negative proof for the branch that survived to the end of the file", async () => {
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: INITIALIZER_CALL_ENTRYPOINT,
    });

    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("attributes no definitive whole-module target to either branch", async () => {
    const { finding, graph } = await scan({
      module: "fixture-lib",
      export: "default",
      entrypoint: INITIALIZER_CALL_ENTRYPOINT,
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
      entrypoint: INITIALIZER_CALL_ENTRYPOINT,
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
