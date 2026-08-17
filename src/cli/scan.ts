import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import {
  type CacheStats,
  FileOsvCacheStore,
  createCachingProvider,
} from "../cache/index.js";
import {
  createTimingResolver,
  type TimingAccumulator,
} from "../performance/timing.js";
import { loadConfigFile, parseConfig } from "../config/load.js";
import type { Config } from "../config/schema.js";
import {
  buildDependencyGraph,
  loadPackageJsonFile,
  loadPackageLockFile,
} from "../dependencies/index.js";
import type { DependencyNode } from "../domain/dependency.js";
import type { Diagnostic } from "../domain/coverage.js";
import type { Finding } from "../domain/verdict.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { indexRulesByVulnerabilityId, loadRuleFile } from "../rules/index.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import { discoverEntrypoints } from "../analysis/entrypoints.js";
import {
  collectGraphDiagnostics,
  computeCoverage,
} from "../analysis/reachability.js";
import { buildFinding } from "../analysis/verdict.js";
import { readOwnVersion } from "../shared/own-version.js";
import { OsvProvider } from "../vulnerabilities/osv-provider.js";
import { normalizeOsvVulnerability } from "../vulnerabilities/osv-normalizer.js";
import { matchVulnerabilities } from "../vulnerabilities/version-matching.js";
import type { VulnerabilityProvider } from "../domain/vulnerability.js";
import { errorMessage } from "./errors.js";
import { type CliIo, defaultIo } from "./io.js";
import {
  SCHEMA_VERSION,
  findingToJson,
  formatScanOutput,
  validateScanOutput,
  type ScanOutput,
} from "./output.js";

export interface RunScanOptions {
  /** The path exactly as the user typed it (used verbatim for `scan.project` in the JSON output). */
  readonly projectPathArg: string;
  readonly configPathOverride?: string;
  readonly cveFilter?: string;
  readonly pretty?: boolean;
  /** `--no-cache` (docs/SDD.md § 28): forces the vulnerability provider cache off regardless of config. */
  readonly noCache?: boolean;
  /** Defaults to `<projectRoot>/.vulntrace-cache/osv`; mainly for tests. */
  readonly cacheDir?: string;
  /** Defaults to a real {@link OsvProvider}; overridable for testing without live network access. */
  readonly provider?: VulnerabilityProvider;
  readonly io?: CliIo;
}

/** One {@link DependencyNode} per distinct install location; a scan only needs one check per distinct name+version. */
function dedupeDependencies(
  nodes: readonly DependencyNode[],
): DependencyNode[] {
  const seen = new Map<string, DependencyNode>();
  for (const node of nodes) {
    const key = `${node.name}@${node.version}`;
    if (!seen.has(key)) {
      seen.set(key, node);
    }
  }
  return [...seen.values()];
}

function loadConfig(projectRoot: string, configPathOverride?: string): Config {
  if (configPathOverride) {
    return loadConfigFile(path.resolve(configPathOverride));
  }
  const defaultPath = path.join(projectRoot, "vulntrace.yml");
  return existsSync(defaultPath)
    ? loadConfigFile(defaultPath)
    : parseConfig({});
}

function loadRules(
  projectRoot: string,
  ruleFiles: readonly string[],
): VulnerableSymbolRule[] {
  const rules: VulnerableSymbolRule[] = [];
  for (const file of ruleFiles) {
    rules.push(...loadRuleFile(path.resolve(projectRoot, file)));
  }
  return rules;
}

/**
 * Finds the rule for a matched vulnerability, checking not just its
 * primary `id` but every one of its `aliases` too (see TASK-012's
 * `indexRulesByVulnerabilityId`, keyed by whatever id string a rule's own
 * author chose). OSV's primary id for an npm advisory is conventionally a
 * GHSA id, with the corresponding CVE (if any) recorded only as an alias
 * — a rule authored against the CVE id (a common, natural choice) would
 * otherwise never match, silently degrading to UNKNOWN for a genuinely
 * known vulnerability. `--cve` filtering already checks aliases (see
 * below); rule lookup previously did not — found and fixed during
 * TASK-030's final review.
 */
