import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VulnerabilityProvider } from "../domain/vulnerability.js";
import { runScanCommand } from "./scan.js";

/**
 * TASK-029 — performance baseline (docs/SDD.md § 30, § 31's "performance
 * smoke" test category).
 *
 * Builds a synthetic ~300-file "medium" project (a realistic proxy: many
 * feature files, each depending on a handful of shared utility modules —
 * the common real-world shape, rather than one single import chain) and
 * runs a full `runScanCommand` against it, with a fake vulnerability
 * provider (no live network dependency in a performance test — the
 * network boundary is already exercised elsewhere, e.g.
 * src/vulnerabilities/osv-provider.integration.test.ts).
 *
 * Regression threshold: this repo's own CI/dev-machine runtime for this
 * synthetic project should stay well under **5 seconds**. This is a
 * project-local regression guard, deliberately much tighter than
 * docs/SDD.md § 30's user-facing target ("under 30 seconds for a medium
 * Node.js project on cold cache") — that target describes a real-world
 * medium project on real hardware; this fixed, synthetic, in-memory-speed
 * project should comfortably clear it by a wide margin, so a threshold
 * this close to it exists specifically to catch an accidental
 * quadratic-blowup-style regression in module resolution or call-graph
 * traversal before it reaches a real user. If this test starts failing
 * because the tool has genuinely grown slower for a legitimate reason,
 * raise this threshold deliberately and note why, rather than silently
 * increasing it to make the test pass.
 */
const REGRESSION_THRESHOLD_MS = 5_000;
const FEATURE_FILE_COUNT = 300;
const UTILITY_FILE_COUNT = 5;

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

function fakeProvider(): VulnerabilityProvider {
  return { queryPackage: () => Promise.resolve([]) };
}

function write(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

/**
 * A "medium" synthetic Node.js project: `UTILITY_FILE_COUNT` shared
 * utility modules, and `FEATURE_FILE_COUNT` feature files each importing
 * and calling one utility (fan-in on a few shared modules, the realistic
 * shape of most real codebases — distinct from TASK-028's linear-chain
 * fixture, which exists to test on-demand discovery specifically, not to
 * approximate a real project's shape).
 */
function buildMediumProject(root: string): void {
  write(
    root,
    "package.json",
    JSON.stringify({
      name: "medium-fixture",
      version: "1.0.0",
      type: "module",
    }),
  );
  write(
    root,
    "package-lock.json",
    JSON.stringify({
      name: "medium-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: { "": { name: "medium-fixture", version: "1.0.0" } },
    }),
  );

  for (let u = 0; u < UTILITY_FILE_COUNT; u++) {
    write(
      root,
      `src/utils/util${u}.js`,
      `export function helper${u}() {\n  return ${u};\n}\n`,
    );
  }

  const featureImports: string[] = [];
  for (let f = 0; f < FEATURE_FILE_COUNT; f++) {
    const util = f % UTILITY_FILE_COUNT;
    write(
      root,
      `src/features/feature${f}.js`,
      `import { helper${util} } from "../utils/util${util}.js";\n` +
        `export function feature${f}() {\n  return helper${util}();\n}\n`,
    );
    featureImports.push(
      `import { feature${f} } from "./features/feature${f}.js";`,
    );
  }

  write(
    root,
    "src/index.js",
    `${featureImports.join("\n")}\n\n` +
      `export function main() {\n  return [${Array.from(
        { length: FEATURE_FILE_COUNT },
        (_, f) => `feature${f}()`,
      ).join(", ")}];\n}\n`,
  );
}

describe("performance baseline: medium (~300 file) synthetic project", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it(
    `completes within the ${REGRESSION_THRESHOLD_MS}ms regression threshold and reports every major phase's timing`,
    async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-perf-medium-"));
      buildMediumProject(tmpDir);
      const configPath = path.join(tmpDir, "vulntrace.yml");
      writeFileSync(
        configPath,
        "analysis:\n  entrypoints:\n    - src/index.js\n",
      );
      const { io, stdout, stderr } = fakeIo();

      const wallClockStart = Date.now();
      const exitCode = await runScanCommand({
        projectPathArg: tmpDir,
        configPathOverride: configPath,
        provider: fakeProvider(),
        noCache: true,
        io,
      });
      const wallClockMs = Date.now() - wallClockStart;

      expect(stderr).toEqual([]);
      expect(exitCode).toBe(0);
      expect(wallClockMs).toBeLessThan(REGRESSION_THRESHOLD_MS);

      const output = JSON.parse(stdout.join(""));
      // Every feature file plus every utility file plus the entrypoint
      // itself was genuinely discovered and walked -- confirms this
      // actually exercised a ~300-file graph, not a trivially small one.
      expect(output.coverage.files).toBe(
        FEATURE_FILE_COUNT + UTILITY_FILE_COUNT + 1,
      );

      const { timings } = output;
      expect(timings).toMatchObject({
        parsingMs: expect.any(Number),
        resolutionMs: expect.any(Number),
        graphConstructionMs: expect.any(Number),
        reachabilityMs: expect.any(Number),
        providerMs: expect.any(Number),
        cacheHits: expect.any(Number),
        cacheMisses: expect.any(Number),
        totalMs: expect.any(Number),
      });
      // Sanity bounds -- every phase reported is non-negative and no
      // single phase alone exceeds the overall wall clock.
      for (const value of Object.values(timings)) {
        expect(value as number).toBeGreaterThanOrEqual(0);
      }
      expect(timings.graphConstructionMs).toBeLessThanOrEqual(timings.totalMs);
      expect(timings.totalMs).toBeLessThan(REGRESSION_THRESHOLD_MS);
    },
    REGRESSION_THRESHOLD_MS + 5_000,
  );
});

