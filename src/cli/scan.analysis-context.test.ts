import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";
import { fixturePath } from "../testing/fixtures.js";
import { runScanCommand } from "./scan.js";

/**
 * VT-CONTRACT-03 at the production boundary.
 *
 * Two things this file pins that the analysis-layer suite cannot:
 *
 *  - the real `runScanCommand` drives every finding through ONE proof
 *    context and still produces exactly the verdicts and proofs it did
 *    before the API changed;
 *  - the context identity is internal machinery and never reaches the
 *    serialized result. It is a correctness mechanism, not evidence: a
 *    consumer must not see it, a schema must not carry it, and a diff of
 *    two scans must not churn on it.
 */

function fakeProvider(
  byPackageName: Readonly<Record<string, readonly RawVulnerability[]>>,
): VulnerabilityProvider {
  return {
    queryPackage(query: PackageQuery): Promise<readonly RawVulnerability[]> {
      return Promise.resolve(byPackageName[query.name] ?? []);
    },
  };
}

const FIXTURE_LIB_GHSA: RawVulnerability = {
  id: "GHSA-fixture-0001",
  aliases: [],
  affected: [
    {
      package: { ecosystem: "npm", name: "fixture-lib" },
      ranges: [
        { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] },
      ],
    },
  ],
  references: [],
};

interface JsonFindingShape {
  readonly verdict: string;
  readonly evidence?: Record<string, unknown>;
}

describe("VT-CONTRACT-03: the production scan uses one proof context", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function writeConfig(targetExport: string): string {
    tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-ctx-cli-"));
    const rulesPath = path.join(tmpDir, "rules.yml");
    writeFileSync(
      rulesPath,
      "rules:\n" +
        "  - id: GHSA-fixture-0001\n" +
        "    package:\n" +
        "      name: fixture-lib\n" +
        "    targets:\n" +
        "      - module: fixture-lib\n" +
        `        export: ${targetExport}\n`,
    );
    const configPath = path.join(tmpDir, "vulntrace.yml");
    writeFileSync(
      configPath,
      "analysis:\n  entrypoints:\n    - src/index.ts\n" +
        `rules:\n  files:\n    - ${JSON.stringify(rulesPath)}\n`,
    );
    return configPath;
  }

  async function scan(
    fixture: string,
    targetExport: string,
  ): Promise<{ exitCode: number; output: Record<string, unknown> }> {
    const configPath = writeConfig(targetExport);
    const stdout: string[] = [];
    const exitCode = await runScanCommand({
      projectPathArg: fixturePath(fixture),
      configPathOverride: configPath,
      provider: fakeProvider({ "fixture-lib": [FIXTURE_LIB_GHSA] }),
      noCache: true,
      io: { stdout: (t) => stdout.push(t), stderr: () => {} },
    });
    return {
      exitCode,
      output: JSON.parse(stdout.join("")) as Record<string, unknown>,
    };
  }

  it("case 12: a real scan still produces its proof, through one context", async () => {
    const { exitCode, output } = await scan("not-reachable", "vulnerable");

    // Unchanged from before VT-CONTRACT-03: a real family-C NOT_AFFECTED.
    expect(exitCode).toBe(0);
    const findings = output.findings as readonly JsonFindingShape[];
    expect(findings.length).toBeGreaterThan(0);

    const notAffected = findings.filter((f) => f.verdict === "NOT_AFFECTED");
    expect(notAffected.length).toBeGreaterThan(0);
    for (const finding of notAffected) {
      // Every NOT_AFFECTED still carries exactly one proof -- the context
      // change did not withdraw a legitimate proof anywhere.
      const proofs = [
        "confirmedAbsentFromModuleLoadClosure",
        "confirmedAbsentInstance",
        "confirmedUnreachableTarget",
      ].filter((key) => finding.evidence?.[key] !== undefined);
      expect(proofs).toHaveLength(1);
    }
  });

  it("case 12b: an AFFECTED scan is unchanged too", async () => {
    const { exitCode, output } = await scan("direct-esm", "vulnerable");

    expect(exitCode).toBe(1);
    const findings = output.findings as readonly JsonFindingShape[];
    expect(findings.some((f) => f.verdict === "AFFECTED")).toBe(true);
    // No negative proof may ride along on an AFFECTED.
    for (const finding of findings.filter((f) => f.verdict === "AFFECTED")) {
      expect(finding.evidence?.["confirmedUnreachableTarget"]).toBeUndefined();
      expect(
        finding.evidence?.["confirmedAbsentFromModuleLoadClosure"],
      ).toBeUndefined();
      expect(finding.evidence?.["confirmedAbsentInstance"]).toBeUndefined();
    }
  });

  it("case 14: the context identity never reaches the serialized result", async () => {
    const { output } = await scan("not-reachable", "vulnerable");
    const json = JSON.stringify(output);

    // Neither the mark's description nor any field name from the context
    // appears anywhere in the output.
    expect(json).not.toContain("analysisProofContext");
    expect(json).not.toContain("vulntrace.analysisProofContext");
    expect(json).not.toContain("graphTruncated");
    expect(json).not.toContain("knownPackageRoots");
    expect(json).not.toContain("projectRoot");
    expect(json).not.toContain("moduleLoadClosure");

    // A symbol-keyed property cannot survive JSON at all, but assert the
    // shape directly too: findings carry only their documented keys.
    const findings = output.findings as readonly Record<string, unknown>[];
    for (const finding of findings) {
      for (const key of Object.keys(finding)) {
        expect([
          "vulnerability",
          "package",
          "version",
          "verdict",
          "confidence",
          "target",
          "evidence",
        ]).toContain(key);
      }
      const evidence = finding.evidence as Record<string, unknown> | undefined;
      for (const key of Object.keys(evidence ?? {})) {
        expect([
          "path",
          "reasons",
          "confirmedAbsentFromModuleLoadClosure",
          "confirmedAbsentInstance",
          "confirmedUnreachableTarget",
        ]).toContain(key);
      }
      expect(Object.getOwnPropertySymbols(finding)).toHaveLength(0);
    }
  });
});
