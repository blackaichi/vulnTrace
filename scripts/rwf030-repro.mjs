/**
 * RWF-030 canonical reproduction probe.
 *
 * Scans one fixture entrypoint against one advisory target and prints the
 * verdict plus the resolved evidence path, so the false `AFFECTED` (an
 * advisory naming the package's PUBLIC `vulnerable` answered with an
 * unrelated same-named SIBLING) can be reproduced on any checkout without
 * a test harness.
 *
 * Usage:
 *   node scripts/rwf030-repro.mjs <fixtureDir> <entrypoint> <package> <export> [instance]
 */
import path from "node:path";
import { buildCallGraph } from "../dist/code-intelligence/call-graph.js";
import { createModuleResolver } from "../dist/code-intelligence/module-resolver.js";
import { loadTsProject } from "../dist/code-intelligence/ts-project.js";
import { buildKnownPackageRoots } from "../dist/domain/resolved-target.js";
import { discoverEntrypoints } from "../dist/analysis/entrypoints.js";
import { buildFinding } from "../dist/analysis/verdict.js";
import { createAnalysisProofContext } from "../dist/analysis/analysis-context.js";

const [fixtureDir, entrypoint, packageName, exportName, instance] =
  process.argv.slice(2);

const root = path.resolve(fixtureDir);
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

const finding = await buildFinding({
  vulnerability: {
    id: "GHSA-rwf-030-probe",
    aliases: [],
    package: packageName,
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  },
  packageName,
  packageVersion: "1.0.0",
  packageInstance: instance
    ? path.join(root, "node_modules", ...instance.split("/"))
    : undefined,
  matchResult: "affected",
  rule: {
    id: "GHSA-rwf-030-probe",
    package: { name: packageName },
    targets: [{ module: packageName, export: exportName, kind: "function" }],
  },
  context: createAnalysisProofContext({
    projectRoot: root,
    resolver,
    entrypoints: entrypointsResult.entrypoints,
    knownPackageRoots,
    graph,
  }),
});

console.log(
  JSON.stringify(
    {
      verdict: finding?.verdict ?? "NO_FINDING",
      reason: finding?.reason,
      path: (finding?.evidence?.path ?? []).map((p) =>
        p.replace(root + path.sep, ""),
      ),
    },
    null,
    2,
  ),
);
