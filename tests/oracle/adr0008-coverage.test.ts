import { describe, expect, it } from "vitest";
import {
  runOracleCase,
  type OracleCaseResult,
} from "../../src/testing/oracle/case.js";
import {
  ALL_BUILTIN_ARG_KINDS,
  probeBuiltinArgKind,
  probeBuiltinInvocation,
} from "../../src/testing/oracle/builtin-probe.js";
import { toVerdictObservation } from "../../src/testing/oracle/scan.js";
import {
  loadDefectRegisters,
  openSoundnessDefectProblems,
  VERDICT_DOMAIN,
  type OpenSoundnessDefect,
  type Verdict,
  type VerdictObservation,
} from "../../src/testing/open-soundness-defect.js";
import {
  S1,
  S2,
  S3,
  S4,
  TARGET_MARKER,
  oracleCase,
  type Scenario,
} from "./adr0008-coverage.cases.js";

/**
 * Task A-0 (docs/tasks/A-0-adr0008-coverage-reproduction.md): the
 * implicit invocations ADR 0008's protocol-member rule does not name,
 * reproduced on `main` against real Node, and pinned.
 *
 * Every scenario in `adr0008-coverage.cases.ts` has exactly one entry in
 * {@link PINS}, and each kind of entry is checked the only way AGENTS.md
 * § G allows:
 *
 * - `open-defect`: a reproduced wrong verdict. Pinned as an
 *   open-soundness-defect record (`src/testing/open-soundness-defect.ts`),
 *   never as an expectation: it fails when the defect is fixed (delete the
 *   record, assert `expected`) and when it drifts (re-measure).
 * - `sound-called` / `sound-not-called`: `main` is right today. Asserted
 *   as the ADMISSIBLE set for real Node's answer, not as today's exact
 *   verdict, so lane A may move them within that set (a sound precision
 *   cost) but never out of it.
 * - `precision-control` (S4): must stay exactly `NOT_AFFECTED` through lane
 *   A. Asserted through the harness's own `expectation`, which also checks
 *   real Node agrees.
 *
 * Every case, whatever its kind, also re-confirms with the H-0 builtin
 * probe what the trigger really does with the hook's argument kind.
 */

type Pin =
  | {
      readonly kind: "open-defect";
      readonly rwf: string;
      readonly failure: "false NOT_AFFECTED" | "false AFFECTED";
      readonly observed: VerdictObservation;
    }
  | { readonly kind: "sound-called" }
  | { readonly kind: "sound-not-called" }
  | { readonly kind: "precision-control" }
  /**
   * An `open-defect` record a lane-A task closed: its record was deleted,
   * and the case asserts the verdict REMEDIATION-PLAN § 5a requires
   * (`UNKNOWN`), with real Node's answer (`called`) re-checked.
   */
  | {
      readonly kind: "closed";
      readonly rwf: string;
      readonly by: string;
      readonly called: boolean;
    };

/** Closed by task A-3a: the case is UNKNOWN (REMEDIATION-PLAN § 5a, "A-0 additions"). Every false NOT_AFFECTED this suite pinned. */
const closedByA3a = (rwf: string): Pin => ({
  kind: "closed",
  rwf,
  by: "A-3a",
  called: true,
});
/**
 * Closed by task A-4: the getter is its own owner, reached by a possible
 * edge (Amendment A-0 part B), so the target is UNKNOWN. Every false
 * AFFECTED this suite pinned: real Node never runs these getters.
 */
const closedByA4 = (rwf: string): Pin => ({
  kind: "closed",
  rwf,
  by: "A-4",
  called: false,
});

const READERS = [
  "JSON.stringify",
  "Object.assign",
  "spread",
  "Object.entries",
] as const;
const forReaders = (form: string, pin: Pin): Record<string, Pin> =>
  Object.fromEntries(READERS.map((r) => [`S2.${form}.${r}`, pin]));

