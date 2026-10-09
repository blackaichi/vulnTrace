import { describe, expect, it } from "vitest";
import { OsvNormalizationError } from "./osv-normalizer-errors.js";
import { normalizeOsvVulnerability } from "./osv-normalizer.js";

const target = { ecosystem: "npm", name: "fixture-lib" };

describe("normalizeOsvVulnerability: aliases", () => {
  it("maps aliases, defaulting to an empty array when absent", () => {
    const withAliases = normalizeOsvVulnerability(
      {
        id: "GHSA-fixture-0001",
        aliases: ["CVE-2021-99999"],
        affected: [{ package: target, ranges: [] }],
      },
      target,
    );
    expect(withAliases.aliases).toEqual(["CVE-2021-99999"]);

    const withoutAliases = normalizeOsvVulnerability(
      { id: "GHSA-fixture-0001", affected: [{ package: target, ranges: [] }] },
      target,
    );
    expect(withoutAliases.aliases).toEqual([]);
  });
});

describe("normalizeOsvVulnerability: affected ranges", () => {
  it("maps a simple introduced+fixed range", () => {
    const vuln = normalizeOsvVulnerability(
      {
        id: "GHSA-fixture-0001",
        affected: [
          {
            package: target,
            ranges: [
              {
                type: "SEMVER",
                events: [{ introduced: "0" }, { fixed: "1.5.0" }],
              },
            ],
          },
        ],
      },
      target,
    );

    expect(vuln.affectedVersions).toEqual([
      { introduced: "0", fixed: "1.5.0" },
    ]);
    expect(vuln.fixedVersions).toEqual(["1.5.0"]);
  });

  it("maps an open-ended range with no known fix yet", () => {
    const vuln = normalizeOsvVulnerability(
      {
        id: "GHSA-fixture-0001",
        affected: [
          {
            package: target,
            ranges: [{ type: "SEMVER", events: [{ introduced: "2.0.0" }] }],
          },
        ],
      },
      target,
    );

    expect(vuln.affectedVersions).toEqual([{ introduced: "2.0.0" }]);
    expect(vuln.fixedVersions).toEqual([]);
  });

  it("splits multiple disjoint ranges within one events array", () => {
    const vuln = normalizeOsvVulnerability(
      {
        id: "GHSA-fixture-0001",
        affected: [
          {
            package: target,
            ranges: [
              {
                type: "SEMVER",
                events: [
                  { introduced: "1.0.0" },
                  { fixed: "1.5.0" },
                  { introduced: "2.0.0" },
                  { fixed: "2.3.0" },
                ],
              },
            ],
          },
        ],
      },
      target,
    );

    expect(vuln.affectedVersions).toEqual([
      { introduced: "1.0.0", fixed: "1.5.0" },
      { introduced: "2.0.0", fixed: "2.3.0" },
    ]);
    expect(vuln.fixedVersions).toEqual(["1.5.0", "2.3.0"]);
  });

  it("maps a last_affected event", () => {
    const vuln = normalizeOsvVulnerability(
      {
        id: "GHSA-fixture-0001",
        affected: [
          {
            package: target,
            ranges: [
              {
                type: "SEMVER",
                events: [{ introduced: "1.0.0" }, { last_affected: "1.2.0" }],
              },
            ],
          },
        ],
      },
      target,
    );

    expect(vuln.affectedVersions).toEqual([
      { introduced: "1.0.0", lastAffected: "1.2.0" },
    ]);
    expect(vuln.fixedVersions).toEqual([]);
  });

  it("maps an explicit versions[] enumeration to single-version ranges", () => {
    const vuln = normalizeOsvVulnerability(
      {
        id: "GHSA-fixture-0001",
        affected: [{ package: target, versions: ["1.0.0", "1.0.1"] }],
      },
      target,
    );

    expect(vuln.affectedVersions).toEqual([
      { introduced: "1.0.0", lastAffected: "1.0.0" },
      { introduced: "1.0.1", lastAffected: "1.0.1" },
    ]);
  });

  it("deduplicates fixedVersions across multiple affected entries", () => {
    const vuln = normalizeOsvVulnerability(
      {
        id: "GHSA-fixture-0001",
        affected: [
          {
            package: target,
            ranges: [
              { events: [{ introduced: "0" }, { fixed: "1.5.0" }] },
              { events: [{ introduced: "1.6.0" }, { fixed: "1.5.0" }] },
            ],
          },
        ],
      },
      target,
    );

    expect(vuln.fixedVersions).toEqual(["1.5.0"]);
  });
});

