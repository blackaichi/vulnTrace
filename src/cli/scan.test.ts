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
  id: "GHSA-fixture-0001",
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

describe("runScanCommand: fixtures/direct-esm end to end with an injected provider", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function ensureTmpDir(): string {
    if (!tmpDir) {
      tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-scan-test-"));
    }
    return tmpDir;
  }

  function writeConfig(ruleFilePath: string | undefined): string {
    const dir = ensureTmpDir();
    const rulesLines = ruleFilePath
      ? `rules:\n  files:\n    - ${JSON.stringify(ruleFilePath)}\n`
      : "";
    const configPath = path.join(dir, "vulntrace.yml");
    writeFileSync(
      configPath,
      "analysis:\n  entrypoints:\n    - src/index.ts\n" + rulesLines,
    );
    return configPath;
  }

  function writeRulesFile(targetExport: string): string {
    const dir = ensureTmpDir();
    const filePath = path.join(dir, "rules.yml");
    writeFileSync(
      filePath,
      "rules:\n" +
        "  - id: GHSA-fixture-0001\n" +
        "    package:\n" +
        "      name: fixture-lib\n" +
        "    targets:\n" +
        "      - module: fixture-lib\n" +
        `        export: ${targetExport}\n`,
    );
    return filePath;
  }

  it("produces AFFECTED (exit code 1) when the rule targets a symbol main() reaches", async () => {
    const rulesPath = writeRulesFile("vulnerable");
    const configPath = writeConfig(rulesPath);
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
    const output = JSON.parse(stdout.join(""));
    expect(output.schemaVersion).toBeDefined();
    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]).toMatchObject({
      vulnerability: "GHSA-fixture-0001",
      package: "fixture-lib",
      verdict: "AFFECTED",
      target: { module: "fixture-lib", symbol: "vulnerable" },
    });
  });

  it("produces NOT_AFFECTED (exit code 0) when the rule targets a symbol main() never calls", async () => {
    const rulesPath = writeRulesFile("safe");
    const configPath = writeConfig(rulesPath);
    const { io, stdout } = fakeIo();

    const exitCode = await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      configPathOverride: configPath,
      provider: fakeProvider({ "fixture-lib": [FIXTURE_LIB_GHSA] }),
      noCache: true,
      io,
    });

    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout.join(""));
    expect(output.findings[0]?.verdict).toBe("NOT_AFFECTED");
  });

  it("produces UNKNOWN (exit code 0) when no rule is configured for the vulnerability", async () => {
    const configPath = writeConfig(undefined);
    const { io, stdout } = fakeIo();

    const exitCode = await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      configPathOverride: configPath,
      provider: fakeProvider({ "fixture-lib": [FIXTURE_LIB_GHSA] }),
      noCache: true,
      io,
    });

    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout.join(""));
    expect(output.findings[0]?.verdict).toBe("UNKNOWN");
  });

  it("filters findings to the vulnerability matching --cve", async () => {
    const rulesPath = writeRulesFile("vulnerable");
    const configPath = writeConfig(rulesPath);
    const { io, stdout } = fakeIo();

    const exitCode = await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      configPathOverride: configPath,
      cveFilter: "GHSA-does-not-match",
      provider: fakeProvider({ "fixture-lib": [FIXTURE_LIB_GHSA] }),
      noCache: true,
      io,
    });

    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout.join(""));
    expect(output.findings).toHaveLength(0);
  });

  it("produces valid, schema-conforming JSON output", async () => {
    const rulesPath = writeRulesFile("vulnerable");
    const configPath = writeConfig(rulesPath);
    const { io, stdout } = fakeIo();

    await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      configPathOverride: configPath,
      provider: fakeProvider({ "fixture-lib": [FIXTURE_LIB_GHSA] }),
      noCache: true,
      io,
    });

    const output = JSON.parse(stdout.join(""));
    expect(output).toMatchObject({
      schemaVersion: expect.any(String),
      scan: { id: expect.any(String), project: fixturePath("direct-esm") },
      coverage: {
        files: expect.any(Number),
        modulesResolved: expect.any(Number),
        modulesUnresolved: expect.any(Number),
        functions: expect.any(Number),
        callsResolved: expect.any(Number),
        callsDynamic: expect.any(Number),
      },
      diagnostics: [],
    });
  });

  // Regression (TASK-026): entrypointsResult.diagnostics was computed by
  // discoverEntrypoints() but never read anywhere in the CLI -- a typo'd
  // `analysis.entrypoints` entry silently produced zero entrypoints (and
  // therefore only UNKNOWN findings, per TASK-022's checkedAny fix) with
  // no indication of why. It must now surface in the JSON output.
  it("surfaces a diagnostic when a configured entrypoint does not exist, instead of silently dropping it", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-scan-test-"));
    const configPath = path.join(tmpDir, "vulntrace.yml");
    writeFileSync(
      configPath,
      "analysis:\n  entrypoints:\n    - src/typo-does-not-exist.ts\n",
    );
    const { io, stdout } = fakeIo();

    const exitCode = await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      configPathOverride: configPath,
      provider: fakeProvider({ "fixture-lib": [FIXTURE_LIB_GHSA] }),
      noCache: true,
      io,
    });

    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout.join(""));
    expect(output.diagnostics).toEqual([
      {
        source: "entrypoints:configured",
        message:
          "analysis.entrypoints[0] does not exist: src/typo-does-not-exist.ts",
      },
    ]);
    // Zero entrypoints -> zero call-graph coverage, and the vulnerable
    // symbol was never checked -- UNKNOWN, not NOT_AFFECTED.
    expect(output.coverage.files).toBe(0);
    expect(output.findings[0]?.verdict).toBe("UNKNOWN");
  });

  it("surfaces a call-graph diagnostic explaining a dynamic call-graph blocker (fixtures/dynamic)", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-scan-test-"));
    const configPath = path.join(tmpDir, "vulntrace.yml");
    writeFileSync(
      configPath,
      "analysis:\n  entrypoints:\n    - src/index.ts\n",
    );
    const { io, stdout } = fakeIo();

    const exitCode = await runScanCommand({
      projectPathArg: fixturePath("dynamic"),
      configPathOverride: configPath,
      provider: fakeProvider({ "fixture-lib": [FIXTURE_LIB_GHSA] }),
      noCache: true,
      io,
    });

    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout.join(""));
    expect(output.diagnostics).toContainEqual({
      source: "call-graph",
      message: expect.stringContaining("dynamic_member_access"),
    });
  });
});

