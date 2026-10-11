import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";
import { renderHtmlReport } from "./html-report.js";
import {
  SCHEMA_VERSION,
  validateScanOutput,
  type ScanOutput,
} from "./output.js";
import { runScanCommand } from "./scan.js";

/**
 * Task B-5 -- CLI and output, end to end through a real scan.
 *
 *  - AUD-12: an all-UNKNOWN scan exited 0, exactly like a clean one, and
 *    the output carried no summary. Decision 3 (REMEDIATION-PLAN § 6.1
 *    item 3): exit 0 only when nothing is AFFECTED and every candidate is
 *    decided, 1 when something is AFFECTED, a new code (5) when nothing is
 *    AFFECTED and something is undecided; `--lenient-exit` restores 0 for
 *    that case; the JSON output always carries counts.
 *  - A `--cve` filter that matches nothing said so nowhere.
 *  - PRM-36: the versionless instance's "no advisory" detail was computed
 *    from the `--cve`-filtered set.
 *  - PRM-110: the HTML overview read "no reason recorded" for an UNKNOWN
 *    whose reason is recorded in `unknownReasons` only.
 *
 * The fixture is loud: `vuln-lib` exports `danger` and `safe`, and every
 * rule targets `danger`. Which outcome a scan has is chosen by the
 * advisories the stub provider returns and by what the application calls,
 * never by weakening the analysis.
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CONFIG =
  "analysis:\n  entrypoints:\n    - src/index.js\nrules:\n  files:\n    - rules.yml\n";

const LIB_SOURCE =
  "function danger(x){ return x; }\n" +
  "function safe(x){ return x; }\n" +
  "module.exports = { danger, safe };\n";

function rules(...ids: string[]): string {
  if (ids.length === 0) {
    return "rules: []\n";
  }
  return (
    "rules:\n" +
    ids
      .map(
        (id) =>
          `  - id: ${id}\n` +
          `    package:\n` +
          `      name: vuln-lib\n` +
          `    targets:\n` +
          `      - module: vuln-lib\n` +
          `        export: danger\n` +
          `        kind: function\n` +
          `        confidence: 1.0\n`,
      )
      .join("")
  );
}

/** An advisory for `vuln-lib`, affected in [introduced, fixed). */
function advisory(
  id: string,
  options: {
    readonly introduced?: string;
    readonly fixed?: string;
    readonly name?: string;
    readonly aliases?: readonly string[];
    readonly withdrawn?: string;
  } = {},
): RawVulnerability {
  return {
    id,
    ...(options.aliases !== undefined ? { aliases: options.aliases } : {}),
    ...(options.withdrawn !== undefined
      ? { withdrawn: options.withdrawn }
      : {}),
    affected: [
      {
        package: { ecosystem: "npm", name: options.name ?? "vuln-lib" },
        ranges: [
          {
            type: "SEMVER",
            events: [
              { introduced: options.introduced ?? "0" },
              { fixed: options.fixed ?? "2.0.0" },
            ],
          },
        ],
      },
    ],
  } as unknown as RawVulnerability;
}

/** A record the normalizer cannot use (B-1: an `undetermined` entry). */
const MALFORMED = {
  id: "GHSA-b5-malformed",
  affected: "not an array",
} as unknown as RawVulnerability;

/**
 * Returns every advisory that names the queried package, whatever the
 * version: applicability is the scan's job (`matchVersion`), so an
 * out-of-range advisory reaches it and becomes `not_applicable`.
 */
function stub(advisories: readonly RawVulnerability[]): VulnerabilityProvider {
  return {
    queryPackage(query: PackageQuery) {
      return Promise.resolve(
        advisories.filter((entry) => {
          const affected = (entry as unknown as { affected?: unknown })
            .affected;
          return Array.isArray(affected)
            ? affected.some(
                (item: { package: { name: string } }) =>
                  item.package.name === query.name,
              )
            : query.name === "vuln-lib";
        }),
      );
    },
  };
}

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-b5-"));
  dirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return root;
}

