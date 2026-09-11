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
 * P0-Z remediation SELF-REVIEW, pinned by execution.
 *
 * Each case is one way this fix could have been wrong, written as a test
 * rather than argued in a comment. They are deliberately NOT new mechanism
 * -- every one of them exercises the shipped behavior from the outside.
 */

async function scan(options: {
  readonly fixture: string;
  readonly entrypoint: string;
  readonly package: string;
  readonly export: string;
}) {
  const root = fixturePath(options.fixture);
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
    id: "GHSA-p0z-self-review",
    aliases: [],
    package: options.package,
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-p0z-self-review",
    package: { name: options.package },
    targets: [
      { module: options.package, export: options.export, kind: "function" },
    ],
  };

  return buildFindingForTest({
    vulnerability,
    packageName: options.package,
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

const FIXTURE = "entrypoint-reexport-root-completeness";

describe("P0-Z self-review: the ways this fix could have been wrong", () => {
  it("A. an unresolved re-export is NOT still treated as zero roots", async () => {
    const finding = await scan({
      fixture: FIXTURE,
      entrypoint: "src/whole-module.cjs",
      package: "fixture-lib",
      export: "dangerousOp",
    });

    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("B. a no-export entrypoint is NOT falsely marked incomplete", async () => {
    const finding = await scan({
      fixture: FIXTURE,
      entrypoint: "src/no-callable-export.cjs",
      package: "fixture-lib",
      export: "neverCalled",
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
  });

  it("C. a direct local export is NOT unnecessarily degraded", async () => {
    const finding = await scan({
      fixture: FIXTURE,
      entrypoint: "src/direct.cjs",
      package: "fixture-lib",
      export: "dangerousOp",
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("D. Family C is NOT globally disabled", async () => {
    const finding = await scan({
      fixture: FIXTURE,
      entrypoint: "src/valid-family-c.cjs",
      package: "fixture-lib",
      export: "neverCalled",
    });

    expect(finding?.evidence?.confirmedUnreachableTarget).toMatchObject({
      reachableSubgraphComplete: true,
    });
  });

  it("E. no unrelated top-level callable is accidentally rooted (RWF-021's own guard)", async () => {
    // RWF-021's false-AFFECTED control, re-run here: this fix must not have
    // reintroduced over-rooting as a way of covering the root gap.
    const finding = await scan({
      fixture: "commonjs-entrypoint-root-widening",
      entrypoint: "src/never-exported.cjs",
      package: "fixture-lib",
      export: "dangerousOp",
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
  });

  it("F. ESM export * is NOT treated as complete without evidence", async () => {
    const finding = await scan({
      fixture: FIXTURE,
      entrypoint: "src/export-star.mjs",
      package: "fixture-lib",
      export: "dangerousOp",
    });

    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("G. a package re-export does not certify absence of the package it hands out", async () => {
    const finding = await scan({
      fixture: FIXTURE,
      entrypoint: "src/package-reexport.cjs",
      package: "fixture-lib",
      export: "dangerousOp",
    });

    expect(finding?.verdict).not.toBe("NOT_AFFECTED");
  });

  it("H. a CHAINED re-export does not silently drop the incompleteness", async () => {
    const finding = await scan({
      fixture: FIXTURE,
      entrypoint: "src/chained.cjs",
      package: "fixture-lib",
      export: "dangerousOp",
    });

    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("I. RWF-021's stale-root bug is not reintroduced", async () => {
    const finding = await scan({
      fixture: "commonjs-entrypoint-root-widening",
      entrypoint: "src/reassigned.cjs",
      package: "fixture-lib",
      export: "dangerousOp",
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
  });

  it("J. RWF-021's widened roots still find the real path", async () => {
    const finding = await scan({
      fixture: "commonjs-entrypoint-root-widening",
      entrypoint: "src/rwf016.cjs",
      package: "fixture-lib",
      export: "dangerousOp",
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("K. the new mechanism never asserts reachability -- it degrades, never invents", async () => {
    // Every blocker form must land on UNKNOWN or AFFECTED-by-real-evidence,
    // never a fabricated AFFECTED. `whole-module.cjs` has no resolved call
    // path in the graph, so the honest answer is UNKNOWN, not AFFECTED.
    const finding = await scan({
      fixture: FIXTURE,
      entrypoint: "src/whole-module.cjs",
      package: "fixture-lib",
      export: "dangerousOp",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.path ?? []).toEqual([]);
  });

  it("L. root incompleteness does not disturb a Family A module-load proof", async () => {
    // `direct.cjs` never loads `absent-lib` at all, so family A's proof is
    // available and must be unaffected by anything this fix added. A
    // package that is not installed yields no finding at all; the point of
    // the assertion is that the entrypoint's own root handling did not
    // convert a non-family-C route into an UNKNOWN with a root reason.
    const finding = await scan({
      fixture: FIXTURE,
      entrypoint: "src/direct.cjs",
      package: "fixture-lib",
      export: "neverCalled",
    });

    // Roots ARE derivable here, so family C remains available -- the proof
    // families are decided by their own preconditions, not by this fix.
    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeDefined();
  });
});
