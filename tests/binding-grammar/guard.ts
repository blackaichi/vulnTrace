import type { Observation } from "./harness.js";
import type { Expectation } from "./matrix.js";
import type { KnownDisagreement } from "./disagreements.js";

/**
 * THE GUARD: what a disagreement entry is allowed to silence.
 *
 * `disagreements.ts` entries are SILENCERS. Each one converts a cell
 * that would fail into a cell that passes. That is what makes the sweep
 * a usable standing gate instead of a permanently red research record --
 * and it is also the one mechanism by which this instrument could be
 * turned against itself.
 *
 * THE FAILURE MODE THIS PREVENTS. Suppose a future change makes
 * `const [, run] = require("pkg")` resolve to `pkg#run` again -- the
 * exact RWF-046a defect. The cell fails. If entries could record any
 * observation, the cheapest way to get CI green is to add one saying
 * "observed: EXACT node_modules/pkg/index.js#run", and the suite built
 * to catch that defect now certifies it. The wrong answer would sit in
 * a file whose header says the wrong answer is never pinned.
 *
 * THE RULE. An entry may silence exactly one kind of divergence:
 *
 *     expected an EXACT target, observed a REFUSAL.
 *
 * That is the direction this engine is permitted to fail in -- costing
 * an edge, never inventing one. Everything else fails unconditionally:
 *
 *   - observed an EXACT that is not the expected one. A wrong export
 *     name, a wrong install, or a wrong declaration. Class A/B/C, and
 *     NO ENTRY CAN SILENCE IT -- {@link classifyCellOutcome} checks this
 *     BEFORE it looks at the table at all.
 *   - observed an EXACT where a refusal was expected: a fabrication out
 *     of a shape that proves nothing. Same treatment.
 *   - observed a degenerate result (no edge, several edges, no probe).
 *     A vanished probe is its own defect and must never read as a
 *     refusal.
 *   - expected a refusal and observed a different refusal. Not a
 *     fabrication, but not the refusal direction either: the cell's
 *     expectation and the engine's own reason taxonomy disagree, which
 *     is a fact somebody has to look at rather than record.
 *
 * TWO LAYERS, DELIBERATELY. {@link KnownDisagreement}'s `observed` field
 * is typed so it cannot NAME an exact target -- the wrong entry is
 * unrepresentable, not merely discouraged. This function enforces the
 * same rule again at runtime, because a type constrains source code and
 * says nothing about a value that arrives through a cast, a JSON load,
 * or a later widening of the field. `guard.test.ts` proves both layers.
 */

export type CellOutcome =
  /** Observed exactly what the oracle expects. */
  | { readonly kind: "agrees" }
  /** A refusal that a recorded, classified entry accounts for. */
  | { readonly kind: "known-disagreement" }
  /**
   * The cell must fail. `message` says why, and `fabrication` marks the
   * subset that no entry could ever have silenced.
   */
  | {
      readonly kind: "violation";
      readonly message: string;
      readonly fabrication: boolean;
    };

/** The observation format the report and the entries both speak. */
export function formatObserved(o: Observation): string {
  switch (o.kind) {
    case "exact":
      return `EXACT ${o.target}`;
    case "unknown":
      return `UNKNOWN ${o.reason}`;
    case "no-edge":
      return "NO-EDGE";
    case "ambiguous":
      return `AMBIGUOUS(${o.count})`;
    case "no-probe":
      return "NO-PROBE";
  }
}

export function formatExpected(e: Expectation): string {
  return e.kind === "exact" ? `EXACT ${e.target}` : `UNKNOWN ${e.reason}`;
}

export interface CellJudgement {
  readonly key: string;
  readonly expectation: Expectation;
  readonly observed: Observation;
  readonly entry: KnownDisagreement | undefined;
}

