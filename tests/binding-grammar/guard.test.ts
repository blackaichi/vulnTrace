import { describe, expect, it } from "vitest";
import type { Observation } from "./harness.js";
import type { Expectation } from "./matrix.js";
import {
  KNOWN_DISAGREEMENTS,
  type KnownDisagreement,
} from "./disagreements.js";
import { classifyCellOutcome } from "./guard.js";

/**
 * PROOF THAT THE GUARD HOLDS.
 *
 * `guard.ts` decides what a `disagreements.ts` entry is allowed to
 * silence. That decision is the single point at which this instrument
 * could be turned against itself: an entry that could record a WRONG
 * EXACT would let the gate go green on exactly the fabrication class the
 * sweep exists to catch.
 *
 * So the rule is asserted directly, on synthetic inputs, rather than
 * being left as a property of the 264 real cells. The real cells prove
 * the analyzer's behaviour; these prove the harness's.
 */

const EXPECT_EXACT: Expectation = {
  kind: "exact",
  target: "node_modules/pkg/index.js#run",
};
const EXPECT_UNKNOWN: Expectation = {
  kind: "unknown",
  reason: "unsupported_callee_binding",
  category: "unmodeled_construct",
};

const OBSERVED_RIGHT_EXACT: Observation = {
  kind: "exact",
  target: "node_modules/pkg/index.js#run",
};
/** The RWF-046a fabrication: a wrong export name on the right module. */
const OBSERVED_WRONG_NAME: Observation = {
  kind: "exact",
  target: "node_modules/pkg/index.js#probeTarget",
};
/** A wrong INSTALL: right name, wrong copy of the package. */
const OBSERVED_WRONG_INSTALL: Observation = {
  kind: "exact",
  target: "node_modules/nested/node_modules/twin/index.js#run",
};
const OBSERVED_REFUSAL: Observation = {
  kind: "unknown",
  reason: "unsupported_callee_binding",
};

function refusalEntry(reason: string): KnownDisagreement {
  return {
    form: "synthetic",
    mechanism: "synthetic",
    group: "synthetic",
    observed: { kind: "unknown", reason },
  };
}

