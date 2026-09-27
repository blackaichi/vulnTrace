import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";

/**
 * The stub OSV boundary of both adversarial suites, defined once (BL-029).
 *
 * `tests/adversarial/v1/adversarial.test.ts` and
 * `tests/adversarial/v2/adversarial-v2.test.ts` each inject one synthetic
 * OSV-shaped record; this is the only non-real piece of their pipeline.
 * The differential tool (`src/testing/differential-collect.ts`) must scan
 * with exactly the same records the suites scan with, or its "suite view"
 * would silently measure a different question. One definition, imported by
 * all three, makes that drift impossible instead of merely unlikely.
 */

/**
 * Every v1 scenario's vulnerable dependency is named `adv-vuln-lib`,
 * affected for versions < 2.0.0.
 */
export const ADVERSARIAL_V1_ADVISORY: RawVulnerability = {
  id: "GHSA-adv-0001",
  aliases: [],
  affected: [
    {
      package: { ecosystem: "npm", name: "adv-vuln-lib" },
      ranges: [
        { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "2.0.0" }] },
      ],
    },
  ],
  references: [],
};

/**
 * Every v2 scenario's vulnerable dependency is named `vt2-vuln-lib`,
 * affected for versions < 2.0.0.
 */
export const ADVERSARIAL_V2_ADVISORY: RawVulnerability = {
  id: "GHSA-vt2v2-0001",
  aliases: [],
  affected: [
    {
      package: { ecosystem: "npm", name: "vt2-vuln-lib" },
      ranges: [
        { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "2.0.0" }] },
      ],
    },
  ],
  references: [],
};

/** A provider answering by package name only, as both suites' stub does. */
export function stubProvider(
  byPackageName: Readonly<Record<string, readonly RawVulnerability[]>>,
): VulnerabilityProvider {
  return {
    queryPackage(query: PackageQuery): Promise<readonly RawVulnerability[]> {
      return Promise.resolve(byPackageName[query.name] ?? []);
    },
  };
}

export function adversarialV1Provider(): VulnerabilityProvider {
  return stubProvider({ "adv-vuln-lib": [ADVERSARIAL_V1_ADVISORY] });
}

export function adversarialV2Provider(): VulnerabilityProvider {
  return stubProvider({ "vt2-vuln-lib": [ADVERSARIAL_V2_ADVISORY] });
}
