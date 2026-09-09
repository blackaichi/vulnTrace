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
 * RWF-025's permanent end-to-end regression.
 *
 * RWF-016 through RWF-024 all rest on the same callee-identity question:
 * is the name `bail` at the call site still the module-top-level `function
 * bail` this file can read a body out of? That is answered from a set of
 * names reassigned anywhere module evaluation can reach, cached per SOURCE
 * FILE.
 *
 * The collector filling that set used to record EVERY identifier under an
 * assignment target. An assignment target's AST also contains expressions
 * that are merely EVALUATED while the target is resolved:
 *
 * ```js
 * ({ [keyFor(bail)]: seen } = REGISTRY);   // rebinds `seen`, and only `seen`
 * REGISTRY[keyFor(bail)] = "installed";    // rebinds NOTHING local
 * ```
 *
 * so `bail` was recorded as locally reassigned. Because the set is cached
 * per source file, ONE such statement -- anywhere in the file, arbitrarily
 * far from the vulnerable path, and semantically unrelated to it --
 * withdrew every abrupt-completion cutoff for that name across the WHOLE
 * file. `module.exports = safeOp` regained an authority it does not have,
 * `dangerousOp` was left with no incoming edge, and the search over
 * `danger.explode` came back unreachable with a complete subgraph: a
 * Family C proof, and a false NOT_AFFECTED, for a package that reaches the
 * sink on every load that takes the early branch.
 *
 * The runtime facts this rests on are asserted in-process by real `node`
 * in fixtures/destructuring-computed-key-assignment-target-ground-truth/
 * (see its README for the seven measured rows and the circular-import
 * proof). With `FIXTURE_LIB_MODE=fast` both poisoned modules here throw
 * DURING module evaluation, so `module.exports = safeOp` never runs --
 * while `rebound.js`, where `bail` is GENUINELY replaced by a destructuring
 * assignment, completes normally, which is exactly why its cutoff must stay
 * withdrawn.
 *
 * Nothing about callee-body proof, cutoff position, negative-proof
 * semantics or package identity is re-derived here.
 */

const FIXTURE =
  "commonjs-destructuring-computed-key-reassignment-cache-poisoning";
const POISONED_ENTRYPOINT = "src/index.cjs";
/** Reaches only the definitely-reached whole-module export — the Family C control. */
const STABLE_ENTRYPOINT = "src/stable-only.cjs";
/** Reaches only the module where `bail` is GENUINELY rebound, for the same subgraph-completeness reason. */
const REBOUND_ENTRYPOINT = "src/rebound-only.cjs";

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
    id: "GHSA-rwf-025",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-025",
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

describe("RWF-025 fixture: an unrelated computed-key assignment target no longer withdraws a merged cutoff (fixtures/commonjs-destructuring-computed-key-reassignment-cache-poisoning)", () => {
  it("does not prove the bypassed vulnerable branch unreachable -> UNKNOWN", async () => {
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: POISONED_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("issues no Family C negative proof for the branch that survived to the end of the file", async () => {
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: POISONED_ENTRYPOINT,
    });

    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("attributes no definitive whole-module target to the DESTRUCTURING-poisoned module", async () => {
    const { finding } = await scan({
      module: "fixture-lib",
      export: "default",
      entrypoint: POISONED_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("attributes no definitive whole-module target to the ELEMENT-ACCESS-poisoned module", async () => {
    const { finding } = await scan({
      module: "fixture-lib/element-key",
      export: "default",
      entrypoint: POISONED_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("puts neither branch of the poisoned module on the evidence path", async () => {
    const { finding, graph } = await scan({
      module: "fixture-lib",
      export: "default",
      entrypoint: POISONED_ENTRYPOINT,
    });

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

  it("keeps the later export attributable where `bail` is GENUINELY rebound by a destructuring assignment (the false-AFFECTED control)", async () => {
    // `fixture-lib/rebound.js` replaces `bail` through `({ bail } =
    // HANDLERS)` -- a real assignment destination, right beside an
    // unrelated computed-key statement. Real `node` confirms that module
    // completes normally even in fast mode, so refusing the cutoff there
    // is correct, not conservative. Narrowing WHICH identifiers a target
    // contributes must not drop the genuine one.
    const { finding } = await scan({
      module: "fixture-lib/rebound",
      export: "default",
      entrypoint: REBOUND_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toMatchObject({
      reachableSubgraphComplete: true,
      target: { module: "fixture-lib/rebound", export: "default" },
    });
  });

  it("never substitutes a different PackageInstance for the ambiguous export", async () => {
    const { finding, root } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      entrypoint: POISONED_ENTRYPOINT,
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
    // `fixture-lib/stable.js` carries a computed-key destructuring
    // statement of exactly the shape this task stops recording, and its
    // export is still a fact. The control must keep working, or this task
    // would have bought its soundness by disabling negative proofs.
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
