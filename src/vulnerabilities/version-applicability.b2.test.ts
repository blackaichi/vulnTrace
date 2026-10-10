import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { VersionRange } from "../domain/vulnerability.js";
import { normalizeOsvVulnerability } from "./osv-normalizer.js";
import { matchVersion, type VersionMatchResult } from "./version-matching.js";

/**
 * Task B-2 -- version applicability (AUD-05, AUD-09, RWF-091).
 *
 * The ground truth is OSV's own specification
 * (https://ossf.github.io/osv-schema/, "Evaluation", read 2026-10-10),
 * transcribed literally below as {@link osvIsVulnerable}, with SEMVER
 * precedence from the `semver` package (SemVer 2.0 § 11, which OSV's
 * SEMVER type names). Every test runs the production pipeline:
 * `normalizeOsvVulnerability` then `matchVersion`.
 */

const TARGET = { ecosystem: "npm", name: "vuln-lib" };

interface OsvRange {
  readonly type?: string;
  readonly events: readonly Record<string, string>[];
}

interface OsvAffected {
  readonly ranges?: readonly OsvRange[];
  readonly versions?: readonly string[];
}

function applicability(
  installed: string,
  affected: OsvAffected,
): VersionMatchResult {
  const vulnerability = normalizeOsvVulnerability(
    {
      id: "GHSA-b2",
      affected: [{ package: { ...TARGET }, ...affected }],
    },
    TARGET,
  );
  return matchVersion(installed, vulnerability.affectedVersions);
}

const semverRange = (...events: Record<string, string>[]): OsvAffected => ({
  ranges: [{ type: "SEMVER", events }],
});

describe("B-2 / AUD-05: SemVer precedence, prereleases included", () => {
  it("a prerelease sorts before its release", () => {
    expect(
      applicability(
        "2.0.0-rc.1",
        semverRange({ introduced: "0" }, { fixed: "2.0.0" }),
      ),
    ).toBe("affected");
  });

  it("prerelease identifiers are ordered among themselves", () => {
    expect(
      applicability(
        "2.0.0-rc.1",
        semverRange({ introduced: "0" }, { fixed: "2.0.0-rc.2" }),
      ),
    ).toBe("affected");
    expect(
      applicability(
        "2.0.0-rc.2",
        semverRange({ introduced: "0" }, { fixed: "2.0.0-rc.2" }),
      ),
    ).toBe("not_affected");
  });

  it("a later prerelease is above a prerelease `last_affected`", () => {
    expect(
      applicability(
        "1.5.0-beta.3",
        semverRange({ introduced: "0" }, { last_affected: "1.5.0-beta.2" }),
      ),
    ).toBe("not_affected");
  });

  it("a later prerelease is outside a prerelease-bounded range", () => {
    expect(
      applicability(
        "1.5.0-beta.3",
        semverRange({ introduced: "1.5.0-beta.1" }, { fixed: "1.5.0-beta.2" }),
      ),
    ).toBe("not_affected");
  });

  it("a release is above a prerelease `introduced` (the snapshot's `4.0.0-beta.3`)", () => {
    expect(
      applicability(
        "4.0.0",
        semverRange({ introduced: "4.0.0-beta.3" }, { fixed: "4.5.5" }),
      ),
    ).toBe("affected");
    expect(
      applicability(
        "4.0.0-beta.2",
        semverRange({ introduced: "4.0.0-beta.3" }, { fixed: "4.5.5" }),
      ),
    ).toBe("not_affected");
  });

  it("`introduced: 0` sorts before every prerelease", () => {
    expect(applicability("0.0.0-alpha", semverRange({ introduced: "0" }))).toBe(
      "affected",
    );
  });

  it("a listed version is matched by SemVer equality, prerelease included", () => {
    expect(applicability("2.0.0", { versions: ["2.0.0-rc.1"] })).toBe(
      "not_affected",
    );
    expect(applicability("2.0.0-rc.1", { versions: ["2.0.0-rc.1"] })).toBe(
      "affected",
    );
  });

  it("build metadata does not take part in precedence", () => {
    expect(
      applicability(
        "1.0.0+build.7",
        semverRange({ introduced: "0" }, { fixed: "1.0.0" }),
      ),
    ).toBe("not_affected");
  });
});