/** The measured result on `main` for every case, and the finding that owns it. */
const PINS: Readonly<Record<string, Pin>> = {
  // S1 -- util.inspect.custom: PRM-117. Closed by task A-3a through the
  // fail-closed default: none of the three builtins is admitted (the
  // admission test measures `util.inspect.custom` firing), and `obj` is
  // not attributable, so the call gets an unknown edge.
  "S1.console.log": closedByA3a("PRM-117"),
  "S1.util.inspect": closedByA3a("PRM-117"),
  "S1.util.format-o": closedByA3a("PRM-117"),

  // S2 -- getters. Only an OWN ENUMERABLE getter is read by these four
  // readers (measured). The object-literal getter is right today only
  // because its body is attributed to the module (round-1 PRM-46); the
  // same attribution fabricates a path for the class getters, which real
  // Node never runs (PRM-118, new). A default `defineProperty` getter is
  // non-enumerable and is correctly NOT_AFFECTED; the enumerable one is
  // the AUD-01 descriptor shape sweep round 2 recorded.
  ...forReaders("literal", { kind: "sound-called" }),
  // PRM-118, closed by task A-4: the getter body is no longer attributed
  // to the class-definition owner; the getter is reached by a possible
  // edge only.
  ...forReaders("class-instance", closedByA4("PRM-118")),
  ...forReaders("class-static", closedByA4("PRM-118")),
  ...forReaders("defineProperty", { kind: "sound-not-called" }),
  // AUD-01, closed by task A-3a: the descriptor's getter is a possible
  // edge (the escape row, "a property descriptor"), and the named object
  // handed to Object.defineProperty an unknown one.
  ...forReaders("defineProperty-enumerable", closedByA3a("AUD-01")),

  // S3 -- Proxy traps: the AUD-01 handler shape sweep round 2 recorded.
  // Closed by task A-3a: an inline handler's traps are possible edges from
  // `new Proxy` (the escape row), a named handler an unknown edge
  // (`new Proxy` is never admitted, Amendment A-0 part A).
  "S3.Object.keys.ownKeys": closedByA3a("AUD-01"),
  "S3.Object.getOwnPropertyNames.ownKeys": closedByA3a("AUD-01"),
  "S3.in.has": closedByA3a("AUD-01"),
  "S3.JSON.stringify.ownKeys": closedByA3a("AUD-01"),
  "S3.JSON.stringify.get": closedByA3a("AUD-01"),
  "S3.Object.keys.ownKeys.named-handler": closedByA3a("AUD-01"),
  "S3.in.has.named-handler": closedByA3a("AUD-01"),

  // S4 -- precision controls lane A must keep.
  "S4.Array.isArray": { kind: "precision-control" },
  "S4.Object.is": { kind: "precision-control" },
};

const ALL: readonly Scenario[] = [...S1, ...S2, ...S3, ...S4];

function confirmProbe(scenario: Scenario): void {
  if (scenario.probeExpect === "none") {
    const results = probeBuiltinInvocation(
      scenario.probeTemplate,
      ALL_BUILTIN_ARG_KINDS,
    );
    for (const kind of ALL_BUILTIN_ARG_KINDS) {
      expect(
        results[kind].ranUserCode,
        `${scenario.probeTemplate} ran user code for ${kind}: ${JSON.stringify(results[kind].fired)}`,
      ).toBe(false);
    }
    return;
  }
  const result = probeBuiltinArgKind(
    scenario.probeTemplate,
    scenario.probeExpect.kind,
  );
  expect(
    result.fired,
    `${scenario.probeTemplate} with a ${scenario.probeExpect.kind} argument`,
  ).toContain(scenario.probeExpect.fires);
}

function observe(result: OracleCaseResult): VerdictObservation {
  const coverage = result.variant.scan.output?.coverage;
  expect(coverage, "the case scan produced JSON output").toBeDefined();
  return toVerdictObservation(result.variant.scan.findings[0], coverage!);
}

describe("every A-0 scenario is pinned exactly once", () => {
  it("PINS and the scenario list name the same cases", () => {
    expect(Object.keys(PINS).sort()).toEqual(ALL.map((s) => s.id).sort());
  });
});

describe.each(ALL.map((s) => [s.id, s] as const))("%s", (_id, scenario) => {
  const pin = PINS[scenario.id]!;

  it(`${scenario.mechanism} -- ${pin.kind === "open-defect" ? `${pin.failure} (${pin.rwf})` : pin.kind}`, async () => {
    confirmProbe(scenario);

    if (pin.kind === "precision-control") {
      // The harness's expectation checks the verdict AND that real Node
      // never called the target.
      await runOracleCase({
        ...oracleCase(scenario),
        expectation: { verdict: "NOT_AFFECTED", calledMarker: TARGET_MARKER },
      });
      return;
    }

    const result = await runOracleCase(oracleCase(scenario));
    const called = result.variant.groundTruth.calledMarkers.has(TARGET_MARKER);
    const live = observe(result);

    if (pin.kind === "sound-called") {
      expect(called, "real Node calls the target").toBe(true);
      expect(["AFFECTED", "UNKNOWN"]).toContain(live.verdict);
      return;
    }
    if (pin.kind === "sound-not-called") {
      expect(called, "real Node never calls the target").toBe(false);
      expect(["NOT_AFFECTED", "UNKNOWN"]).toContain(live.verdict);
      return;
    }
    if (pin.kind === "closed") {
      expect(called, "real Node's ground truth").toBe(pin.called);
      expect(live.verdict, `${pin.rwf}, closed by ${pin.by}`).toBe("UNKNOWN");
      return;
    }

    const falseNotAffected = pin.failure === "false NOT_AFFECTED";
    expect(called, "real Node's ground truth for this record").toBe(
      falseNotAffected,
    );
    // After lane A, a target reachable only through a `possible` edge is
    // neither AFFECTED nor NOT_AFFECTED (ADR 0008 § 1, Decision 2).
    const admissible: readonly Verdict[] = falseNotAffected
      ? ["UNKNOWN", "AFFECTED"]
      : ["UNKNOWN", "NOT_AFFECTED"];
    const record: OpenSoundnessDefect<Verdict, VerdictObservation> = {
      caseId: scenario.id,
      rwf: pin.rwf,
      debt: "D-17",
      admissible,
      expected: "UNKNOWN",
      observed: pin.observed,
    };
    expect(
      openSoundnessDefectProblems(
        record,
        VERDICT_DOMAIN,
        live,
        loadDefectRegisters(),
      ),
    ).toEqual([]);
  });
});