export function classifyCellOutcome(input: CellJudgement): CellOutcome {
  const { key, expectation, observed, entry } = input;
  const actual = formatObserved(observed);
  const wanted = formatExpected(expectation);

  // ------------------------------------------------------------------
  // (1) THE UNCONDITIONAL GUARD. Checked BEFORE `entry` is consulted,
  // so that no table row can reach it.
  // ------------------------------------------------------------------
  if (observed.kind === "exact" && actual !== wanted) {
    return {
      kind: "violation",
      fabrication: true,
      message:
        `${key}: the analyzer named a target that is NOT the correct one.\n` +
        `  expected: ${wanted}\n` +
        `  observed: ${actual}\n` +
        `This is a wrong attribution -- a wrong export name, a wrong ` +
        `install, or a wrong declaration -- and it is the class-A defect ` +
        `class this instrument exists to catch (RWF-043, RWF-045, ` +
        `RWF-046, RWF-046a). It CANNOT be silenced by adding a row to ` +
        `disagreements.ts: entries may only record the refusal ` +
        `direction, and this check runs before the table is read. ` +
        `Classify it, report it as a live soundness defect, and fix the ` +
        `analyzer.`,
    };
  }

  // A degenerate observation is never a refusal and never an answer.
  if (
    observed.kind === "no-edge" ||
    observed.kind === "ambiguous" ||
    observed.kind === "no-probe"
  ) {
    return {
      kind: "violation",
      fabrication: false,
      message:
        `${key}: degenerate observation ${actual}. The probe produced no ` +
        `single call edge, so the cell asked nothing. This is a defect in ` +
        `the cell or in the graph, never a refusal, and no entry may ` +
        `record it.`,
    };
  }

  // ------------------------------------------------------------------
  // (2) Agreement.
  // ------------------------------------------------------------------
  if (actual === wanted) {
    if (entry) {
      return {
        kind: "violation",
        fabrication: false,
        message:
          `${key} is recorded as a known disagreement but now AGREES with ` +
          `the correct expectation (${wanted}). The analyzer was fixed. ` +
          `Delete its row from disagreements.ts -- never edit the row to ` +
          `match.`,
      };
    }
    return { kind: "agrees" };
  }

  // ------------------------------------------------------------------
  // (3) A divergence. Only the refusal direction is recordable.
  // ------------------------------------------------------------------
  if (expectation.kind !== "exact") {
    return {
      kind: "violation",
      fabrication: false,
      message:
        `${key}: expected ${wanted} and observed ${actual}. Both are ` +
        `refusals, so this is not a fabrication -- but it is not the ` +
        `refusal direction either. The cell's expected reason and the ` +
        `analyzer's own taxonomy disagree about WHY this shape is ` +
        `unresolved, which is something to look at rather than to ` +
        `record. Fix the expected reason if the cell is wrong about the ` +
        `call shape; otherwise this is a taxonomy finding.`,
    };
  }

  if (!entry) {
    return {
      kind: "violation",
      fabrication: false,
      message:
        `${key}: UNCLASSIFIED DISAGREEMENT. Expected ${wanted}, observed ` +
        `${actual}. The analyzer refuses where the language names a ` +
        `target. That may well be a sound, deliberate refusal -- but it ` +
        `has not been classified, so add a row to disagreements.ts with ` +
        `a group carrying its class and its FINDINGS reference.`,
    };
  }

  // The entry's type cannot name an EXACT, but a value can still arrive
  // through a cast or a JSON load, so the rule is re-checked here.
  if (entry.observed.kind !== "unknown") {
    return {
      kind: "violation",
      fabrication: true,
      message:
        `${key}: the disagreement entry does not record a refusal. Only ` +
        `the refusal direction may be silenced; an entry naming an exact ` +
        `target would let the gate go green on a fabrication.`,
    };
  }

  if (`UNKNOWN ${entry.observed.reason}` !== actual) {
    return {
      kind: "violation",
      fabrication: false,
      message:
        `${key}: a known disagreement whose observed behaviour has ` +
        `CHANGED.\n  recorded: UNKNOWN ${entry.observed.reason}\n` +
        `  observed: ${actual}\n` +
        `The defect changed shape. Re-measure it and re-classify before ` +
        `updating the row.`,
    };
  }

  return { kind: "known-disagreement" };
}