describe("B-2: a value that is not a SemVer version is never coerced into one", () => {
  it("an installed version that is not strict SemVer is indeterminate", () => {
    for (const installed of ["1.2", "1", "latest", "1.2.3.4", ""]) {
      expect(
        applicability(
          installed,
          semverRange({ introduced: "0" }, { fixed: "9.0.0" }),
        ),
        installed,
      ).toBe("indeterminate");
    }
  });

  it("a bound that is not strict SemVer is indeterminate", () => {
    for (const bound of ["1.2", "3f2a9c1b0d", "2.x", "abc"]) {
      expect(
        applicability(
          "5.0.0",
          semverRange({ introduced: "0" }, { fixed: bound }),
        ),
        bound,
      ).toBe("indeterminate");
    }
  });

  it("an empty range list decides nothing", () => {
    expect(matchVersion("1.0.0", [])).toBe("indeterminate");
  });

  it("an interval handed to the matcher directly is compared with prerelease precedence", () => {
    const range: VersionRange = { introduced: "1.0.0", fixed: "2.0.0" };
    expect(matchVersion("1.0.0-rc.1", [range])).toBe("not_affected");
    expect(matchVersion("2.0.0-rc.1", [range])).toBe("affected");
  });
});

describe("B-2 audit findings: shapes the first fix still misread", () => {
  it("finding 1: a numeric prerelease identifier too large to compare exactly is not a SemVer version here", () => {
    // node-semver compares these as JavaScript numbers: ...992 and ...993
    // are equal to it, while SemVer precedence orders them.
    expect(
      applicability(
        "1.0.0-9007199254740992",
        semverRange({ introduced: "0" }, { fixed: "1.0.0-9007199254740993" }),
      ),
    ).toBe("indeterminate");
    expect(
      applicability(
        "1.0.0-rc.1",
        semverRange({ introduced: "0" }, { fixed: "1.0.0-9007199254740993" }),
      ),
    ).toBe("indeterminate");
    expect(
      applicability(
        "1.0.0-9007199254740992",
        semverRange(
          { introduced: "1.0.0-9007199254740992" },
          { last_affected: "1.0.0-9007199254740992" },
        ),
      ),
    ).toBe("indeterminate");
  });

  it("finding 1, control: a numeric identifier below Number.MAX_SAFE_INTEGER still compares", () => {
    expect(
      applicability(
        "1.0.0-9007199254740989",
        semverRange({ introduced: "0" }, { fixed: "1.0.0-9007199254740990" }),
      ),
    ).toBe("affected");
  });

  it.each<[string, Record<string, string>]>([
    ["fixed and last_affected", { fixed: "1.2.0", last_affected: "2.0.0" }],
    ["limit and fixed", { limit: "*", fixed: "1.2.0" }],
    ["introduced and fixed", { introduced: "1.0.0", fixed: "1.2.0" }],
  ])(
    "finding 2: an event naming %s is undecided, never narrowed to one of them",
    (_name, event) => {
      expect(
        applicability("1.5.0", semverRange({ introduced: "1.0.0" }, event)),
      ).toBe("indeterminate");
    },
  );

  it("finding 2, control: an event with an unknown extra key still reads its one known key", () => {
    expect(
      applicability(
        "1.5.0",
        semverRange({ introduced: "1.0.0" }, { fixed: "1.2.0", note: "x" }),
      ),
    ).toBe("not_affected");
  });

  it("finding 2: an event naming none of the four keys is still an unusable record", () => {
    expect(() =>
      applicability("1.5.0", semverRange({ introduced: "1.0.0" }, {})),
    ).toThrow();
  });
});

