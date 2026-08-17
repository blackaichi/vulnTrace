import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../../src/domain/vulnerability.js";
import { runScanCommand } from "../../src/cli/scan.js";
import { validateScanOutput } from "../../src/cli/output.js";

/**
 * VulnTrace adversarial validation suite.
 *
 * This does NOT test "does VulnTrace pass its own tests" -- it tests
 * whether VulnTrace produces the verdict a human security analyst would
 * independently derive by reading each scenario's own source code. The
 * expected verdicts in expected.json were written by reading the fixture
 * projects under fixtures/adversarial/, never by running VulnTrace and
 * copying its output.
 *
 * Per the governing instructions for this suite: when a scenario's actual
 * verdict disagrees with the independently-authored expected verdict, the
 * test is KEPT and marked FAIL -- the analyzer is never modified to make
 * it pass. See REPORT.md for the investigation of every such disagreement.
 */

interface OracleEntry {
  readonly id: string;
  readonly dir: string;
  readonly category: string;
  readonly description: string;
  readonly expected: "AFFECTED" | "NOT_AFFECTED" | "UNKNOWN";
  readonly reason: string;
  readonly vulnerability: string;
  readonly vulnerableTarget: string;
  readonly findingSelector: {
    readonly package: string;
    readonly version: string;
  };
}

interface ScenarioResult {
  readonly id: string;
  readonly category: string;
  readonly description: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
}

/**
 * Per-scenario mechanism analysis, written from reading the actual analyzer
 * source (src/analysis, src/code-intelligence), not from running the tool.
 * Included in REPORT.md only for scenarios that actually disagree at run
 * time -- this is *why* a mismatch happens, not a prediction of whether one
 * will.
 */
const ANALYSIS: Record<
  string,
  { files: readonly string[]; component: string; explanation: string }