/** One installed `vuln-lib@1.0.0`; the application calls `call`. */
function projectWithLib(
  call: "danger" | "safe",
  ruleIds: readonly string[],
): string {
  return project({
    "vulntrace.yml": CONFIG,
    "rules.yml": rules(...ruleIds),
    "package.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { "vuln-lib": "1.0.0" },
    }),
    "package-lock.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "app",
          version: "1.0.0",
          dependencies: { "vuln-lib": "1.0.0" },
        },
        "node_modules/vuln-lib": { version: "1.0.0" },
      },
    }),
    "src/index.js":
      'const lib = require("vuln-lib");\n' +
      `function main(input) { return lib.${call}(input); }\n` +
      "module.exports = { main };\n",
    "node_modules/vuln-lib/package.json": JSON.stringify({
      name: "vuln-lib",
      version: "1.0.0",
    }),
    "node_modules/vuln-lib/index.js": LIB_SOURCE,
  });
}

/** The summary decision 3 asks for (schema 0.8). */
interface Summary {
  readonly outcome: string;
  readonly findings: object;
  readonly unreportedCandidates: object;
}

interface Run {
  readonly exit: number;
  readonly output: ScanOutput & { readonly summary?: Summary };
  readonly stderr: string;
  readonly text: string;
}

async function scan(
  root: string,
  provider: VulnerabilityProvider,
  options: {
    readonly cveFilter?: string;
    readonly lenientExit?: boolean;
    readonly format?: "json" | "html";
  } = {},
): Promise<Run> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
  };
  const common = {
    projectPathArg: root,
    configPathOverride: path.join(root, "vulntrace.yml"),
    provider,
    noCache: true,
    ...(options.cveFilter !== undefined
      ? { cveFilter: options.cveFilter }
      : {}),
    ...(options.lenientExit !== undefined
      ? { lenientExit: options.lenientExit }
      : {}),
  };
  if (options.format === "html") {
    const outputPath = path.join(root, "report.html");
    const exit = await runScanCommand({
      ...common,
      format: "html",
      outputPath,
      io,
    });
    return {
      exit,
      output: undefined as unknown as ScanOutput,
      stderr: stderr.join(""),
      text: readFileSync(outputPath, "utf-8"),
    };
  }
  const exit = await runScanCommand({ ...common, io });
  const text = stdout.join("");
  if (text === "") {
    throw new Error(`scan wrote no output (exit ${exit}): ${stderr.join("")}`);
  }
  return {
    exit,
    output: JSON.parse(text) as ScanOutput,
    stderr: stderr.join(""),
    text,
  };
}

const PAST = "2020-01-01T00:00:00Z";

/** Each outcome's fixture: a project and a provider, nothing else. */
const OUTCOMES = {
  affected: () => ({
    root: projectWithLib("danger", ["GHSA-b5-affected"]),
    provider: stub([advisory("GHSA-b5-affected")]),
  }),
  affectedAndUnknown: () => ({
    root: projectWithLib("danger", ["GHSA-b5-affected"]),
    provider: stub([advisory("GHSA-b5-affected"), advisory("GHSA-b5-norule")]),
  }),
  // No rule for the advisory: an UNKNOWN (`no_vulnerable_symbol_rule`),
  // AUD-12's own reproduction (two such findings).
  allUnknown: () => ({
    root: projectWithLib("danger", []),
    provider: stub([advisory("GHSA-b5-norule"), advisory("GHSA-b5-norule2")]),
  }),
  notAffected: () => ({
    root: projectWithLib("safe", ["GHSA-b5-unreached"]),
    provider: stub([advisory("GHSA-b5-unreached")]),
  }),
  notApplicable: () => ({
    root: projectWithLib("danger", ["GHSA-b5-later"]),
    provider: stub([
      advisory("GHSA-b5-later", { introduced: "5.0.0", fixed: "6.0.0" }),
    ]),
  }),
  withdrawn: () => ({
    root: projectWithLib("danger", ["GHSA-b5-withdrawn"]),
    provider: stub([advisory("GHSA-b5-withdrawn", { withdrawn: PAST })]),
  }),
  undeterminedOnly: () => ({
    root: projectWithLib("danger", []),
    provider: stub([MALFORMED]),
  }),
  nothing: () => ({
    root: projectWithLib("danger", []),
    provider: stub([]),
  }),
} as const;

type Outcome = keyof typeof OUTCOMES;

async function run(
  outcome: Outcome,
  options: { readonly lenientExit?: boolean; readonly format?: "html" } = {},
): Promise<Run> {
  const { root, provider } = OUTCOMES[outcome]();
  return scan(root, provider, options);
}