/**
 * Performance baseline: ONE large file with many local declarations and
 * call sites (VT-307c-capability-flow's own performance regression).
 *
 * The medium-project baseline above is a deliberately WIDE shape (many
 * small files) -- it never exercised the pathology this test guards
 * against, which is specific to a single, DEEP file: before
 * `resolveSingleAssignmentValue` (local-aliases.ts) was memoized per
 * `SourceFile`, every call to it re-walked the WHOLE file from scratch,
 * and VT-307c-capability-floor/flow's own escape-detection fallback
 * calls it from many more classification sites per file than any earlier
 * fix did (every call argument, variable initializer, `return`, `throw`,
 * export, and default parameter). On a single real-world ~17,000-line
 * file (lodash.js, tests/validation/fixtures/lodash-4.17.15-*) this
 * measured taking 40-60+ SECONDS -- effectively quadratic in file size --
 * severe enough that the wall-clock cost alone made live network calls
 * sharing the same event loop (tests/validation's real OSV lookups) look
 * like they were failing outright, a purely algorithmic problem
 * masquerading as a network one. This synthetic fixture reproduces the
 * SAME shape (one large file, many `const` declarations, many call sites
 * each passing several arguments) at a scale deliberately smaller than
 * lodash.js but still easily large enough to make an O(n^2) regression
 * fail this threshold by a wide margin, while a correctly-memoized O(n)
 * implementation clears it in well under a second.
 */
describe("performance baseline: single large file with many local declarations/calls", () => {
  const SINGLE_FILE_THRESHOLD_MS = 3_000;
  const DECLARATION_COUNT = 3_000;

  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it(
    `completes within the ${SINGLE_FILE_THRESHOLD_MS}ms regression threshold`,
    async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-perf-single-file-"));
      write(
        tmpDir,
        "package.json",
        JSON.stringify({ name: "single-file-fixture", version: "1.0.0" }),
      );
      write(
        tmpDir,
        "package-lock.json",
        JSON.stringify({
          name: "single-file-fixture",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: { "": { name: "single-file-fixture", version: "1.0.0" } },
        }),
      );

      const lines: string[] = [];
      for (let i = 0; i < DECLARATION_COUNT; i++) {
        // Each iteration contributes several distinct local names and a
        // call passing a few of them as arguments -- the exact shape
        // that multiplies `resolveSingleAssignmentValue` call sites
        // (VT-307c-capability-floor/flow's own new anchor points: the
        // variable initializer itself, plus each call argument).
        lines.push(
          `const value${i} = { a: ${i}, b: "x${i}" };`,
          `const helper${i} = () => value${i};`,
          `doWork(value${i}, helper${i}, ${i});`,
        );
      }
      const body =
        `function doWork(a, b, c) { return a && b && c; }\n` +
        lines.join("\n") +
        `\nmodule.exports = { doWork };\n`;
      write(tmpDir, "src/index.js", body);

      const configPath = path.join(tmpDir, "vulntrace.yml");
      writeFileSync(
        configPath,
        "analysis:\n  entrypoints:\n    - src/index.js\n",
      );
      const { io, stdout, stderr } = fakeIo();

      const wallClockStart = Date.now();
      const exitCode = await runScanCommand({
        projectPathArg: tmpDir,
        configPathOverride: configPath,
        provider: fakeProvider(),
        noCache: true,
        io,
      });
      const wallClockMs = Date.now() - wallClockStart;

      expect(stderr).toEqual([]);
      expect(exitCode).toBe(0);
      expect(wallClockMs).toBeLessThan(SINGLE_FILE_THRESHOLD_MS);
      expect(JSON.parse(stdout.join("")).coverage.files).toBe(1);
    },
    SINGLE_FILE_THRESHOLD_MS + 5_000,
  );
});
