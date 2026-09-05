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
 * RWF-019's permanent end-to-end regression (see
 * fixtures/commonjs-circular-import-computed-class-key-throw-ground-truth/README.md
 * for the real-Node runtime proof that a cyclic `require()` really can
 * retain the earlier, dangerous export this fixture's `bail()` call
 * bypasses -- and, in the same process, that the DEFERRED controls
 * genuinely do NOT bypass it).
 *
 * The fixture's `fixture-lib/index.js` is RWF-016/017/018's fixture with
 * the call moved into the one position none of them models: a class
 * element's COMPUTED KEY, on an element carrying no `static` modifier. A
 * computed property name is evaluated by ClassDefinitionEvaluation as each
 * element is defined, because installing the element needs a property key
 * -- so reaching the class necessarily invokes `bail()` and the class
 * definition never completes. `fixture-lib/method-key.js` holds the same
 * defect on a METHOD, where the value AND the body are both deferred and
 * only the key runs.
 *
 * RWF-016 recognised the call as an ExpressionStatement, RWF-017 as a
 * VariableStatement and RWF-018 as a static field INITIALIZER, so before
 * RWF-019 both files' whole exported value bound to `safeOp`, the
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

const FIXTURE = "commonjs-computed-class-key-throwing-call-export-authority";
const COMPUTED_KEY_ENTRYPOINT = "src/index.cjs";
/** Reaches only the definitely-reached whole-module export — see the fixture's README. */
const STABLE_ENTRYPOINT = "src/stable-only.cjs";
/** Reaches only the DEFERRED-context control, for the same subgraph-completeness reason. */
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
    id: "GHSA-rwf-019",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-019",
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

describe("RWF-019 fixture: a resolvable local throwing call in a class element's COMPUTED KEY bypassing the final whole-module export (fixtures/commonjs-computed-class-key-throwing-call-export-authority)", () => {
  it("does not prove the bypassed vulnerable branch unreachable -> UNKNOWN", async () => {
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: COMPUTED_KEY_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("issues no Family C negative proof for the branch that survived to the end of the file", async () => {
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: COMPUTED_KEY_ENTRYPOINT,
    });

    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("attributes no definitive whole-module target to either branch", async () => {
    const { finding, graph } = await scan({
      module: "fixture-lib",
      export: "default",
      entrypoint: COMPUTED_KEY_ENTRYPOINT,
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

  it("attributes no definitive whole-module target when the computed key sits on a METHOD (the value AND the body are deferred; only the key runs)", async () => {
    const { finding } = await scan({
      module: "fixture-lib/method-key",
      export: "default",
      entrypoint: COMPUTED_KEY_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("never substitutes a different PackageInstance for the ambiguous export", async () => {
    const { finding, root } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: COMPUTED_KEY_ENTRYPOINT,
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

  it("keeps the later export attributable when the call sits in genuinely DEFERRED positions (the control that makes this sound rather than merely conservative)", async () => {
    // `fixture-lib/deferred-key` holds the identical call in an instance
    // field's VALUE and in a class defined inside a never-called function.
    // Neither runs during module evaluation, so `module.exports = safeOp`
    // really is reached on every load -- proven in-process in the
    // ground-truth fixture's `c.js`. Treating either like a computed key
    // would withdraw authority from an export that is genuinely reached,
    // which is a false refusal rather than conservatism.
    const { finding } = await scan({
      module: "fixture-lib/deferred-key",
      export: "default",
      entrypoint: DEFERRED_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toMatchObject({
      reachableSubgraphComplete: true,
      target: { module: "fixture-lib/deferred-key", export: "default" },
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
