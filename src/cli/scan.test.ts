import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

function write(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
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
      {
        source: "entrypoints",
        message:
          "no entrypoints were discovered (no analysis.entrypoints configured, and no resolvable package.json main/bin field); nothing could be analyzed",
      },
    ]);
    // Zero entrypoints -> zero call-graph coverage, and the vulnerable
    // symbol was never checked -- UNKNOWN, not NOT_AFFECTED.
    expect(output.coverage.files).toBe(0);
    expect(output.findings[0]?.verdict).toBe("UNKNOWN");
  });

  // Regression (TASK-030): found while verifying the documented example
  // scan from a clean environment -- a project with no entrypoints
  // *configured at all* (not even a failed attempt) previously produced
  // an empty diagnostics array, with nothing explaining why every
  // coverage count was zero.
  it("surfaces a diagnostic when zero entrypoints are configured or discoverable at all", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-scan-test-"));
    const configPath = path.join(tmpDir, "vulntrace.yml");
    writeFileSync(configPath, "analysis: {}\n");
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
        source: "entrypoints",
        message:
          "no entrypoints were discovered (no analysis.entrypoints configured, and no resolvable package.json main/bin field); nothing could be analyzed",
      },
    ]);
    expect(output.coverage.files).toBe(0);
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

  // Regression (TASK-030): found during final MVP review. OSV's primary
  // id for an npm advisory is conventionally a GHSA id, with the
  // corresponding CVE recorded only as an alias -- a rule authored
  // against the CVE id (a common, natural choice) previously never
  // matched, silently degrading to UNKNOWN for a genuinely known,
  // reachable vulnerability.
  it("matches a rule authored against a vulnerability's CVE alias, not just its primary GHSA id", async () => {
    const dir = ensureTmpDir();
    const rulesPath = path.join(dir, "rules.yml");
    writeFileSync(
      rulesPath,
      "rules:\n" +
        "  - id: CVE-2020-99999\n" +
        "    package:\n" +
        "      name: fixture-lib\n" +
        "    targets:\n" +
        "      - module: fixture-lib\n" +
        "        export: vulnerable\n",
    );
    const configPath = writeConfig(rulesPath);
    const rawVulnerability: RawVulnerability = {
      id: "GHSA-fixture-alias-0001",
      aliases: ["CVE-2020-99999"],
      affected: [
        {
          package: { ecosystem: "npm", name: "fixture-lib" },
          ranges: [
            {
              type: "SEMVER",
              events: [{ introduced: "0" }, { fixed: "1.0.1" }],
            },
          ],
        },
      ],
      references: [],
    };
    const { io, stdout } = fakeIo();

    const exitCode = await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      configPathOverride: configPath,
      provider: fakeProvider({ "fixture-lib": [rawVulnerability] }),
      noCache: true,
      io,
    });

    expect(exitCode).toBe(1);
    const output = JSON.parse(stdout.join(""));
    expect(output.findings[0]).toMatchObject({
      vulnerability: "GHSA-fixture-alias-0001",
      verdict: "AFFECTED",
    });
  });
});