describe("B-2 / AUD-09: a range that cannot be ordered against an npm version is indeterminate", () => {
  it.each<[string, OsvRange]>([
    [
      "GIT",
      { type: "GIT", events: [{ introduced: "0" }, { fixed: "3f2a9c1b0d" }] },
    ],
    [
      "ECOSYSTEM",
      { type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "4.0.0" }] },
    ],
    [
      "an unknown type",
      { type: "CALVER", events: [{ introduced: "0" }, { fixed: "4.0.0" }] },
    ],
    ["no type", { events: [{ introduced: "0" }, { fixed: "4.0.0" }] }],
  ])("%s", (_name, range) => {
    expect(applicability("5.0.0", { ranges: [range] })).toBe("indeterminate");
  });

  it("an entry with no ranges and no versions", () => {
    expect(applicability("5.0.0", {})).toBe("indeterminate");
    expect(applicability("5.0.0", { ranges: [], versions: [] })).toBe(
      "indeterminate",
    );
  });

  it("a SEMVER range with no events, or with no `introduced`", () => {
    expect(applicability("1.0.0", semverRange())).toBe("indeterminate");
    expect(applicability("1.0.0", semverRange({ fixed: "2.0.0" }))).toBe(
      "indeterminate",
    );
  });

  it("two events of different kinds at one version (the specification's sort leaves their order open)", () => {
    expect(
      applicability(
        "1.0.0",
        semverRange({ introduced: "1.0.0" }, { fixed: "1.0.0" }),
      ),
    ).toBe("indeterminate");
  });

  it("an undecidable range never hides another range that covers the version", () => {
    expect(
      applicability("5.0.0", {
        ranges: [
          {
            type: "GIT",
            events: [{ introduced: "0" }, { fixed: "3f2a9c1b0d" }],
          },
          { type: "SEMVER", events: [{ introduced: "4.0.0" }] },
        ],
      }),
    ).toBe("affected");
    expect(
      applicability("5.0.0", {
        ranges: [
          {
            type: "GIT",
            events: [{ introduced: "0" }, { fixed: "3f2a9c1b0d" }],
          },
        ],
        versions: ["5.0.0"],
      }),
    ).toBe("affected");
  });

  it("an undecidable range is never outvoted by one that excludes the version", () => {
    expect(
      applicability("5.0.0", {
        ranges: [
          {
            type: "GIT",
            events: [{ introduced: "0" }, { fixed: "3f2a9c1b0d" }],
          },
          { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.0" }] },
        ],
      }),
    ).toBe("indeterminate");
  });

  it("an empty affected entry is undecided even beside an entry that excludes the version", () => {
    const vulnerability = normalizeOsvVulnerability(
      {
        id: "GHSA-b2",
        affected: [
          { package: { ...TARGET } },
          {
            package: { ...TARGET },
            ranges: [
              {
                type: "SEMVER",
                events: [{ introduced: "0" }, { fixed: "1.0.0" }],
              },
            ],
          },
        ],
      },
      TARGET,
    );
    expect(matchVersion("5.0.0", vulnerability.affectedVersions)).toBe(
      "indeterminate",
    );
  });

  it("a SEMVER range with no `introduced` is undecided even beside a range that excludes the version", () => {
    expect(
      applicability("0.5.0", {
        ranges: [
          { type: "SEMVER", events: [{ fixed: "1.0.0" }] },
          { type: "SEMVER", events: [{ introduced: "2.0.0" }] },
        ],
      }),
    ).toBe("indeterminate");
  });
});