describe("B-5 (AUD-12, decision 3): the exit code says whether anything was left undecided", () => {
  it.each<[Outcome, number, number]>([
    // outcome, strict exit, lenient exit
    ["affected", 1, 1],
    ["affectedAndUnknown", 1, 1],
    ["allUnknown", 5, 0],
    ["undeterminedOnly", 5, 0],
    ["notAffected", 0, 0],
    ["notApplicable", 0, 0],
    ["withdrawn", 0, 0],
    ["nothing", 0, 0],
  ])(
    "%s exits %i, and %i with --lenient-exit",
    async (outcome, strict, lenient) => {
      expect((await run(outcome)).exit).toBe(strict);
      expect((await run(outcome, { lenientExit: true })).exit).toBe(lenient);
    },
  );

  it("each fixture has the shape its name says (the exit codes above test what they claim)", async () => {
    const verdicts = async (outcome: Outcome) =>
      (await run(outcome)).output.findings.map((finding) => finding.verdict);
    const dispositions = async (outcome: Outcome) =>
      (await run(outcome)).output.unreportedCandidates?.map(
        (entry) => entry.disposition,
      );
    expect(await verdicts("affected")).toEqual(["AFFECTED"]);
    expect((await verdicts("affectedAndUnknown")).sort()).toEqual([
      "AFFECTED",
      "UNKNOWN",
    ]);
    expect(await verdicts("allUnknown")).toEqual(["UNKNOWN", "UNKNOWN"]);
    expect(await verdicts("notAffected")).toEqual(["NOT_AFFECTED"]);
    expect(await verdicts("notApplicable")).toEqual([]);
    expect(await dispositions("notApplicable")).toEqual(["not_applicable"]);
    expect(await verdicts("withdrawn")).toEqual([]);
    expect(await dispositions("withdrawn")).toEqual(["withdrawn"]);
    expect(await verdicts("undeterminedOnly")).toEqual([]);
    expect(await dispositions("undeterminedOnly")).toEqual(["undetermined"]);
    expect(await verdicts("nothing")).toEqual([]);
    expect(await dispositions("nothing")).toEqual([]);
  });

  it("an undetermined identity entry (B-4: a versionless instance with no advisory) exits 5", async () => {
    const root = project({
      "vulntrace.yml": CONFIG,
      "rules.yml": rules(),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "vuln-lib": "1.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": { name: "app", version: "1.0.0" },
          "node_modules/vuln-lib": { name: "vuln-lib" },
        },
      }),
      "src/index.js":
        'const lib = require("vuln-lib");\nmodule.exports = { main: (x) => lib.safe(x) };\n',
      "node_modules/vuln-lib/package.json": JSON.stringify({
        name: "vuln-lib",
      }),
      "node_modules/vuln-lib/index.js": LIB_SOURCE,
    });
    const result = await scan(root, stub([]));
    expect(result.output.findings).toEqual([]);
    expect(
      result.output.unreportedCandidates?.map((entry) => entry.reason),
    ).toEqual(["installed_version_unavailable"]);
    expect(result.exit).toBe(5);
  });

  it("the HTML format exits with the same code as JSON", async () => {
    const html = await run("allUnknown", { format: "html" });
    expect(html.exit).toBe(5);
    expect(html.text).toContain("GHSA-b5-norule");
    expect(
      (await run("allUnknown", { format: "html", lenientExit: true })).exit,
    ).toBe(0);
    expect((await run("affected", { format: "html" })).exit).toBe(1);
    expect((await run("notAffected", { format: "html" })).exit).toBe(0);
  });

  it("says on stderr why it exits 5", async () => {
    const result = await run("allUnknown");
    expect(result.stderr).toMatch(/undecided/);
    expect(result.stderr).toMatch(/--lenient-exit/);
  });
});