describe("runScanCommand: same package name+version installed at multiple locations (VT-307c-fix-1)", () => {
  // Reproduces the live false negative the VT-307d soundness review found:
  // foo@1.0.0 installed at TWO distinct locations (non-hoisted, since a
  // top-level foo@2.0.0 forces both nested copies to stay put). Only the
  // instance under `b` is ever loaded, and its vulnerable() is genuinely
  // called; the instance under `a` is installed but never imported by
  // anything. Before this fix, scan.ts's own `dedupeDependencies` collapsed
  // both `foo@1.0.0` DependencyNodes (one per install location) into a
  // single one keyed by "foo@1.0.0", silently discarding whichever wasn't
  // first -- so the finding pipeline evaluated reachability against
  // whichever instance survived, not necessarily the one actually reached.
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  const FOO_GHSA: RawVulnerability = {
    id: "GHSA-foo-multi-0001",
    aliases: [],
    affected: [
      {
        package: { ecosystem: "npm", name: "foo" },
        ranges: [
          { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "2.0.0" }] },
        ],
      },
    ],
    references: [],
  };

  function buildFixture(): string {
    const root = mkdtempSync(
      path.join(tmpdir(), "vulntrace-scan-multi-instance-"),
    );

    write(
      root,
      "package.json",
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { a: "1.0.0", b: "1.0.0", foo: "2.0.0" },
      }),
    );
    write(
      root,
      "package-lock.json",
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "app",
            version: "1.0.0",
            dependencies: { a: "1.0.0", b: "1.0.0", foo: "2.0.0" },
          },
          "node_modules/foo": { version: "2.0.0" },
          "node_modules/a": {
            version: "1.0.0",
            dependencies: { foo: "1.0.0" },
          },
          "node_modules/a/node_modules/foo": { version: "1.0.0" },
          "node_modules/b": {
            version: "1.0.0",
            dependencies: { foo: "1.0.0" },
          },
          "node_modules/b/node_modules/foo": { version: "1.0.0" },
        },
      }),
    );

    const FOO_SOURCE =
      "function vulnerable(){ return 'BOOM'; }\nmodule.exports = { vulnerable };\n";
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "2.0.0" }),
    );
    write(root, "node_modules/foo/index.js", FOO_SOURCE);

    // `a`: installed, requires its own nested foo@1.0.0, but NOTHING in the
    // application ever requires `a` itself -- this instance is never loaded.
    write(
      root,
      "node_modules/a/package.json",
      JSON.stringify({
        name: "a",
        version: "1.0.0",
        dependencies: { foo: "1.0.0" },
      }),
    );
    write(
      root,
      "node_modules/a/node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(root, "node_modules/a/node_modules/foo/index.js", FOO_SOURCE);
    write(
      root,
      "node_modules/a/index.js",
      "const foo = require('foo');\nmodule.exports = { unused(){ return foo.vulnerable(); } };\n",
    );

    // `b`: installed, requires its own nested foo@1.0.0, and the
    // application requires `b` and calls its `useIt()`, which genuinely
    // calls foo.vulnerable().
    write(
      root,
      "node_modules/b/package.json",
      JSON.stringify({
        name: "b",
        version: "1.0.0",
        dependencies: { foo: "1.0.0" },
      }),
    );
    write(
      root,
      "node_modules/b/node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(root, "node_modules/b/node_modules/foo/index.js", FOO_SOURCE);
    write(
      root,
      "node_modules/b/index.js",
      "const foo = require('foo');\nmodule.exports = { useIt(){ return foo.vulnerable(); } };\n",
    );

    write(
      root,
      "src/index.js",
      "const b = require('b');\nfunction main(){ return b.useIt(); }\nmodule.exports = { main };\n",
    );
    write(
      root,
      "vulntrace.yml",
      "analysis:\n  entrypoints:\n    - src/index.js\nrules:\n  files:\n    - rules.yml\n",
    );
    write(
      root,
      "rules.yml",
      "rules:\n" +
        "  - id: GHSA-foo-multi-0001\n" +
        "    package:\n" +
        "      name: foo\n" +
        "    targets:\n" +
        "      - module: foo\n" +
        "        export: vulnerable\n" +
        "        kind: function\n",
    );

    return root;
  }

  it("does not lose the reached instance's AFFECTED verdict merely because a sibling install shares its name+version", async () => {
    const root = buildFixture();
    tmpDir = root;
    const { io, stdout, stderr } = fakeIo();

    const exitCode = await runScanCommand({
      projectPathArg: root,
      provider: fakeProvider({ foo: [FOO_GHSA] }),
      noCache: true,
      io,
    });

    expect(stderr).toEqual([]);
    const output = JSON.parse(stdout.join(""));
    const fooFindings = output.findings.filter(
      (f: { vulnerability: string }) =>
        f.vulnerability === "GHSA-foo-multi-0001",
    );

    // The scan as a whole must never conclude NOT_AFFECTED for this
    // vulnerability merely because one of the two identically-named/
    // versioned installed instances happened to be discarded before
    // reachability -- the genuinely-reached `b` instance's AFFECTED
    // verdict must survive.
    expect(
      fooFindings.some((f: { verdict: string }) => f.verdict === "AFFECTED"),
    ).toBe(true);
    expect(exitCode).toBe(1);
  });

  it("evaluates both installed instances separately: one per exact install location, not one shared verdict", async () => {
    const root = buildFixture();
    tmpDir = root;
    const { io, stdout, stderr } = fakeIo();

    await runScanCommand({
      projectPathArg: root,
      provider: fakeProvider({ foo: [FOO_GHSA] }),
      noCache: true,
      io,
    });

    expect(stderr).toEqual([]);
    const output = JSON.parse(stdout.join(""));
    const fooFindings = output.findings.filter(
      (f: { vulnerability: string }) =>
        f.vulnerability === "GHSA-foo-multi-0001",
    );

    // Both installed foo@1.0.0 instances (under `a` and under `b`) are
    // covered by the advisory and must each get their own reachability
    // evaluation -- one AFFECTED (b, genuinely reached) and one
    // NOT_AFFECTED (a, never loaded at all), never collapsed into a
    // single shared finding.
    expect(fooFindings).toHaveLength(2);
    const verdicts = fooFindings
      .map((f: { verdict: string }) => f.verdict)
      .sort();
    expect(verdicts).toEqual(["AFFECTED", "NOT_AFFECTED"]);

    const affected = fooFindings.find(
      (f: { verdict: string }) => f.verdict === "AFFECTED",
    );
    // The AFFECTED finding's own evidence path must reference the actually
    // reached instance's own directory (`b`), not the unreached one (`a`)
    // -- proving the fix carries the correct per-instance identity through
    // to reachability, not merely that "some" finding happens to be
    // AFFECTED by coincidence.
    expect(
      affected.evidence.path.some((p: string) =>
        p.includes("node_modules/b/node_modules/foo"),
      ),
    ).toBe(true);
  });

  it("negative control: neither instance reached -- no cross-instance borrowing produces a false AFFECTED", async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "vulntrace-scan-multi-instance-negative-"),
    );
    tmpDir = root;

    write(
      root,
      "package.json",
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { a: "1.0.0", b: "1.0.0", foo: "2.0.0" },
      }),
    );
    write(
      root,
      "package-lock.json",
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "app",
            version: "1.0.0",
            dependencies: { a: "1.0.0", b: "1.0.0", foo: "2.0.0" },
          },
          "node_modules/foo": { version: "2.0.0" },
          "node_modules/a": {
            version: "1.0.0",
            dependencies: { foo: "1.0.0" },
          },
          "node_modules/a/node_modules/foo": { version: "1.0.0" },
          "node_modules/b": {
            version: "1.0.0",
            dependencies: { foo: "1.0.0" },
          },
          "node_modules/b/node_modules/foo": { version: "1.0.0" },
        },
      }),
    );

    const FOO_SOURCE =
      "function vulnerable(){ return 'BOOM'; }\nfunction safe(){ return 'ok'; }\nmodule.exports = { vulnerable, safe };\n";
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "2.0.0" }),
    );
    write(root, "node_modules/foo/index.js", FOO_SOURCE);

    // `a` IS loaded and calls foo, but only the SAFE export -- never the
    // vulnerable one.
    write(
      root,
      "node_modules/a/package.json",
      JSON.stringify({
        name: "a",
        version: "1.0.0",
        dependencies: { foo: "1.0.0" },
      }),
    );
    write(
      root,
      "node_modules/a/node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(root, "node_modules/a/node_modules/foo/index.js", FOO_SOURCE);
    write(
      root,
      "node_modules/a/index.js",
      "const foo = require('foo');\nmodule.exports = { useSafe(){ return foo.safe(); } };\n",
    );

    // `b` is installed but never required by anything -- never loaded.
    write(
      root,
      "node_modules/b/package.json",
      JSON.stringify({
        name: "b",
        version: "1.0.0",
        dependencies: { foo: "1.0.0" },
      }),
    );
    write(
      root,
      "node_modules/b/node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(root, "node_modules/b/node_modules/foo/index.js", FOO_SOURCE);
    write(
      root,
      "node_modules/b/index.js",
      "const foo = require('foo');\nmodule.exports = { useIt(){ return foo.vulnerable(); } };\n",
    );

    write(
      root,
      "src/index.js",
      "const a = require('a');\nfunction main(){ return a.useSafe(); }\nmodule.exports = { main };\n",
    );
    write(
      root,
      "vulntrace.yml",
      "analysis:\n  entrypoints:\n    - src/index.js\nrules:\n  files:\n    - rules.yml\n",
    );
    write(
      root,
      "rules.yml",
      "rules:\n" +
        "  - id: GHSA-foo-multi-0001\n" +
        "    package:\n" +
        "      name: foo\n" +
        "    targets:\n" +
        "      - module: foo\n" +
        "        export: vulnerable\n" +
        "        kind: function\n",
    );

    const { io, stdout, stderr } = fakeIo();
    const exitCode = await runScanCommand({
      projectPathArg: root,
      provider: fakeProvider({ foo: [FOO_GHSA] }),
      noCache: true,
      io,
    });

    expect(stderr).toEqual([]);
    const output = JSON.parse(stdout.join(""));
    const fooFindings = output.findings.filter(
      (f: { vulnerability: string }) =>
        f.vulnerability === "GHSA-foo-multi-0001",
    );

    expect(fooFindings).toHaveLength(2);
    // Neither instance's vulnerable() is ever reached -- `a` only calls
    // safe(), `b` is never loaded at all -- so no cross-instance evidence
    // borrowing may manufacture an AFFECTED verdict for either.
    expect(
      fooFindings.every((f: { verdict: string }) => f.verdict !== "AFFECTED"),
    ).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("npm alias: two differently-named aliases resolving to the same real package name and version stay distinct instances", async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "vulntrace-scan-alias-same-version-"),
    );
    tmpDir = root;

    // "foo-old"/"foo-new" are npm aliases (VT-306): the install DIRECTORY
    // names differ, but both installed package.json files declare the
    // real name "foo" -- and, deliberately, the SAME version, so scan.ts's
    // own advisory-lookup grouping (keyed by name@version) puts both in
    // ONE group. Only foo-new's copy is ever loaded and its vulnerable()
    // called.
    write(
      root,
      "package.json",
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: {
          "foo-old": "npm:foo@1.0.0",
          "foo-new": "npm:foo@1.0.0",
        },
      }),
    );
    write(
      root,
      "package-lock.json",
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "app",
            version: "1.0.0",
            dependencies: {
              "foo-old": "npm:foo@1.0.0",
              "foo-new": "npm:foo@1.0.0",
            },
          },
          "node_modules/foo-old": { name: "foo", version: "1.0.0" },
          "node_modules/foo-new": { name: "foo", version: "1.0.0" },
        },
      }),
    );

    const FOO_SOURCE =
      "function vulnerable(){ return 'BOOM'; }\nmodule.exports = { vulnerable };\n";
    write(
      root,
      "node_modules/foo-old/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(root, "node_modules/foo-old/index.js", FOO_SOURCE);
    write(
      root,
      "node_modules/foo-new/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(root, "node_modules/foo-new/index.js", FOO_SOURCE);

    write(
      root,
      "src/index.js",
      "const fooNew = require('foo-new');\n" +
        "function main(){ return fooNew.vulnerable(); }\n" +
        "module.exports = { main };\n",
    );
    write(
      root,
      "vulntrace.yml",
      "analysis:\n  entrypoints:\n    - src/index.js\nrules:\n  files:\n    - rules.yml\n",
    );
    write(
      root,
      "rules.yml",
      "rules:\n" +
        "  - id: GHSA-foo-multi-0001\n" +
        "    package:\n" +
        "      name: foo\n" +
        "    targets:\n" +
        "      - module: foo\n" +
        "        export: vulnerable\n" +
        "        kind: function\n",
    );

    const { io, stdout, stderr } = fakeIo();
    const exitCode = await runScanCommand({
      projectPathArg: root,
      provider: fakeProvider({ foo: [FOO_GHSA] }),
      noCache: true,
      io,
    });

    expect(stderr).toEqual([]);
    const output = JSON.parse(stdout.join(""));
    const fooFindings = output.findings.filter(
      (f: { vulnerability: string }) =>
        f.vulnerability === "GHSA-foo-multi-0001",
    );

    // Both aliases are covered by ONE advisory lookup (same name@version),
    // but each is still its own installed instance -- foo-old (never
    // loaded) must not borrow foo-new's AFFECTED verdict, and foo-new's
    // genuine AFFECTED must not be discarded merely because foo-old shares
    // its identity and version.
    expect(fooFindings).toHaveLength(2);
    const verdicts = fooFindings
      .map((f: { verdict: string }) => f.verdict)
      .sort();
    expect(verdicts).toEqual(["AFFECTED", "NOT_AFFECTED"]);
    expect(exitCode).toBe(1);
  });
});