> = {
  "ADV-011": {
    files: [
      "src/code-intelligence/call-graph.ts",
      "src/code-intelligence/module-model.ts",
    ],
    component: "call-graph construction's re-export handling",
    explanation:
      'ADR-0007 ("Re-exports are not chased", TASK-018) documents that `export { x } from "./y";` is recorded in the module model but never followed to `./y`\'s own definition of `x` when building the call graph. A call reached only through such a re-export is not attributed to the real vulnerable-lib function, so it cannot appear as a graph edge to the true target.',
  },
  "ADV-012": {
    files: [
      "src/code-intelligence/call-graph.ts",
      "src/code-intelligence/module-model.ts",
    ],
    component: "call-graph construction's re-export handling",
    explanation:
      "Same root cause as ADV-011 (ADR-0007's documented re-export gap), exercised across a two-hop re-export chain instead of one.",
  },
  "ADV-018": {
    files: ["src/analysis/reachability.ts"],
    component: "reachability model has no control-flow/dead-code elimination",
    explanation:
      "VulnTrace's reachability (docs/SDD.md § 20) is call-graph reachability: whether any call edge exists from an entrypoint to the target, not whether a surrounding branch condition is statically true. A lexically-present call behind `if (false)` is not distinguished from a live one, because the analyzer does no branch-condition/dead-code evaluation -- an explicit, deliberate MVP scope boundary, not an oversight, but one that means 'reachable' does not mean 'provably executes'.",
  },
  "ADV-019": {
    files: ["src/code-intelligence/call-graph.ts"],
    component:
      "call-graph edge construction records no edge at all for an indirectly-invoked parameter",
    explanation:
      'Confirmed by direct inspection: the graph correctly records a resolved `direct` edge from main() to invoke() (a same-file direct call), but records ZERO edges -- not even an "unknown" one -- for invoke()\'s own `fn()` call on its parameter. A function value passed as an argument and invoked indirectly is not merely mis-resolved, it is entirely absent from the graph: the vulnerable dependency is never flagged as a blocker, it simply does not exist as far as reachability search is concerned.',
  },
  "ADV-020": {
    files: ["src/code-intelligence/call-graph.ts"],
    component:
      "call-graph traversal never visits the target file for a bare `new X()` construction",
    explanation:
      "Confirmed by direct inspection: the graph for this scenario contains only main()'s own node -- zero edges, and no node at all for adv-vuln-lib's index.js. `new Vulnerable()` (a NewExpression) does not trigger import-following/edge-recording the way a direct call or `import`-edge does, so the vulnerable file is never even discovered, let alone flagged as reachable or unknown. This is a call-graph-construction gap, not a target-resolution gap: kind: \"constructor\" is a real, named target kind (SDD § 13) with no corresponding graph support.",
  },
  "ADV-021": {
    files: ["src/code-intelligence/call-graph.ts"],
    component:
      "call-graph traversal never visits the target file for a method call on a locally-constructed instance",
    explanation:
      "Confirmed by direct inspection: identical to ADV-020 -- the graph contains only main()'s own node. `const instance = new Lib(); instance.vulnerableMethod();` never causes adv-vuln-lib's index.js to be visited at all. kind: \"method\" is a real, named target kind (SDD § 13) with no corresponding graph support for instance-method calls.",
  },
  "ADV-025": {
    files: [
      "src/analysis/verdict.ts",
      "src/code-intelligence/module-resolver.ts",
    ],
    component:
      "checkReachability's rule-target resolution uses the wrong importer context, landing on a different conditional-exports branch than the real call site",
    explanation:
      'Confirmed by direct inspection: the call graph itself resolves main()\'s import correctly through the "import" condition to esm/index.js#vulnerable (a real edge exists to that exact node). But checkReachability resolves the rule\'s target.module separately, via `resolver.resolve(target.module, path.join(projectRoot, "package.json"))` -- using package.json itself, not the real importing file, as the resolution context. Resolving relative to package.json lands on the "require" branch instead (cjs/index.js), a file the call graph never visited. findOrPhantomTarget then can\'t find a graph node there, falls back to a phantom node, and reports confirmed-unreachable even though the real, call-graph-verified path to esm/index.js#vulnerable exists a few lines away in the same output.',
  },
  "ADV-026": {
    files: ["src/analysis/verdict.ts"],
    component:
      "checkReachability's rule-target resolution always uses the project root's own package.json as the resolution context (same root cause as ADV-025)",
    explanation:
      "Confirmed by direct inspection: the call graph traversal is entirely correct here -- it contains a complete, real path from main() through adv-consumer's useIt() to the actually-installed, nested adv-vuln-lib@1.0.0's vulnerable() node. The false NOT_AFFECTED comes purely from checkReachability's separate rule-target resolution step: `resolver.resolve(target.module, path.join(projectRoot, \"package.json\"))` resolves \"adv-vuln-lib\" from the project root's own context, landing on the unrelated top-level adv-vuln-lib@2.0.0 instead of the nested 1.0.0 instance the graph actually traversed. This is the identical mechanism as ADV-025 -- referenceFile = <projectRoot>/package.json is the wrong resolution context whenever it disagrees with the real call site's own context (a different installed instance, or a different conditional-exports branch). Documented narrowly (multi-version only) as a known limitation in ADR-0007's \"Multiple/nested package versions\" section; the conditional-exports failure mode (ADV-025) shows the same referenceFile choice is the actual root cause, not multi-version specifically.",
  },
  "ADV-023": {
    files: [
      "src/code-intelligence/module-resolver.ts",
      "src/code-intelligence/ts-project.ts",
    ],
    component:
      "TypeScript path-alias resolution fails end-to-end despite baseUrl/paths loading correctly",
    explanation:
      'Confirmed by direct inspection: `loadTsProject` correctly discovers and loads this fixture\'s own tsconfig.json -- `baseUrl`/`paths` for `@lib/*` are present in the resulting compiler options. Yet calling the real resolver directly, `resolver.resolve("@lib/wrapper", ".../src/index.ts")`, still returns `{ kind: "unresolved" }`, and the call graph correspondingly records an `unknown (unresolved_module)` edge for main()\'s import. This is despite src/code-intelligence/module-resolver.test.ts having dedicated, passing unit tests for baseUrl/paths mapping -- meaning those unit tests\' own TS-program setup does not fully represent what happens when a real tsconfig.json is discovered and loaded via loadTsProject against an actual fixture project on disk. A concrete demonstration of why unit-level coverage of a resolver mechanism is not a substitute for fixture-suite/E2E proof (the exact gap already flagged for the typescript-paths fixture category in the prior MVP audit).',
  },
  "ADV-030": {
    files: ["src/code-intelligence/call-graph.ts"],
    component:
      "dynamic-call detection is purely syntactic and is evaded by one extra variable assignment",
    explanation:
      'Confirmed by direct inspection: the graph for this scenario contains only main()\'s own node -- zero edges, not even an "unknown" one. `lib[key]()` (ADV-014, calling the computed member directly) IS correctly recognized and flagged as an unknown/dynamic edge. But `const fn = lib[key]; fn();` -- the identical runtime behavior, split across one extra local-variable assignment -- produces no edge at all, silently. Reachability search then finds zero blockers and zero paths, and reports NOT_AFFECTED with full confidence for a call the analyzer never actually looked at. This is the most severe failure mode in this suite: it is not merely an accuracy gap, it silently converts unresolved dynamic behavior into NOT_AFFECTED, which AGENTS.md names as the one thing the analyzer must never do.',
  },
  "ADV-032": {
    files: ["src/analysis/verdict.ts"],
    component:
      "entrypointSourceNodes treats every export of a configured entrypoint FILE as a reachability source",
    explanation:
      "VulnTrace's entrypoint configuration (analysis.entrypoints) is file-granular, not function-granular. entrypointSourceNodes -- added to fix a real, different gap (an entrypoint's own exports that are never called at the file's own top level must still be searchable) -- treats every export of a configured entrypoint file as an equally valid reachability source. There is no way to express 'only this one function within this file is the real entrypoint'; any other export in the same file gets identical treatment, however unrelated its own purpose.",
  },
};

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const FIXTURES_ROOT = path.join(REPO_ROOT, "fixtures", "adversarial");
const REPORT_PATH = path.join(REPO_ROOT, "tests", "adversarial", "REPORT.md");

