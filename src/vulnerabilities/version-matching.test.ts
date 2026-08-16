import { describe, expect, it } from "vitest";
import type { Vulnerability, VersionRange } from "../domain/vulnerability.js";
import { matchVersion, matchVulnerabilities } from "./version-matching.js";

function vuln(
  id: string,
  affectedVersions: readonly VersionRange[],
): Vulnerability {
  return {
    id,
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions,
    fixedVersions: [],
    references: [],
  };
}

describe("matchVersion: fixed (exclusive) upper bound", () => {
  const range: VersionRange = { introduced: "1.0.0", fixed: "1.5.0" };

  it("is not_affected below the introduced boundary", () => {
    expect(matchVersion("0.9.0", [range])).toBe("not_affected");
  });

  it("is affected at the introduced boundary", () => {
    expect(matchVersion("1.0.0", [range])).toBe("affected");
  });

  it("is affected strictly inside the range", () => {
    expect(matchVersion("1.2.3", [range])).toBe("affected");
  });

  it("is not_affected exactly at the fixed version (exclusive)", () => {
    expect(matchVersion("1.5.0", [range])).toBe("not_affected");
  });

  it("is not_affected above the fixed version", () => {
    expect(matchVersion("2.0.0", [range])).toBe("not_affected");
  });
});

describe("matchVersion: lastAffected (inclusive) upper bound", () => {
  const range: VersionRange = { introduced: "1.0.0", lastAffected: "1.2.0" };

  it("is affected exactly at lastAffected (inclusive)", () => {
    expect(matchVersion("1.2.0", [range])).toBe("affected");
  });

  it("is not_affected just above lastAffected", () => {
    expect(matchVersion("1.2.1", [range])).toBe("not_affected");
  });
});

describe("matchVersion: open-ended range (no known fix)", () => {
  const range: VersionRange = { introduced: "2.0.0" };

  it("is affected at and above introduced, with no upper bound", () => {
    expect(matchVersion("2.0.0", [range])).toBe("affected");
    expect(matchVersion("99.0.0", [range])).toBe("affected");
  });

  it("is not_affected below introduced", () => {
    expect(matchVersion("1.9.9", [range])).toBe("not_affected");
  });
});

describe("matchVersion: defaults and multiple ranges", () => {
  it("defaults a missing introduced to the OSV '0' sentinel", () => {
    expect(matchVersion("0.0.1", [{ fixed: "1.0.0" }])).toBe("affected");
  });

  it("is not_affected when affectedVersions is empty", () => {
    expect(matchVersion("1.0.0", [])).toBe("not_affected");
  });

  it("is affected if ANY range matches", () => {
    const ranges: VersionRange[] = [
      { introduced: "1.0.0", fixed: "1.5.0" },
      { introduced: "2.0.0", fixed: "2.3.0" },
    ];
    expect(matchVersion("2.1.0", ranges)).toBe("affected");
    expect(matchVersion("1.7.0", ranges)).toBe("not_affected");
  });

  it("is deterministic across repeated calls with the same input", () => {
    const ranges: VersionRange[] = [{ introduced: "1.0.0", fixed: "1.5.0" }];
    const results = Array.from({ length: 5 }, () =>
      matchVersion("1.2.0", ranges),
    );
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe("affected");
  });
});

describe("matchVersion: indeterminate, never silently not_affected", () => {
  it("is indeterminate when the installed version cannot be parsed", () => {
    expect(
      matchVersion("not-a-version", [{ introduced: "1.0.0", fixed: "2.0.0" }]),
    ).toBe("indeterminate");
  });

  it("is indeterminate when a range's fixed boundary cannot be parsed", () => {
    expect(
      matchVersion("1.2.0", [{ introduced: "1.0.0", fixed: "not-a-version" }]),
    ).toBe("indeterminate");
  });

  it("is indeterminate when a range's lastAffected boundary cannot be parsed", () => {
    expect(
      matchVersion("1.2.0", [
        { introduced: "1.0.0", lastAffected: "not-a-version" },
      ]),
    ).toBe("indeterminate");
  });

  it("prefers a confident affected match over an indeterminate one across ranges", () => {
    const ranges: VersionRange[] = [
      { introduced: "1.0.0", fixed: "not-a-version" },
      { introduced: "1.0.0", fixed: "2.0.0" },
    ];
    expect(matchVersion("1.5.0", ranges)).toBe("affected");
  });
});

describe("matchVulnerabilities", () => {
  it("excludes confidently not_affected vulnerabilities", () => {
    const vulns = [
      vuln("GHSA-fixed", [{ introduced: "1.0.0", fixed: "1.5.0" }]),
      vuln("GHSA-open", [{ introduced: "5.0.0" }]),
    ];

    const matches = matchVulnerabilities("1.2.0", vulns);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.vulnerability.id).toBe("GHSA-fixed");
    expect(matches[0]?.result).toBe("affected");
  });

  it("still includes indeterminate matches as candidates", () => {
    const vulns = [
      vuln("GHSA-indeterminate", [
        { introduced: "1.0.0", fixed: "not-a-version" },
      ]),
    ];

    const matches = matchVulnerabilities("1.2.0", vulns);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.result).toBe("indeterminate");
  });

  it("returns an empty array when nothing matches", () => {
    const vulns = [vuln("GHSA-safe", [{ introduced: "5.0.0" }])];
    expect(matchVulnerabilities("1.0.0", vulns)).toEqual([]);
  });

  it("returns an empty array for an empty vulnerability list", () => {
    expect(matchVulnerabilities("1.0.0", [])).toEqual([]);
  });
});
