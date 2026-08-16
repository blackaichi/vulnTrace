import { z } from "zod";
import type {
  RawVulnerability,
  Severity,
  Vulnerability,
  VulnerabilityReference,
  VersionRange,
} from "../domain/vulnerability.js";
import { summarizeZodError } from "../shared/zod-issues.js";
import { OsvNormalizationError } from "./osv-normalizer-errors.js";

/**
 * Only the subset of the OSV schema (https://ossf.github.io/osv-schema/)
 * this normalizer maps onto {@link Vulnerability} is modeled here. This is
 * the one place in VulnTrace that knows OSV's raw JSON shape — nothing
 * outside `src/vulnerabilities/` should ever import from this file's
 * schemas (see docs/SDD.md § 12; AGENTS.md: "Do not couple OSV parsing
 * directly to the verdict engine").
 */
const OsvEventSchema = z.union([
  z.object({ introduced: z.string() }),
  z.object({ fixed: z.string() }),
  z.object({ last_affected: z.string() }),
  z.object({ limit: z.string() }),
]);

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

const OsvRecordSchema = z.object({
  id: z.string(),
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

/**
 * Converts one OSV `ranges[].events[]` sequence into {@link VersionRange}s.
 * OSV represents (possibly several, disjoint) affected ranges as a flat
 * chronological event list — each `introduced` opens a range, closed by
 * the next `fixed`/`last_affected`. A `limit` event (an unresolved upper
 * bound with no known fix) is intentionally not mapped to a field — see
 * TASK-010 completion report.
 */
function eventsToRanges(events: readonly OsvEvent[]): VersionRange[] {
  const ranges: VersionRange[] = [];
  let current:
    { introduced?: string; fixed?: string; lastAffected?: string } | undefined;

  for (const event of events) {
    if ("introduced" in event) {
      if (current) {
        ranges.push(current);
      }
      current = { introduced: event.introduced };
    } else if ("fixed" in event) {
      current = { ...current, fixed: event.fixed };
      ranges.push(current);
      current = undefined;
    } else if ("last_affected" in event) {
      current = { ...current, lastAffected: event.last_affected };
      ranges.push(current);
      current = undefined;
    }
    // "limit" events carry no field of their own in VersionRange; skipped.
  }

  if (current) {
    ranges.push(current);
  }

  return ranges;
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
    for (const range of entry.ranges) {
      affectedVersions.push(...eventsToRanges(range.events));
    }
    for (const version of entry.versions) {
      affectedVersions.push({ introduced: version, lastAffected: version });
    }
  }

  const fixedVersions = [
    ...new Set(
      affectedVersions
        .map((range) => range.fixed)
        .filter((fixed): fixed is string => typeof fixed === "string"),
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
  };
}