const oracle: readonly OracleEntry[] = JSON.parse(
  readFileSync(
    path.join(REPO_ROOT, "tests", "adversarial", "expected.json"),
    "utf-8",
  ),
) as OracleEntry[];

function fakeProvider(
  byPackageName: Readonly<Record<string, readonly RawVulnerability[]>>,
): VulnerabilityProvider {
  return {
    queryPackage(query: PackageQuery): Promise<readonly RawVulnerability[]> {
      return Promise.resolve(byPackageName[query.name] ?? []);
    },
  };
}

function fakeIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (t: string) => stdout.push(t),
      stderr: (t: string) => stderr.push(t),
    },
    stdout,
    stderr,
  };
}

/**
 * Every scenario's vulnerable dependency is named `adv-vuln-lib`, affected
 * for versions < 2.0.0 (see gen-adversarial's shared record). One synthetic
 * OSV-shaped record, injected the same way TASK-025's e2e test injects
 * `fixture-lib`'s -- this is the only non-real piece of the pipeline;
 * dependency graph, module resolution, call graph, reachability, verdict
 * and JSON output all run for real against real files on disk.
 */
const ADV_GHSA: RawVulnerability = {
  id: "GHSA-adv-0001",
  aliases: [],
  affected: [
    {
      package: { ecosystem: "npm", name: "adv-vuln-lib" },
      ranges: [
        { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "2.0.0" }] },
      ],
    },
  ],
  references: [],
};

const provider = fakeProvider({ "adv-vuln-lib": [ADV_GHSA] });

const results: ScenarioResult[] = [];

