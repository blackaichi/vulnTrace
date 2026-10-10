import semver from "semver";
import { z } from "zod";
import type {
  RawVulnerability,
  Severity,
  Vulnerability,
  VulnerabilityReference,
  VersionInterval,
  VersionRange,
} from "../domain/vulnerability.js";
import { summarizeZodError } from "../shared/zod-issues.js";
import { OsvNormalizationError } from "./osv-normalizer-errors.js";
import { parseSemVer } from "./version-matching.js";

/**
 * Only the subset of the OSV schema (https://ossf.github.io/osv-schema/)
 * this normalizer maps onto {@link Vulnerability} is modeled here. This is
 * the one place in VulnTrace that knows OSV's raw JSON shape — nothing
 * outside `src/vulnerabilities/` should ever import from this file's
 * schemas (see docs/SDD.md § 12; AGENTS.md: "Do not couple OSV parsing
 * directly to the verdict engine").
 */
/**
 * One OSV event: OSV allows "only a single type" per event object. Every
 * key is read, so an event that names two (`{fixed, last_affected}`) is
 * seen as such, and its range is uninterpretable (B-2's independent audit,
 * finding 2; RWF-092) -- a union of non-strict objects kept the first
 * branch that matched and dropped the other key, narrowing the range. An
 * event with none of the four keys is still a record the normalizer
 * cannot use.
 */
const OsvEventSchema = z
  .object({
    introduced: z.string().optional(),
    fixed: z.string().optional(),
    last_affected: z.string().optional(),
    limit: z.string().optional(),
  })
  .refine(
    (event) =>
      event.introduced !== undefined ||
      event.fixed !== undefined ||
      event.last_affected !== undefined ||
      event.limit !== undefined,
    {
      message: "an event names none of introduced, fixed, last_affected, limit",
    },
  );

type OsvEvent = z.infer<typeof OsvEventSchema>;

const OsvRangeSchema = z.object({
  type: z.string().optional(),
  events: z.array(OsvEventSchema).default([]),
});

const OsvAffectedPackageSchema = z.object({
  ecosystem: z.string().optional(),
  name: z.string().optional(),
});

const OsvAffectedSchema = z.object({
  package: OsvAffectedPackageSchema.optional(),
  ranges: z.array(OsvRangeSchema).default([]),
  versions: z.array(z.string()).default([]),
});

const OsvReferenceSchema = z.object({
  type: z.string().default("WEB"),
  url: z.string(),
});

const OsvSeverityEntrySchema = z.object({
  type: z.string(),
  score: z.string().optional(),
});

/**
 * `id` is non-empty (task B-1, AUD-11): an empty id normalized, then
 * failed `result.schema.json`'s `minLength: 1` at output time, which lost
 * the whole report. Refused here, it is one unusable record the scan
 * accounts.
 *
 * `withdrawn` (task B-1, AUD-14): OSV's "RFC3339-formatted timestamp in
 * UTC (ending in 'Z')", the time the entry should be considered withdrawn.
 * One this schema cannot read makes the record unusable -- never
 * "withdrawn" (that would hide the advisory) and never "live" (that would
 * ignore what the database said).
 */
const OsvRecordSchema = z.object({
  id: z.string().min(1),
  withdrawn: z
    .string()
    .datetime()
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: "withdrawn is not a timestamp this runtime can compare",
    })
    .optional(),
  aliases: z.array(z.string()).default([]),
  affected: z.array(OsvAffectedSchema).default([]),
  references: z.array(OsvReferenceSchema).default([]),
  severity: z.array(OsvSeverityEntrySchema).default([]),
  database_specific: z.record(z.string(), z.unknown()).optional(),
});

export interface NormalizationTarget {
  readonly ecosystem: string;
  readonly name: string;
}

/** OSV's `introduced: "0"`: "a version that sorts before any other version". */
const OSV_BEGINNING = "0";

type EventKind = "introduced" | "fixed" | "last_affected";