describe("the guard: what a disagreement entry may silence", () => {
  it("accepts the one recordable divergence: expected EXACT, observed a refusal", () => {
    const outcome = classifyCellOutcome({
      key: "synthetic",
      expectation: EXPECT_EXACT,
      observed: OBSERVED_REFUSAL,
      entry: refusalEntry("unsupported_callee_binding"),
    });
    expect(outcome.kind).toBe("known-disagreement");
  });

  it("REJECTS a wrong export name, and no entry can silence it", () => {
    for (const entry of [
      undefined,
      refusalEntry("unsupported_callee_binding"),
      // The nearest thing a future author could write while still
      // satisfying the type: an entry for this cell, recording a
      // refusal, hoping it swallows whatever actually happened.
      refusalEntry("unresolved_target"),
    ]) {
      const outcome = classifyCellOutcome({
        key: "synthetic",
        expectation: EXPECT_EXACT,
        observed: OBSERVED_WRONG_NAME,
        entry,
      });
      expect(outcome.kind, `entry=${JSON.stringify(entry)}`).toBe("violation");
      expect(outcome.kind === "violation" && outcome.fabrication).toBe(true);
    }
  });

  it("REJECTS a wrong install even when the export name is right", () => {
    const outcome = classifyCellOutcome({
      key: "synthetic",
      expectation: EXPECT_EXACT,
      observed: OBSERVED_WRONG_INSTALL,
      entry: refusalEntry("unsupported_callee_binding"),
    });
    expect(outcome.kind).toBe("violation");
    expect(outcome.kind === "violation" && outcome.fabrication).toBe(true);
  });

  it("REJECTS an EXACT where a refusal was expected (a fabrication out of nothing)", () => {
    const outcome = classifyCellOutcome({
      key: "synthetic",
      expectation: EXPECT_UNKNOWN,
      observed: OBSERVED_WRONG_NAME,
      entry: refusalEntry("unsupported_callee_binding"),
    });
    expect(outcome.kind).toBe("violation");
    expect(outcome.kind === "violation" && outcome.fabrication).toBe(true);
  });

  it("REJECTS an entry that is not a refusal, even if one is forced past the type", () => {
    // The type makes this unrepresentable in source. A value can still
    // arrive through a cast, a JSON load, or a later widening of the
    // field, so the runtime layer is asserted independently.
    const forced = {
      form: "synthetic",
      mechanism: "synthetic",
      group: "synthetic",
      observed: { kind: "exact", target: "node_modules/pkg/index.js#run" },
    } as unknown as KnownDisagreement;

    const outcome = classifyCellOutcome({
      key: "synthetic",
      expectation: EXPECT_EXACT,
      observed: OBSERVED_REFUSAL,
      entry: forced,
    });
    expect(outcome.kind).toBe("violation");
    expect(outcome.kind === "violation" && outcome.fabrication).toBe(true);
  });

  it("REJECTS a recorded refusal that has drifted to a different reason", () => {
    const outcome = classifyCellOutcome({
      key: "synthetic",
      expectation: EXPECT_EXACT,
      observed: OBSERVED_REFUSAL,
      entry: refusalEntry("unresolved_target"),
    });
    expect(outcome.kind).toBe("violation");
    expect(outcome.kind === "violation" && outcome.fabrication).toBe(false);
  });

  it("REJECTS a recorded cell that now agrees (the fix signal)", () => {
    const outcome = classifyCellOutcome({
      key: "synthetic",
      expectation: EXPECT_EXACT,
      observed: OBSERVED_RIGHT_EXACT,
      entry: refusalEntry("unsupported_callee_binding"),
    });
    expect(outcome.kind).toBe("violation");
  });

  it("REJECTS an unclassified refusal", () => {
    const outcome = classifyCellOutcome({
      key: "synthetic",
      expectation: EXPECT_EXACT,
      observed: OBSERVED_REFUSAL,
      entry: undefined,
    });
    expect(outcome.kind).toBe("violation");
  });

  it("REJECTS every degenerate observation, entry or no entry", () => {
    const degenerate: Observation[] = [
      { kind: "no-edge" },
      { kind: "ambiguous", count: 2 },
      { kind: "no-probe" },
    ];
    for (const observed of degenerate) {
      for (const entry of [
        undefined,
        refusalEntry("unsupported_callee_binding"),
      ]) {
        const outcome = classifyCellOutcome({
          key: "synthetic",
          expectation: EXPECT_EXACT,
          observed,
          entry,
        });
        expect(outcome.kind, `${observed.kind}`).toBe("violation");
      }
    }
  });

  it("accepts plain agreement with no entry", () => {
    expect(
      classifyCellOutcome({
        key: "synthetic",
        expectation: EXPECT_EXACT,
        observed: OBSERVED_RIGHT_EXACT,
        entry: undefined,
      }).kind,
    ).toBe("agrees");
  });

  it("the TYPE forbids an entry that names an exact target", () => {
    // The first layer of the guard. If this stops being a type error,
    // `npm run typecheck` fails on the `@ts-expect-error`, and the
    // runtime layer above is all that stands between a fabrication and
    // a green gate.
    const forbidden: KnownDisagreement = {
      form: "synthetic",
      mechanism: "synthetic",
      group: "synthetic",
      // @ts-expect-error -- a disagreement entry may record only a
      // refusal; naming an exact target is unrepresentable by design.
      observed: { kind: "exact", target: "node_modules/pkg/index.js#run" },
    };
    expect(forbidden.observed.kind).toBe("exact");
  });

  it("every committed entry records a refusal", () => {
    // The rule, applied to the real table rather than to synthetics.
    for (const d of KNOWN_DISAGREEMENTS) {
      expect(d.observed.kind, `${d.form} x ${d.mechanism}`).toBe("unknown");
      expect(d.observed.reason, `${d.form} x ${d.mechanism}`).toMatch(/^\w+$/);
    }
  });
});