describe("B-5 (AUD-12, decision 3): the JSON output always carries a summary of its own counts", () => {
  it.each<[Outcome, string]>([
    ["affected", "affected"],
    ["affectedAndUnknown", "affected"],
    ["allUnknown", "undecided"],
    ["undeterminedOnly", "undecided"],
    ["notAffected", "decided"],
    ["notApplicable", "decided"],
    ["withdrawn", "decided"],
    ["nothing", "decided"],
  ])(
    "%s: outcome %s, and counts equal to its own arrays",
    async (outcome, expected) => {
      const { output, exit } = await run(outcome);
      expect(validateScanOutput(output)).toEqual([]);
      expect(output.schemaVersion).toBe("0.8");
      const count = <T>(items: readonly T[], test: (item: T) => boolean) =>
        items.filter(test).length;
      const entries = output.unreportedCandidates ?? [];
      expect(output.summary).toEqual({
        outcome: expected,
        findings: {
          AFFECTED: count(output.findings, (f) => f.verdict === "AFFECTED"),
          NOT_AFFECTED: count(
            output.findings,
            (f) => f.verdict === "NOT_AFFECTED",
          ),
          UNKNOWN: count(output.findings, (f) => f.verdict === "UNKNOWN"),
        },
        unreportedCandidates: {
          not_applicable: count(
            entries,
            (e) => e.disposition === "not_applicable",
          ),
          undetermined: count(entries, (e) => e.disposition === "undetermined"),
          withdrawn: count(entries, (e) => e.disposition === "withdrawn"),
        },
      });
      // The exit code is the outcome's, never computed separately.
      expect(exit).toBe({ affected: 1, undecided: 5, decided: 0 }[expected]);
    },
  );

  it("the summary is the same with --lenient-exit (the flag changes the exit code only)", async () => {
    const strict = await run("allUnknown");
    const lenient = await run("allUnknown", { lenientExit: true });
    expect(lenient.output.summary).toEqual(strict.output.summary);
    expect(lenient.output.summary?.outcome).toBe("undecided");
  });

  it("is schema 0.8", () => {
    expect(SCHEMA_VERSION).toBe("0.8");
  });

  it.each<[string, (summary: Record<string, unknown>) => unknown]>([
    ["an unknown outcome", (s) => ({ ...s, outcome: "clean" })],
    [
      "a negative count",
      (s) => ({
        ...s,
        findings: { AFFECTED: -1, NOT_AFFECTED: 0, UNKNOWN: 0 },
      }),
    ],
    [
      "a fractional count",
      (s) => ({
        ...s,
        findings: { AFFECTED: 0.5, NOT_AFFECTED: 0, UNKNOWN: 0 },
      }),
    ],
    [
      "a missing verdict count",
      (s) => ({ ...s, findings: { AFFECTED: 0, NOT_AFFECTED: 0 } }),
    ],
    [
      "an extra disposition",
      (s) => ({
        ...s,
        unreportedCandidates: {
          not_applicable: 0,
          undetermined: 0,
          withdrawn: 0,
          ignored: 0,
        },
      }),
    ],
    ["an extra key", (s) => ({ ...s, exitCode: 5 })],
  ])("the schema rejects a summary with %s", async (_label, corrupt) => {
    const { output } = await run("nothing");
    const json = JSON.parse(JSON.stringify(output)) as Record<string, unknown>;
    expect(validateScanOutput(json)).toEqual([]);
    json.summary = corrupt(json.summary as Record<string, unknown>);
    expect(validateScanOutput(json)).not.toEqual([]);
  });
});

describe("B-5: a --cve filter that matches nothing says so", () => {
  it("a diagnostic and a stderr line name the filter", async () => {
    const { root, provider } = OUTCOMES.affected();
    const result = await scan(root, provider, { cveFilter: "CVE-0000-0001" });
    expect(result.output.findings).toEqual([]);
    expect(result.stderr).toMatch(/--cve CVE-0000-0001 matched no advisory/);
    expect(
      result.output.diagnostics.filter((d) =>
        d.message.includes("--cve CVE-0000-0001 matched no advisory"),
      ),
    ).toHaveLength(1);
  });

  it("a filter that matches says nothing of the kind", async () => {
    const { root, provider } = OUTCOMES.affected();
    const result = await scan(root, provider, {
      cveFilter: "GHSA-b5-affected",
    });
    expect(result.output.findings.map((f) => f.verdict)).toEqual(["AFFECTED"]);
    expect(result.stderr).not.toMatch(/matched no advisory/);
    expect(
      result.output.diagnostics.some((d) =>
        d.message.includes("matched no advisory"),
      ),
    ).toBe(false);
  });

  it("an unusable record whose identity cannot exclude the filter counts as a match (B-1)", async () => {
    const root = projectWithLib("danger", []);
    const result = await scan(
      root,
      stub([{ affected: "x" } as unknown as RawVulnerability]),
      { cveFilter: "CVE-0000-0002" },
    );
    expect(result.output.unreportedCandidates?.map((e) => e.reason)).toEqual([
      "advisory_record_malformed",
    ]);
    expect(result.stderr).not.toMatch(/matched no advisory/);
  });
});

