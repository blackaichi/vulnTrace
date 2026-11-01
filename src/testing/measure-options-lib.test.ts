/**
 * `scripts/measure-options-lib.mjs` (task BL-120): how an option's oracle
 * report, differential and census are compared with the base's. Driven
 * from synthetic reports; the end-to-end run is in the task file.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import MeasureOptionsReporter, {
  errorText,
} from "../../scripts/measure-options-reporter.mjs";
import type { DiffResult } from "../../scripts/differential-lib.mjs";
import {
  aggregateCensus,
  classifyFailure,
  compareOracle,
  oracleOutcomes,
  packageOf,
  RECORD_DRIFTED,
  RECORD_FLIPPED,
  renderReport,
  summarizeDifferential,
  type TestOutcome,
} from "../../scripts/measure-options-lib.mjs";
import {
  openSoundnessDefectProblems,
  VERDICT_DOMAIN,
} from "./open-soundness-defect.js";

const pass: TestOutcome = { status: "passed", messages: [] };
const fail = (...messages: string[]): TestOutcome => ({
  status: "failed",
  messages,
});

describe("measure-options-lib: the oracle suite", () => {
  it("keys each test by its file relative to the side and its full name", () => {
    const root = path.join(path.sep, "scratch", "sides", "o1");
    const outcomes = oracleOutcomes(
      {
        testResults: [
          {
            name: path.join(root, "tests", "oracle", "a.test.ts"),
            assertionResults: [
              { fullName: "a > keeps its proof", status: "passed" },
              {
                fullName: "a > RWF-900",
                status: "failed",
                failureMessages: ["x"],
              },
            ],
          },
          {
            name: path.join(root, "tests", "oracle", "broken.test.ts"),
            status: "failed",
            message: "SyntaxError",
            assertionResults: [],
          },
        ],
      },
      root,
    );
    expect([...outcomes.entries()]).toEqual([
      ["tests/oracle/a.test.ts > a > keeps its proof", pass],
      ["tests/oracle/a.test.ts > a > RWF-900", fail("x")],
      ["tests/oracle/broken.test.ts > (file)", fail("SyntaxError")],
    ]);
  });

  it("reads the fixed words openSoundnessDefectProblems actually writes", () => {
    const record = {
      caseId: "c",
      rwf: "RWF-900",
      debt: "D-99",
      admissible: ["UNKNOWN" as const],
      expected: "UNKNOWN" as const,
      observed: {
        verdict: "NOT_AFFECTED" as const,
        proofFamily: "A" as const,
        target: "t",
        reachableSubgraphComplete: true,
        unknownEdges: 0,
      },
    };
    // Empty registers: the references' own problems are reported too, and
    // filtered out below; only the live result's message is under test.
    const registers = { findings: "", openDebts: "" };
    const fixed = openSoundnessDefectProblems(
      record,
      VERDICT_DOMAIN,
      { ...record.observed, verdict: "UNKNOWN" },
      registers,
    );
    const drifted = openSoundnessDefectProblems(
      record,
      VERDICT_DOMAIN,
      { ...record.observed, unknownEdges: 1 },
      registers,
    );
    expect(fixed.some((p) => p.includes(RECORD_FLIPPED))).toBe(true);
    expect(drifted.some((p) => p.includes(RECORD_DRIFTED))).toBe(true);
    expect(
      classifyFailure(fixed.filter((p) => p.includes(RECORD_FLIPPED))),
    ).toBe("flipped");
    expect(
      classifyFailure(drifted.filter((p) => p.includes(RECORD_DRIFTED))),
    ).toBe("drifted");
  });

  it("classifies a new failure: a drift is never a fix; anything else is a lost control", () => {
    expect(classifyFailure([`r: ${RECORD_FLIPPED} -- fixed`])).toBe("flipped");
    expect(classifyFailure([`r: ${RECORD_DRIFTED}`])).toBe("drifted");
    expect(
      classifyFailure([`a: ${RECORD_FLIPPED}`, `b: ${RECORD_DRIFTED}`]),
    ).toBe("drifted");
    expect(classifyFailure(["expected 'NOT_AFFECTED' to be 'UNKNOWN'"])).toBe(
      "lost",
    );
    expect(classifyFailure([])).toBe("lost");
  });

  it("compares two sides, listing a test on one side only", () => {
    const base = new Map<string, TestOutcome>([
      ["f > record flips", pass],
      ["f > record drifts", pass],
      ["f > control", pass],
      ["f > still failing", fail("y")],
      ["f > was failing", fail("z")],
      ["f > unchanged", pass],
      ["f > base only", pass],
    ]);
    const option = new Map<string, TestOutcome>([
      ["f > record flips", fail(`x: ${RECORD_FLIPPED}`)],
      ["f > record drifts", fail(`x: ${RECORD_DRIFTED}`)],
      ["f > control", fail("expected proof")],
      ["f > still failing", fail("y")],
      ["f > was failing", pass],
      ["f > unchanged", pass],
      ["f > option only", pass],
    ]);
    expect(compareOracle(base, option)).toEqual({
      run: 7,
      passed: 3,
      flipped: ["f > record flips"],
      drifted: ["f > record drifts"],
      lost: ["f > control"],
      gained: ["f > was failing"],
      onlyBase: ["f > base only"],
      onlyOption: ["f > option only"],
    });
  });
});

/** A `diff.json` with only the given parts. */
function diff(parts: {
  verdict?: DiffResult["verdict"]["changed"];
  suite?: DiffResult["suite"];
  proof?: DiffResult["proof"]["changed"];
}): DiffResult {
  return {
    base: { label: "base", cases: 3 },
    head: { label: "o1", cases: 3 },
    cases: {
      total: 3,
      onlyBase: [],
      onlyHead: [],
      unmeasured: [],
      duplicateKeys: [],
      schemaIssues: [],
    },
    graph: { measured: 3, unavailable: [], changed: [] },
    proof: { measured: 3, changed: parts.proof ?? [] },
    verdict: {
      measured: 3,
      changed: parts.verdict ?? [],
      added: [],
      removed: [],
      unreportedAdded: [],
      unreportedRemoved: [],
    },
    suite: parts.suite ?? [],
  };
}

