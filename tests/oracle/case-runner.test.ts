import { describe, expect, it } from "vitest";
import {
  runOracleCase,
  type OracleCase,
} from "../../src/testing/oracle/case.js";
import { LoudFixtureViolation } from "../../src/testing/oracle/loud-fixture.js";
import { nodeEntryCommand } from "../../src/testing/oracle/ground-truth.js";
import { syntheticProvider } from "../../src/testing/oracle/provider.js";
import {
  simpleConfigFile,
  simplePackageFiles,
  simpleRuleFile,
} from "../../src/testing/oracle/config-files.js";
import {
  HIT_HELPER_SOURCE,
  hitFunction,
} from "../../src/testing/oracle/hit.js";
import type { ProjectSpec } from "../../src/testing/oracle/project.js";

/**
 * SELF-TEST for the case runner (task H-0 step 4): "prove the harness
 * catches what it exists to catch." Every case below uses only fixtures
 * that pass on `main` today -- no failing reproduction from docs/audits/
 * is ported here (that belongs to later tasks; task H-0 boundary).
 *
 * Shared fixture: `vuln-lib` exports `parse` (the rule's target) and
 * `safe` (an inert sibling), each marked with the `hit()` convention
 * (src/testing/oracle/hit.ts) so ground truth is a plain "CALLED <name>"
 * line -- the same convention every docs/audits/ reproduction uses.
 */

const ADVISORY_ID = "GHSA-oracle-self-test";
const LIB_SOURCE =
  HIT_HELPER_SOURCE +
  hitFunction("parse", '"p"') +
  hitFunction("safe", '"s"') +
  `module.exports = { parse, safe };\n`;

