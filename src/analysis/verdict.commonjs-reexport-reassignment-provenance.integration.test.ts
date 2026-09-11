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
 * RWF-025b's permanent end-to-end regression (see
 * fixtures/commonjs-reexport-computed-key-reassignment-provenance/README.md
 * for the measured runtime ground truth).
 *
 * `commonjs-reexports.ts` decided which names a file WRITES TO with a
 * `ts.forEachChild(target, markAssigned)` fallback that recorded every
 * identifier under an assignment target — including the ones a computed
 * key or an element-access index merely READS. That set is the file's
 * authoritative negative provenance and is cached per source file, so one
 * line of unrelated telemetry bookkeeping withdrew a real `./lib`
 * re-export origin across the whole facade, and the vulnerable export
 * stopped resolving to the function the package actually publishes.
 *
 * The direction is precision-only and is asserted as such below: the
 * poisoned scan was UNKNOWN, never NOT_AFFECTED, because an unattributable
 * export is an unresolved target and an unresolved target puts an
 * `unknown(unresolved_target)` edge in the graph — which is exactly what
 * forecloses the complete-subgraph proof Family C requires.
 *
 * Nothing about negative-proof semantics, package identity or the
 * re-export SHAPES themselves is re-derived here; those are RWF-004a/b's
 * and are covered by verdict.commonjs-reexport.integration.test.ts.
 */

const FIXTURE = "commonjs-reexport-computed-key-reassignment-provenance";
/** Calls the export the bookkeeping poisoned. */
const POISONED_ENTRYPOINT = "src/index.cjs";
/** Reaches only `safe`, so a cleanly-attributed `unused` stays provably unreachable. */
const FAMILY_C_ENTRYPOINT = "src/safe-only.cjs";
/** Reaches the export the facade GENUINELY reassigns. */
const REBOUND_ENTRYPOINT = "src/rebound-only.cjs";

async function scan(options: {
  readonly target: string;
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
    id: "GHSA-rwf-025b",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-025b",
    package: { name: "fixture-lib" },
    targets: [
      { module: "fixture-lib", export: options.target, kind: "function" },
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

describe("RWF-025b fixture: computed-key/element-index reads no longer withdraw a CommonJS re-export origin", () => {
  it("resolves the poisoned export and reports the runtime truth, AFFECTED", async () => {
    // Before RWF-025b this was UNKNOWN: `vulnerable` appeared in the
    // facade's `reassignedNames` purely because two statements named it
    // inside evaluated-only positions, so `exports.vulnerable = vulnerable`
    // carried no origin and the hop into ./lib became an unresolved target.
    const { finding } = await scan({
      target: "vulnerable",
      entrypoint: POISONED_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("the correction never points at NOT_AFFECTED — the precision-only direction, asserted", async () => {
    // The single assertion the soundness classification rests on. Restoring
    // attribution only ever turns an UNKNOWN edge into a resolved one; it
    // withdraws no edge, so it cannot complete a subgraph by subtraction.
    const { finding } = await scan({
      target: "vulnerable",
      entrypoint: POISONED_ENTRYPOINT,
    });

    expect(finding?.verdict).not.toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("keeps a valid, complete Family C proof exactly as it was", async () => {
    // `unused` is cleanly attributed before AND after — it never appears in
    // the bookkeeping — and no entrypoint reaches it. The proof over it is
    // unchanged by RWF-025b, which is the point of the control.
    const { finding } = await scan({
      target: "unused",
      entrypoint: FAMILY_C_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeDefined();
  });

  it("still refuses an export the facade GENUINELY reassigns, in the same evaluated position", async () => {
    // `REGISTRY[(rebound = require("./lib").reboundReplacement)] = true` is
    // a real write written inside exactly the element-access index the fix
    // stops walking blindly. Losing it would re-open RWF-013: `rebound`
    // would be attributed to `reboundOriginal`, which the package does not
    // export. UNKNOWN is the honest answer.
    const { finding } = await scan({
      target: "rebound",
      entrypoint: REBOUND_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("the unpoisoned sibling export is unaffected either way — the shape is not what differed", async () => {
    const { finding } = await scan({
      target: "safe",
      entrypoint: FAMILY_C_ENTRYPOINT,
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("binds the target inside the right PackageInstance", async () => {
    const root = fixturePath(FIXTURE);
    const instance = canonicalizePackageInstancePath(
      path.join(root, "node_modules", "fixture-lib"),
    );
    const { finding } = await scan({
      target: "vulnerable",
      entrypoint: POISONED_ENTRYPOINT,
      packageInstance: instance,
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });
});