describe("measure-options-lib: the differential and the suites' proofs", () => {
  const suiteRow = (
    c: string,
    expected: string,
    base: string,
    head: string,
  ) => ({
    case: c,
    expected,
    knownFailure: null,
    base,
    head,
    moved: base !== head,
  });

  it("counts the NOT_AFFECTED proofs held and lost, by corpus", () => {
    const d = summarizeDifferential(
      diff({
        suite: [
          suiteRow(
            "validation/RWB-07",
            "NOT_AFFECTED",
            "NOT_AFFECTED",
            "UNKNOWN",
          ),
          suiteRow(
            "validation/RWB-11b",
            "NOT_AFFECTED",
            "NOT_AFFECTED",
            "NOT_AFFECTED",
          ),
          // Expected NOT_AFFECTED but the base does not prove it: not held.
          suiteRow("validation/VAL-002", "NOT_AFFECTED", "UNKNOWN", "UNKNOWN"),
          suiteRow(
            "adversarial-v2/ADV2-085",
            "NOT_AFFECTED",
            "NOT_AFFECTED",
            "UNKNOWN",
          ),
          suiteRow(
            "adversarial-v1/ADV-001",
            "AFFECTED",
            "AFFECTED",
            "AFFECTED",
          ),
        ],
      }),
    );
    expect(d.suite.proofs).toEqual({
      validation: {
        held: 2,
        lost: [{ case: "validation/RWB-07", to: "UNKNOWN" }],
      },
      "adversarial-v2": {
        held: 1,
        lost: [{ case: "adversarial-v2/ADV2-085", to: "UNKNOWN" }],
      },
      "adversarial-v1": { held: 0, lost: [] },
    });
    expect(d.suite.moved).toBe(2);
    expect(d.suite.intoNotAffected).toEqual([]);
  });

  it("names every suite verdict moved into NOT_AFFECTED, whatever was expected", () => {
    const d = summarizeDifferential(
      diff({
        suite: [
          suiteRow(
            "adversarial-v1/ADV-009",
            "UNKNOWN",
            "UNKNOWN",
            "NOT_AFFECTED",
          ),
          suiteRow(
            "validation/RWB-03",
            "NOT_AFFECTED",
            "ERROR",
            "NOT_AFFECTED",
          ),
        ],
      }),
    );
    expect(d.suite.intoNotAffected).toEqual([
      { case: "adversarial-v1/ADV-009", expected: "UNKNOWN", from: "UNKNOWN" },
      { case: "validation/RWB-03", expected: "NOT_AFFECTED", from: "ERROR" },
    ]);
  });

  it("lists the verdicts moved, those into NOT_AFFECTED first, with differential-lib's own counts", () => {
    const moved = (
      c: string,
      from: "AFFECTED" | "UNKNOWN" | "NOT_AFFECTED",
      to: typeof from,
    ) => ({
      case: c,
      key: `${c}#k`,
      from,
      to,
      intoNotAffected: to === "NOT_AFFECTED",
    });
    const d = summarizeDifferential(
      diff({
        verdict: [
          moved("validation/A", "NOT_AFFECTED", "UNKNOWN"),
          moved("validation/B", "UNKNOWN", "NOT_AFFECTED"),
          moved("adversarial-v1/C", "AFFECTED", "UNKNOWN"),
        ],
      }),
    );
    expect(d.verdictsMoved.map((v) => v.case)).toEqual([
      "validation/B",
      "adversarial-v1/C",
      "validation/A",
    ]);
    expect(d.summary.verdict).toMatchObject({ changed: 3, intoNotAffected: 1 });
  });
});

