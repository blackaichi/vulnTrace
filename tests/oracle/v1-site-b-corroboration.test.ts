import { beforeEach, describe, expect, it } from "vitest";
import type { JsonFinding } from "../../src/cli/output.js";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  ALL_CASES,
  TARGET_MARKER,
  oracleCase,
  type ProofFamily,
} from "./v1-site-b-corroboration.cases.js";

/**
 * Task V-1 (docs/tasks/V-1-site-b-closure-corroboration.md): ADR 0011's
 * predicates 2 and 3 at Site B, and Amendment V-1's family-C closure
 * corroboration, against real Node. On the base commit every case whose
 * `base` differs from its `expected` was wrong: a family-C `NOT_AFFECTED`
 * over a phantom target (PRM-101), over a package chosen by its manifest
 * name (PRM-102), or over a target a never-evaluated module calls
 * (RWF-078). Nothing here pins a base verdict.
 *
 * Every case asserts its sound verdict through the harness's own
 * `expectation`, checks real Node's answer against the case's `called`,
 * and, where a `NOT_AFFECTED` is expected, the proof family that carries
 * it -- in the case and in the negative control.
 */

/** The one negative-proof evidence object a `NOT_AFFECTED` carries, as its family. */
function proofFamily(finding: JsonFinding | undefined): ProofFamily | "none" {
  const evidence = finding?.evidence;
  if (evidence?.confirmedAbsentFromModuleLoadClosure !== undefined) {
    return "A";
  }
  if (evidence?.confirmedAbsentInstance !== undefined) {
    return "B";
  }
  if (evidence?.confirmedUnreachableTarget !== undefined) {
    return "C";
  }
  return "none";
}

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(ALL_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`${kase.finding}: ${kase.mechanism} -- ${kase.expected}`, async () => {
    const result = await runOracleCase({
      ...oracleCase(kase),
      expectation: { verdict: kase.expected, calledMarker: TARGET_MARKER },
    });
    expect(
      result.variant.groundTruth.calledMarkers.has(TARGET_MARKER),
      "real Node's ground truth",
    ).toBe(kase.called);
    if (kase.precisionCost !== undefined) {
      // An UNKNOWN real Node does not reach is a cost, stated as one.
      expect(kase.expected).toBe("UNKNOWN");
      expect(kase.called).toBe(false);
    }
    if (kase.expectedFamily !== undefined) {
      expect(proofFamily(result.variant.scan.findings[0])).toBe(
        kase.expectedFamily,
      );
    }
    if (kase.negativeFamily !== undefined) {
      expect(proofFamily(result.controls?.negative.scan.findings[0])).toBe(
        kase.negativeFamily,
      );
    }
  });
});