function project(entrySource: string): ProjectSpec {
  return {
    files: {
      ...simplePackageFiles("app", "vuln-lib", "1.0.0"),
      "node_modules/vuln-lib/package.json": JSON.stringify({
        name: "vuln-lib",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/vuln-lib/index.js": LIB_SOURCE,
      "src/index.js": entrySource,
      "rules.yml": simpleRuleFile({
        id: ADVISORY_ID,
        packageName: "vuln-lib",
        exportName: "parse",
      }),
      "vulntrace.yml": simpleConfigFile({ entrypoints: ["src/index.js"] }),
    },
  };
}

const CALL_PARSE = 'const lib = require("vuln-lib");\nlib.parse("x");\n';
const CALL_SAFE = 'const lib = require("vuln-lib");\nlib.safe("x");\n';

function baseCase(overrides: Partial<OracleCase> = {}): OracleCase {
  return {
    id: "self-test",
    loudFixture: { specifier: "vuln-lib", boundNames: ["parse", "safe"] },
    provider: () =>
      syntheticProvider([
        { id: ADVISORY_ID, packageName: "vuln-lib", fixed: "99.0.0" },
      ]),
    groundTruthCommand: nodeEntryCommand("src/index.js"),
    controls: {
      kind: "controls",
      controls: {
        positive: { name: "positive-control", project: project(CALL_PARSE) },
        negative: { name: "negative-control", project: project(CALL_SAFE) },
      },
    },
    variant: { name: "case", project: project(CALL_PARSE) },
    expectation: { verdict: "AFFECTED", calledMarker: "parse" },
    ...overrides,
  };
}

describe("runOracleCase: the happy path", () => {
  it("passes when controls and ground truth agree", async () => {
    const result = await runOracleCase(baseCase());

    expect(result.variant.scan.findings[0]?.verdict).toBe("AFFECTED");
    expect(result.variant.groundTruth.calledMarkers.has("parse")).toBe(true);
    expect(result.controls?.positive.scan.findings[0]?.verdict).toBe(
      "AFFECTED",
    );
    expect(result.controls?.negative.scan.findings[0]?.verdict).toBe(
      "NOT_AFFECTED",
    );
    expect(
      result.controls?.negative.groundTruth.calledMarkers.has("parse"),
    ).toBe(false);
  });

  it("reports the declared reason for a case whose controls are inapplicable", async () => {
    const result = await runOracleCase(
      baseCase({
        controls: { kind: "inapplicable", reason: "silent-drop case" },
        expectation: undefined,
      }),
    );
    expect(result.controlsInapplicableReason).toBe("silent-drop case");
    expect(result.controls).toBeUndefined();
  });
});

describe("runOracleCase: catches a broken case (functional)", () => {
  it("fails loudly when a bound name is not exported by the fixture", async () => {
    const badCase = baseCase({
      loudFixture: {
        specifier: "vuln-lib",
        boundNames: ["parse", "safe", "doesNotExist"],
      },
    });
    await expect(runOracleCase(badCase)).rejects.toThrow(LoudFixtureViolation);
  });

  it("fails when the negative control does not resolve to NOT_AFFECTED", async () => {
    const badCase = baseCase({
      controls: {
        kind: "controls",
        controls: {
          positive: { name: "positive-control", project: project(CALL_PARSE) },
          // WRONG: a "negative" control that actually calls the vulnerable export.
          negative: { name: "negative-control", project: project(CALL_PARSE) },
        },
      },
    });
    await expect(runOracleCase(badCase)).rejects.toThrow(
      /negative control expected NOT_AFFECTED/,
    );
  });

  it("fails when the declared expectation contradicts real-Node ground truth", async () => {
    // The analyzer correctly reports NOT_AFFECTED here (nothing in this
    // variant calls "parse", the rule's target) -- the contradiction is
    // between the DECLARED expectation and GROUND TRUTH, not between the
    // expectation and the analyzer, which is what this case's own
    // "calledMarker: safe" is built to exercise without asserting
    // anything false about the analyzer itself.
    const badCase = baseCase({
      variant: { name: "case", project: project(CALL_SAFE) },
      expectation: { verdict: "NOT_AFFECTED", calledMarker: "safe" },
    });
    await expect(runOracleCase(badCase)).rejects.toThrow(
      /ground truth contradicts expected verdict NOT_AFFECTED/,
    );
  });
});

describe("mutations: the guarantees cannot be bypassed", () => {
  it("mutation: a positive control that does not resolve to AFFECTED is caught, not skipped", async () => {
    const badCase = baseCase({
      controls: {
        kind: "controls",
        controls: {
          // WRONG: a "positive" control that never calls the vulnerable export.
          positive: { name: "positive-control", project: project(CALL_SAFE) },
          negative: { name: "negative-control", project: project(CALL_SAFE) },
        },
      },
    });
    await expect(runOracleCase(badCase)).rejects.toThrow(
      /positive control expected AFFECTED/,
    );
  });

  it("mutation: the loud-fixture check cannot be bypassed at the primitive level either", async () => {
    // Below runOracleCase entirely: assertLoudFixture itself, called
    // directly the way runVariant calls it internally, with no case
    // wrapper to potentially short-circuit.
    const { assertLoudFixture } =
      await import("../../src/testing/oracle/loud-fixture.js");
    const { withTempProject } =
      await import("../../src/testing/oracle/project.js");
    await expect(
      withTempProject(project(CALL_PARSE), (dir) =>
        assertLoudFixture(dir, {
          specifier: "vuln-lib",
          boundNames: ["parse", "safe", "phantom"],
        }),
      ),
    ).rejects.toThrow(LoudFixtureViolation);
  });

  it("ground truth is present alongside every scan observation, for the case and both controls", async () => {
    // Runtime confirmation of the structural guarantee that is actually
    // TYPE-CHECKED in src/testing/oracle/case.guards.test.ts (which lives
    // under src/, where `npm run typecheck` runs -- unlike this
    // dedicated suite's tests/oracle/, which it does not cover): every
    // `OracleVariantResult` this module ever returns carries a real
    // `GroundTruthResult`, never a placeholder or an absent one.
    const result = await runOracleCase(baseCase());
    for (const variant of [
      result.variant,
      result.controls?.positive,
      result.controls?.negative,
    ]) {
      expect(variant).toBeDefined();
      expect(variant?.groundTruth.command.length).toBeGreaterThan(0);
      expect(variant?.groundTruth.calledMarkers).toBeInstanceOf(Set);
    }
  });
});