/**
 * OSV's SEMVER comparison: SemVer 2.0 precedence, with `introduced: "0"`
 * before every version. `null` for a value that is not a SemVer version --
 * never coerced into one (task B-2, AUD-05).
 */
function semverKey(kind: EventKind, raw: string): semver.SemVer | "0" | null {
  if (kind === "introduced" && raw === OSV_BEGINNING) {
    return OSV_BEGINNING;
  }
  return parseSemVer(raw);
}

function compareKeys(a: semver.SemVer | "0", b: semver.SemVer | "0"): number {
  if (a === OSV_BEGINNING) return b === OSV_BEGINNING ? 0 : -1;
  if (b === OSV_BEGINNING) return 1;
  return semver.compare(a, b);
}

/**
 * Converts one OSV `SEMVER` range's `events` into disjoint
 * {@link VersionInterval}s, by OSV's own evaluation (the specification's
 * `IncludedInRanges`, read 2026-10-10): the events are SORTED by version
 * and walked in that order -- `introduced` opens a range, `fixed` closes it
 * before its version, `last_affected` after its version. OSV only
 * recommends a sorted array; reading it in array order paired an
 * `introduced` with whatever event followed it, and declared a version the
 * specification calls affected out of range (task B-2, RWF-091).
 *
 * Every case the specification does not decide is uninterpretable, never
 * an empty (or narrower) range:
 *
 * - no events, or no `introduced` ("There must be at least one
 *   `introduced` object");
 * - a bound that is not a SemVer version;
 * - two events of different kinds at one version (the specification's
 *   `sorted(range.events)` leaves their order, and so the answer, open).
 *
 * A `limit` event is not applied: it only narrows a range (OSV: it "may
 * result in false negatives"), so leaving it out can only keep a version
 * in range -- the direction that never hides a finding.
 */
function semverEventsToRanges(events: readonly OsvEvent[]): VersionRange[] {
  const keyed: {
    readonly kind: EventKind;
    readonly raw: string;
    readonly key: semver.SemVer | "0";
  }[] = [];

  for (const event of events) {
    const present = (
      ["introduced", "fixed", "last_affected", "limit"] as const
    ).filter((name) => event[name] !== undefined);
    if (present.length !== 1) {
      return [
        {
          uninterpretable: `a SEMVER range event names ${present.join(" and ")}, where OSV allows one`,
        },
      ];
    }
    let kind: EventKind;
    let raw: string;
    if (event.introduced !== undefined) {
      kind = "introduced";
      raw = event.introduced;
    } else if (event.fixed !== undefined) {
      kind = "fixed";
      raw = event.fixed;
    } else if (event.last_affected !== undefined) {
      kind = "last_affected";
      raw = event.last_affected;
    } else {
      continue;
    }
    const key = semverKey(kind, raw);
    if (key === null) {
      return [
        {
          uninterpretable: `a SEMVER range bound "${raw}" is not a SemVer version`,
        },
      ];
    }
    keyed.push({ kind, raw, key });
  }

  if (!keyed.some((event) => event.kind === "introduced")) {
    return [
      {
        uninterpretable: "a SEMVER range has no introduced event",
      },
    ];
  }

  keyed.sort((a, b) => compareKeys(a.key, b.key));

  for (let i = 1; i < keyed.length; i += 1) {
    const previous = keyed[i - 1]!;
    const current = keyed[i]!;
    if (
      compareKeys(previous.key, current.key) === 0 &&
      previous.kind !== current.kind
    ) {
      return [
        {
          uninterpretable:
            `a SEMVER range has both a ${previous.kind} and a ${current.kind} ` +
            `event at version "${current.raw}", which leaves its order undecided`,
        },
      ];
    }
  }

  const ranges: VersionInterval[] = [];
  let open: string | undefined;

  for (const event of keyed) {
    if (event.kind === "introduced") {
      open ??= event.raw;
    } else if (open !== undefined) {
      ranges.push(
        event.kind === "fixed"
          ? { introduced: open, fixed: event.raw }
          : { introduced: open, lastAffected: event.raw },
      );
      open = undefined;
    }
  }

  if (open !== undefined) {
    ranges.push({ introduced: open });
  }

  return ranges;
}