describe("normalizeOsvVulnerability: ecosystem/package scoping", () => {
  it("only uses affected entries matching the target, ignoring other ecosystems", () => {
    const vuln = normalizeOsvVulnerability(
      {
        id: "GHSA-fixture-0001",
        affected: [
          {
            package: { ecosystem: "PyPI", name: "fixture-lib" },
            ranges: [{ events: [{ introduced: "0" }, { fixed: "9.9.9" }] }],
          },
          {
            package: target,
            ranges: [{ events: [{ introduced: "0" }, { fixed: "1.0.1" }] }],
          },
        ],
      },
      target,
    );

    expect(vuln.affectedVersions).toEqual([
      { introduced: "0", fixed: "1.0.1" },
    ]);
    expect(vuln.package).toBe("fixture-lib");
    expect(vuln.ecosystem).toBe("npm");
  });

  it("throws when no affected entry matches the target package/ecosystem", () => {
    expect(() =>
      normalizeOsvVulnerability(
        {
          id: "GHSA-fixture-0001",
          affected: [
            {
              package: { ecosystem: "PyPI", name: "unrelated-package" },
              ranges: [],
            },
          ],
        },
        target,
      ),
    ).toThrow(OsvNormalizationError);
  });

  it("throws when affected is entirely absent", () => {
    expect(() =>
      normalizeOsvVulnerability({ id: "GHSA-fixture-0001" }, target),
    ).toThrow(OsvNormalizationError);
  });
});

describe("normalizeOsvVulnerability: references", () => {
  it("maps references, defaulting type to WEB when absent", () => {
    const vuln = normalizeOsvVulnerability(
      {
        id: "GHSA-fixture-0001",
        affected: [{ package: target, ranges: [] }],
        references: [
          { type: "ADVISORY", url: "https://example.com/advisory" },
          { url: "https://example.com/no-type" },
        ],
      },
      target,
    );

    expect(vuln.references).toEqual([
      { type: "ADVISORY", url: "https://example.com/advisory" },
      { type: "WEB", url: "https://example.com/no-type" },
    ]);
  });
});

describe("normalizeOsvVulnerability: severity", () => {
  it("prefers database_specific.severity when present", () => {
    const vuln = normalizeOsvVulnerability(
      {
        id: "GHSA-fixture-0001",
        affected: [{ package: target, ranges: [] }],
        severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L" }],
        database_specific: { severity: "HIGH" },
      },
      target,
    );

    expect(vuln.severity).toEqual({ label: "HIGH" });
  });

  it("falls back to the first severity entry's type", () => {
    const vuln = normalizeOsvVulnerability(
      {
        id: "GHSA-fixture-0001",
        affected: [{ package: target, ranges: [] }],
        severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L" }],
      },
      target,
    );

    expect(vuln.severity).toEqual({ label: "CVSS_V3" });
  });

  it("is undefined when no severity information is present", () => {
    const vuln = normalizeOsvVulnerability(
      { id: "GHSA-fixture-0001", affected: [{ package: target, ranges: [] }] },
      target,
    );

    expect(vuln.severity).toBeUndefined();
  });
});

