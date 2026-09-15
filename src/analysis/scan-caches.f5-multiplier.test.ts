import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildDependencyGraph } from "../dependencies/dependency-graph.js";
import { loadPackageJsonFile } from "../dependencies/package-json.js";
import { loadPackageLockFile } from "../dependencies/package-lock.js";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import {
  buildKnownPackageRoots,
  createScanModuleIdentityCache,
} from "../domain/resolved-target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import { discoverEntrypoints } from "./entrypoints.js";
import { buildGateEligibleModuleLoadClosure } from "./module-load-closure.js";
import { createAnalysisProofContext } from "./analysis-context.js";
import { buildFinding } from "./verdict.js";

/**
 * FOUNDATION F5 — THE MULTIPLIER GATE.
 *
 * This is the authoritative regression guard for the one thing F5 removed:
 * `resolveTargetNodes` re-deriving "which installed instances of this
 * package does the call graph contain" by walking EVERY graph node, once
 * per advisory target. Its cost was `graph nodes × advisories`, unbounded
 * in graph size.
 *
 * WHY THIS IS AN OPERATION-COUNT TEST AND NOT A STOPWATCH.
 *
 * The first version of this guard timed two scans (4 advisories vs 32) and
 * required the wall-clock ratio to stay under 4x. That gate was replaced
 * rather than re-tuned, because measurement showed it was not merely noisy
 * — it was ANTI-CORRELATED with the property it claimed to own:
 *
 * - With F5 intact, ten local runs measured ratios 1.88 / 3.32 median /
 *   5.88, i.e. **1 in 10 failed** — and CI failed at 4.07.
 * - With the graph index **completely disabled** — the exact regression
 *   the gate exists to catch — four runs measured 2.71 / 3.15 median /
 *   3.24, i.e. **0 in 4 failed**. It passed comfortably.
 *
 * Both observations have the same cause. A restored walk costs ~3,900
 * identity lookups instead of ~160, but with the per-scan identity memo
 * still in place those lookups are in-memory map reads, while the scan's
 * wall time is dominated by parsing and graph construction. So the
 * regression is nearly invisible to a stopwatch, while ordinary machine
 * variance on a ~200ms denominator is not. A threshold cannot separate
 * those two; no choice of ratio would have made that gate meaningful.
 *
 * The operation counts below have no such problem. They are exact
 * integers, identical on every run and on every machine, and they move by
 * a factor of ~25 the moment the optimization is removed.
 *
 * WHAT THIS FILE ASSERTS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * It asserts the SHAPE of the work: identity requests must be
 * `O(graph nodes) + O(1) per advisory`, never `O(graph nodes × advisories)`.
 * It asserts nothing about elapsed time, and it is not a benchmark. The
 * coarse "did something catastrophic happen" signal lives in
 * `cli/scan-performance.test.ts`, as a generous absolute ceiling.
 *
 * It drives the REAL production composition — the same functions in the
 * same order `cli/scan.ts` calls them — rather than a stub, because a gate
 * built on a reimplementation of the pipeline would keep passing while the
 * pipeline itself regressed. The one thing it does differently is supply
 * its own {@link createScanModuleIdentityCache} so the counters that
 * object already carries can be read back afterwards. That is exactly what
 * production does (`cli/scan.ts` creates the memo and threads it into
 * `createAnalysisProofContext`); nothing here reaches past a public API,
 * and no production code exists for this test's benefit.
 */

/**
 * Identity requests an intact scan makes, measured across graph sizes and
 * advisory counts: `graphNodes + advisories + 6`.
 *
 * - `graphNodes` — ONE pass, when the index is first built.
 * - `advisories` — one ownership check per finding (Site A/B in
 *   `resolveTargetNodes`), which is genuine per-finding work F5 neither
 *   removes nor should.
 * - `6` — a small fixed cost (public-entry probes for the one instance).
 *
 * Verified exactly at N=33/123/243 and M=1/4/8/16/32. The bound below is
 * deliberately looser than this formula: the gate must survive honest
 * changes to per-finding work, and only has to separate "constant per
 * advisory" from "one graph walk per advisory".
 */
const MAX_IDENTITY_REQUESTS_PER_ADVISORY = 4;

