import { randomUUID } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
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
  advisoryQueryVersions,
  buildDependencyGraph,
  buildPackageInstanceRegistry,
  describePackageInstance,
  discoverWorkspacePackages,
  findApplicablePackageInstances,
  loadPackageJsonFile,
  loadPackageLockFile,
} from "../dependencies/index.js";
import type { DependencyNode } from "../domain/dependency.js";
import type { Diagnostic } from "../domain/coverage.js";
import { buildKnownPackageRoots } from "../domain/resolved-target.js";
import type { Finding } from "../domain/verdict.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { indexRulesByVulnerabilityId, loadRuleFile } from "../rules/index.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import { discoverEntrypoints } from "../analysis/entrypoints.js";
import {
  collectGraphDiagnostics,
  computeCoverage,
} from "../analysis/reachability.js";
import { createAnalysisProofContext } from "../analysis/analysis-context.js";
import { buildFinding } from "../analysis/verdict.js";
import {
  buildGateEligibleModuleLoadClosure,
  type ModuleLoadClosure,
} from "../analysis/module-load-closure.js";
import { readOwnVersion } from "../shared/own-version.js";
import { OsvProvider } from "../vulnerabilities/osv-provider.js";
import { normalizeOsvVulnerability } from "../vulnerabilities/osv-normalizer.js";
import { matchVersion } from "../vulnerabilities/version-matching.js";
import type { VulnerabilityProvider } from "../domain/vulnerability.js";
import { errorMessage } from "./errors.js";
import { renderHtmlReport } from "./html-report.js";
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
  /**
   * How to RENDER the finished scan result (`--format`). Defaults to
   * `"json"`, which is the unchanged existing behavior in every respect:
   * the same `ScanOutput`, the same schema validation, the same stdout.
   *
   * `"html"` renders that identical `ScanOutput` through
   * {@link renderHtmlReport} instead. It is a presentation choice and
   * nothing more -- no analysis, verdict, evidence or diagnostic differs
   * by format, and the HTML report is generated from the very object the
   * JSON output serializes (see html-report.ts).
   */
  readonly format?: "json" | "html";
  /**
   * `--output`: write the rendered result to this file instead of stdout.
   * Required by `runCli` for `--format html` (there is no safe stdout
   * behavior for a full HTML document -- see run.ts), optional for JSON.
   * Relative paths resolve against the process working directory, not the
   * scanned project, so `--output` behaves like every other shell
   * redirection target the user could have typed.
   */
  readonly outputPath?: string;
  readonly pretty?: boolean;
  /** `--no-cache` (docs/SDD.md § 28): forces the vulnerability provider cache off regardless of config. */
  readonly noCache?: boolean;
  /** Defaults to `<projectRoot>/.vulntrace-cache/osv`; mainly for tests. */
  readonly cacheDir?: string;
  /** Defaults to a real {@link OsvProvider}; overridable for testing without live network access. */
  readonly provider?: VulnerabilityProvider;
  readonly io?: CliIo;
  /**
   * Read-only observation seam for the scan's single
   * {@link ModuleLoadClosure} (VT-307d), invoked exactly once per scan
   * with whatever `buildGateEligibleModuleLoadClosure` produced --
   * including `undefined` when no gate-eligible closure could be built at
   * all (no entrypoints, or a construction failure).
   *
   * Deliberately an OBSERVATION callback and nothing else: it receives the
   * closure, it cannot supply or alter one, and no analysis decision reads
   * anything it returns (it returns `void`). That asymmetry is the point --
   * unlike `BuildFindingOptions.allowSyntheticNameOnlyTargetBinding`, this
   * seam is structurally incapable of changing a verdict, so wiring it up
   * cannot weaken the negative-proof gate it exists to test. It is not
   * exposed through `vulntrace.yml` or any CLI flag.
   *
   * Exists because the six real-world closure facts VT-307d depends on
   * (RWB-06/06A OUT+complete, RWB-07/08/09a IN+complete, RWB-10
   * IN+incomplete) must be asserted against the REAL production
   * construction order -- dependency graph -> KnownPackageRoots ->
   * entrypoint discovery -> closure -- and not merely against a
   * hand-assembled `buildModuleLoadClosure` call that could silently drift
   * from what `runScanCommand` actually does. See scan.module-load-closure.test.ts.
   */
  readonly onModuleLoadClosure?: (
    closure: ModuleLoadClosure | undefined,
  ) => void;
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

  // The scan's dependency-provenance registry (VT-307c-fix-4b), built once
  // from the full dependency graph -- every DependencyNode's every
  // location, canonicalized -- so identifyModule can attribute a linked
  // dependency (an npm workspace member, a `file:` dependency, ...) whose
  // physical target has no `node_modules` segment of its own, regardless
  // of whether that target lives inside or outside projectRoot. Threaded
  // explicitly into every buildFinding call below so verdict.ts's own
  // identifyModule calls (Site A instance-matching, VT-300's closure-
  // widening guard) use the exact same identity authority as the finding's
  // own packageInstance just below.
  //
  // P1-A4 adds the second provenance authority: the repository's own
  // `workspaces` declaration. A monorepo's local packages are frequently
  // absent from the dependency graph entirely (a lockfile link entry
  // carries no version, so it forms no DependencyNode), and their physical
  // roots have no `node_modules` segment -- so without this they have NO
  // package identity at all, and every advisory naming one fails closed to
  // UNKNOWN. Discovery is bounded by the declaration itself and never
  // scans the repository at large; an uninterpretable declaration
  // discovers nothing rather than guessing. Adding a root changes only
  // ATTRIBUTION of files the analysis already reached -- it loads nothing
  // and makes nothing reachable (P1-A4 § MODULE LOAD CLOSURE).
  //
  // F1-A: discovery incompleteness is MACHINE-READABLE. Every reason
  // `discoverWorkspacePackages` returns -- an uninterpretable declaration,
  // an unsupported pattern shape, a truncated traversal, a pnpm-only
  // layout -- is a package this scan may never have seen, and a reader of
  // the JSON or HTML report has to be able to see that. Previously these
  // reached stderr alone: the verdict layer still failed closed, but a
  // consumer parsing `diagnostics` had no way to tell an incompletely
  // enumerated monorepo from a fully enumerated one. The stderr line is
  // kept as well -- it is what a human running the CLI sees first.
  const workspaces = discoverWorkspacePackages(projectRoot);
  const workspaceDiagnostics: Diagnostic[] = workspaces.unsupported.map(
    (reason) => ({ source: "workspaces", message: reason }),
  );
  for (const reason of workspaces.unsupported) {
    io.stderr(`vulntrace: ${reason}\n`);
  }
  const knownPackageRoots = buildKnownPackageRoots(
    dependencyNodes,
    projectRoot,
    workspaces.packages.map((workspacePackage) => ({
      canonicalRoot: workspacePackage.canonicalRoot,
      packageName:
        workspacePackage.packageName ??
        path.basename(workspacePackage.canonicalRoot),
    })),
  );

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
      // RWF-004a: the same registry the findings below already use, so the
      // call graph's same-canonical-PackageInstance test for a CommonJS
      // re-export and a finding's own `packageInstance` are decided by one
      // identity authority, never two.
      knownPackageRoots,
    });
    graphBuildMs = Date.now() - graphBuildStart;
  } catch (error) {
    io.stderr(`vulntrace: analysis failure: ${errorMessage(error)}\n`);
    return 3;
  }

  const diagnostics: Diagnostic[] = [
    ...workspaceDiagnostics,
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

  // The scan's single {@link ModuleLoadClosure} (VT-307d), built EXACTLY
  // ONCE here -- never per advisory, per package, per vulnerability or per
  // finding -- and threaded unchanged into every `buildFinding` call below.
  // Its construction order is deliberate and load-bearing: the dependency
  // graph and `knownPackageRoots` above must both already exist, because a
  // closure built without authoritative package-root identity silently
  // loses the `PackageInstanceId` of every workspace/`file:`-linked install
  // (see `buildGateEligibleModuleLoadClosure`) -- exactly the false-absence
  // shape the Site-B negative-proof gate must never observe.
  //
  // Built through the STRICT builder, never `buildModuleLoadClosure`
  // directly: that is what makes gate eligibility structural rather than a
  // caller promise. `knownPackageRoots` is required there at the TYPE
  // level, and the empty-entrypoints case returns `undefined` rather than
  // a vacuously-complete closure in which every installed package instance
  // would be OUT.
  //
  // `maxFiles` is the closure's OWN traversal bound; reaching it records
  // `traversal_truncated` and makes the closure incomplete. That is
  // deliberately independent of the call graph's `graphTruncated` below --
  // the two traversals visit different file sets and can be truncated
  // independently.
  let moduleLoadClosure: ModuleLoadClosure | undefined;
  try {
    moduleLoadClosure = await buildGateEligibleModuleLoadClosure({
      entrypoints: entrypointsResult.entrypoints,
      resolver,
      maxFiles: config.analysis.limits.maxFiles,
      knownPackageRoots,
    });
  } catch (error) {
    // A closure failure disables the absence proof; it never fails the
    // scan, and it must never be turned into an empty-but-"complete"
    // closure -- that would assert every package instance is unloadable,
    // the exact false NOT_AFFECTED this whole mechanism exists to avoid.
    // The rest of the pipeline continues down its existing conservative
    // path, which reaches UNKNOWN on its own.
    moduleLoadClosure = undefined;
    diagnostics.push({
      source: "module-load-closure",
      message: `module-load absence proof is unavailable: closure construction failed (${errorMessage(error)}); findings fall back to call-graph reachability alone`,
    });
  }
  options.onModuleLoadClosure?.(moduleLoadClosure);

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

  // THE scan's single proof context (VT-CONTRACT-03), created exactly ONCE
  // here -- never per advisory, per package or per finding -- and passed by
  // reference into every `buildFinding` call below.
  //
  // Its position is deliberate and load-bearing: every input it binds must
  // already be final. The dependency graph and `knownPackageRoots` exist,
  // entrypoints are discovered, the call graph is built, `graphTruncated`
  // has just been decided from the limit checks above, and the one
  // `moduleLoadClosure` was built further up. Constructing it any earlier
  // would freeze a value that had not yet been determined.
  //
  // This is what makes a cross-scan proof unrepresentable rather than
  // merely discouraged: `buildFinding` no longer takes the closure, the
  // graph, the roots or the entrypoints as separate arguments that could
  // individually come from somewhere else.
  const analysisProofContext = createAnalysisProofContext({
    projectRoot,
    resolver,
    entrypoints: entrypointsResult.entrypoints,
    knownPackageRoots,
    graph,
    graphTruncated,
    moduleLoadClosure,
  });

  const cveFilter = options.cveFilter;

  // P1-A5 -- THE SCAN'S CANDIDATE PACKAGE INSTANCES, enumerated once.
  //
  // Built from authoritative metadata only (lockfile install paths and the
  // repository's own `workspaces` declaration), converged on the canonical
  // physical root so a symlink, its target and a lockfile entry naming the
  // same directory are ONE instance, while two genuinely separate physical
  // copies of the same name AND version stay two. Never a filesystem hunt
  // for directories named after a package.
  const instanceRegistry = buildPackageInstanceRegistry({
    dependencyNodes,
    projectRoot,
    workspacePackages: workspaces.packages,
  });

  // A package root whose own discovery records CONTRADICT each other about
  // the version fails closed in the registry: no version, no provider
  // query, no verdict derived from a version nothing established. Sound,
  // but silent -- such an instance simply contributes nothing to the
  // report, and a reader cannot tell "nothing was wrong here" from "this
  // project's metadata contradicts itself and the question was never
  // asked".
  //
  // Said out loud here, as a diagnostic and nothing more. It creates no
  // finding and moves no verdict: a contradiction in the project's own
  // metadata is an absence of information, not evidence of anything.
  for (const conflict of instanceRegistry.versionConflicts) {
    // Every version is labelled with the authorities that actually claimed
    // it, from the registry's own provenance -- never re-derived here, and
    // never assumed. The previous wording attributed every conflicting
    // version to "this project's own dependency metadata", which stopped
    // being true the moment the installed manifest became a claimant: it
    // sent a reader to grep a lockfile for a version that only ever
    // existed on disk.
    const claims = conflict.versionClaims
      .map((claim) => `${claim.version} (${claim.sources.join(", ")})`)
      .join(", ");
    // A statement about who made CLAIMS, not about who disagrees with
    // whom: when three authorities claim two versions, "A and B disagree"
    // is frequently false, while this is always exactly true.
    const origin = conflict.sources.includes("installed")
      ? `these claims come from this project's own dependency metadata and from the package installed on disk`
      : `every claim comes from this project's own dependency metadata`;
    diagnostics.push({
      source: "dependencies",
      message:
        `package instance "${describePackageInstance(conflict.packageInstance, projectRoot)}" ` +
        `(${conflict.packageName}) has conflicting versions ${claims}; ${origin}; ` +
        `its version could not be established, so no advisory version range was ` +
        `evaluated against it`,
    });
  }

  // F1-B § 18 -- the same silence, a different cause. A package IS
  // installed at this root and its own manifest cannot be read, so the
  // version this project declares for it can no longer be confirmed to
  // describe the code actually there. Failing closed is the sound answer
  // and, like a contradiction, it is a silent one without this.
  for (const uncertain of instanceRegistry.untrustedManifests) {
    const declared =
      uncertain.declaredVersions.length > 0
        ? `the version this project declares for it (${uncertain.declaredVersions.join(", ")}) ` +
          `could not be confirmed against the package actually installed there`
        : `its installed version could not be established`;
    // A manifest carrying `"version": 123` was read, and parsed, perfectly
    // well -- only the field is unusable. Saying it "could not be read"
    // describes a different failure and sends a reader looking for a
    // corrupt file that is not there.
    const fault =
      uncertain.reason === "unreadable"
        ? `has an installed package.json that could not be read`
        : `has an installed package.json whose "version" field is not a usable version string`;
    diagnostics.push({
      source: "dependencies",
      message:
        `package instance "${describePackageInstance(uncertain.packageInstance, projectRoot)}" ` +
        `(${uncertain.packageName}) ${fault}, so ` +
        `${declared}; no advisory version range was evaluated against it`,
    });
  }

  const findings: Finding[] = [];

  // Advisory lookup is driven by PACKAGE NAME, and the fan-out below is
  // driven by INSTANCE -- deliberately two different keys.
  //
  // The previous shape grouped by `name@version` and did both at once,
  // which silently made the group's shared version the only version any of
  // its advisories could ever be evaluated against. An instance whose own
  // version could not be established therefore belonged to no group and
  // was never analyzed at all: it produced no finding, not even an
  // UNKNOWN, and a reader saw a confident NOT_AFFECTED about its sibling
  // with nothing at all said about it. Splitting the keys is what lets
  // every instance of a name be evaluated, independently, against every
  // advisory discovered for that name.
  for (const [packageName, candidates] of [
    ...instanceRegistry.byOwnershipName,
  ].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    // One provider query per distinct installed VERSION of this name --
    // never one per instance (twins share an answer) and never one per
    // advisory. Same query set as before this change; only the pairing of
    // answers to instances widened.
    const vulnerabilitiesById = new Map<string, Vulnerability>();

    for (const version of advisoryQueryVersions(candidates)) {
      let rawVulnerabilities;
      const providerStart = Date.now();
      try {
        rawVulnerabilities = await provider.queryPackage({
          ecosystem: "npm",
          name: packageName,
          version,
        });
        providerMs += Date.now() - providerStart;
      } catch (error) {
        providerMs += Date.now() - providerStart;
        io.stderr(
          `vulntrace: vulnerability provider failure for ${packageName}@${version}: ${errorMessage(error)}\n`,
        );
        return 4;
      }

      for (const raw of rawVulnerabilities) {
        try {
          const vulnerability = normalizeOsvVulnerability(raw, {
            ecosystem: "npm",
            name: packageName,
          });
          // Keyed by advisory id, so the same advisory returned by two
          // versions' queries is ONE advisory evaluated once per instance,
          // not one duplicate finding per query that happened to return
          // it. First write wins under a sorted version order, so which
          // copy is kept does not depend on enumeration order.
          if (!vulnerabilitiesById.has(vulnerability.id)) {
            vulnerabilitiesById.set(vulnerability.id, vulnerability);
          }
        } catch (error) {
          const message = `skipping malformed vulnerability record for ${packageName}@${version}: ${errorMessage(error)}`;
          io.stderr(`vulntrace: ${message}\n`);
          diagnostics.push({ source: "vulnerabilities", message });
        }
      }
    }

    const relevant = [...vulnerabilitiesById.values()]
      .filter(
        (vulnerability) =>
          cveFilter === undefined ||
          vulnerability.id === cveFilter ||
          vulnerability.aliases.includes(cveFilter),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    // FAN OUT PER EXACT INSTANCE. Each one is resolved, evaluated and
    // proved entirely on its own: `buildFinding` still reasons about
    // exactly one PackageInstance per call, and never sees the others.
    // That is what keeps a path into instance B from making instance A
    // AFFECTED, and B's absence from proving A safe.
    for (const candidate of findApplicablePackageInstances(
      instanceRegistry,
      packageName,
    )) {
      for (const vulnerability of relevant) {
        // Version applicability, evaluated PER INSTANCE against this
        // instance's own version and nothing else. An instance with no
        // established version is `indeterminate` -- it does not borrow a
        // sibling's version, and it is not silently dropped.
        const matchResult =
          candidate.version === undefined
            ? "indeterminate"
            : matchVersion(candidate.version, vulnerability.affectedVersions);

        // Unchanged contract (TASK-011): an instance this advisory
        // confidently does not apply to produces NO finding. That is a
        // statement about THIS instance only, and says nothing about any
        // sibling -- which is precisely why each sibling gets its own
        // evaluation above rather than inheriting this one.
        if (matchResult === "not_affected") {
          continue;
        }

        const rule = findRuleForVulnerability(rulesById, vulnerability);
        const reachabilityStart = Date.now();
        const finding = await buildFinding({
          vulnerability,
          // The name the ADVISORY selected this instance by, not
          // necessarily the install directory it lives under: an npm
          // alias (`"foo-alias": "npm:foo@1.2.0"`) is reported as, and
          // resolved as, the package it actually is (P1-A3).
          packageName,
          packageVersion: candidate.version,
          // The dependency graph / workspace declaration already knows
          // exactly which installed instance this finding corresponds to
          // (VT-212, SDD-v0.2.md § 4.3) -- pass it through as the
          // authoritative identity rather than letting verdict resolution
          // reconstruct it from the call graph alone, which cannot
          // distinguish "the wrong instance" from "an instance never
          // reached at all". Already canonicalized by the registry, which
          // is the single place that formula lives.
          packageInstance: candidate.packageInstance,
          matchResult,
          rule,
          // The one proof context built above (VT-CONTRACT-03), passed by
          // reference to every finding -- never rebuilt per advisory or
          // per instance, and structurally incapable of carrying a
          // closure, graph or entrypoint set from another scan.
          context: analysisProofContext,
        });
        reachabilityMs += Date.now() - reachabilityStart;
        if (finding) {
          findings.push(finding);
        }
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

  // RENDERING, and only rendering, happens past this point. `output` is
  // final and identical for every format: the HTML report is a
  // presentation of the exact object the JSON output serializes, never a
  // second analysis (see html-report.ts).
  const rendered =
    options.format === "html"
      ? renderHtmlReport(output)
      : formatScanOutput(output, options.pretty ?? config.output.pretty) + "\n";

  if (options.outputPath !== undefined) {
    const destination = path.resolve(options.outputPath);
    try {
      writeFileSync(destination, rendered, "utf-8");
    } catch (error) {
      // The scan itself succeeded; only delivery failed. Reported as a
      // usage error (an unwritable destination is something the user
      // typed) rather than silently exiting 0/1 as though the report the
      // user asked for existed.
      io.stderr(
        `vulntrace: failed to write --output file ${destination}: ${errorMessage(error)}\n`,
      );
      return 2;
    }
    io.stderr(
      `vulntrace: wrote ${options.format ?? "json"} report to ${destination}\n`,
    );
  } else {
    io.stdout(rendered);
  }

  return findings.some((finding) => finding.verdict === "AFFECTED") ? 1 : 0;
}