describe("normalizeOsvVulnerability: malformed input", () => {
  it("throws OsvNormalizationError when id is missing", () => {
    expect(() => normalizeOsvVulnerability({}, target)).toThrow(
      OsvNormalizationError,
    );
  });

  it("throws OsvNormalizationError when a reference is missing url", () => {
    expect(() =>
      normalizeOsvVulnerability(
        {
          id: "GHSA-fixture-0001",
          affected: [{ package: target, ranges: [] }],
          references: [{ type: "WEB" }],
        },
        target,
      ),
    ).toThrow(OsvNormalizationError);
  });

  it("throws OsvNormalizationError for wrong field types, never silently coercing", () => {
    expect(() =>
      normalizeOsvVulnerability({ id: 12345, affected: [] }, target),
    ).toThrow(OsvNormalizationError);
    expect(() =>
      normalizeOsvVulnerability({ id: "X", affected: "not-an-array" }, target),
    ).toThrow(OsvNormalizationError);
    expect(() =>
      normalizeOsvVulnerability(
        { id: "X", affected: [{ package: target, ranges: null }] },
        target,
      ),
    ).toThrow(OsvNormalizationError);
  });

  // TASK-028 security hardening: an OSV record is untrusted external data
  // (docs/SDD.md § 29) parsed with zod, which builds a fresh object from
  // its own declared schema shape rather than copying arbitrary input
  // keys — confirms a `__proto__` key in the raw record can never pollute
  // Object.prototype.
  it("is not vulnerable to prototype pollution via a '__proto__' key in the raw record", () => {
    const malicious = JSON.parse(
      `{"id":"GHSA-evil","__proto__":{"polluted":true},"affected":[{"package":${JSON.stringify(
        target,
      )},"ranges":[{"events":[{"introduced":"0"}]}]}]}`,
    ) as Record<string, unknown>;

    const result = normalizeOsvVulnerability(malicious, target);

    expect(result.id).toBe("GHSA-evil");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

/**
 * Task B-1. The normalizer is the one place a record's shape is checked,
 * so a record the rest of the scan cannot carry must be refused HERE --
 * where the scan accounts it as one unusable record -- and never
 * downstream, where it fails the whole report.
 */
describe("normalizeOsvVulnerability: identity and withdrawal (B-1)", () => {
  const affected = [{ package: target, ranges: [] }];

  // AUD-11: `id: ""` normalized, then failed `result.schema.json`'s
  // `minLength: 1` on `findings[].vulnerability`: exit 3, report lost.
  it("rejects an empty id", () => {
    expect(() =>
      normalizeOsvVulnerability({ id: "", affected }, target),
    ).toThrow(OsvNormalizationError);
  });

  // AUD-14: OSV's `withdrawn` is "an RFC3339-formatted timestamp in UTC
  // (ending in 'Z')" -- the time the entry should be considered withdrawn.
  it("carries withdrawn when present", () => {
    const vuln = normalizeOsvVulnerability(
      { id: "GHSA-withdrawn", withdrawn: "2026-01-01T00:00:00Z", affected },
      target,
    );
    expect(vuln).toMatchObject({ withdrawn: "2026-01-01T00:00:00Z" });
  });

  it("carries withdrawn with fractional seconds", () => {
    const vuln = normalizeOsvVulnerability(
      {
        id: "GHSA-withdrawn",
        withdrawn: "2026-01-01T00:00:00.123456Z",
        affected,
      },
      target,
    );
    expect(vuln).toMatchObject({ withdrawn: "2026-01-01T00:00:00.123456Z" });
  });

  it("leaves withdrawn absent for a live record", () => {
    const vuln = normalizeOsvVulnerability(
      { id: "GHSA-live", affected },
      target,
    );
    expect("withdrawn" in vuln).toBe(false);
  });

  // A `withdrawn` the normalizer cannot read is neither "withdrawn" (which
  // would hide the advisory) nor "live" (which would ignore what the
  // database said): the record is unusable, and the scan accounts it.
  it.each([
    ["a number", 1767225600],
    ["a date without a time", "2026-01-01"],
    ["a non-UTC offset", "2026-01-01T00:00:00+02:00"],
    ["free text", "yes"],
  ])("rejects a withdrawn that is %s", (_label, withdrawn) => {
    expect(() =>
      normalizeOsvVulnerability(
        { id: "GHSA-withdrawn", withdrawn, affected },
        target,
      ),
    ).toThrow(OsvNormalizationError);
  });
});