describe("B-5 (PRM-36): the versionless 'no advisory' detail is computed from the unfiltered set", () => {
  /**
   * The round-1 audit's fixture shape (`agentB/versionless`): a workspace
   * member `foo` with no version, and a nested `foo@1.0.0` under `bar`.
   * GHSA-x (CVE-X) affects foo 0–2.0.0; GHSA-y (CVE-Y) 3.0.0–3.1.0.
   */
  function versionless(): string {
    return project({
      "vulntrace.yml": CONFIG,
      "rules.yml": "rules: []\n",
      "package.json": JSON.stringify({
        name: "root",
        private: true,
        workspaces: ["packages/*"],
      }),
      "package-lock.json": JSON.stringify({
        name: "root",
        lockfileVersion: 3,
        packages: {
          "": { name: "root", workspaces: ["packages/*"] },
          "node_modules/app": { resolved: "packages/app", link: true },
          "node_modules/foo": { resolved: "packages/foo", link: true },
          "node_modules/bar": { version: "1.0.0" },
          "node_modules/bar/node_modules/foo": { version: "1.0.0" },
          "packages/app": {
            name: "app",
            version: "1.0.0",
            dependencies: { bar: "1.0.0" },
          },
          "packages/foo": {},
        },
      }),
      "packages/foo/package.json": JSON.stringify({ name: "foo" }),
      "packages/foo/index.js": LIB_SOURCE,
      "packages/app/package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { bar: "1.0.0" },
      }),
      "node_modules/bar/package.json": JSON.stringify({
        name: "bar",
        version: "1.0.0",
      }),
      "node_modules/bar/index.js":
        'const foo = require("foo");\nmodule.exports = { run: (x) => foo.safe(x) };\n',
      "node_modules/bar/node_modules/foo/package.json": JSON.stringify({
        name: "foo",
        version: "1.0.0",
      }),
      "node_modules/bar/node_modules/foo/index.js": LIB_SOURCE,
      "src/index.js":
        'const bar = require("bar");\nmodule.exports = { main: (x) => bar.run(x) };\n',
    });
  }

  const provider = stub([
    advisory("GHSA-x", { name: "foo", aliases: ["CVE-X"] }),
    advisory("GHSA-y", {
      name: "foo",
      aliases: ["CVE-Y"],
      introduced: "3.0.0",
      fixed: "3.1.0",
    }),
  ]);

  const unavailable = (output: ScanOutput) =>
    (output.unreportedCandidates ?? []).filter(
      (entry) => entry.reason === "installed_version_unavailable",
    );

  it("the audit's own case (--cve CVE-Y): the versionless instance is evaluated against GHSA-y, and no 'no advisory' entry is made", async () => {
    const { output } = await scan(versionless(), provider, {
      cveFilter: "CVE-Y",
    });
    expect(unavailable(output)).toEqual([]);
    expect(
      output.findings
        .filter((f) => f.packageInstance === "packages/foo")
        .map((f) => [f.vulnerability, f.verdict]),
    ).toEqual([["GHSA-y", "UNKNOWN"]]);
  });

  it("a filter that removes every advisory returned for the name says so, and says how many were returned", async () => {
    const { output } = await scan(versionless(), provider, {
      cveFilter: "CVE-Z",
    });
    const entries = unavailable(output);
    expect(entries.map((e) => e.packageInstance)).toEqual(["packages/foo"]);
    expect(entries[0]!.detail).toContain(
      "2 advisories were returned for this name (its query without a version included), and none matches --cve CVE-Z",
    );
    expect(entries[0]!.detail).not.toMatch(/no advisory .*was returned/);
  });

  it("one advisory, usable from one query and malformed from another, is counted once (B-5's audit, finding 1)", async () => {
    const usable = advisory("GHSA-x", { name: "foo", aliases: ["CVE-X"] });
    const malformed = {
      id: "GHSA-x",
      affected: "broken",
    } as unknown as RawVulnerability;
    const byVersion: VulnerabilityProvider = {
      queryPackage(query: PackageQuery) {
        if (query.name !== "foo") {
          return Promise.resolve([]);
        }
        return Promise.resolve(
          query.version === undefined ? [malformed] : [usable],
        );
      },
    };
    const { output } = await scan(versionless(), byVersion, {
      cveFilter: "CVE-Z",
    });
    const entries = unavailable(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail).toContain(
      "1 advisory was returned for this name",
    );
  });

  it("'no advisory was returned' is said only when none was", async () => {
    const { output } = await scan(versionless(), stub([]), {
      cveFilter: "CVE-Z",
    });
    const entries = unavailable(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail).toContain(
      "no advisory was returned for this name, asked without a version",
    );
    expect(entries[0]!.detail).not.toContain("CVE-Z");
  });
});

