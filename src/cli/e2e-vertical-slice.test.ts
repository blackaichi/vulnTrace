import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";
import { fixturePath } from "../testing/fixtures.js";
import { runScanCommand } from "./scan.js";
import { validateScanOutput } from "./output.js";

/**
 * TASK-025 — the first complete end-to-end vertical slice (docs/SDD.md
 * § 32): package-lock.json -> dependency graph -> OSV -> normalized
 * vulnerability -> manual vulnerable-symbol rule -> JS/TS source model ->
 * module/symbol resolution -> call graph -> reachability -> verdict ->
 * evidence + JSON — driven through the real `runScanCommand` (the same
 * code path `vulntrace scan` runs), not just `buildFinding()` directly
 * (see src/analysis/fixture-suite.integration.test.ts for the
 * per-fixture-category proof one layer down).
 *
 * The only non-real piece is the vulnerability provider: `fixture-lib`
 * isn't a package the live OSV API has ever heard of (see TASK-022's
 * completion report), so a fake provider stands in for OSV's HTTP
 * boundary and supplies a synthetic-but-realistically-shaped OSV record.
 * Every other stage — dependency graph, module resolution, call graph,
 * reachability, verdict, JSON output — runs for real, against real files
 * on disk (fixtures/direct-esm, fixtures/not-reachable, fixtures/dynamic;
 * see TASK-024).
 */

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

const FIXTURE_LIB_GHSA: RawVulnerability = {
  id: "GHSA-e2e-vertical-slice",
  aliases: [],
  affected: [
    {
      package: { ecosystem: "npm", name: "fixture-lib" },
      ranges: [
        { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] },
      ],
    },
  ],
  references: [],
};

describe("E2E vertical slice (TASK-025)", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function writeVerticalSliceConfig(entrypoint: string): string {
    tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-e2e-"));
    const rulesPath = path.join(tmpDir, "rules.yml");
    writeFileSync(
      rulesPath,
      "rules:\n" +
        "  - id: GHSA-e2e-vertical-slice\n" +
        "    package:\n" +
        "      name: fixture-lib\n" +
        "    targets:\n" +
        "      - module: fixture-lib\n" +
        "        export: vulnerable\n" +
        "        kind: function\n" +
        "        confidence: 1.0\n",
    );
    const configPath = path.join(tmpDir, "vulntrace.yml");
    writeFileSync(
      configPath,
      `analysis:\n  entrypoints:\n    - ${entrypoint}\n` +
        `rules:\n  files:\n    - ${JSON.stringify(rulesPath)}\n`,
    );
    return configPath;
  }

  it("known vulnerable + reachable fixture (direct-esm) -> AFFECTED, exit code 1, schema-valid JSON with evidence", async () => {
    const configPath = writeVerticalSliceConfig("src/index.ts");
    const { io, stdout, stderr } = fakeIo();

    const exitCode = await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      configPathOverride: configPath,
      provider: fakeProvider({ "fixture-lib": [FIXTURE_LIB_GHSA] }),
      noCache: true,
      io,
    });

    expect(stderr).toEqual([]);
    expect(exitCode).toBe(1);

    const output: unknown = JSON.parse(stdout.join(""));
    expect(validateScanOutput(output)).toEqual([]);
    expect((output as { findings: unknown[] }).findings).toHaveLength(1);
    expect((output as { findings: unknown[] }).findings[0]).toMatchObject({
      vulnerability: "GHSA-e2e-vertical-slice",
      package: "fixture-lib",
      version: "1.0.0",
      verdict: "AFFECTED",
      confidence: 1,
      target: { module: "fixture-lib", symbol: "vulnerable" },
      evidence: {
        reasons: [
          "vulnerable symbol resolved",
          "symbol reachable from application entrypoint",
        ],
      },
    });
  });

  it("known vulnerable + unused vulnerable symbol (not-reachable) -> NOT_AFFECTED, exit code 0, schema-valid JSON with evidence", async () => {
    const configPath = writeVerticalSliceConfig("src/index.ts");
    const { io, stdout, stderr } = fakeIo();

    const exitCode = await runScanCommand({
      projectPathArg: fixturePath("not-reachable"),
      configPathOverride: configPath,
      provider: fakeProvider({ "fixture-lib": [FIXTURE_LIB_GHSA] }),
      noCache: true,
      io,
    });

    expect(stderr).toEqual([]);
    expect(exitCode).toBe(0);

    const output: unknown = JSON.parse(stdout.join(""));
    expect(validateScanOutput(output)).toEqual([]);
    const findings = (output as { findings: unknown[] }).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      vulnerability: "GHSA-e2e-vertical-slice",
      verdict: "NOT_AFFECTED",
      target: { module: "fixture-lib", symbol: "vulnerable" },
      evidence: {
        path: [],
        reasons: [
          "vulnerable symbol confirmed unreachable from all analyzed entrypoints",
        ],
      },
    });
  });

  it("known vulnerable + dynamic call target (dynamic fixture) -> UNKNOWN, never NOT_AFFECTED, exit code 0, schema-valid JSON", async () => {
    const configPath = writeVerticalSliceConfig("src/index.ts");
    const { io, stdout, stderr } = fakeIo();

    const exitCode = await runScanCommand({
      projectPathArg: fixturePath("dynamic"),
      configPathOverride: configPath,
      provider: fakeProvider({ "fixture-lib": [FIXTURE_LIB_GHSA] }),
      noCache: true,
      io,
    });

    // FOUNDATION F3 § 22. A scan that produces an UNKNOWN is no longer
    // silent about WHY on the human-facing stream. Everything else about
    // stderr is unchanged -- this is the only line the scan writes, so an
    // otherwise-clean scan with no UNKNOWN still writes nothing at all
    // (asserted by the two AFFECTED/NOT_AFFECTED cases above, which still
    // require `stderr` to be exactly `[]`).
    //
    // Stdout is untouched: the machine-readable contract never carries
    // prose, which is why this goes to stderr and is asserted here rather
    // than in the JSON body below.
    expect(stderr.join("")).toContain("1 UNKNOWN finding; why:");
    expect(stderr.join("")).toContain("value_uncertainty");
    expect(stderr.join("")).toContain("dynamic_member_access (1)");
    expect(exitCode).toBe(0);

    const output: unknown = JSON.parse(stdout.join(""));
    expect(validateScanOutput(output)).toEqual([]);
    const findings = (output as { findings: unknown[] }).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      vulnerability: "GHSA-e2e-vertical-slice",
      verdict: "UNKNOWN",
      // F3 test-matrix row B: a computed member access is a MODELED
      // construct whose destination is not statically unique. It is
      // deliberately not `capability_escape` -- it cannot introduce a
      // module the graph never saw -- and not `unmodeled_construct`, which
      // no amount of syntax support would close.
      unknownReasons: [
        {
          category: "value_uncertainty",
          reason: "dynamic_member_access",
          count: 1,
        },
      ],
    });
    // UNKNOWN must never be silently coerced from/into NOT_AFFECTED
    // (AGENTS.md) -- assert it directly rather than only via toMatchObject.
    expect((findings[0] as { verdict: string }).verdict).not.toBe(
      "NOT_AFFECTED",
    );
  });
});
