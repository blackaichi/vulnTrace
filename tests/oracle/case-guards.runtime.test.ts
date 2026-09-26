import { describe, expect, it } from "vitest";
import {
  OracleCaseViolation,
  runOracleCase,
  type OracleCase,
} from "../../src/testing/oracle/case.js";
import {
  assertLoudFixture,
  LoudFixtureViolation,
  type LoudFixtureCheck,
} from "../../src/testing/oracle/loud-fixture.js";
import {
  nodeEntryCommand,
  runGroundTruth,
} from "../../src/testing/oracle/ground-truth.js";
import { syntheticProvider } from "../../src/testing/oracle/provider.js";
import type { ProjectSpec } from "../../src/testing/oracle/project.js";

/**
 * RUNTIME structural guards (task A-0 step 1).
 *
 * `src/testing/oracle/case.guards.test.ts` proves the TYPES forbid a case
 * with no bound names, no controls or no ground truth. A type only binds
 * where a gate type-checks the file, and a cast, untyped JSON or an
 * unchecked file gets past it. Every case below is therefore built with
 * an explicit cast around the one malformed field, and each must be
 * REFUSED before anything is scanned or run -- which the empty project
 * (no files at all) makes observable: had the runner gone on to scan it,
 * the failure would be a scan or control error, not this violation.
 */

const EMPTY_PROJECT: ProjectSpec = { files: {} };

function wellFormed(): OracleCase {
  return {
    id: "runtime-guard",
    loudFixture: { specifier: "vuln-lib", boundNames: ["parse"] },
    provider: () => syntheticProvider([]),
    groundTruthCommand: nodeEntryCommand("src/index.js"),
    controls: {
      kind: "controls",
      controls: {
        positive: { name: "positive-control", project: EMPTY_PROJECT },
        negative: { name: "negative-control", project: EMPTY_PROJECT },
      },
    },
    variant: { name: "case", project: EMPTY_PROJECT },
  };
}

async function refusal(kase: OracleCase): Promise<OracleCaseViolation> {
  const error: unknown = await runOracleCase(kase).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OracleCaseViolation);
  return error as OracleCaseViolation;
}

describe("runOracleCase refuses a malformed case at runtime", () => {
  it("an empty boundNames list", async () => {
    const violation = await refusal({
      ...wellFormed(),
      loudFixture: {
        specifier: "vuln-lib",
        boundNames: [] as unknown as LoudFixtureCheck["boundNames"],
      },
    });
    expect(violation.problems.join("\n")).toMatch(/boundNames is empty/);
  });

  it("a boundNames list holding an empty name", async () => {
    const violation = await refusal({
      ...wellFormed(),
      loudFixture: { specifier: "vuln-lib", boundNames: [""] },
    });
    expect(violation.problems.join("\n")).toMatch(/non-name entry/);
  });

  it("no controls declaration at all", async () => {
    const violation = await refusal({
      ...wellFormed(),
      controls: undefined as unknown as OracleCase["controls"],
    });
    expect(violation.problems.join("\n")).toMatch(/no controls/);
  });

  it("a control pair missing its negative control", async () => {
    const violation = await refusal({
      ...wellFormed(),
      controls: {
        kind: "controls",
        controls: {
          positive: { name: "positive-control", project: EMPTY_PROJECT },
        },
      } as unknown as OracleCase["controls"],
    });
    expect(violation.problems.join("\n")).toMatch(
      /controls\.negative: missing/,
    );
  });

  it("controls declared inapplicable with an empty reason", async () => {
    const violation = await refusal({
      ...wellFormed(),
      controls: { kind: "inapplicable", reason: "  " },
    });
    expect(violation.problems.join("\n")).toMatch(/no reason/);
  });

  it("no ground-truth command", async () => {
    const violation = await refusal({
      ...wellFormed(),
      groundTruthCommand:
        undefined as unknown as OracleCase["groundTruthCommand"],
    });
    expect(violation.problems.join("\n")).toMatch(
      /groundTruthCommand: no ground-truth command/,
    );
  });

  it("an empty ground-truth command", async () => {
    const violation = await refusal({
      ...wellFormed(),
      groundTruthCommand: [] as unknown as OracleCase["groundTruthCommand"],
    });
    expect(violation.problems.join("\n")).toMatch(/no ground-truth command/);
  });

  it("an empty per-variant ground-truth override", async () => {
    const violation = await refusal({
      ...wellFormed(),
      variant: {
        name: "case",
        project: EMPTY_PROJECT,
        groundTruthCommand: [""] as unknown as OracleCase["groundTruthCommand"],
      },
    });
    expect(violation.problems.join("\n")).toMatch(
      /variant\.groundTruthCommand: no ground-truth command/,
    );
  });
});

describe("the lower-level entry points refuse the same shapes", () => {
  it("assertLoudFixture refuses an empty boundNames list", () => {
    // `node:path` loads anywhere, so the only thing wrong here is the
    // empty list -- a load failure cannot satisfy this test instead.
    expect(() =>
      assertLoudFixture(process.cwd(), {
        specifier: "node:path",
        boundNames: [] as unknown as LoudFixtureCheck["boundNames"],
      }),
    ).toThrow(LoudFixtureViolation);
    expect(() =>
      assertLoudFixture(process.cwd(), {
        specifier: "node:path",
        boundNames: [] as unknown as LoudFixtureCheck["boundNames"],
      }),
    ).toThrow(/no bound names declared/);
  });

  it("runGroundTruth refuses an empty command instead of recording threw: true", () => {
    expect(() =>
      runGroundTruth(
        process.cwd(),
        [] as unknown as readonly [string, ...string[]],
      ),
    ).toThrow(/no ground-truth command/);
  });
});
