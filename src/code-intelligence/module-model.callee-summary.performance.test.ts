import { describe, expect, it } from "vitest";
import {
  buildModuleModel,
  calleeSummaryEvaluationCount,
  invocationTargetResolutionCount,
  mapExportsToFunctions,
} from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * BL-066 — the STRUCTURAL cost of the callee summary (`callableAlwaysThrows`),
 * asserted as counts rather than as a stopwatch.
 *
 * The summary is bounded to three callable bodies deep, and the per-file
 * gate (`fileHasDefinitelyAbruptCallable`) asks it of every callable in the
 * file. Recomputed along every call path, a callable that calls `k` others
 * costs `1 + k + k²` body reads, and the file `n` times that: measured by
 * BL-066 on its base at 5 s (standalone) for 300 callables of ten bare call
 * statements each. BL-066 reads every required position of a body, not
 * only bare call statements, which multiplied that cost again, so it
 * memoizes two things:
 *
 * - each callable's answer per depth and argument count, but only an
 *   answer whose computation met no recursion refusal (an answer computed
 *   inside a recursion depends on what is in progress and is not stored);
 * - each call site's resolution, which is a fact of the source text.
 *
 * The properties pinned are therefore:
 *
 * 1. WITHOUT RECURSION, the number of summaries computed depends on how
 *    many callables the file has, never on how many calls each makes.
 * 2. WITH RECURSION, summaries inside a recursion are recomputed (bounded
 *    by the depth bound, so polynomial in the fan-out, not linear — raising
 *    the bound raises this cost as `k^depth`), but no call site is ever
 *    resolved twice.
 *
 * Deleting the answer memo fails (1) (the fan-out-8 file below would
 * compute about seventy times as many); deleting the resolution memo fails
 * (2).
 */

/**
 * `n` one-parameter callables, none of which can throw, each calling `k`
 * others with one argument — and itself too, when `recursive` — as bare
 * call statements or nested in one expression's required positions.
 */
function fanOut(
  n: number,
  k: number,
  nested: boolean,
  recursive = false,
): string {
  let text = "function first() {}\nfunction second() {}\n";
  text += "function g(a, b) {\n  return a;\n}\n";
  for (let i = 0; i < n; i++) {
    const calls = Array.from(
      { length: k },
      (_, j) => `f${(i * 7 + j * 13 + 1) % n}(x)`,
    );
    if (recursive) {
      calls.push(`f${i}(x)`);
    }
    const body = nested
      ? `  return ${calls.reduce((a, b) => `g(${a}, ${b})`)};\n`
      : `${calls.map((call) => `  ${call};\n`).join("")}  return 1;\n`;
    text += `function f${i}(x) {\n${body}}\n`;
  }
  return `${text}f0(1);\nmodule.exports = second;\n`;
}

/** Every call expression in a `fanOut` file: one per `f…(` or `g(`. */
function callSitesIn(text: string): number {
  return (text.match(/\b(?:f\d+|g)\(/g) ?? []).length;
}

function costOf(text: string): { summaries: number; resolutions: number } {
  const summariesBefore = calleeSummaryEvaluationCount();
  const resolutionsBefore = invocationTargetResolutionCount();
  const index = indexSourceFile("/pkg/index.js", text);
  const model = buildModuleModel(index);
  // The program completes, so the later write keeps its authority.
  expect(mapExportsToFunctions(index, model).get("default")?.name).toBe(
    "second",
  );
  return {
    summaries: calleeSummaryEvaluationCount() - summariesBefore,
    resolutions: invocationTargetResolutionCount() - resolutionsBefore,
  };
}

describe("BL-066: without recursion, the callee summary is computed per callable, not per call path", () => {
  const n = 200;
  // Three depths; at each, at most two argument counts (the gate's zero,
  // and the one argument every call here supplies); plus `g` and the two
  // declarations with no call in them.
  const bound = 3 * 2 * (n + 3);

  for (const nested of [false, true]) {
    const shape = nested ? "nested in required positions" : "bare statements";

    it(`computes at most a constant number per callable, at fan-out 2 and 8 (${shape})`, () => {
      const narrow = costOf(fanOut(n, 2, nested)).summaries;
      const wide = costOf(fanOut(n, 8, nested)).summaries;
      expect(narrow).toBeGreaterThan(0);
      expect(narrow).toBeLessThanOrEqual(bound);
      expect(wide).toBeLessThanOrEqual(bound);
    });
  }
});

describe("BL-066: with recursion, no call site is resolved twice", () => {
  for (const nested of [false, true]) {
    const shape = nested ? "nested in required positions" : "bare statements";

    it(`resolves each call site at most once, at fan-out 8 (${shape})`, () => {
      const text = fanOut(200, 8, nested, true);
      const { summaries, resolutions } = costOf(text);
      // The recursion really does defeat the answer memo here ...
      expect(summaries).toBeGreaterThan(3 * 2 * 203);
      // ... and the resolution memo still holds every call site to one.
      expect(resolutions).toBeLessThanOrEqual(callSitesIn(text));
    });
  }
});