function findRuleForVulnerability(
  rulesById: ReadonlyMap<string, VulnerableSymbolRule>,
  vulnerability: Vulnerability,
): VulnerableSymbolRule | undefined {
  const direct = rulesById.get(vulnerability.id);
  if (direct) {
    return direct;
  }
  for (const alias of vulnerability.aliases) {
    const byAlias = rulesById.get(alias);
    if (byAlias) {
      return byAlias;
    }
  }
  return undefined;
}

/**
 * `vulntrace scan <path>` (see docs/SDD.md § 25, § 32's vertical slice).
 * Runs the full pipeline — dependency graph -> vulnerability provider ->
 * normalization -> version match -> vulnerable-symbol rule -> call graph ->
 * reachability -> verdict — and prints the resulting JSON to `io.stdout`.
 *
 * Exit codes follow docs/SDD.md § 25:
 * - `0`: scan completed, no AFFECTED findings;
 * - `1`: scan completed, at least one AFFECTED finding;
 * - `2`: configuration/usage error (bad project path, invalid
 *   `vulntrace.yml`, invalid rules file);
 * - `3`: analysis failure (missing/malformed package.json or
 *   package-lock.json, code-intelligence failure, or a generated result
 *   that fails to validate against schemas/result.schema.json);
 * - `4`: vulnerability-provider/network failure. Treated as fatal for the
 *   whole scan (not skipped per-dependency): proceeding without this data
 *   would mean silently reporting on an incomplete dependency set, which
 *   risks a scan result being misread as complete when it is not (see
 *   AGENTS.md: never infer NOT_AFFECTED — nor omit a dependency's findings
 *   entirely — merely because something failed to resolve).
 */
