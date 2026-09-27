// SCRATCH AUDIT HARNESS -- P0 soundness closure inventory. Not production,
// not committed. Runs every generated probe fixture through the real
// scan pipeline on current main and reports verdict + Family A/B/C proof.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { buildCallGraph } from "./code-intelligence/call-graph.js";
import { createModuleResolver } from "./code-intelligence/module-resolver.js";
import { loadTsProject } from "./code-intelligence/ts-project.js";
import { buildKnownPackageRoots } from "./domain/resolved-target.js";
import type { VulnerableSymbolRule } from "./domain/target.js";
import type { Vulnerability } from "./domain/vulnerability.js";
import { discoverEntrypoints } from "./analysis/entrypoints.js";
import { buildFindingForTest } from "./testing/finding.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBES = path.join(HERE, "..", ".p0probe", "fixtures3");

interface ManifestEntry {
  readonly id: string;
  readonly endsEval: boolean;
  readonly dir: string;
}

async function scanProbe(root: string) {
  const entry = path.join(root, "src", "index.cjs");
  const resolver = createModuleResolver(loadTsProject(root));
  const knownPackageRoots = buildKnownPackageRoots([], root);

  const [graph, entrypointsResult] = await Promise.all([
    buildCallGraph({ entryFiles: [entry], resolver, knownPackageRoots }),
    discoverEntrypoints({
      projectRoot: root,
      resolver,
      configuredEntrypoints: ["src/index.cjs"],
    }),
  ]);

  const vulnerability: Vulnerability = {
    id: "GHSA-p0-probe",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-p0-probe",
    package: { name: "fixture-lib" },
    targets: [
      { module: "fixture-lib/danger", export: "explode", kind: "function" },
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

describe("P0 closure inventory probes round 3", () => {
  it("scans every probe and reports verdict + proof family", async () => {
    const manifest: ManifestEntry[] = JSON.parse(
      fs.readFileSync(path.join(PROBES, "manifest.json"), "utf-8"),
    );
    const rows: unknown[] = [];

    for (const probe of manifest) {
      const root = path.join(PROBES, probe.id);
      let verdict = "ERROR";
      let familyA = false;
      let familyB = false;
      let familyC = false;
      let complete: unknown = undefined;
      let reason = "";
      try {
        const finding = await scanProbe(root);
        verdict = finding?.verdict ?? "NO_FINDING";
        reason = finding?.reason ?? "";
        const ev = finding?.evidence as Record<string, unknown> | undefined;
        familyA = ev?.confirmedAbsentInstance !== undefined;
        familyB = ev?.packageAbsentFromCallGraph !== undefined;
        familyC = ev?.confirmedUnreachableTarget !== undefined;
        complete = (
          ev?.confirmedUnreachableTarget as Record<string, unknown> | undefined
        )?.reachableSubgraphComplete;
      } catch (err) {
        reason = String((err as Error).message).slice(0, 120);
      }

      // A false NOT_AFFECTED is only possible where runtime says module
      // evaluation ENDED before the later safe export write.
      const unsound = probe.endsEval && verdict === "NOT_AFFECTED";
      rows.push({
        id: probe.id,
        endsEval: probe.endsEval,
        verdict,
        familyA,
        familyB,
        familyC,
        complete,
        unsound,
        reason,
      });
      console.log(
        [
          unsound ? "!!FALSE-NOT_AFFECTED" : "  ok                ",
          probe.id.padEnd(32),
          `endsEval=${String(probe.endsEval).padEnd(5)}`,
          verdict.padEnd(13),
          `A=${familyA ? 1 : 0} B=${familyB ? 1 : 0} C=${familyC ? 1 : 0}`,
          `complete=${String(complete)}`,
          reason.slice(0, 46),
        ].join(" "),
      );
    }

    fs.writeFileSync(
      path.join(PROBES, "..", "analyzer-results3.json"),
      JSON.stringify(rows, null, 2),
    );
    const bad = rows.filter((r) => (r as { unsound: boolean }).unsound);
    console.log(
      `\n${rows.length} probes scanned, ${bad.length} FALSE NOT_AFFECTED`,
    );
  }, 600_000);
});
