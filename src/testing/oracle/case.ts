import type { VulnerabilityProvider } from "../../domain/vulnerability.js";
import {
  assertLoudFixture,
  type LoudFixtureCheck,
  type LoudFixtureResult,
} from "./loud-fixture.js";
import { runGroundTruth, type GroundTruthResult } from "./ground-truth.js";
import {
  runOracleScan,
  type OracleScanOptions,
  type ScanObservation,
} from "./scan.js";
import { withTempProject, type ProjectSpec } from "./project.js";
import type { Verdict } from "../../domain/verdict.js";

/** One project variant: the "case" itself, or one of its controls. */
export interface OracleVariant {
  readonly name: string;
  readonly project: ProjectSpec;
  /** Overrides the case's own `groundTruthCommand` for this variant only. */
  readonly groundTruthCommand?: readonly [string, ...string[]];
}

export interface OracleControls {
  readonly positive: OracleVariant;
  readonly negative: OracleVariant;
}

/**
 * CONTROLS (task H-0 step 2). Every case requires both, unless it
 * explicitly declares why one does not apply -- with a reason string that
 * is reported, never silently absent. The one documented shape where a
 * control genuinely does not apply is a silent-drop case (see
 * docs/audits/2026-09-premise-sweep-round-1.md § 4 PRM-34: "A negative
 * control does not apply here, because the finding is the drop itself").
 */
export type ControlsDeclaration =
  | { readonly kind: "controls"; readonly controls: OracleControls }
  | { readonly kind: "inapplicable"; readonly reason: string };

/**
 * An expectation for the CASE variant itself (never for a control, which
 * always expects AFFECTED/NOT_AFFECTED unconditionally).
 *
 * ONLY FOR CASES ALREADY KNOWN TO BE SOUND. AGENTS.md § G forbids pinning
 * a wrong verdict as an expectation; an OPEN soundness defect must be
 * reproduced through {@link import("./scan.js").toVerdictObservation} and
 * `src/testing/open-soundness-defect.ts`'s `openSoundnessDefectProblems`
 * instead, which structurally cannot be satisfied by a wrong verdict (see
 * that module's own doc comment). This field exists for this harness's
 * own self-tests, and for a LATER task's case once its fix has landed.
 */
export interface OracleExpectation {
  readonly verdict: Verdict;
  /** The {@link import("./hit.js").hitCall} marker name real Node must (verdict AFFECTED) or must not (NOT_AFFECTED) have produced. */
  readonly calledMarker: string;
}

export interface OracleCase {
  readonly id: string;
  readonly loudFixture: LoudFixtureCheck;
  readonly provider: () => VulnerabilityProvider;
  readonly scanOptions?: OracleScanOptions;
  /** The default ground-truth command for every variant that does not override it. */
  readonly groundTruthCommand: readonly [string, ...string[]];
  readonly controls: ControlsDeclaration;
  readonly variant: OracleVariant;
  readonly expectation?: OracleExpectation;
}

/**
 * GROUND TRUTH IS STRUCTURAL (task H-0 step 2): `groundTruth` is a
 * REQUIRED field here, never optional and never obtainable on its own --
 * there is no function in this module that returns a {@link ScanObservation}
 * without one alongside it. A case "cannot assert an expected verdict
 * without also recording the real-Node ground truth it rests on" because
 * the type this module returns does not allow it.
 */
export interface OracleVariantResult {
  readonly name: string;
  readonly loud: LoudFixtureResult;
  readonly scan: ScanObservation;
  readonly groundTruth: GroundTruthResult;
}

export interface OracleCaseResult {
  readonly caseId: string;
  readonly variant: OracleVariantResult;
  readonly controls?: {
    readonly positive: OracleVariantResult;
    readonly negative: OracleVariantResult;
  };
  readonly controlsInapplicableReason?: string;
}

async function runVariant(
  kase: Pick<OracleCase, "loudFixture" | "provider" | "scanOptions" | "groundTruthCommand">,
  variant: OracleVariant,
): Promise<OracleVariantResult> {
  return withTempProject(variant.project, async (dir) => {
    // LOUD FIXTURE, unconditional: every variant is checked before it is
    // ever scanned, with no parameter anywhere in this module's public API
    // to suppress it.
    const loud = assertLoudFixture(dir, kase.loudFixture);
    const scan = await runOracleScan(dir, kase.provider(), kase.scanOptions);
    const groundTruth = runGroundTruth(
      dir,
      variant.groundTruthCommand ?? kase.groundTruthCommand,
    );
    return { name: variant.name, loud, scan, groundTruth };
  });
}

function firstVerdict(result: OracleVariantResult): Verdict | undefined {
  return result.scan.findings[0]?.verdict;
}

function describeVariant(result: OracleVariantResult): string {
  return (
    `exit ${String(result.scan.exitCode)}, ` +
    `${String(result.scan.findings.length)} finding(s), ` +
    `stderr: ${result.scan.stderr || "(empty)"}`
  );
}

/**
 * Runs one {@link OracleCase} end to end: the case variant, its controls
 * (unless declared inapplicable), the loud-fixture check and the
 * real-Node ground truth for every one of them -- and enforces every
 * guarantee task H-0 step 2 requires by THROWING when one is violated,
 * which is what turns a bad case into a loudly failing vitest test rather
 * than a silently accepted one.
 */
export async function runOracleCase(
  kase: OracleCase,
): Promise<OracleCaseResult> {
  const variant = await runVariant(kase, kase.variant);

  if (kase.expectation) {
    const observedVerdict = firstVerdict(variant);
    if (observedVerdict !== kase.expectation.verdict) {
      throw new Error(
        `${kase.id}: expected verdict ${kase.expectation.verdict}, analyzer gave ${observedVerdict ?? "<no finding>"} (${describeVariant(variant)})`,
      );
    }
    const called = variant.groundTruth.calledMarkers.has(
      kase.expectation.calledMarker,
    );
    if (kase.expectation.verdict === "AFFECTED" && !called) {
      throw new Error(
        `${kase.id}: ground truth contradicts expected verdict AFFECTED -- real Node never called "${kase.expectation.calledMarker}" (ground truth stdout: ${variant.groundTruth.stdout || "(empty)"})`,
      );
    }
    if (kase.expectation.verdict === "NOT_AFFECTED" && called) {
      throw new Error(
        `${kase.id}: ground truth contradicts expected verdict NOT_AFFECTED -- real Node DID call "${kase.expectation.calledMarker}" (ground truth stdout: ${variant.groundTruth.stdout || "(empty)"})`,
      );
    }
  }

  if (kase.controls.kind === "inapplicable") {
    return {
      caseId: kase.id,
      variant,
      controlsInapplicableReason: kase.controls.reason,
    };
  }

  const positive = await runVariant(kase, kase.controls.controls.positive);
  const negative = await runVariant(kase, kase.controls.controls.negative);

  const positiveVerdict = firstVerdict(positive);
  if (positiveVerdict !== "AFFECTED") {
    throw new Error(
      `${kase.id}: positive control expected AFFECTED, got ${positiveVerdict ?? "<no finding>"} (${describeVariant(positive)})`,
    );
  }
  const negativeVerdict = firstVerdict(negative);
  if (negativeVerdict !== "NOT_AFFECTED") {
    throw new Error(
      `${kase.id}: negative control expected NOT_AFFECTED, got ${negativeVerdict ?? "<no finding>"} (${describeVariant(negative)})`,
    );
  }

  return { caseId: kase.id, variant, controls: { positive, negative } };
}