describe("B-5 (PRM-110): the HTML overview falls back to the first unknownReasons entry", () => {
  /** The overview row's summary cell for the finding with this advisory. */
  function summaryCell(html: string, vulnerability: string): string {
    const row = html
      .split('<tr class="finding-row"')
      .find((chunk) => chunk.includes(`>${vulnerability}</a>`));
    if (row === undefined) {
      throw new Error(`no overview row for ${vulnerability}`);
    }
    return /<td class="summary">(.*?)<\/td>/.exec(row)![1]!;
  }

  it("a real scan's no-rule UNKNOWN shows its recorded reason, not 'no reason recorded'", async () => {
    const { output } = await run("allUnknown");
    const finding = output.findings.find(
      (f) => f.vulnerability === "GHSA-b5-norule",
    )!;
    // The premise: the reason lives in unknownReasons only.
    expect(finding.evidence?.reasons ?? []).toEqual([]);
    expect(finding.unknownReasons?.[0]?.reason).toBe(
      "no_vulnerable_symbol_rule",
    );
    const cell = summaryCell(renderHtmlReport(output), "GHSA-b5-norule");
    expect(cell).not.toContain("no reason recorded");
    expect(cell).toContain("no_vulnerable_symbol_rule");
  });

  it("evidence reasons still come first when present", async () => {
    const { output } = await run("notAffected");
    const reason = output.findings[0]!.evidence!.reasons![0]!;
    const cell = summaryCell(renderHtmlReport(output), "GHSA-b5-unreached");
    expect(cell).toContain(reason.slice(0, 20));
  });

  /** A hand-made output holding exactly `findings`. */
  function outputOf(findings: readonly unknown[]): ScanOutput {
    return {
      schemaVersion: SCHEMA_VERSION,
      scan: { id: "s", project: "." },
      findings,
      coverage: {
        files: 0,
        modulesResolved: 0,
        modulesUnresolved: 0,
        functions: 0,
        callsResolved: 0,
        callsDynamic: 0,
        callsPossible: 0,
      },
      diagnostics: [],
      unreportedCandidates: [],
      timings: {
        parsingMs: 0,
        resolutionMs: 0,
        graphConstructionMs: 0,
        reachabilityMs: 0,
        providerMs: 0,
        cacheHits: 0,
        cacheMisses: 0,
        totalMs: 0,
      },
    } as unknown as ScanOutput;
  }

  it("on an UNKNOWN carrying both, the evidence reason still comes first", () => {
    const html = renderHtmlReport(
      outputOf([
        {
          vulnerability: "GHSA-both",
          package: "p",
          verdict: "UNKNOWN",
          evidence: { path: [], reasons: ["eval at lib/index.js:3"] },
          unknownReasons: [
            {
              category: "value_uncertainty",
              reason: "dynamic_member_access",
              count: 1,
            },
          ],
        },
      ]),
    );
    const cell = summaryCell(html, "GHSA-both");
    expect(cell).toContain("eval at lib/index.js:3");
    expect(cell).not.toContain("dynamic_member_access");
  });

  it("a finding with neither still reads 'no reason recorded'", () => {
    const html = renderHtmlReport(
      outputOf([
        { vulnerability: "GHSA-bare", package: "p", verdict: "UNKNOWN" },
      ]),
    );
    expect(summaryCell(html, "GHSA-bare")).toContain("no reason recorded");
  });
});