describe("measure-options-lib: the census", () => {
  it("names a package by its path through node_modules, scoped or not", () => {
    expect(packageOf("/r/node_modules/ini/lib/ini.js")).toBe(
      "/r/node_modules/ini",
    );
    expect(packageOf("/r/node_modules/@scope/p/index.js")).toBe(
      "/r/node_modules/@scope/p",
    );
    expect(packageOf("/r/node_modules/a/node_modules/b/x.js")).toBe(
      "/r/node_modules/a/node_modules/b",
    );
    expect(packageOf("/r/src/x.js")).toBe("(no package)");
  });

  it("counts files and the packages holding a flagged file", () => {
    expect(
      aggregateCensus([
        { file: "/r/node_modules/a/x.js", flagged: true },
        { file: "/r/node_modules/a/y.js", flagged: false },
        { file: "/r/node_modules/b/x.js", flagged: false },
        { file: "/r/node_modules/@s/c/x.js", flagged: true },
      ]),
    ).toEqual({ files: 4, flagged: 2, packages: 3, packagesFlagged: 2 });
  });
});

describe("measure-options-lib: the report", () => {
  it("compares every option with the base, and never reports an unmeasured part as zero", () => {
    const report = renderReport({
      base: "d54511e",
      sides: [
        {
          name: "base",
          oracle: { run: 10, passed: 9 },
          census: { error: "no predicate in this build" },
        },
        {
          name: "o1",
          oracle: {
            run: 10,
            passed: 8,
            flipped: ["f > RWF-900"],
            drifted: [],
            lost: ["f > control"],
            gained: [],
            onlyBase: [],
            onlyOption: [],
          },
          differential: summarizeDifferential(
            diff({
              suite: [
                {
                  case: "validation/RWB-07",
                  expected: "NOT_AFFECTED",
                  knownFailure: null,
                  base: "NOT_AFFECTED",
                  head: "UNKNOWN",
                  moved: true,
                },
              ],
            }),
          ),
          census: { files: 200, flagged: 50, packages: 20, packagesFlagged: 5 },
        },
        { name: "o2", error: "the patch does not apply to the base" },
      ],
      notes: ["a note"],
    });
    const row = (label: string) =>
      report.split("\n").find((l) => l.startsWith(`| ${label}`));
    expect(row("oracle tests passed / run")).toBe(
      "| oracle tests passed / run | 9 / 10 | 8 / 10 | error |",
    );
    expect(row("open records flipped")).toBe(
      "| open records flipped (now admissible) | — | 1 | error |",
    );
    expect(row("census: files flagged")).toBe(
      "| census: files flagged | unavailable | 50 of 200 (25.0 %) | error |",
    );
    expect(row("`validation` `NOT_AFFECTED` proofs lost")).toBe(
      "| `validation` `NOT_AFFECTED` proofs lost | — | 1 of 1 | error |",
    );
    expect(report).toContain(
      "**`o2` was not measured:** the patch does not apply to the base",
    );
    expect(report).toContain("  - `validation/RWB-07` → UNKNOWN");
    expect(report).toContain("- a note");
    // A side measured without a differential says so.
    const noDiff = renderReport({
      base: "b",
      sides: [
        { name: "base" },
        {
          name: "o",
          oracle: {
            run: 1,
            passed: 1,
            flipped: [],
            drifted: [],
            lost: [],
            gained: [],
            onlyBase: [],
            onlyOption: [],
          },
        },
      ],
    });
    expect(noDiff).toContain(
      "| proof differential: findings changed | — | not measured |",
    );
  });
});