export async function runScanCommand(options: RunScanOptions): Promise<number> {
  const scanStart = Date.now();
  const io = options.io ?? defaultIo;
  const rawProvider = options.provider ?? new OsvProvider();
  const projectRoot = path.resolve(options.projectPathArg);
  const cacheStats: CacheStats = { hits: 0, misses: 0 };
  const resolutionTiming: TimingAccumulator = { ms: 0 };
  let providerMs = 0;
  let reachabilityMs = 0;

  if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
    io.stderr(
      `vulntrace: project path does not exist or is not a directory: ${options.projectPathArg}\n`,
    );
    return 2;
  }

  let config: Config;
  try {
    config = loadConfig(projectRoot, options.configPathOverride);
  } catch (error) {
    io.stderr(`vulntrace: invalid configuration: ${errorMessage(error)}\n`);
    return 2;
  }

  // Cache-first vulnerability provider (see docs/SDD.md § 28). `--no-cache`
  // always wins over config; otherwise config's `vulnerabilities.cache.enabled`
  // decides (enabled by default).
  const provider =
    options.noCache !== true && config.vulnerabilities.cache.enabled
      ? createCachingProvider(
          rawProvider,
          new FileOsvCacheStore(
            options.cacheDir ??
              path.join(projectRoot, ".vulntrace-cache", "osv"),
          ),
          readOwnVersion(),
          cacheStats,
        )
      : rawProvider;

  let rules: VulnerableSymbolRule[];
  let rulesById: ReadonlyMap<string, VulnerableSymbolRule>;
  try {
    rules = loadRules(projectRoot, config.rules.files);
    rulesById = indexRulesByVulnerabilityId(rules);
  } catch (error) {
    io.stderr(
      `vulntrace: invalid rules configuration: ${errorMessage(error)}\n`,
    );
    return 2;
  }

  let dependencyNodes: DependencyNode[];
  try {
    const packageJson = loadPackageJsonFile(
      path.join(projectRoot, "package.json"),
    );
    const packageLock = loadPackageLockFile(
      path.join(projectRoot, "package-lock.json"),
    );
    dependencyNodes = buildDependencyGraph(packageJson, packageLock);
  } catch (error) {
    io.stderr(
      `vulntrace: failed to read project dependency manifests: ${errorMessage(error)}\n`,
    );
    return 3;
  }

  let entrypointsResult;
  let graph;
  let resolver;
  let graphBuildMs = 0;
  try {
    const tsProject = loadTsProject(projectRoot);
    resolver = createTimingResolver(
      createModuleResolver(tsProject),
      resolutionTiming,
    );
    entrypointsResult = await discoverEntrypoints({
      projectRoot,
      resolver,
      configuredEntrypoints: config.analysis.entrypoints,
    });
    const graphBuildStart = Date.now();
    graph = await buildCallGraph({
      entryFiles: entrypointsResult.entrypoints.map((entry) => entry.filePath),
      resolver,
      maxFiles: config.analysis.limits.maxFiles,
      maxGraphNodes: config.analysis.limits.maxGraphNodes,
      maxAnalysisSeconds: config.analysis.limits.maxAnalysisSeconds,
      project: tsProject,
    });
    graphBuildMs = Date.now() - graphBuildStart;
  } catch (error) {
    io.stderr(`vulntrace: analysis failure: ${errorMessage(error)}\n`);
    return 3;
  }

  const diagnostics: Diagnostic[] = [
    ...entrypointsResult.diagnostics.map((d) => ({
      source: `entrypoints:${d.source}`,
      message: d.message,
    })),
    ...collectGraphDiagnostics(graph),
  ];

  // Regression found while verifying the documented example scan from a
  // clean environment (TASK-030): a project with no `analysis.entrypoints`
  // configured and no resolvable package.json main/bin field discovers
  // zero entrypoints -- and, when nothing was even attempted (as opposed
  // to attempted and failed, which already produces its own diagnostic
  // above), that previously produced an empty diagnostics array with no
  // explanation for why every coverage count was zero.
  if (entrypointsResult.entrypoints.length === 0) {
    diagnostics.push({
      source: "entrypoints",
      message:
        "no entrypoints were discovered (no analysis.entrypoints configured, and no resolvable package.json main/bin field); nothing could be analyzed",
    });
  }

  // A limit reached mid-build (see docs/SDD.md § 26, § 29 hardening: a
  // pathological/adversarial target project must not consume unbounded
  // resources) truncates the call graph rather than aborting the scan —
  // surface that truncation explicitly rather than letting a partial graph
  // look like a complete one.
  const filesDiscovered = computeCoverage(graph).files;
  const hitFileLimit = filesDiscovered >= config.analysis.limits.maxFiles;
  const hitNodeLimit =
    graph.nodes.length >= config.analysis.limits.maxGraphNodes;
  const hitTimeLimit =
    graphBuildMs >= config.analysis.limits.maxAnalysisSeconds * 1000;

  if (hitFileLimit) {
    diagnostics.push({
      source: "call-graph",
      message: `analysis stopped after reaching the configured file limit (${config.analysis.limits.maxFiles}); results may be incomplete`,
    });
  }
  if (hitNodeLimit) {
    diagnostics.push({
      source: "call-graph",
      message: `analysis stopped after reaching the configured graph-node limit (${config.analysis.limits.maxGraphNodes}); results may be incomplete`,
    });
  }
  if (hitTimeLimit) {
    diagnostics.push({
      source: "call-graph",
      message: `analysis stopped after reaching the configured time limit (${config.analysis.limits.maxAnalysisSeconds}s); results may be incomplete`,
    });
  }

  // VT-202 (SDD-v0.2.md § 3.3): a truncated graph can't positively confirm
  // NOT_AFFECTED for any finding -- the untraversed region might have held
  // the very path being searched for. Computed once per scan (the same
  // graph is reused for every dependency's findings below) and passed
  // through to buildFinding, which downgrades what would otherwise be
  // NOT_AFFECTED to UNKNOWN when this is true.
  const graphTruncated = hitFileLimit || hitNodeLimit || hitTimeLimit;

  const cveFilter = options.cveFilter;
  const uniqueDependencies = dedupeDependencies(dependencyNodes);
  const findings: Finding[] = [];

  for (const dependency of uniqueDependencies) {
    let rawVulnerabilities;
    const providerStart = Date.now();
    try {
      rawVulnerabilities = await provider.queryPackage({
        ecosystem: dependency.ecosystem,
        name: dependency.name,
        version: dependency.version,
      });
      providerMs += Date.now() - providerStart;
    } catch (error) {
      providerMs += Date.now() - providerStart;
      io.stderr(
        `vulntrace: vulnerability provider failure for ${dependency.name}@${dependency.version}: ${errorMessage(error)}\n`,
      );
      return 4;
    }

    const vulnerabilities: Vulnerability[] = [];
    for (const raw of rawVulnerabilities) {
      try {
        vulnerabilities.push(
          normalizeOsvVulnerability(raw, {
            ecosystem: dependency.ecosystem,
            name: dependency.name,
          }),
        );
      } catch (error) {
        const message = `skipping malformed vulnerability record for ${dependency.name}@${dependency.version}: ${errorMessage(error)}`;
        io.stderr(`vulntrace: ${message}\n`);
        diagnostics.push({ source: "vulnerabilities", message });
      }
    }

    const relevant = cveFilter
      ? vulnerabilities.filter(
          (vulnerability) =>
            vulnerability.id === cveFilter ||
            vulnerability.aliases.includes(cveFilter),
        )
      : vulnerabilities;

    const matches = matchVulnerabilities(dependency.version, relevant);

    for (const match of matches) {
      const rule = findRuleForVulnerability(rulesById, match.vulnerability);
      const reachabilityStart = Date.now();
      const finding = await buildFinding({
        vulnerability: match.vulnerability,
        packageName: dependency.name,
        packageVersion: dependency.version,
        // The dependency graph already knows exactly which installed
        // instance this finding corresponds to (VT-212, SDD-v0.2.md § 4.3)
        // -- pass it through as the authoritative identity rather than
        // letting verdict resolution reconstruct it from the call graph
        // alone, which cannot distinguish "the wrong instance" from "an
        // instance never reached at all".
        packageInstance: dependency.locations[0]
          ? path.resolve(projectRoot, dependency.locations[0])
          : undefined,
        matchResult: match.result,
        rule,
        graph,
        entrypoints: entrypointsResult.entrypoints,
        resolver,
        projectRoot,
        graphTruncated,
      });
      reachabilityMs += Date.now() - reachabilityStart;
      if (finding) {
        findings.push(finding);
      }
    }
  }

  const output: ScanOutput = {
    schemaVersion: SCHEMA_VERSION,
    scan: { id: randomUUID(), project: options.projectPathArg },
    findings: findings.map(findingToJson),
    coverage: computeCoverage(graph),
    diagnostics,
    timings: {
      // Derived, not independently measured -- see PhaseTimings' own doc
      // comment (src/performance/timing.ts) for why.
      parsingMs: Math.max(0, graphBuildMs - resolutionTiming.ms),
      resolutionMs: resolutionTiming.ms,
      graphConstructionMs: graphBuildMs,
      reachabilityMs,
      providerMs,
      cacheHits: cacheStats.hits,
      cacheMisses: cacheStats.misses,
      totalMs: Date.now() - scanStart,
    },
  };

  const issues = validateScanOutput(output);
  if (issues.length > 0) {
    io.stderr(
      `vulntrace: internal error: generated output does not match schemas/result.schema.json:\n` +
        issues.map((issue) => `  ${issue.path}: ${issue.message}`).join("\n") +
        "\n",
    );
    return 3;
  }

  io.stdout(
    formatScanOutput(output, options.pretty ?? config.output.pretty) + "\n",
  );

  return findings.some((finding) => finding.verdict === "AFFECTED") ? 1 : 0;
}