describe("VulnTrace adversarial validation suite", () => {
  for (const scenario of oracle) {
    it(`${scenario.id} ${scenario.description}`, async () => {
      const fixtureDir = path.join(FIXTURES_ROOT, scenario.dir);
      const { io, stdout, stderr } = fakeIo();

      const exitCode = await runScanCommand({
        projectPathArg: fixtureDir,
        configPathOverride: path.join(fixtureDir, "vulntrace.yml"),
        provider,
        noCache: true,
        io,
      });

      let actual = "NO_OUTPUT";
      let schemaIssues: unknown[] = [];
      try {
        const output = JSON.parse(stdout.join("")) as {
          findings: ReadonlyArray<{
            package: string;
            version: string;
            verdict: string;
          }>;
        };
        schemaIssues = validateScanOutput(output);
        const match = output.findings.find(
          (f) =>
            f.package === scenario.findingSelector.package &&
            f.version === scenario.findingSelector.version,
        );
        actual = match ? match.verdict : "NO_FINDING";
      } catch {
        actual = "UNPARSEABLE_OUTPUT";
      }

      results.push({
        id: scenario.id,
        category: scenario.category,
        description: scenario.description,
        expected: scenario.expected,
        actual,
        pass: actual === scenario.expected,
      });

      expect(
        schemaIssues,
        `${scenario.id}: exit ${exitCode}, stderr: ${stderr.join("")}`,
      ).toEqual([]);
      expect(
        actual,
        `${scenario.id} (${scenario.category}): expected ${scenario.expected}, got ${actual}.\n` +
          `Human rationale: ${scenario.reason}\n` +
          `stderr: ${stderr.join("")}`,
      ).toBe(scenario.expected);
    });
  }

  afterAll(() => {
    writeReport();
    printTable();
  });
});

function printTable(): void {
  const rows = [...results].sort((a, b) => a.id.localeCompare(b.id));
  const lines: string[] = [];
  lines.push("ID       EXPECTED        ACTUAL          RESULT");
  lines.push("------------------------------------------------");
  for (const r of rows) {
    lines.push(
      r.id.padEnd(9) +
        r.expected.padEnd(16) +
        r.actual.padEnd(16) +
        (r.pass ? "PASS" : "FAIL"),
    );
  }
  const passed = rows.filter((r) => r.pass).length;
  lines.push("------------------------------------------------");
  lines.push(
    `${passed}/${rows.length} passed (${((passed / rows.length) * 100).toFixed(1)}%)`,
  );
  console.log("\n" + lines.join("\n") + "\n");
}

function accuracyFor(verdict: string): { total: number; correct: number } {
  const subset = results.filter((r) => r.expected === verdict);
  return { total: subset.length, correct: subset.filter((r) => r.pass).length };
}