describe("B-2 / RWF-091: SEMVER events are walked in version order", () => {
  it("an introduced listed after a lower fixed still opens its range", () => {
    expect(
      applicability(
        "2.5.0",
        semverRange({ introduced: "2.0.0" }, { fixed: "1.0.0" }),
      ),
    ).toBe("affected");
  });

  it("a fixed listed after a higher fixed still closes the range", () => {
    expect(
      applicability(
        "2.5.0",
        semverRange(
          { introduced: "1.0.0" },
          { fixed: "3.0.0" },
          { fixed: "2.0.0" },
        ),
      ),
    ).toBe("not_affected");
  });

  it("a second introduced inside an open range does not close it", () => {
    expect(
      applicability(
        "2.5.0",
        semverRange(
          { introduced: "1.0.0" },
          { introduced: "2.0.0" },
          { fixed: "3.0.0" },
        ),
      ),
    ).toBe("affected");
    expect(
      applicability(
        "3.5.0",
        semverRange(
          { introduced: "1.0.0" },
          { introduced: "2.0.0" },
          { fixed: "3.0.0" },
        ),
      ),
    ).toBe("not_affected");
  });

  it("`fixedVersions` lists only fixed versions that close a range", () => {
    const vulnerability = normalizeOsvVulnerability(
      {
        id: "GHSA-b2",
        affected: [
          {
            package: { ...TARGET },
            ranges: [
              {
                type: "SEMVER",
                events: [{ introduced: "1.0.0" }, { fixed: "2.0.0" }],
              },
              {
                type: "GIT",
                events: [{ introduced: "0" }, { fixed: "3f2a9c1b0d" }],
              },
            ],
          },
        ],
      },
      TARGET,
    );
    expect(vulnerability.fixedVersions).toEqual(["2.0.0"]);
  });
});

// ---------------------------------------------------------------------------
// The specification sweep.
// ---------------------------------------------------------------------------

/** OSV's comparison for SEMVER: `"0"` (introduced only) sorts before every version. */
function osvCompare(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "0") return -1;
  if (b === "0") return 1;
  return semver.compare(a, b);
}

const eventValue = (event: Record<string, string>): string =>
  Object.values(event)[0] as string;

/**
 * OSV's evaluation pseudo-code, transcribed literally (`IsVulnerable`,
 * `IncludedInVersions`, `IncludedInRanges`, `BeforeLimits`), for ONE
 * affected entry of SEMVER ranges. `sorted(range.events)` sorts by
 * version; the sweep never generates two events of different kinds at one
 * version, the one case where that order is left open.
 */
function osvIsVulnerable(v: string, affected: OsvAffected): boolean {
  for (const version of affected.versions ?? []) {
    if (semver.eq(v, version)) return true;
  }
  for (const range of affected.ranges ?? []) {
    const limits = range.events.filter((event) => "limit" in event);
    const beforeLimits =
      limits.length === 0 ||
      limits.some((event) => osvCompare(v, eventValue(event)) < 0);
    if (!beforeLimits) continue;
    let vulnerable = false;
    const sorted = [...range.events].sort((a, b) =>
      osvCompare(eventValue(a), eventValue(b)),
    );
    for (const event of sorted) {
      if ("introduced" in event && osvCompare(v, event.introduced!) >= 0) {
        vulnerable = true;
      } else if ("fixed" in event && osvCompare(v, event.fixed!) >= 0) {
        vulnerable = false;
      } else if (
        "last_affected" in event &&
        osvCompare(v, event.last_affected!) > 0
      ) {
        vulnerable = false;
      }
    }
    if (vulnerable) return true;
  }
  return false;
}