describe("runScanCommand: symlinked installs canonicalize to the same PackageInstance identity (VT-307c-fix-4)", () => {
  // The VT-307d soundness review found that the finding side
  // (dependency-graph/lockfile-derived, LOGICAL path) and the
  // resolver/call-graph side (PHYSICAL, post-symlink path) disagreed for
  // any symlinked install -- pnpm's content-addressed store, an npm
  // workspace/`file:` link, `npm link`. Reproduced directly against the
  // pre-fix code: this exact fixture returned a false NOT_AFFECTED
  // (exit code 0) even though `vulnerable()` is genuinely, directly
  // called -- a live production bug (VT-212/VT-300's own instance-matching
  // logic), not merely prerequisite work for a future VT-307d gate.
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  const FOO_GHSA: RawVulnerability = {
    id: "GHSA-pnpm-symlink-0001",
    aliases: [],
    affected: [
      {
        package: { ecosystem: "npm", name: "foo" },
        ranges: [
          { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "2.0.0" }] },
        ],
      },
    ],
    references: [],
  };

  function buildFixture(): string {
    const root = mkdtempSync(
      path.join(tmpdir(), "vulntrace-scan-pnpm-symlink-"),
    );

    write(
      root,
      "package.json",
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { foo: "1.0.0" },
      }),
    );
    write(
      root,
      "package-lock.json",
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "app",
            version: "1.0.0",
            dependencies: { foo: "1.0.0" },
          },
          "node_modules/foo": { version: "1.0.0" },
        },
      }),
    );

    // pnpm-style physical layout: `node_modules/foo` is a SYMLINK into the
    // content-addressed store, not a real directory -- lockfile-derived
    // location and resolver-reported physical file therefore differ.
    const real = "node_modules/.pnpm/foo@1.0.0/node_modules/foo";
    write(
      root,
      `${real}/package.json`,
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(
      root,
      `${real}/index.js`,
      "function vulnerable(){ return 'BOOM'; }\nmodule.exports = { vulnerable };\n",
    );
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(root, real),
      path.join(root, "node_modules/foo"),
      "dir",
    );

    write(
      root,
      "src/index.js",
      "const foo = require('foo');\nfunction main(){ return foo.vulnerable(); }\nmodule.exports = { main };\n",
    );
    write(
      root,
      "vulntrace.yml",
      "analysis:\n  entrypoints:\n    - src/index.js\nrules:\n  files:\n    - rules.yml\n",
    );
    write(
      root,
      "rules.yml",
      "rules:\n" +
        "  - id: GHSA-pnpm-symlink-0001\n" +
        "    package:\n" +
        "      name: foo\n" +
        "    targets:\n" +
        "      - module: foo\n" +
        "        export: vulnerable\n" +
        "        kind: function\n",
    );

    return root;
  }

  it("keeps a directly-called vulnerable function AFFECTED when its install is a pnpm-store symlink", async () => {
    const root = buildFixture();
    tmpDir = root;
    const { io, stdout, stderr } = fakeIo();

    const exitCode = await runScanCommand({
      projectPathArg: root,
      provider: fakeProvider({ foo: [FOO_GHSA] }),
      noCache: true,
      io,
    });

    expect(stderr).toEqual([]);
    const output = JSON.parse(stdout.join(""));
    const fooFindings = output.findings.filter(
      (f: { vulnerability: string }) =>
        f.vulnerability === "GHSA-pnpm-symlink-0001",
    );

    expect(fooFindings).toHaveLength(1);
    expect(fooFindings[0].verdict).toBe("AFFECTED");
    expect(exitCode).toBe(1);
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
