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
 * RWF-014's permanent end-to-end regression (see
 * fixtures/commonjs-conditional-whole-module-export/README.md).
 *
 * The fixture's `fixture-lib/index.js` writes `module.exports` from BOTH
 * arms of an `if`/`else`, with a bare identifier on each side. Before
 * RWF-014, `findLastModuleExportsAssignment` kept whichever assignment
 * came LAST in source order (`safeOp`), bound the module's whole exported
 * value to it, and every consumer downstream treated that as the module's
 * identity. The entrypoint's `fixture(input)` call then got a fully
 * RESOLVED edge to `safeOp`, `dangerousOp` was left with no incoming edge
 * at all, and the reachability search over `danger.explode` came back
 * unreachable with a complete subgraph -- a Family C proof, and a false
 * NOT_AFFECTED, for a package that reaches the sink whenever the other
 * branch is taken at runtime.
 *
 * Post-fix the whole-module export is ambiguous, nothing attributes it,
 * and the call becomes an honest `unknown(unresolved_target)` edge -- so
 * the answer is UNKNOWN.
 */

const FIXTURE = "commonjs-conditional-whole-module-export";
const ENTRYPOINT = "src/index.cjs";
/** Reaches only the UNCONDITIONAL whole-module export — see the fixture's README. */
const STABLE_ENTRYPOINT = "src/stable-only.cjs";

async function scan(options: {
  readonly module: string;
  readonly export: string;
  readonly packageInstance?: string;
  readonly entrypoint?: string;
}) {
  const entrypoint = options.entrypoint ?? ENTRYPOINT;
  const root = fixturePath(FIXTURE);
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

  const vulnerability: Vulnerability = {
    id: "GHSA-rwf-014",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-014",
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

describe("RWF-014 fixture: conditional whole-module CommonJS export (fixtures/commonjs-conditional-whole-module-export)", () => {
  it("does not prove the runtime-selected vulnerable branch unreachable -> UNKNOWN", async () => {
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("issues no Family C negative proof for the arbitrarily-selected branch", async () => {
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
    });

    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("attributes no definitive whole-module target to either branch", async () => {
    // The whole-module export itself: neither `dangerousOp` nor `safeOp`
    // may be handed back as "the" exported function.
    const { finding, graph } = await scan({
      module: "fixture-lib",
      export: "default",
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

  it("still proves a genuinely unreachable UNCONDITIONAL whole-module export -> NOT_AFFECTED (Family C control)", async () => {
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

  it("never substitutes a different PackageInstance for the ambiguous export", async () => {
    const root = fixturePath(FIXTURE);
    const { finding } = await scan({
      module: "fixture-lib/danger",
      export: "explode",
      packageInstance: canonicalizePackageInstancePath(
        path.join(
          root,
          "node_modules",
          "elsewhere",
          "node_modules",
          "fixture-lib",
        ),
      ),
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
    expect(finding?.evidence?.path ?? []).toHaveLength(0);
  });
});