/** Files in the single installed package — the fan-out that makes a walk expensive. */
const PACKAGE_FILE_COUNT = 40;
const FEW_ADVISORIES = 4;
const MANY_ADVISORIES = 32;

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function write(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

/** One installed package of many files, reached from the project's entrypoint. */
function buildProject(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-f5-multiplier-"));
  dirs.push(root);

  write(
    root,
    "package.json",
    JSON.stringify({
      name: "f5-multiplier-fixture",
      version: "1.0.0",
      dependencies: { wide: "1.0.0" },
    }),
  );
  write(
    root,
    "package-lock.json",
    JSON.stringify({
      name: "f5-multiplier-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "f5-multiplier-fixture", version: "1.0.0" },
        "node_modules/wide": { version: "1.0.0" },
      },
    }),
  );

  const requires: string[] = [];
  const exportsList: string[] = [];
  for (let i = 0; i < PACKAGE_FILE_COUNT; i += 1) {
    write(
      root,
      `node_modules/wide/m${i}.js`,
      `function danger${i}(x) { return x; }\n` +
        `function helper${i}(x) { return danger${i}(x); }\n` +
        `module.exports = { danger${i}, helper${i} };\n`,
    );
    requires.push(`const m${i} = require("./m${i}.js");`);
    exportsList.push(`danger${i}: m${i}.danger${i}`);
  }
  write(
    root,
    "node_modules/wide/package.json",
    JSON.stringify({ name: "wide", version: "1.0.0", main: "index.js" }),
  );
  write(
    root,
    "node_modules/wide/index.js",
    `${requires.join("\n")}\nmodule.exports = { ${exportsList.join(", ")} };\n`,
  );
  write(
    root,
    "src/index.js",
    'const wide = require("wide");\n' +
      "function main(x) { return wide.danger0(x); }\n" +
      "module.exports = { main };\n",
  );
  return root;
}

interface ScanWork {
  readonly graphNodes: number;
  readonly findings: number;
  /** Identity requests made DURING verdict evaluation (index build included). */
  readonly identityRequests: number;
  /** `realpathSync` calls during verdict evaluation. */
  readonly realpathCalls: number;
  /** `package.json` reads during verdict evaluation. */
  readonly manifestReads: number;
  /** Distinct (instance, specifier) pairs the public-entry memo held. */
  readonly publicEntryKeys: number;
}

/**
 * Runs the production pipeline for `advisoryCount` advisories against one
 * installed package, and reports the structural work the verdict phase did.
 *
 * Counters are sampled AFTER the graph and closure are built and the
 * context is created, so what they measure is verdict-phase work alone —
 * the phase the multiplier lived in. Graph construction and the
 * module-load closure are identical either way and would only add a
 * constant to both sides.
 */
async function measureScan(
  advisoryCount: number,
  options: { readonly withholdIdentityMemo?: boolean } = {},
): Promise<ScanWork> {
  const root = buildProject();

  const dependencyNodes = buildDependencyGraph(
    loadPackageJsonFile(path.join(root, "package.json")),
    loadPackageLockFile(path.join(root, "package-lock.json")),
  );
  const knownPackageRoots = buildKnownPackageRoots(dependencyNodes, root, []);
  const moduleIdentityCache = createScanModuleIdentityCache(knownPackageRoots);

  const tsProject = loadTsProject(root);
  const resolver = createModuleResolver(tsProject);
  const entrypointsResult = await discoverEntrypoints({
    projectRoot: root,
    resolver,
    configuredEntrypoints: ["src/index.js"],
  });
  const graph = await buildCallGraph({
    entryFiles: entrypointsResult.entrypoints.map((entry) => entry.filePath),
    resolver,
    maxFiles: 2_000,
    maxGraphNodes: 50_000,
    maxAnalysisSeconds: 120,
    project: tsProject,
    knownPackageRoots,
  });
  const moduleLoadClosure = await buildGateEligibleModuleLoadClosure({
    entrypoints: entrypointsResult.entrypoints,
    resolver,
    maxFiles: 2_000,
    knownPackageRoots,
    moduleIdentityCache,
  });
  const context = createAnalysisProofContext({
    projectRoot: root,
    resolver,
    entrypoints: entrypointsResult.entrypoints,
    knownPackageRoots,
    graph,
    graphTruncated: false,
    moduleLoadClosure,
    // Withholding this is the CONTROL for the zero-filesystem-cost
    // assertion below: the context then builds its own correctly-bound
    // memo, which is cold, so the verdict phase has to canonicalize and
    // read manifests again. Production always threads it (`cli/scan.ts`).
    moduleIdentityCache: options.withholdIdentityMemo
      ? undefined
      : moduleIdentityCache,
  });

  const before = { ...context.caches.identity.operations };
  const packageInstance = path.join(root, "node_modules", "wide");
  let findings = 0;
  for (let i = 0; i < advisoryCount; i += 1) {
    const vulnerability: Vulnerability = {
      id: `GHSA-f5-${i}`,
      aliases: [],
      package: "wide",
      ecosystem: "npm",
      affectedVersions: [{ introduced: "0" }],
      fixedVersions: [],
      references: [],
    };
    const rule: VulnerableSymbolRule = {
      id: `GHSA-f5-${i}`,
      package: { name: "wide" },
      targets: [
        {
          module: "wide",
          export: `danger${i % PACKAGE_FILE_COUNT}`,
          kind: "function",
          confidence: 1,
        },
      ],
    };
    const finding = await buildFinding({
      vulnerability,
      packageName: "wide",
      packageVersion: "1.0.0",
      packageInstance,
      matchResult: "affected",
      rule,
      context,
    });
    if (finding) {
      findings += 1;
    }
  }

  const after = context.caches.identity.operations;
  return {
    graphNodes: graph.nodes.length,
    findings,
    identityRequests:
      after.identityHits +
      after.identityMisses -
      (before.identityHits + before.identityMisses),
    realpathCalls: after.realpathCalls - before.realpathCalls,
    manifestReads: after.manifestReads - before.manifestReads,
    publicEntryKeys: context.caches.publicEntries.size,
  };
}

