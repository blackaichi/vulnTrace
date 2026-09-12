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
 * P0-Z's permanent end-to-end regression: an entrypoint whose exported
 * behavior cannot be turned into concrete reachability roots must never
 * produce a Family C negative proof.
 *
 * The P0-Z audit reproduced SIX false NOT_AFFECTED verdicts sharing one
 * root cause. Each fixture entrypoint here re-exports a callable that
 * reaches the vulnerable sink; `verify.cjs` proves with real Node that the
 * callable is genuinely published and genuinely reaches it. Before the fix
 * the re-export contributed no local root, `analyzeReachability` searched
 * from the `<module>` node alone, met no unresolved edge, and the finding
 * carried `confirmedUnreachableTarget.reachableSubgraphComplete: true` --
 * a complete proof over a subgraph that was never correctly rooted.
 *
 * The controls are what make this a fix rather than a blanket disabling of
 * negative proofs: `direct.cjs` must still be AFFECTED, and
 * `valid-family-c.cjs` must still produce a real, complete Family C proof.
 */

const FIXTURE = "entrypoint-reexport-root-completeness";

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
    id: "GHSA-p0z-reexport-root",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-p0z-reexport-root",
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

/** The six audit forms, plus the chained variant P0-Z's blast radius found. */
const BLOCKER_FORMS: ReadonlyArray<readonly [string, string]> = [
  ["B1 whole-module CJS re-export", "src/whole-module.cjs"],
  ["B2 Object.assign export forwarding", "src/object-assign.cjs"],
  ["B3 CJS property re-export", "src/property.cjs"],
  ["B4 ESM named re-export", "src/named-reexport.mjs"],
  ["B5 ESM export *", "src/export-star.mjs"],
  ["B7 package re-export", "src/package-reexport.cjs"],
  ["two-hop re-export chain", "src/chained.cjs"],
  // Found by this remediation's own mutation matrix: not a re-export at
  // all, but the identical root loss -- a LOCAL callable published under a
  // name only the runtime knows. Confirmed a live false NOT_AFFECTED with
  // a complete Family C proof before the fix.
  ["dynamic computed export name", "src/computed-key.cjs"],
  // Found by the focused re-audit: not a re-export, and not dynamic --
  // a LOCAL callable under a statically exact bracket key, which
  // `describeCommonJsExportTarget` never modeled at all.
  ["literal bracket export", "src/literal-bracket.cjs"],
  ["bracket RE-export", "src/bracket-reexport.cjs"],
  ["dynamic bracket export", "src/dynamic-bracket.cjs"],
  // P0-Z round 3: not a re-export and not a bracket key -- a plain
  // exported local ALIAS, whose candidate name never matched a callable.
  ["exported local alias", "src/alias-export.cjs"],
  ["REASSIGNED exported alias", "src/alias-reassigned.cjs"],
];

describe("P0-Z: an unrootable entrypoint export must not yield a Family C proof", () => {
  for (const [label, entrypoint] of BLOCKER_FORMS) {
    it(`issues no Family C negative proof for ${label}`, async () => {
      const finding = await scan({ entrypoint, export: "dangerousOp" });
      expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
    });

    it(`never reports NOT_AFFECTED for the runtime-reachable target via ${label}`, async () => {
      const finding = await scan({ entrypoint, export: "dangerousOp" });
      // `verify.cjs` proves with real Node that this target IS reached.
      expect(finding?.verdict).not.toBe("NOT_AFFECTED");
    });

    it(`states the ROOT gap, not a phantom unresolved edge, for ${label}`, async () => {
      const finding = await scan({ entrypoint, export: "dangerousOp" });
      // The uncertainty must be reported at the layer it actually lives
      // at: we do not know the ROOT, not "we met an unresolved call edge".
      if (finding?.verdict === "UNKNOWN") {
        expect(finding.evidence?.reasons?.join(" ")).toMatch(
          /root|reexport|re-export|forwarding/i,
        );
      }
    });
  }
});

describe("P0-Z: the controls that make this a fix rather than a blanket refusal", () => {
  it("keeps the DIRECT export's behavior unchanged -- roots derived, path found", async () => {
    const finding = await scan({
      entrypoint: "src/direct.cjs",
      export: "dangerousOp",
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("still issues a genuine, complete Family C proof when roots ARE derivable", async () => {
    const finding = await scan({
      entrypoint: "src/valid-family-c.cjs",
      export: "neverCalled",
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toMatchObject({
      target: { module: "fixture-lib", export: "neverCalled" },
      reachableSubgraphComplete: true,
    });
  });

  it("does not mark an entrypoint with NO callable export incomplete", async () => {
    // "There is no root" is a complete answer and must stay one, or the
    // fix would destroy valid negative proofs wholesale.
    const finding = await scan({
      entrypoint: "src/no-callable-export.cjs",
      export: "neverCalled",
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeDefined();
  });

  it("still issues Family C when an exported ALIAS resolves to a concrete root", async () => {
    // P0-Z round 3's key control: alias support must not globally force
    // UNKNOWN. The alias materializes, so the derivation is complete and
    // the genuinely-unreachable target keeps its real proof.
    const finding = await scan({
      entrypoint: "src/alias-safe.cjs",
      export: "neverCalled",
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toMatchObject({
      reachableSubgraphComplete: true,
    });
  });

  it("finds the real path through an exported alias (AFFECTED, not merely non-C)", async () => {
    const finding = await scan({
      entrypoint: "src/alias-export.cjs",
      export: "dangerousOp",
    });

    expect(finding?.verdict).toBe("AFFECTED");
    // Positive evidence, not an absence: a concrete reachable path.
    expect((finding?.evidence?.path ?? []).length).toBeGreaterThan(0);
  });

  it("does not treat a READ of the export object as export forwarding", async () => {
    const finding = await scan({
      entrypoint: "src/export-read-only.cjs",
      export: "neverCalled",
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeDefined();
  });
});
