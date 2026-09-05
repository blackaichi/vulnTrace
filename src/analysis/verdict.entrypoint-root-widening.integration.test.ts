import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import { buildKnownPackageRoots } from "../domain/resolved-target.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { fixturePath } from "../testing/fixtures.js";
import { discoverEntrypoints } from "./entrypoints.js";
import { buildFindingForTest } from "../testing/finding.js";

/**
 * RWF-021's permanent end-to-end regression.
 *
 * Every entrypoint in this fixture reaches the vulnerable sink through its
 * OWN exported function and never from module-scope code, so entrypoint
 * ROOT selection is the only thing standing between the analyzer and the
 * truth. Each cutoff-family file additionally places a soundness cutoff
 * (RWF-016/017/018/019's shapes) above its export write, which correctly
 * withdraws export ATTRIBUTION.
 *
 * Before RWF-021 the root was read out of that same attribution
 * (`exp.localName ?? exp.exportedName`), so withdrawing it deleted the
 * root: `main`'s body was never traversed, the sink came back unreachable,
 * and the finding carried a COMPLETE Family C proof — a false NOT_AFFECTED
 * for a module that, on every run where the branch is not taken, really
 * does export `main` and really does reach the sink. Verified on
 * `8d18130` (current main, RWF-019 merged) for all four families.
 *
 * Post-fix, uncertainty widens the root set instead of emptying it, the
 * real `main -> dep.dangerousOp` path is found, and the answer is
 * AFFECTED. The two controls are what make that a fix rather than a
 * blanket disabling of negative proofs: `precise.cjs` must keep its
 * unchanged precise behavior, and `unreachable.cjs` — whose authority is
 * withdrawn and whose roots therefore widen — must still produce a
 * genuine, complete Family C NOT_AFFECTED for a target none of its
 * callables reaches.
 */

const FIXTURE = "commonjs-entrypoint-root-widening";

async function scan(options: {
  readonly entrypoint: string;
  readonly export: string;
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
    id: "GHSA-rwf-021",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-021",
    package: { name: "fixture-lib" },
    targets: [
      { module: "fixture-lib", export: options.export, kind: "function" },
    ],
  };

  return buildFindingForTest({
    vulnerability,
    packageName: "fixture-lib",
    packageVersion: "1.0.0",
    matchResult: "affected",
    rule,
    graph,
    entrypoints: entrypointsResult.entrypoints,
    resolver,
    projectRoot: root,
    knownPackageRoots,
  });
}

describe("RWF-021: withdrawing export attribution must not delete the entrypoint's reachability root", () => {
  const families: ReadonlyArray<readonly [string, string]> = [
    ["RWF-016 (bare `bail();`)", "src/rwf016.cjs"],
    ["RWF-017 (`const unused = bail();`)", "src/rwf017.cjs"],
    ["RWF-018 (`static ready = bail();`)", "src/rwf018.cjs"],
    ["RWF-019 (`[bail()] = 1`)", "src/rwf019.cjs"],
  ];

  for (const [label, entrypoint] of families) {
    it(`finds the real path through the exported function for ${label}`, async () => {
      const finding = await scan({ entrypoint, export: "dangerousOp" });
      expect(finding?.verdict).toBe("AFFECTED");
    });

    it(`issues no Family C negative proof for ${label}`, async () => {
      const finding = await scan({ entrypoint, export: "dangerousOp" });
      expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
    });
  }

  it("finds the path for a PROPERTY export whose provenance was withdrawn", async () => {
    const finding = await scan({
      entrypoint: "src/property.cjs",
      export: "dangerousOp",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("finds the path for an ANONYMOUS exported callable, rooted by position", async () => {
    const finding = await scan({
      entrypoint: "src/anonymous.cjs",
      export: "dangerousOp",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });
});

describe("RWF-021: the controls that make this a fix rather than a blanket refusal", () => {
  it("keeps the PRECISE export's behavior unchanged -- authority intact, nothing widens", async () => {
    const finding = await scan({
      entrypoint: "src/precise.cjs",
      export: "dangerousOp",
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("still proves a genuinely unreachable target NOT_AFFECTED even though roots WIDENED", async () => {
    // `unreachable.cjs` has its authority withdrawn, so its roots widen to
    // every top-level callable it declares -- and none of them reaches
    // `neverCalled`. Widening must not cost a real negative proof.
    const finding = await scan({
      entrypoint: "src/unreachable.cjs",
      export: "neverCalled",
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toMatchObject({
      reachableSubgraphComplete: true,
      target: { module: "fixture-lib", export: "neverCalled" },
    });
  });
});
