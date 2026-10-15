import { beforeEach, describe, expect, it } from "vitest";
import type { VulnerabilityProvider } from "../../domain/vulnerability.js";
import { runOracleCase, type OracleCase } from "./case.js";
import {
  simpleConfigFile,
  simplePackageFiles,
  simpleRuleFile,
} from "./config-files.js";
import { nodeEntryCommand } from "./ground-truth.js";
import { HIT_HELPER_SOURCE, hitFunction } from "./hit.js";
import type { ProjectSpec } from "./project.js";
import { injectedOsvProvider, syntheticProvider } from "./provider.js";
import type { OracleScanOptions, ScanObservation } from "./scan.js";
import {
  observationDifference,
  rerootObservation,
  resetScanReuse,
  scanReuseCounts,
  scanReuseKey,
  scanReuseMode,
  scanWithReuse,
} from "./scan-reuse.js";

/**
 * BL-089 — a control's scan reused within one run, attacked on each rule.
 *
 * A mis-keyed reuse would let a control pass on another case's result, so
 * every input of the scan must move the key, every provider whose answers
 * are code must forbid reuse, and every option that reads or writes a
 * path must forbid it. End to end: a second case with the same controls
 * reuses their scans and still runs their ground truth, and a case's own
 * variant is never reused, even when it is byte-identical to an earlier
 * control.
 */

const ADVISORY = "GHSA-scan-reuse";
const LIB =
  HIT_HELPER_SOURCE +
  hitFunction("parse", '"p"') +
  hitFunction("safe", '"s"') +
  "module.exports = { parse, safe };\n";