describe("F5 multiplier gate: verdict work is O(nodes) + O(1) per advisory", () => {
  it("does not re-walk the graph for each advisory", async () => {
    const few = await measureScan(FEW_ADVISORIES);
    const many = await measureScan(MANY_ADVISORIES);

    // The workload has to be real, or every bound below is vacuous: a
    // graph big enough for a per-advisory walk to be expensive, and a
    // finding actually produced for every advisory.
    expect(few.graphNodes).toBeGreaterThan(100);
    expect(many.graphNodes).toBe(few.graphNodes);
    expect(few.findings).toBe(FEW_ADVISORIES);
    expect(many.findings).toBe(MANY_ADVISORIES);

    // THE INVARIANT. Each additional advisory may add a constant amount
    // of identity work; it may not add a graph walk. Measured intact:
    // exactly 1 request per advisory. With the index removed: ~124 --
    // one per graph node, which is precisely the restored multiplier.
    const perAdvisory =
      (many.identityRequests - few.identityRequests) /
      (MANY_ADVISORIES - FEW_ADVISORIES);
    expect(
      perAdvisory,
      `identity requests per advisory: ${perAdvisory} ` +
        `(${few.identityRequests} for ${FEW_ADVISORIES}, ` +
        `${many.identityRequests} for ${MANY_ADVISORIES}, ` +
        `${many.graphNodes} graph nodes)`,
    ).toBeLessThanOrEqual(MAX_IDENTITY_REQUESTS_PER_ADVISORY);

    // Stated a second way, as an absolute bound, so the gate still holds
    // if someone changes the advisory counts above: total identity work
    // stays within one graph pass plus a constant per advisory. The
    // product form (nodes x advisories = 3,936 here) exceeds this by
    // more than an order of magnitude.
    expect(many.identityRequests).toBeLessThanOrEqual(
      many.graphNodes + MAX_IDENTITY_REQUESTS_PER_ADVISORY * MANY_ADVISORIES,
    );
    expect(many.identityRequests).toBeLessThan(
      many.graphNodes * MANY_ADVISORIES,
    );
  }, 120_000);

  it("pays no filesystem cost at all during verdict evaluation", async () => {
    // The scan's ONE identity memo is created before the module-load
    // closure and threaded into the proof context, so by the time
    // verdicts are evaluated every file the analysis touched has already
    // been canonicalized and its manifest read. Zero is therefore the
    // exact expected number, not a generous bound -- and it is what
    // fails if `cli/scan.ts` ever stops threading its memo through
    // (measured with the memo withheld: 2 realpath calls, 1 manifest
    // read, and 42 fresh identity misses).
    const many = await measureScan(MANY_ADVISORIES);
    expect(many.realpathCalls).toBe(0);
    expect(many.manifestReads).toBe(0);

    // CONTROL -- `toBe(0)` on a counter is only meaningful if something
    // can make it non-zero. Withholding the scan's memo (so the context
    // builds a cold one) is exactly the regression this asserts against,
    // and it must produce real filesystem work.
    const cold = await measureScan(MANY_ADVISORIES, {
      withholdIdentityMemo: true,
    });
    expect(cold.realpathCalls).toBeGreaterThan(0);
    expect(cold.manifestReads).toBeGreaterThan(0);
    // ...and the answers are identical either way: this is a cost
    // difference, never a semantic one.
    expect(cold.findings).toBe(many.findings);
  }, 120_000);

  it("resolves one package's public entry once for the whole scan", async () => {
    // Every advisory here names the same instance and the same module
    // specifier, differing only in the exported symbol. The public-entry
    // memo is keyed (instance, specifier), so that is ONE entry however
    // many advisories run -- the per-scan lifetime F5 introduced. A
    // per-finding memo, which is what F5 replaced, would hold one entry
    // and re-resolve on every finding.
    const few = await measureScan(FEW_ADVISORIES);
    const many = await measureScan(MANY_ADVISORIES);
    expect(few.publicEntryKeys).toBe(1);
    expect(many.publicEntryKeys).toBe(1);
  }, 120_000);
});
