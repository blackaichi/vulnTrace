// SCRATCH AUDIT HARNESS -- PackageInstance discipline check.
// Every round-3 fixture installs a duplicate same-name/same-version TWIN
// under node_modules/elsewhere/node_modules/fixture-lib that is never
// required. A proof about the REACHED instance must never be reported for
// the twin, and vice versa -- no name/version-only reasoning.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { buildCallGraph } from "./code-intelligence/call-graph.js";
import { createModuleResolver } from "./code-intelligence/module-resolver.js";
import { loadTsProject } from "./code-intelligence/ts-project.js";
import {
  buildKnownPackageRoots,
  canonicalizePackageInstancePath,
} from "./domain/resolved-target.js";
import type { VulnerableSymbolRule } from "./domain/target.js";
import type { Vulnerability } from "./domain/vulnerability.js";
import { discoverEntrypoints } from "./analysis/entrypoints.js";
import { buildFindingForTest } from "./testing/finding.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBES = path.join(HERE, "..", ".p0probe", "fixtures3");

async function scan(root: string, packageInstance?: string) {
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
    packageInstance,
    matchResult: "affected",
    rule,
    graph,
    entrypoints: entrypointsResult.entrypoints,
    resolver,
    projectRoot: root,
    knownPackageRoots,
  });
}

describe("PackageInstance discipline", () => {
  it("never reports the reached instance's proof for the unreached twin", async () => {
    const manifest: { id: string }[] = JSON.parse(
      fs.readFileSync(path.join(PROBES, "manifest.json"), "utf-8"),
    );
    for (const probe of manifest) {
      const root = path.join(PROBES, probe.id);
      const reached = canonicalizePackageInstancePath(
        path.join(root, "node_modules", "fixture-lib"),
      );
      const twin = canonicalizePackageInstancePath(
        path.join(
          root,
          "node_modules",
          "elsewhere",
          "node_modules",
          "fixture-lib",
        ),
      );
      const [a, b, c] = await Promise.all([
        scan(root),
        scan(root, reached),
        scan(root, twin),
      ]);
      const fam = (f: Awaited<ReturnType<typeof scan>>) => {
        const ev = f?.evidence as Record<string, unknown> | undefined;
        return [
          ev?.confirmedAbsentInstance !== undefined ? "A" : "-",
          ev?.packageAbsentFromCallGraph !== undefined ? "B" : "-",
          ev?.confirmedUnreachableTarget !== undefined ? "C" : "-",
        ].join("");
      };
      console.log(
        [
          probe.id.padEnd(34),
          `noInstance=${(a?.verdict ?? "NO_FINDING").padEnd(13)}${fam(a)}`,
          `reached=${(b?.verdict ?? "NO_FINDING").padEnd(13)}${fam(b)}`,
          `TWIN=${(c?.verdict ?? "NO_FINDING").padEnd(13)}${fam(c)}`,
          `twinReason=${(c?.reason ?? "").slice(0, 44)}`,
        ].join(" "),
      );
    }
  }, 600_000);
});