/** A small deterministic PRNG (mulberry32), so the sweep is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL = [
  "0.0.0-alpha",
  "0.9.0",
  "1.0.0-alpha",
  "1.0.0-beta.1",
  "1.0.0-beta.2",
  "1.0.0",
  "1.0.1",
  "1.5.0-rc.1",
  "1.5.0",
  "2.0.0-rc.1",
  "2.0.0",
  "2.0.1",
  "3.0.0-0",
  "3.0.0",
] as const;

const INSTALLED = [...POOL, "0.0.1", "1.2.3", "9.9.9", "2.0.0-rc.1+b"];

describe("B-2: the production pipeline against OSV's evaluation pseudo-code", () => {
  const random = prng(0xb2);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)] as T;

  /** A random SEMVER event list: one or more introduced, in random order, no cross-kind ties. */
  function randomEvents(): Record<string, string>[] {
    const closer = random() < 0.7 ? "fixed" : "last_affected";
    const count = 1 + Math.floor(random() * 5);
    const events: Record<string, string>[] = [];
    const kindAt = new Map<string, string>();
    const push = (kind: string, value: string) => {
      const seen = kindAt.get(value);
      if (seen !== undefined && seen !== kind) return;
      kindAt.set(value, kind);
      events.push({ [kind]: value });
    };
    push("introduced", random() < 0.3 ? "0" : pick(POOL));
    for (let i = 1; i < count; i += 1) {
      if (random() < 0.4) push("introduced", pick(POOL));
      else push(closer, pick(POOL));
    }
    // Shuffle (Fisher-Yates): OSV only recommends a sorted array.
    for (let i = events.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [events[i], events[j]] = [events[j]!, events[i]!];
    }
    return events;
  }

  function randomAffected(): OsvAffected {
    const ranges: OsvRange[] = [];
    const rangeCount = Math.floor(random() * 3);
    for (let i = 0; i < rangeCount; i += 1) {
      ranges.push({ type: "SEMVER", events: randomEvents() });
    }
    const versions =
      random() < 0.3 ? [pick(POOL), pick(POOL)] : ([] as string[]);
    if (ranges.length === 0 && versions.length === 0) {
      ranges.push({ type: "SEMVER", events: randomEvents() });
    }
    return { ranges, versions };
  }

  const CASES = 3000;

  it(`decides every well-formed SEMVER entry exactly as the specification does (${CASES} generated entries x ${INSTALLED.length} versions)`, () => {
    const disagreements: string[] = [];
    let compared = 0;
    for (let n = 0; n < CASES; n += 1) {
      const affected = randomAffected();
      for (const installed of INSTALLED) {
        const expected = osvIsVulnerable(installed, affected)
          ? "affected"
          : "not_affected";
        const actual = applicability(installed, affected);
        compared += 1;
        if (actual !== expected) {
          disagreements.push(
            `${installed} ${JSON.stringify(affected)}: ${actual}, spec ${expected}`,
          );
        }
      }
    }
    expect(compared).toBe(CASES * INSTALLED.length);
    expect(disagreements.slice(0, 5)).toEqual([]);
  });

  it("an entry with an undecidable range is never declared out of range when the specification's SEMVER part does not decide it", () => {
    const failures: string[] = [];
    for (let n = 0; n < 500; n += 1) {
      const decidable = randomAffected();
      const affected: OsvAffected = {
        ...decidable,
        ranges: [
          ...(decidable.ranges ?? []),
          {
            type: pick(["GIT", "ECOSYSTEM", undefined] as const),
            events: [{ introduced: "0" }, { fixed: "3f2a9c1b0d" }],
          } as OsvRange,
        ],
      };
      for (const installed of INSTALLED) {
        const expected = osvIsVulnerable(installed, decidable)
          ? "affected"
          : "indeterminate";
        const actual = applicability(installed, affected);
        if (actual !== expected) {
          failures.push(`${installed} ${JSON.stringify(affected)}: ${actual}`);
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });
});

describe("B-2: census -- no production file coerces a version", () => {
  it("no production file under src/ names `coerce` (an identifier, never a comment)", () => {
    const root = path.resolve(fileURLToPath(import.meta.url), "../..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          /\.(ts|mts|cts|js|mjs)$/.test(entry.name) &&
          !/\.test\.ts$/.test(entry.name)
        ) {
          // Identifiers only: a comment or a string naming the function
          // (as this task's own comments do) is not a use of it.
          const source = ts.createSourceFile(
            full,
            readFileSync(full, "utf8"),
            ts.ScriptTarget.Latest,
          );
          const visit = (node: ts.Node): void => {
            if (ts.isIdentifier(node) && node.text === "coerce") {
              offenders.push(path.relative(root, full));
            }
            ts.forEachChild(node, visit);
          };
          visit(source);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