function writeReport(): void {
  const rows = [...results].sort((a, b) => a.id.localeCompare(b.id));
  const total = rows.length;
  const passed = rows.filter((r) => r.pass).length;
  const failed = total - passed;
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : "0.0";

  const byCategory = new Map<string, ScenarioResult[]>();
  for (const r of rows) {
    const list = byCategory.get(r.category) ?? [];
    list.push(r);
    byCategory.set(r.category, list);
  }

  const affected = accuracyFor("AFFECTED");
  const notAffected = accuracyFor("NOT_AFFECTED");
  const unknown = accuracyFor("UNKNOWN");

  const falsePositives = rows.filter(
    (r) => r.expected === "NOT_AFFECTED" && r.actual === "AFFECTED",
  );
  const falseNegatives = rows.filter(
    (r) =>
      r.expected === "AFFECTED" &&
      (r.actual === "NOT_AFFECTED" || r.actual === "UNKNOWN"),
  );
  const incorrectUnknown = rows.filter(
    (r) => r.expected === "UNKNOWN" && r.actual !== "UNKNOWN",
  );
  const wronglyCoercedToNotAffected = rows.filter(
    (r) =>
      (r.expected === "AFFECTED" || r.expected === "UNKNOWN") &&
      r.actual === "NOT_AFFECTED",
  );

  const lines: string[] = [];
  lines.push("# VulnTrace Adversarial Validation Report");
  lines.push("");
  lines.push(
    "Generated by `npm run test:adversarial` (`tests/adversarial/adversarial.test.ts`). " +
      "Expected verdicts come from `tests/adversarial/expected.json`, authored independently " +
      "of VulnTrace's own output by reading each scenario's source code.",
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total scenarios: ${total}`);
  lines.push(`- Passed: ${passed}`);
  lines.push(`- Failed: ${failed}`);
  lines.push(`- Pass rate: ${passRate}%`);
  lines.push("");
  lines.push("## Accuracy by expected verdict");
  lines.push("");
  lines.push("| Verdict | Correct | Total | Accuracy |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(
    `| AFFECTED | ${affected.correct} | ${affected.total} | ${pct(affected)} |`,
  );
  lines.push(
    `| NOT_AFFECTED | ${notAffected.correct} | ${notAffected.total} | ${pct(notAffected)} |`,
  );
  lines.push(
    `| UNKNOWN | ${unknown.correct} | ${unknown.total} | ${pct(unknown)} |`,
  );
  lines.push("");
  lines.push("## Breakdown by scenario category");
  lines.push("");
  lines.push("| Category | Passed | Total |");
  lines.push("| --- | --- | --- |");
  for (const [category, list] of byCategory) {
    const catPassed = list.filter((r) => r.pass).length;
    lines.push(`| ${category} | ${catPassed} | ${list.length} |`);
  }
  lines.push("");
  lines.push("## Result table");
  lines.push("");
  lines.push("```");
  lines.push("ID       EXPECTED        ACTUAL          RESULT");
  lines.push("------------------------------------------------");
  for (const r of rows) {
    lines.push(
      r.id.padEnd(9) +
        r.expected.padEnd(16) +
        r.actual.padEnd(16) +
        (r.pass ? "PASS" : "FAIL"),
    );
  }
  lines.push("```");
  lines.push("");
  lines.push("## Failures");
  lines.push("");
  if (failed === 0) {
    lines.push("No failures.");
  } else {
    for (const r of rows.filter((x) => !x.pass)) {
      const oracleEntry = oracle.find((o) => o.id === r.id);
      const analysis = ANALYSIS[r.id];
      lines.push(`### ${r.id} -- ${r.description}`);
      lines.push("");
      lines.push(`- Category: ${r.category}`);
      lines.push(`- Expected: **${r.expected}**`);
      lines.push(`- Actual: **${r.actual}**`);
      if (oracleEntry) {
        lines.push(
          `- Human rationale for expected verdict: ${oracleEntry.reason}`,
        );
      }
      if (analysis) {
        lines.push(`- Suspected analyzer component: ${analysis.component}`);
        lines.push(
          `- Relevant source files: ${analysis.files.map((f) => "`" + f + "`").join(", ")}`,
        );
        lines.push(`- Explanation: ${analysis.explanation}`);
      } else {
        lines.push(
          "- No pre-registered mechanism analysis for this scenario -- needs manual investigation.",
        );
      }
      lines.push("");
    }
  }
  lines.push("## Classification errors");
  lines.push("");
  lines.push(
    `- False positives (expected NOT_AFFECTED, got AFFECTED): ${falsePositives.length}`,
  );
  for (const r of falsePositives) lines.push(`  - ${r.id}: ${r.description}`);
  lines.push(
    `- False negatives (expected AFFECTED, got NOT_AFFECTED or UNKNOWN): ${falseNegatives.length}`,
  );
  for (const r of falseNegatives)
    lines.push(`  - ${r.id}: ${r.description} (got ${r.actual})`);
  lines.push(
    `- Incorrect UNKNOWN handling (expected UNKNOWN, got something else): ${incorrectUnknown.length}`,
  );
  for (const r of incorrectUnknown)
    lines.push(`  - ${r.id}: ${r.description} (got ${r.actual})`);
  lines.push(
    `- AFFECTED/UNKNOWN silently coerced to NOT_AFFECTED (the one thing AGENTS.md forbids outright): ${wronglyCoercedToNotAffected.length}`,
  );
  for (const r of wronglyCoercedToNotAffected)
    lines.push(`  - ${r.id}: ${r.description} (expected ${r.expected})`);
  lines.push("");

  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, lines.join("\n") + "\n");
}

function pct(a: { total: number; correct: number }): string {
  return a.total > 0 ? `${((a.correct / a.total) * 100).toFixed(1)}%` : "n/a";
}
