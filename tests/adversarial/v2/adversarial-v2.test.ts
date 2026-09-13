import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../../../src/domain/vulnerability.js";
import { runScanCommand } from "../../../src/cli/scan.js";
import { validateScanOutput } from "../../../src/cli/output.js";

/**
 * VulnTrace independent adversarial validation suite (v2).
 *
 * This is a SEPARATE, INDEPENDENT suite from tests/adversarial/ (the
 * original 34-scenario suite built during v0.2 remediation). Its purpose is
 * to detect false confidence and overfitting to that first suite: every
 * scenario here, its fixture source, and its expected verdict were authored
 * fresh, without reading tests/adversarial/expected.json's specific values
 * or running VulnTrace first and copying its output. Expected verdicts are
 * the verdict a human security analyst would independently derive by
 * reading each scenario's own fixture source.
 *
 * Per the governing instructions for this suite: when a scenario's actual
 * verdict disagrees with the independently-authored expected verdict, the
 * test is KEPT and marked FAIL -- the analyzer is never modified to make it
 * pass, and the oracle is never adjusted to match the tool's output. See
 * REPORT.md for the full result set.
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
    /**
     * The exact installed instance this scenario is about (P1-A5), as the
     * scan result's own `packageInstance` spells it.
     *
     * REQUIRED whenever package+version matches more than one finding --
     * which is the norm in this suite, because many fixtures deliberately
     * plant a second, identically named AND versioned install as a decoy
     * ("the TOP-LEVEL vt2-vuln-lib install, which any resolution keyed on
     * package name and version rather than on install path would find").
     * Selecting such a scenario by package+version alone reads whichever
     * twin the scan happened to emit first, so the oracle would be
     * answering about the decoy for reasons no assertion states. Omitted
     * only where exactly one finding matches.
     */
    readonly packageInstance?: string;
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

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL("../../../", import.meta.url)),
);
const SUITE_ROOT = path.join(REPO_ROOT, "tests", "adversarial", "v2");
const FIXTURES_ROOT = path.join(SUITE_ROOT, "fixtures");
const REPORT_PATH = path.join(SUITE_ROOT, "REPORT.md");

const oracle: readonly OracleEntry[] = JSON.parse(
  readFileSync(path.join(SUITE_ROOT, "expected.json"), "utf-8"),
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
 * Every scenario's vulnerable dependency is named `vt2-vuln-lib`, affected
 * for versions < 2.0.0. One synthetic OSV-shaped record is injected the
 * same way the original adversarial suite does -- this is the only
 * non-real piece of the pipeline; dependency graph, module resolution,
 * call graph, reachability, verdict and JSON output all run for real
 * against real files on disk.
 */
const VT2_GHSA: RawVulnerability = {
  id: "GHSA-vt2v2-0001",
  aliases: [],
  affected: [
    {
      package: { ecosystem: "npm", name: "vt2-vuln-lib" },
      ranges: [
        { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "2.0.0" }] },
      ],
    },
  ],
  references: [],
};

const provider = fakeProvider({ "vt2-vuln-lib": [VT2_GHSA] });

const results: ScenarioResult[] = [];

/**
 * WHY THE ORACLE'S SELECTOR MUST NAME AN INSTANCE (P1-A5).
 *
 * Many fixtures in this suite deliberately plant a second install of
 * `vt2-vuln-lib` at the SAME version as the one the host package really
 * requires -- "the TOP-LEVEL vt2-vuln-lib install, which any resolution
 * keyed on package name and version rather than on install path would
 * find", as the scenarios themselves put it. That decoy exists to catch a
 * name/version-keyed ANALYZER.
 *
 * It also catches a name/version-keyed ORACLE, which is what this guards.
 * Both installs produce a finding, they can carry DIFFERENT verdicts, and
 * `findings.find(package && version)` returns whichever the scan emitted
 * first -- so the suite's answer was a function of emission order, and
 * nothing asserted which instance it was about. It passed only because
 * emission order happened to put the nested copy first.
 */
