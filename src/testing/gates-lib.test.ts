import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// Plain ESM (run by `scripts/gates.mjs` under bare `node`); its types live
// in the matching `.d.mts` file.
import {
  compareValidation,
  exactlyOnceProblems,
  FAST_GATES,
  readVitestReport,
  SUITES,
  vitestArgs,
} from "../../scripts/gates-lib.mjs";

/**
 * BL-089 — the local gate runner's pure core.
 *
 * The runner must not be a weaker gate set than `AGENTS.md` § I: it must
 * name every gate, run each suite exactly as `npm run` does, refuse a
 * split of `npm test` that would drop or repeat a file, and hold
 * `test:validation` to exactly its documented known failures — a new
 * failure and a known failure that now passes both fail it.
 */

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const scripts = (
  JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8")) as {
    scripts: Record<string, string>;
  }
).scripts;

describe("the gate list", () => {
  it("names every gate of AGENTS.md § I, with § I's command", () => {
    const agents = readFileSync(path.join(ROOT, "AGENTS.md"), "utf-8");
    const section = agents.slice(
      agents.indexOf("## I. Gates"),
      agents.indexOf("## J. Report format"),
    );
    const commands = [...section.matchAll(/^\| [^|]+ \| `([^`]+)` \|/gm)].map(
      (m) => m[1],
    );
    expect(commands.length).toBeGreaterThanOrEqual(15);
    const runnerCommands = new Set([
      ...FAST_GATES.map((g) => g.argv.join(" ")),
      ...SUITES.map((s) =>
        s.script === "test" ? "npm test" : `npm run ${s.script}`,
      ),
    ]);
    for (const command of commands) {
      expect(runnerCommands, command).toContain(command);
    }
  });

  it("derives every suite's vitest arguments from package.json", () => {
    for (const suite of SUITES) {
      expect(["vitest", ...vitestArgs(scripts, suite.script)].join(" ")).toBe(
        scripts[suite.script],
      );
    }
    expect(vitestArgs(scripts, "test")).toEqual(["run"]);
  });

  it("refuses a script that is not a plain `vitest run`", () => {
    expect(() => vitestArgs({ t: "vitest run && echo ok" }, "t")).toThrow(
      /plain/,
    );
    expect(() => vitestArgs({ t: "jest" }, "t")).toThrow(/vitest run/);
    expect(() => vitestArgs({}, "t")).toThrow(/no "t" script/);
  });
});

describe("exactlyOnceProblems", () => {
  const full = ["src/a.test.ts", "src/b.test.ts", "src/c.test.ts"];

  it("accepts disjoint suites whose split of npm test is exact", () => {
    expect(
      exactlyOnceProblems(
        {
          "test:foundation": ["src/a.test.ts"],
          test: ["src/b.test.ts", "src/c.test.ts"],
          "test:oracle": ["tests/oracle/x.test.ts"],
        },
        full,
      ),
    ).toEqual([]);
  });

  it("refuses a file in two suites", () => {
    expect(
      exactlyOnceProblems(
        {
          "test:foundation": ["src/a.test.ts"],
          test: ["src/a.test.ts", "src/b.test.ts", "src/c.test.ts"],
        },
        full,
      ),
    ).toEqual([
      "src/a.test.ts would run twice: in test:foundation and in test",
    ]);
  });

  it("refuses a split that drops a file of npm test", () => {
    expect(
      exactlyOnceProblems(
        { "test:foundation": ["src/a.test.ts"], test: ["src/b.test.ts"] },
        full,
      ),
    ).toEqual([
      "src/c.test.ts is in npm test but in neither half of the split",
    ]);
  });

  it("refuses a split that adds a file npm test does not run", () => {
    expect(
      exactlyOnceProblems(
        {
          "test:foundation": ["src/a.test.ts"],
          test: [
            "src/b.test.ts",
            "src/c.test.ts",
            "src/cli/scan-performance.test.ts",
          ],
        },
        full,
      ),
    ).toEqual([
      "src/cli/scan-performance.test.ts is in the split but not in npm test",
    ]);
  });
});

describe("readVitestReport", () => {
  it("counts files, tests and failures, including a file that failed outside any test", () => {
    const report = readVitestReport(
      JSON.stringify({
        numTotalTests: 3,
        numPassedTests: 1,
        numFailedTests: 1,
        numPendingTests: 1,
        numTodoTests: 0,
        success: false,
        testResults: [
          {
            name: "/r/a.test.ts",
            status: "failed",
            assertionResults: [
              {
                title: "t1",
                fullName: "s t1",
                status: "passed",
                failureMessages: [],
              },
              {
                title: "t2",
                fullName: "s t2",
                status: "failed",
                failureMessages: ["AssertionError: expected 1 to be 2\n  at x"],
              },
              {
                title: "t3",
                fullName: "s t3",
                status: "skipped",
                failureMessages: [],
              },
            ],
          },
          {
            name: "/r/b.test.ts",
            status: "failed",
            message: "Cannot find module",
            assertionResults: [],
          },
        ],
      }),
    );
    expect(report).toMatchObject({
      files: 2,
      failedFiles: 2,
      tests: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      success: false,
    });
    expect(report.failures).toEqual([
      {
        file: "/r/a.test.ts",
        title: "t2",
        fullName: "s t2",
        message: "AssertionError: expected 1 to be 2",
      },
      {
        file: "/r/b.test.ts",
        title: "(file)",
        fullName: "/r/b.test.ts",
        message: "Cannot find module",
      },
    ]);
  });
});

describe("compareValidation", () => {
  const cases = [
    { id: "VAL-001", knownFailure: false },
    { id: "VAL-002", knownFailure: true },
    { id: "RWB-03", knownFailure: true },
  ];
  const failure = (title: string) => ({
    title,
    fullName: `suite ${title}`,
    message: "m",
  });

  it("matches when exactly the known failures fail", () => {
    const v = compareValidation(
      [failure("VAL-002 some case"), failure("RWB-03 other case")],
      cases,
    );
    expect(v.matches).toBe(true);
    expect(v.failedIds).toEqual(["VAL-002", "RWB-03"]);
  });

  it("does not match on a new failure", () => {
    const v = compareValidation(
      [failure("VAL-001 x"), failure("VAL-002 y"), failure("RWB-03 z")],
      cases,
    );
    expect(v.matches).toBe(false);
    expect(v.unexpected).toEqual(["VAL-001"]);
  });

  it("does not match when a known failure passes", () => {
    const v = compareValidation([failure("VAL-002 y")], cases);
    expect(v.matches).toBe(false);
    expect(v.nowPassing).toEqual(["RWB-03"]);
  });

  it("does not match on a failure that is not a case (the hermeticity tests)", () => {
    const v = compareValidation(
      [
        failure("VAL-002 y"),
        failure("RWB-03 z"),
        failure("a package resolves to the fixture's copy"),
      ],
      cases,
    );
    expect(v.matches).toBe(false);
    expect(v.unexpected).toEqual([
      "suite a package resolves to the fixture's copy",
    ]);
  });

  it("takes the baseline from the cases' own knownFailure marks, not from a copy", () => {
    const real = JSON.parse(
      readFileSync(
        path.join(ROOT, "tests/validation/cases/cases.json"),
        "utf-8",
      ),
    ) as { id: string; knownFailure: boolean }[];
    expect(compareValidation([], real).known).toEqual(
      real.filter((c) => c.knownFailure).map((c) => c.id),
    );
  });
});
