/**
 * RWF-030 differential matrix.
 *
 * Runs every case of fixtures/authoritative-public-entry through the built
 * analyzer and prints one line per case: verdict, and the last node of the
 * evidence path (the resolved target). Run it on merged main and on the
 * branch to get the verdict differential.
 *
 * Usage: node scripts/rwf030-matrix.mjs [--json]
 */
import path from "node:path";
import { buildCallGraph } from "../dist/code-intelligence/call-graph.js";
import { createModuleResolver } from "../dist/code-intelligence/module-resolver.js";
import { loadTsProject } from "../dist/code-intelligence/ts-project.js";
import { buildKnownPackageRoots } from "../dist/domain/resolved-target.js";
import { discoverEntrypoints } from "../dist/analysis/entrypoints.js";
import { buildFinding } from "../dist/analysis/verdict.js";
import { createAnalysisProofContext } from "../dist/analysis/analysis-context.js";

const CASES = [
  ["publicsafe", "src/publicsafe-consumer.cjs", "publicsafe-lib", "publicsafe-lib"],
  ["publicvuln", "src/publicvuln-consumer.cjs", "publicvuln-lib", "publicvuln-lib"],
  ["directpub", "src/directpub-consumer.cjs", "directpub-lib", "directpub-lib"],
  ["missing", "src/missing-consumer.cjs", "missing-lib", "missing-lib"],
  ["multisibling", "src/multisibling-consumer.cjs", "multisibling-lib", "multisibling-lib"],
  ["renamesafe", "src/renamesafe-consumer.cjs", "renamesafe-lib", "renamesafe-lib"],
  ["unreachvuln", "src/unreachvuln-consumer.cjs", "unreachvuln-lib", "unreachvuln-lib"],
  ["dupwrite", "src/dupwrite-consumer.cjs", "dupwrite-lib", "dupwrite-lib"],
  ["dupreverse", "src/dupreverse-consumer.cjs", "dupreverse-lib", "dupreverse-lib"],
  ["condpublic", "src/condpublic-consumer.cjs", "condpublic-lib", "condpublic-lib"],
  ["dynpublic", "src/dynpublic-consumer.cjs", "dynpublic-lib", "dynpublic-lib"],
  ["mainfield", "src/mainfield-consumer.cjs", "mainfield-lib", "mainfield-lib"],
  ["deep", "src/deep-consumer.cjs", "deep-lib", "deep-lib"],
  ["crosspub", "src/crosspub-consumer.cjs", "crosspub-lib", "crosspub-lib"],
  ["twin-top", "src/twin-consumer.cjs", "twinpub-lib", "twinpub-lib"],
  ["twin-nested", "src/twin-consumer.cjs", "twinpub-lib", "wrap-lib/node_modules/twinpub-lib"],
  ["esmpub", "src/esmpub-consumer.mjs", "esmpub-lib", "esmpub-lib"],
];

const root = path.resolve("fixtures/authoritative-public-entry");
const results = [];

for (const [id, entrypoint, packageName, instance] of CASES) {
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
      id: "GHSA-rwf-030-matrix",
      aliases: [],
      package: packageName,
      ecosystem: "npm",
      affectedVersions: [{ introduced: "0" }],
      fixedVersions: [],
      references: [],
    },
    packageName,
    packageVersion: "1.0.0",
    packageInstance: path.join(root, "node_modules", ...instance.split("/")),
    matchResult: "affected",
    rule: {
      id: "GHSA-rwf-030-matrix",
      package: { name: packageName },
      targets: [{ module: packageName, export: "vulnerable", kind: "function" }],
    },
    context: createAnalysisProofContext({
      projectRoot: root,
      resolver,
      entrypoints: entrypointsResult.entrypoints,
      knownPackageRoots,
      graph,
    }),
  });

  const evidencePath = (finding?.evidence?.path ?? []).map((p) =>
    p.replace(root + path.sep, ""),
  );
  results.push({
    id,
    verdict: finding?.verdict ?? "NO_FINDING",
    target: evidencePath.at(-1) ?? "",
    reason: finding?.reason ?? "",
  });
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    console.log(
      `${r.id.padEnd(14)} ${r.verdict.padEnd(13)} ${r.target || "(no path)"}`,
    );
  }
}