describe("measure-options-reporter", () => {
  it("keeps the asserted value a record's failure carries, so its fixed words reach the comparison", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "vt-measure-options-"));
    const target = path.join(dir, "oracle.json");
    const previous = process.env.VT_MEASURE_OPTIONS_REPORT;
    process.env.VT_MEASURE_OPTIONS_REPORT = target;
    try {
      // vitest's message for `expect(problems).toEqual([])` names no
      // problem; the asserted value does.
      const recordFailure = {
        message: "expected [ Array(1) ] to deeply equal []",
        actual: `[\n  "c [verdict]: the live result {} ${RECORD_FLIPPED} -- RWF-900 may be fixed"\n]`,
        diff: "- Expected\n+ Received",
      };
      new MeasureOptionsReporter().onFinished([
        {
          type: "suite",
          name: "a.test.ts",
          filepath: path.join(dir, "tests", "oracle", "a.test.ts"),
          result: { state: "fail" },
          tasks: [
            {
              type: "suite",
              name: "group",
              tasks: [
                {
                  type: "test",
                  name: "record",
                  result: { state: "fail", errors: [recordFailure] },
                },
                { type: "test", name: "control", result: { state: "pass" } },
              ],
            },
            { type: "test", name: "skipped", mode: "skip" },
          ],
        },
      ]);
      const outcomes = oracleOutcomes(
        JSON.parse(readFileSync(target, "utf-8")),
        dir,
      );
      expect([...outcomes.keys()]).toEqual([
        "tests/oracle/a.test.ts > group record",
        "tests/oracle/a.test.ts > group control",
        "tests/oracle/a.test.ts > skipped",
      ]);
      expect(outcomes.get("tests/oracle/a.test.ts > skipped")?.status).toBe(
        "skipped",
      );
      const record = outcomes.get("tests/oracle/a.test.ts > group record")!;
      expect(record.status).toBe("failed");
      expect(classifyFailure(record.messages)).toBe("flipped");
      // vitest's message alone would have been a lost control.
      expect(classifyFailure([recordFailure.message])).toBe("lost");
    } finally {
      if (previous === undefined) delete process.env.VT_MEASURE_OPTIONS_REPORT;
      else process.env.VT_MEASURE_OPTIONS_REPORT = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serializes an asserted value that is not a string yet", () => {
    expect(errorText({ message: "m", actual: ["x is now ADMISSIBLE"] })).toBe(
      'm\n["x is now ADMISSIBLE"]',
    );
    expect(errorText({ message: "m" })).toBe("m");
  });
});
