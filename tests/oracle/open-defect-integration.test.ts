import { describe, expect, it } from "vitest";
import {
  runOracleCase,
  type OracleCase,
} from "../../src/testing/oracle/case.js";
import { toVerdictObservation } from "../../src/testing/oracle/scan.js";
import { VERDICT_DOMAIN } from "../../src/testing/open-soundness-defect.js";
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
 * Proves the OPEN-DEFECT INTEGRATION seam (task H-0 step 2) plumbs a
 * scan-level result into the SAME {@link VERDICT_DOMAIN} /
 * `VerdictObservation` domain `src/testing/open-soundness-defect.ts`
 * already defines, without creating any `OpenSoundnessDefect` record
 * (task H-0 boundary: "Create no record in this task" -- that is for a
 * LATER task reproducing a specific open defect).
 */

const ADVISORY_ID = "GHSA-oracle-open-defect-integration";
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

function makeCase(entrySource: string): OracleCase {
  return {
    id: "open-defect-integration",
    loudFixture: { specifier: "vuln-lib", boundNames: ["parse", "safe"] },
    provider: () =>
      syntheticProvider([
        { id: ADVISORY_ID, packageName: "vuln-lib", fixed: "99.0.0" },
      ]),
    groundTruthCommand: nodeEntryCommand("src/index.js"),
    controls: {
      kind: "controls",
      controls: {
        positive: {
          name: "positive-control",
          project: project(
            'const lib = require("vuln-lib");\nlib.parse("x");\n',
          ),
        },
        negative: {
          name: "negative-control",
          project: project(
            'const lib = require("vuln-lib");\nlib.safe("x");\n',
          ),
        },
      },
    },
    variant: {
      name: "case",
      project: project(entrySource),
    },
  };
}

describe("toVerdictObservation: bridges a scan result into the existing VerdictObservation domain", () => {
  it("produces an observation VERDICT_DOMAIN agrees is AFFECTED, for a direct call", async () => {
    const result = await runOracleCase(
      makeCase('const lib = require("vuln-lib");\nlib.parse("x");\n'),
    );
    const finding = result.variant.scan.findings[0];
    const coverage = result.variant.scan.output?.coverage;
    expect(finding).toBeDefined();
    expect(coverage).toBeDefined();
    if (!finding || !coverage) return;

    const observation = toVerdictObservation(finding, coverage);

    expect(observation.verdict).toBe("AFFECTED");
    expect(VERDICT_DOMAIN.admits("AFFECTED", observation)).toBe(true);
    expect(VERDICT_DOMAIN.admits("NOT_AFFECTED", observation)).toBe(false);
    expect(VERDICT_DOMAIN.admits("UNKNOWN", observation)).toBe(false);
  });

  it("produces an observation VERDICT_DOMAIN agrees is NOT_AFFECTED, with a proof family, for an unreachable target", async () => {
    const result = await runOracleCase(
      makeCase('const lib = require("vuln-lib");\nlib.safe("x");\n'),
    );
    const finding = result.variant.scan.findings[0];
    const coverage = result.variant.scan.output?.coverage;
    expect(finding).toBeDefined();
    expect(coverage).toBeDefined();
    if (!finding || !coverage) return;

    const observation = toVerdictObservation(finding, coverage);

    expect(observation.verdict).toBe("NOT_AFFECTED");
    expect(observation.proofFamily).toBe("C");
    expect(VERDICT_DOMAIN.admits("NOT_AFFECTED", observation)).toBe(true);
    expect(VERDICT_DOMAIN.admits("AFFECTED", observation)).toBe(false);
  });
});