function project(entry: string): ProjectSpec {
  return {
    files: {
      ...simplePackageFiles("app", "vuln-lib", "1.0.0"),
      "node_modules/vuln-lib/package.json": JSON.stringify({
        name: "vuln-lib",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/vuln-lib/index.js": LIB,
      "src/index.js": entry,
      "rules.yml": simpleRuleFile({
        id: ADVISORY,
        packageName: "vuln-lib",
        exportName: "parse",
      }),
      "vulntrace.yml": simpleConfigFile({ entrypoints: ["src/index.js"] }),
    },
  };
}

const CALL_PARSE = 'const lib = require("vuln-lib");\nlib.parse("x");\n';
const CALL_SAFE = 'const lib = require("vuln-lib");\nlib.safe("x");\n';
const provider = () =>
  syntheticProvider([
    { id: ADVISORY, packageName: "vuln-lib", fixed: "99.0.0" },
  ]);

function oracleCase(id: string, variantEntry: string): OracleCase {
  return {
    id,
    loudFixture: { specifier: "vuln-lib", boundNames: ["parse", "safe"] },
    provider,
    groundTruthCommand: nodeEntryCommand("src/index.js"),
    controls: {
      kind: "controls",
      controls: {
        positive: { name: "positive-control", project: project(CALL_PARSE) },
        negative: { name: "negative-control", project: project(CALL_SAFE) },
      },
    },
    variant: { name: "case", project: project(variantEntry) },
    expectation: {
      verdict: variantEntry === CALL_PARSE ? "AFFECTED" : "NOT_AFFECTED",
      calledMarker: "parse",
    },
  };
}

beforeEach(() => {
  resetScanReuse();
});

describe("scanReuseKey", () => {
  const key = (
    p: ProjectSpec = project(CALL_PARSE),
    v: VulnerabilityProvider = provider(),
    o: object = {},
  ) => scanReuseKey(p, v, o as OracleScanOptions);

  it("is the same for byte-identical inputs, built separately", () => {
    expect(key()).toBeDefined();
    expect(key()).toBe(key());
  });

  it("moves with one byte of one file", () => {
    expect(key(project(CALL_PARSE + " "))).not.toBe(key());
  });

  it("moves with the order files are written in (a path written twice)", () => {
    const a: ProjectSpec = { files: { "x.js": "1", "y.js": "2" } };
    const b: ProjectSpec = { files: { "y.js": "2", "x.js": "1" } };
    expect(key(a)).not.toBe(key(b));
  });

  it("moves with a symlink", () => {
    const base = project(CALL_PARSE);
    const linked: ProjectSpec = {
      ...base,
      symlinks: { "node_modules/alias": "vuln-lib" },
    };
    expect(key(linked)).not.toBe(key(base));
  });

  it("moves with the provider's answers", () => {
    const other = syntheticProvider([
      { id: ADVISORY, packageName: "vuln-lib", fixed: "1.0.0" },
    ]);
    expect(key(undefined, other)).not.toBe(key());
  });

  it("moves with cveFilter", () => {
    expect(key(undefined, undefined, { cveFilter: ADVISORY })).not.toBe(key());
  });

  it("treats noCache: true as the default it is", () => {
    expect(key(undefined, undefined, { noCache: true })).toBe(key());
  });

  it("forbids reuse under a provider whose answers are code", () => {
    expect(
      key(
        undefined,
        injectedOsvProvider(() => Promise.reject(new Error("no"))),
      ),
    ).toBeUndefined();
    expect(
      key(undefined, { queryPackage: () => Promise.resolve([]) }),
    ).toBeUndefined();
  });

  it("forbids reuse under a synthetic provider changed after it was built", () => {
    const replaced = provider();
    replaced.queryPackage = () => Promise.resolve([]);
    expect(key(undefined, replaced)).toBeUndefined();
    const extended = provider() as ReturnType<typeof provider> & {
      extra?: number;
    };
    extended.extra = 1;
    expect(key(undefined, extended)).toBeUndefined();
  });

  it.each([
    ["configPathOverride", { configPathOverride: "/elsewhere/vulntrace.yml" }],
    ["outputPath", { outputPath: "/tmp/out.json" }],
    ["cacheDir", { cacheDir: "/tmp/cache" }],
    ["noCache: false", { noCache: false }],
    ["format: html", { format: "html" as const }],
    ["an option this module does not know", { newOption: 1 }],
  ])("forbids reuse with %s", (_name, options) => {
    expect(key(undefined, undefined, options)).toBeUndefined();
  });
});

describe("rerootObservation and observationDifference", () => {
  const scanned = (
    dir: string,
    id: string,
    totalMs: number,
  ): ScanObservation => {
    const output = {
      scan: { id, project: `/tmp/${dir}` },
      findings: [],
      unreportedCandidates: [],
      timings: { totalMs, parsingMs: totalMs, cacheHits: 0 },
      outside: `/private/tmp/${dir}/node_modules/x/index.js`,
    };
    return {
      exitCode: 0,
      stdout: JSON.stringify(output),
      stderr: `warning in /tmp/${dir}/src/index.js`,
      output: output as unknown as ScanObservation["output"],
      findings: [],
      unreportedCandidates: [],
      possibleEdgeProblems: [`/tmp/${dir}/a.js`],
    };
  };

  it("moves every spelling of the directory, and issues a fresh scan id", () => {
    const old = scanned(
      "vulntrace-oracle-AAAAAA",
      "11111111-1111-4111-8111-111111111111",
      5,
    );
    const moved = rerootObservation(
      old,
      "vulntrace-oracle-AAAAAA",
      "vulntrace-oracle-BBBBBB",
      undefined,
    );
    expect(moved.stdout).not.toContain("AAAAAA");
    expect(moved.output?.scan.project).toBe("/tmp/vulntrace-oracle-BBBBBB");
    expect(moved.stdout).toContain(
      "/private/tmp/vulntrace-oracle-BBBBBB/node_modules",
    );
    expect(moved.stderr).toBe(
      "warning in /tmp/vulntrace-oracle-BBBBBB/src/index.js",
    );
    expect(moved.possibleEdgeProblems).toEqual([
      "/tmp/vulntrace-oracle-BBBBBB/a.js",
    ]);
    expect(moved.output?.scan.id).not.toBe(old.output?.scan.id);
    expect(moved.output?.scan.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("finds no difference between scans that differ only in scan id and durations", () => {
    const a = scanned("d", "11111111-1111-4111-8111-111111111111", 5);
    const b = scanned("d", "22222222-2222-4222-8222-222222222222", 9);
    expect(observationDifference(a, b)).toBeUndefined();
  });

  it("finds a difference anywhere else", () => {
    const a = scanned("d", "11111111-1111-4111-8111-111111111111", 5);
    const b = { ...a, stderr: a.stderr + "!" };
    expect(observationDifference(a, b)).toMatch(/differ at character/);
    expect(observationDifference(a, { ...a, exitCode: 1 })).toMatch(/differ/);
  });
});

describe("scanWithReuse", () => {
  it("never stores nor reuses without a key", async () => {
    let scans = 0;
    const scan = () => {
      scans += 1;
      return Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: "",
        output: undefined,
        findings: [],
        unreportedCandidates: [],
        possibleEdgeProblems: [],
      } satisfies ScanObservation);
    };
    const args = {
      key: undefined,
      project: { files: {} },
      options: undefined,
      scan,
      mode: "on" as const,
    };
    await scanWithReuse({ ...args, dir: "/tmp/vulntrace-oracle-AAAAAA" });
    const second = await scanWithReuse({
      ...args,
      dir: "/tmp/vulntrace-oracle-BBBBBB",
    });
    expect(second.reused).toBe(false);
    expect(scans).toBe(2);
  });

  it("does not store a failed scan", async () => {
    const args = {
      key: "k",
      project: { files: {} },
      options: undefined,
      mode: "on" as const,
    };
    await expect(
      scanWithReuse({
        ...args,
        dir: "/tmp/vulntrace-oracle-AAAAAA",
        scan: () => Promise.reject(new Error("boom")),
      }),
    ).rejects.toThrow("boom");
    let scanned = false;
    await scanWithReuse({
      ...args,
      dir: "/tmp/vulntrace-oracle-BBBBBB",
      scan: () => {
        scanned = true;
        return Promise.resolve({
          exitCode: 0,
          stdout: "",
          stderr: "",
          output: undefined,
          findings: [],
          unreportedCandidates: [],
          possibleEdgeProblems: [],
        });
      },
    });
    expect(scanned).toBe(true);
  });

  it("reads its mode from VT_ORACLE_SCAN_REUSE, and refuses a value it does not know", () => {
    expect(scanReuseMode({})).toBe("on");
    expect(scanReuseMode({ VT_ORACLE_SCAN_REUSE: "off" })).toBe("off");
    expect(scanReuseMode({ VT_ORACLE_SCAN_REUSE: "verify" })).toBe("verify");
    expect(() => scanReuseMode({ VT_ORACLE_SCAN_REUSE: "yes" })).toThrow(
      /must be/,
    );
  });
});

/** Runs `fn` with `VT_ORACLE_SCAN_REUSE` set to `mode`, whatever the ambient value. */
async function withMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.VT_ORACLE_SCAN_REUSE;
  process.env.VT_ORACLE_SCAN_REUSE = mode;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.VT_ORACLE_SCAN_REUSE;
    else process.env.VT_ORACLE_SCAN_REUSE = previous;
  }
}

describe("runOracleCase: controls reused end to end", () => {
  it("reuses a second case's identical controls, still runs their ground truth, and never reuses a case's own variant", async () => {
    // Case one: variant calls `safe`. Case two: variant is byte-identical
    // to the POSITIVE control both cases share.
    const [first, second] = await withMode(
      "on",
      async () =>
        [
          await runOracleCase(oracleCase("one", CALL_SAFE)),
          await runOracleCase(oracleCase("two", CALL_PARSE)),
        ] as const,
    );

    expect(first.variant.scanReused).toBe(false);
    expect(first.controls?.positive.scanReused).toBe(false);
    expect(first.controls?.negative.scanReused).toBe(false);

    expect(second.variant.scanReused).toBe(false);
    expect(second.controls?.positive.scanReused).toBe(true);
    expect(second.controls?.negative.scanReused).toBe(true);
    expect(scanReuseCounts()).toMatchObject({ scanned: 2, reused: 2 });

    // The reused scans carry the verdicts, re-rooted and re-identified...
    const reused = second.controls!.positive.scan;
    const original = first.controls!.positive.scan;
    expect(reused.findings[0]?.verdict).toBe("AFFECTED");
    expect(second.controls?.negative.scan.findings[0]?.verdict).toBe(
      "NOT_AFFECTED",
    );
    expect(reused.output?.scan.project).not.toBe(original.output?.scan.project);
    expect(reused.output?.scan.id).not.toBe(original.output?.scan.id);
    // ...and each reused control's ground truth is its own, run again.
    expect(
      second.controls?.positive.groundTruth.calledMarkers.has("parse"),
    ).toBe(true);
    expect(
      second.controls?.negative.groundTruth.calledMarkers.has("parse"),
    ).toBe(false);
    expect(second.controls?.positive.groundTruth).not.toBe(
      first.controls?.positive.groundTruth,
    );
  });

  it("in verify mode, scans anyway and finds the reused scan identical to the fresh one", async () => {
    const second = await withMode("verify", async () => {
      await runOracleCase(oracleCase("one", CALL_SAFE));
      return runOracleCase(oracleCase("two", CALL_SAFE));
    });
    expect(second.controls?.positive.scanReused).toBe(false);
    expect(scanReuseCounts()).toMatchObject({
      scanned: 2,
      reused: 0,
      verified: 2,
    });
  });

  it("with VT_ORACLE_SCAN_REUSE=off, scans every control", async () => {
    const second = await withMode("off", async () => {
      await runOracleCase(oracleCase("one", CALL_SAFE));
      return runOracleCase(oracleCase("two", CALL_SAFE));
    });
    expect(second.controls?.positive.scanReused).toBe(false);
    expect(scanReuseCounts()).toMatchObject({
      scanned: 0,
      reused: 0,
      verified: 0,
    });
  });
});