describe("runScanCommand: error handling", () => {
  it("returns exit code 3 when package.json/package-lock.json are missing", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-scan-empty-"));
    const { io, stderr } = fakeIo();

    try {
      const exitCode = await runScanCommand({
        projectPathArg: tmpDir,
        provider: fakeProvider({}),
        noCache: true,
        io,
      });

      expect(exitCode).toBe(3);
      expect(stderr[0]).toContain("dependency manifests");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns exit code 4 when the vulnerability provider fails", async () => {
    const { io, stderr } = fakeIo();
    const failingProvider: VulnerabilityProvider = {
      queryPackage() {
        return Promise.reject(new Error("simulated network failure"));
      },
    };

    const exitCode = await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      provider: failingProvider,
      noCache: true,
      io,
    });

    expect(exitCode).toBe(4);
    expect(stderr[0]).toContain("provider failure");
  });

  it("returns exit code 2 for an invalid vulntrace.yml", async () => {
    const tmpDir = mkdtempSync(
      path.join(tmpdir(), "vulntrace-scan-badconfig-"),
    );
    const configPath = path.join(tmpDir, "vulntrace.yml");
    writeFileSync(configPath, 'analysis:\n  entrypoints: "not-a-list"\n');
    const { io, stderr } = fakeIo();

    try {
      const exitCode = await runScanCommand({
        projectPathArg: fixturePath("direct-esm"),
        configPathOverride: configPath,
        provider: fakeProvider({}),
        noCache: true,
        io,
      });

      expect(exitCode).toBe(2);
      expect(stderr[0]).toContain("invalid configuration");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
