import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";
import { fixturePath } from "../testing/fixtures.js";
import { runScanCommand } from "./scan.js";

/**
 * TASK-027 — proves the OSV cache's observable effects through the real
 * `runScanCommand`, not just the underlying cache module (see
 * src/cache/osv-cache.test.ts for that layer's own unit tests). Every test
 * here uses an isolated `cacheDir` inside its own temp directory, never the
 * default `<projectRoot>/.vulntrace-cache` — fixtures/direct-esm is a real,
 * checked-in, shared fixture reused by many other test files, and writing
 * a real cache directory into it would both pollute the tracked repo and
 * risk cross-test-file cache collisions (two different fake providers
 * answering the exact same {ecosystem, name, version} query differently).
 */

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

function countingProvider(results: readonly RawVulnerability[]): {
  provider: VulnerabilityProvider;
  callCount: () => number;
} {
  let calls = 0;
  return {
    provider: {
      queryPackage(): Promise<readonly RawVulnerability[]> {
        calls++;
        return Promise.resolve(results);
      },
    },
    callCount: () => calls,
  };
}

const FIXTURE_LIB_GHSA: RawVulnerability = {
  id: "GHSA-cache-test-0001",
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

describe("runScanCommand: OSV cache (TASK-027)", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function isolatedTmpDir(): string {
    tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-scan-cache-test-"));
    return tmpDir;
  }

  function writeConfigAndRules(dir: string): string {
    const rulesPath = path.join(dir, "rules.yml");
    writeFileSync(
      rulesPath,
      "rules:\n" +
        "  - id: GHSA-cache-test-0001\n" +
        "    package:\n" +
        "      name: fixture-lib\n" +
        "    targets:\n" +
        "      - module: fixture-lib\n" +
        "        export: vulnerable\n",
    );
    const configPath = path.join(dir, "vulntrace.yml");
    writeFileSync(
      configPath,
      "analysis:\n  entrypoints:\n    - src/index.ts\n" +
        `rules:\n  files:\n    - ${JSON.stringify(rulesPath)}\n`,
    );
    return configPath;
  }

  it("serves a second scan from a warm cache without calling the provider again", async () => {
    const dir = isolatedTmpDir();
    const cacheDir = path.join(dir, "cache");
    const configPath = writeConfigAndRules(dir);
    const { provider, callCount } = countingProvider([FIXTURE_LIB_GHSA]);

    const first = await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      configPathOverride: configPath,
      cacheDir,
      provider,
      io: fakeIo().io,
    });

    const { io, stdout } = fakeIo();
    const second = await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      configPathOverride: configPath,
      cacheDir,
      provider,
      io,
    });

    expect(callCount()).toBe(1);
    expect(first).toBe(1);
    expect(second).toBe(1);
    const output = JSON.parse(stdout.join(""));
    expect(output.findings[0]?.verdict).toBe("AFFECTED");
  });

  it("calls the provider on every scan when --no-cache (noCache: true) is set", async () => {
    const dir = isolatedTmpDir();
    const cacheDir = path.join(dir, "cache");
    const configPath = writeConfigAndRules(dir);
    const { provider, callCount } = countingProvider([FIXTURE_LIB_GHSA]);

    await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      configPathOverride: configPath,
      cacheDir,
      noCache: true,
      provider,
      io: fakeIo().io,
    });
    await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      configPathOverride: configPath,
      cacheDir,
      noCache: true,
      provider,
      io: fakeIo().io,
    });

    expect(callCount()).toBe(2);
  });

  it("calls the provider on every scan when vulnerabilities.cache.enabled: false is configured", async () => {
    const dir = isolatedTmpDir();
    const cacheDir = path.join(dir, "cache");
    const rulesPath = path.join(dir, "rules.yml");
    writeFileSync(
      rulesPath,
      "rules:\n" +
        "  - id: GHSA-cache-test-0001\n" +
        "    package:\n" +
        "      name: fixture-lib\n" +
        "    targets:\n" +
        "      - module: fixture-lib\n" +
        "        export: vulnerable\n",
    );
    const configPath = path.join(dir, "vulntrace.yml");
    writeFileSync(
      configPath,
      "analysis:\n  entrypoints:\n    - src/index.ts\n" +
        "vulnerabilities:\n  cache:\n    enabled: false\n" +
        `rules:\n  files:\n    - ${JSON.stringify(rulesPath)}\n`,
    );
    const { provider, callCount } = countingProvider([FIXTURE_LIB_GHSA]);

    await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      configPathOverride: configPath,
      cacheDir,
      provider,
      io: fakeIo().io,
    });
    await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      configPathOverride: configPath,
      cacheDir,
      provider,
      io: fakeIo().io,
    });

    expect(callCount()).toBe(2);
  });

  it("produces byte-identical findings/coverage/diagnostics across a cold and a warm scan (reproducibility)", async () => {
    const dir = isolatedTmpDir();
    const cacheDir = path.join(dir, "cache");
    const configPath = writeConfigAndRules(dir);
    const { provider } = countingProvider([FIXTURE_LIB_GHSA]);

    const { io: io1, stdout: stdout1 } = fakeIo();
    await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      configPathOverride: configPath,
      cacheDir,
      provider,
      io: io1,
    });
    const { io: io2, stdout: stdout2 } = fakeIo();
    await runScanCommand({
      projectPathArg: fixturePath("direct-esm"),
      configPathOverride: configPath,
      cacheDir,
      provider,
      io: io2,
    });

    const output1 = JSON.parse(stdout1.join(""));
    const output2 = JSON.parse(stdout2.join(""));
    // scan.id is a fresh per-invocation identifier, not an analysis
    // result -- excluded deliberately (see docs/SDD.md § 28's
    // reproducibility goal, which is about analysis results, not
    // invocation bookkeeping).
    function withoutScanId(output: typeof output1) {
      return {
        schemaVersion: output.schemaVersion,
        project: output.scan.project,
        findings: output.findings,
        coverage: output.coverage,
        diagnostics: output.diagnostics,
      };
    }
    expect(withoutScanId(output1)).toEqual(withoutScanId(output2));
  });
});