/**
 * One OSV range, as {@link VersionRange}s. Only a `SEMVER` range can be
 * ordered against an installed npm version (task B-2, AUD-09): a `GIT`
 * range's bounds are commit hashes, an `ECOSYSTEM` range's are
 * "arbitrary, uninterpreted strings" (OSV), and a range of another or no
 * type is not one this normalizer knows. Each is uninterpretable, never
 * compared as SemVer.
 */
function rangeToVersionRanges(
  range: z.infer<typeof OsvRangeSchema>,
): VersionRange[] {
  if (range.type !== "SEMVER") {
    return [
      {
        uninterpretable:
          range.type === undefined
            ? "a range has no type"
            : `a ${range.type} range cannot be ordered against a SemVer version`,
      },
    ];
  }
  return semverEventsToRanges(range.events);
}

function extractSeverity(
  record: z.infer<typeof OsvRecordSchema>,
): Severity | undefined {
  const databaseSeverity = record.database_specific?.severity;
  if (typeof databaseSeverity === "string") {
    return { label: databaseSeverity };
  }

  const first = record.severity[0];
  if (first) {
    return { label: first.type };
  }

  return undefined;
}

/**
 * Normalizes a raw OSV record into the provider-agnostic {@link Vulnerability}
 * model (see docs/SDD.md § 12), scoped to one specific package/ecosystem.
 *
 * A `target` is required because a single OSV record's `affected[]` can, in
 * principle, describe multiple packages/ecosystems (e.g. an advisory
 * affecting both an npm package and an unrelated PyPI package of the same
 * name), while {@link Vulnerability} has a single `package`/`ecosystem`.
 * Only `affected[]` entries matching `target` are used; entries for other
 * ecosystems/packages in the same record are ignored, not merged in.
 */
export function normalizeOsvVulnerability(
  raw: RawVulnerability,
  target: NormalizationTarget,
): Vulnerability {
  const result = OsvRecordSchema.safeParse(raw);

  if (!result.success) {
    throw new OsvNormalizationError(
      "OSV record does not match the expected shape",
      summarizeZodError(result.error),
    );
  }

  const record = result.data;

  const relevantAffected = record.affected.filter(
    (entry) =>
      entry.package?.ecosystem === target.ecosystem &&
      entry.package?.name === target.name,
  );

  if (relevantAffected.length === 0) {
    throw new OsvNormalizationError(
      `OSV record ${record.id} has no "affected" entry for ${target.ecosystem}:${target.name}`,
    );
  }

  const affectedVersions: VersionRange[] = [];
  for (const entry of relevantAffected) {
    // An entry for the package that lists no range and no version says
    // nothing about which versions it affects: never "none" (task B-2,
    // AUD-09).
    if (entry.ranges.length === 0 && entry.versions.length === 0) {
      affectedVersions.push({
        uninterpretable: "an affected entry lists no ranges and no versions",
      });
    }
    for (const range of entry.ranges) {
      affectedVersions.push(...rangeToVersionRanges(range));
    }
    // OSV's `IncludedInVersions`: a listed version is affected. Matched
    // by SemVer equality; one that is not a SemVer version is
    // indeterminate in the matcher.
    for (const version of entry.versions) {
      affectedVersions.push({ introduced: version, lastAffected: version });
    }
  }

  const fixedVersions = [
    ...new Set(
      affectedVersions.flatMap((range) =>
        range.uninterpretable === undefined && range.fixed !== undefined
          ? [range.fixed]
          : [],
      ),
    ),
  ];

  const references: VulnerabilityReference[] = record.references.map(
    (reference) => ({ type: reference.type, url: reference.url }),
  );

  return {
    id: record.id,
    aliases: record.aliases,
    package: target.name,
    ecosystem: target.ecosystem,
    affectedVersions,
    fixedVersions,
    references,
    severity: extractSeverity(record),
    ...(record.withdrawn === undefined ? {} : { withdrawn: record.withdrawn }),
  };
}
