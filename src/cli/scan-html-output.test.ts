import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";
import { fixturePath } from "../testing/fixtures.js";
import { renderHtmlReport } from "./html-report.js";
import { runCli } from "./run.js";
import { runScanCommand } from "./scan.js";

/**
 * HTML Report v0.1 — CLI integration.
 *
 * Drives the real `vulntrace scan ... --format html --output <file>` code
 * path against the real fixture projects, with only the OSV network
 * boundary stubbed — `fixture-lib` is synthetic and has no live advisory
 * data, the same arrangement `e2e-vertical-slice.test.ts` uses.
 *
 * Argument handling goes through `runCli` (the exact parsing a user hits);
 * the scans themselves go through `runScanCommand` with an injected
 * provider, so every case here stays hermetic — `runCli` would construct a
 * real `OsvProvider` and reach the network (see
 * src/cli/scan.integration.test.ts, the suite that is allowed to).
 *
 * What these cases exist to pin down, beyond "a file appears":
 *
 * - the HTML is generated from the SAME `ScanOutput` the JSON format
 *   serializes, so the two can never disagree about a verdict;
 * - existing JSON/stdout behavior is untouched when the new flags are not
 *   used, and exit codes are unchanged when they are;
 * - a scan is never silently reported as delivered when the report could
 *   not actually be written.
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

describe("vulntrace scan --format html --output", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function ensureTmpDir(): string {
    if (!tmpDir) {
      tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-html-"));
    }
    return tmpDir;
  }

  function writeConfig(targetExport: string): string {
    const dir = ensureTmpDir();
    const rulesPath = path.join(dir, "rules.yml");
    writeFileSync(
      rulesPath,
      "rules:\n" +
        "  - id: GHSA-fixture-0001\n" +
        "    package:\n" +
        "      name: fixture-lib\n" +
        "    targets:\n" +
        "      - module: fixture-lib\n" +
        `        export: ${targetExport}\n`,
    );
    const configPath = path.join(dir, "vulntrace.yml");
    writeFileSync(
      configPath,
      "analysis:\n  entrypoints:\n    - src/index.ts\n" +
        `rules:\n  files:\n    - ${JSON.stringify(rulesPath)}\n`,
    );
    return configPath;
  }

  it("writes a complete, self-contained HTML report to --output", async () => {
    const configPath = writeConfig("vulnerable");
    const reportPath = path.join(ensureTmpDir(), "report.html");
    const { io, stdout, stderr } = fakeIo();

    const exitCode = await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      configPathOverride: configPath,
      provider: fakeProvider({ "fixture-lib": [FIXTURE_LIB_GHSA] }),
      noCache: true,
      format: "html",
      outputPath: reportPath,
      io,
    });

    // Exit-code semantics are unchanged by the output format: this
    // fixture reaches the vulnerable symbol, so it is still 1.
    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("wrote html report to");

    const html = readFileSync(reportPath, "utf-8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).toContain("GHSA-fixture-0001");
    expect(html).toContain("fixture-lib");
    expect(html).toContain("AFFECTED");
    expect(html).toContain("Reachability path");
    expect(html).toContain("Analysis scope / supported model");
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']?https?:\/\//i);
  });

  it("renders exactly the verdicts the JSON format reports for the same scan", async () => {
    const configPath = writeConfig("vulnerable");
    const reportPath = path.join(ensureTmpDir(), "report.html");

    const jsonIo = fakeIo();
    const jsonExit = await runScanCommand({
      projectPathArg: fixturePath("not-reachable"),
      configPathOverride: configPath,
      provider: fakeProvider({ "fixture-lib": [FIXTURE_LIB_GHSA] }),
      noCache: true,
      io: jsonIo.io,
    });

    const htmlIo = fakeIo();
    const htmlExit = await runScanCommand({
      projectPathArg: fixturePath("not-reachable"),
      configPathOverride: configPath,
      provider: fakeProvider({ "fixture-lib": [FIXTURE_LIB_GHSA] }),
      noCache: true,
      format: "html",
      outputPath: reportPath,
      io: htmlIo.io,
    });

    expect(jsonExit).toBe(htmlExit);

    const json = JSON.parse(jsonIo.stdout.join("")) as {
      findings: readonly { vulnerability: string; verdict: string }[];
    };
    const html = readFileSync(reportPath, "utf-8");

    expect(json.findings.length).toBeGreaterThan(0);
    for (const finding of json.findings) {
      expect(html).toContain(finding.vulnerability);
      expect(html).toContain(finding.verdict);
    }
    // The report is a rendering of that same result object, so the number
    // of detail sections matches the number of findings exactly.
    expect(html.split('<article class="finding"').length - 1).toBe(
      json.findings.length,
    );
  });

  it("renders a real NOT_AFFECTED with its positive proof, not merely a label", async () => {
    const configPath = writeConfig("vulnerable");
    const reportPath = path.join(ensureTmpDir(), "report.html");
    const { io } = fakeIo();

    const exitCode = await runScanCommand({
      projectPathArg: fixturePath("not-reachable"),
      configPathOverride: configPath,
      provider: fakeProvider({ "fixture-lib": [FIXTURE_LIB_GHSA] }),
      noCache: true,
      format: "html",
      outputPath: reportPath,
      io,
    });

    expect(exitCode).toBe(0);

    const html = readFileSync(reportPath, "utf-8");
    expect(html).toContain("NOT_AFFECTED");
    expect(html).toContain("Positive proof");
    expect(html).toContain("Entrypoint roots");
    expect(html).toMatch(/Family [ABC]/);
    expect(html).not.toContain("[object Object]");
    expect(html).not.toContain("undefined:undefined");
  });

  it("renders a real UNKNOWN with its concrete blockers", async () => {
    const configPath = writeConfig("vulnerable");
    const reportPath = path.join(ensureTmpDir(), "report.html");
    const { io } = fakeIo();

    await runScanCommand({
      projectPathArg: fixturePath("dynamic"),
      configPathOverride: configPath,
      provider: fakeProvider({ "fixture-lib": [FIXTURE_LIB_GHSA] }),
      noCache: true,
      format: "html",
      outputPath: reportPath,
      io,
    });

    const html = readFileSync(reportPath, "utf-8");
    expect(html).toContain("UNKNOWN");
    expect(html).toContain("Why this is UNKNOWN");
    expect(html).toContain("first-class result");
  });

  it("is byte-identical across two renders of one scan result", async () => {
    const configPath = writeConfig("vulnerable");
    const { io, stdout } = fakeIo();

    await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      configPathOverride: configPath,
      provider: fakeProvider({ "fixture-lib": [FIXTURE_LIB_GHSA] }),
      noCache: true,
      io,
    });

    const output = JSON.parse(stdout.join(""));
    expect(renderHtmlReport(output)).toBe(renderHtmlReport(output));
  });
});

describe("runCli argument handling for --format html / --output", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("rejects --format html without --output rather than dumping HTML to stdout", async () => {
    const { io, stdout, stderr } = fakeIo();

    const exitCode = await runCli(
      ["scan", fixturePath("direct-esm"), "--format", "html"],
      io,
    );

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("--format html requires --output");
    expect(stderr.join("")).toContain("report.html");
  });

  it("rejects --output with no value", async () => {
    const { io, stderr } = fakeIo();

    const exitCode = await runCli(
      ["scan", fixturePath("direct-esm"), "--format", "html", "--output"],
      io,
    );

    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain("--output requires a file path");
  });

  it("still rejects an unsupported --format value, now naming both supported formats", async () => {
    const { io, stderr } = fakeIo();

    const exitCode = await runCli(
      ["scan", fixturePath("direct-esm"), "--format", "xml"],
      io,
    );

    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain("--format");
    expect(stderr.join("")).toContain("html");
    expect(stderr.join("")).toContain("json");
  });

  it("lists the html format and --output in the usage text", async () => {
    const { io, stderr } = fakeIo();

    await runCli(["frobnicate"], io);

    expect(stderr.join("")).toContain("--format json|html");
    expect(stderr.join("")).toContain("--output <file>");
  });

  it("reports an unwritable --output destination instead of exiting as though it succeeded", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-html-bad-"));
    const { io, stdout, stderr } = fakeIo();

    const exitCode = await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      provider: fakeProvider({}),
      noCache: true,
      format: "html",
      outputPath: path.join(tmpDir, "no-such-directory", "report.html"),
      io,
    });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("failed to write --output file");
  });
});

describe("existing output behavior is unchanged", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("still prints JSON to stdout, and nothing else, with no new flags", async () => {
    const { io, stdout, stderr } = fakeIo();

    const exitCode = await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      provider: fakeProvider({}),
      noCache: true,
      io,
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const printed = stdout.join("");
    expect(printed.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(printed) as unknown).not.toThrow();
    expect(printed).not.toContain("<!doctype html>");
  });

  it("still prints JSON to stdout for an explicit --format json", async () => {
    const { io, stdout } = fakeIo();

    // Through `runScanCommand` with an injected provider rather than
    // `runCli`, deliberately: every case in this file must stay hermetic
    // (see src/cli/scan.integration.test.ts for the suite that is allowed
    // to reach the live OSV API).
    const exitCode = await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      provider: fakeProvider({}),
      noCache: true,
      format: "json",
      io,
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.join("")) as { schemaVersion: string };
    expect(parsed.schemaVersion).toBeDefined();
  });

  it("writes JSON to --output when asked, byte-identical to what stdout would have received", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-json-out-"));
    const jsonPath = path.join(tmpDir, "result.json");

    const stdoutIo = fakeIo();
    await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      provider: fakeProvider({}),
      noCache: true,
      io: stdoutIo.io,
    });

    const fileIo = fakeIo();
    await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      provider: fakeProvider({}),
      noCache: true,
      outputPath: jsonPath,
      io: fileIo.io,
    });

    expect(fileIo.stdout).toEqual([]);

    const fromStdout = JSON.parse(stdoutIo.stdout.join("")) as {
      scan: { id: string };
    };
    const fromFile = JSON.parse(readFileSync(jsonPath, "utf-8")) as {
      scan: { id: string };
    };

    // Everything but the per-scan id and timings is identical; those two
    // legitimately differ between runs (see the schema's own `scan.id`).
    expect({
      ...fromFile,
      scan: { ...fromFile.scan, id: "x" },
      timings: 0,
    }).toEqual({
      ...fromStdout,
      scan: { ...fromStdout.scan, id: "x" },
      timings: 0,
    });
  });
});