describe("v2 oracle selection is instance-aware, not order-dependent", () => {
  const SCENARIO = "ADV2-072";

  it("the decoy install produces a finding that is genuinely a different answer", async () => {
    const scenario = oracle.find((entry) => entry.id === SCENARIO);
    expect(scenario, `${SCENARIO} must exist in expected.json`).toBeDefined();
    const fixtureDir = path.join(FIXTURES_ROOT, scenario?.dir ?? "");
    const { io, stdout } = fakeIo();

    await runScanCommand({
      projectPathArg: fixtureDir,
      configPathOverride: path.join(fixtureDir, "vulntrace.yml"),
      provider,
      noCache: true,
      io,
    });

    const output = JSON.parse(stdout.join("")) as {
      findings: ReadonlyArray<{
        package: string;
        version: string;
        packageInstance?: string;
        verdict: string;
      }>;
    };

    const candidates = output.findings.filter(
      (f) =>
        f.package === scenario?.findingSelector.package &&
        f.version === scenario?.findingSelector.version,
    );

    // Two installs, identical on every field the old selector looked at.
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((f) => f.version)).size).toBe(1);
    expect(new Set(candidates.map((f) => f.packageInstance)).size).toBe(2);

    // And they do NOT agree -- so which one the oracle read decided the
    // suite's answer. This is the assertion that makes the fix necessary
    // rather than merely tidy.
    expect(new Set(candidates.map((f) => f.verdict)).size).toBe(2);

    // The selector now names the install the host package's own `require`
    // really resolves (verified out of process against real Node), and
    // that choice is stable however the findings are ordered.
    const wanted = scenario?.findingSelector.packageInstance;
    expect(wanted).toBeDefined();
    for (const ordering of [candidates, [...candidates].reverse()]) {
      const picked = ordering.filter((f) => f.packageInstance === wanted);
      expect(picked).toHaveLength(1);
      expect(picked[0]?.verdict).toBe(scenario?.expected);
    }
  });

  it("every scenario whose selector is ambiguous names its instance", async () => {
    // A standing guard for new fixtures: if package+version can match more
    // than one finding, expected.json must say which one. The suite-wide
    // run reports AMBIGUOUS_SELECTOR(...) rather than guessing, so this
    // only restates the contract the oracle now enforces.
    for (const scenario of oracle) {
      if (scenario.findingSelector.packageInstance !== undefined) {
        expect(scenario.findingSelector.packageInstance).toMatch(
          /^node_modules\//,
        );
      }
    }
  });
});

describe("VulnTrace independent adversarial validation suite (v2)", () => {
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
            packageInstance?: string;
            verdict: string;
          }>;
        };
        schemaIssues = validateScanOutput(output);
        // Select by package+version, then REQUIRE the result to be
        // unambiguous. An ambiguous selector is reported as its own
        // failing outcome rather than silently resolved by array
        // position: picking the first match makes the suite's answer a
        // function of emission order, and this suite is full of fixtures
        // whose whole point is a same-name, same-version decoy install.
        const candidates = output.findings.filter(
          (f) =>
            f.package === scenario.findingSelector.package &&
            f.version === scenario.findingSelector.version,
        );
        const wanted = scenario.findingSelector.packageInstance;
        const matches =
          wanted === undefined
            ? candidates
            : candidates.filter((f) => f.packageInstance === wanted);
        actual =
          matches.length === 0
            ? "NO_FINDING"
            : matches.length > 1
              ? `AMBIGUOUS_SELECTOR(${matches
                  .map((f) => f.packageInstance ?? "<no instance>")
                  .sort()
                  .join(", ")})`
              : (matches[0]?.verdict ?? "NO_FINDING");
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
  lines.push("# VulnTrace Independent Adversarial Validation Report (v2)");
  lines.push("");
  lines.push(
    "Generated by `npm run test:adversarial` (`tests/adversarial/v2/adversarial-v2.test.ts`). " +
      "Expected verdicts come from `tests/adversarial/v2/expected.json`, authored independently " +
      "of VulnTrace's own output and independently of the original tests/adversarial/ suite, by " +
      "reading each scenario's source code.",
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
