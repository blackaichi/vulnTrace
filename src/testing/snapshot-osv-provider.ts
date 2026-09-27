import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";

const DEFAULT_SNAPSHOT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "tests",
  "validation",
  "osv-snapshot.json",
);

function snapshotKey(query: PackageQuery): string {
  return query.version
    ? `${query.ecosystem}:${query.name}@${query.version}`
    : `${query.ecosystem}:${query.name}`;
}

/**
 * D-03 — a hermetic {@link VulnerabilityProvider} that replays a recorded
 * snapshot of real OSV answers (`tests/validation/osv-snapshot.json`,
 * produced by `scripts/record-osv-snapshot.mjs` against the live OSV API)
 * instead of querying the network at test time. Used by
 * `tests/validation/validation.test.ts`; lives under `src/testing/`
 * (rather than `tests/validation/`) so its own unit test is swept into
 * the default `npm test`/CI run like the rest of this project's testing
 * infrastructure, instead of only running inside the local-only
 * `test:validation` gate.
 *
 * A query whose key is not in the snapshot **throws** rather than
 * returning `[]`. An empty `vulns` array must only ever mean "OSV
 * confirmed zero known vulnerabilities" (the same discipline
 * `OsvProvider` itself follows -- see its class doc). Silently returning
 * `[]` for an unrecorded query would instead mean "nobody ever asked OSV
 * this", which is a stale-fixture bug, not a real answer -- and letting
 * it read as one is exactly the wrong failure mode for a suite whose job
 * is finding soundness gaps: it could hide a real vulnerability behind a
 * fixture that fell out of date. Regenerate the snapshot (`npm run build
 * && node scripts/record-osv-snapshot.mjs`) whenever a validation fixture
 * or case changes what it queries.
 */
export class SnapshotOsvProvider implements VulnerabilityProvider {
  private readonly snapshot: ReadonlyMap<string, readonly RawVulnerability[]>;
  private readonly snapshotPath: string;

  constructor(snapshotPath: string = DEFAULT_SNAPSHOT_PATH) {
    this.snapshotPath = snapshotPath;
    const raw = JSON.parse(readFileSync(snapshotPath, "utf-8")) as Record<
      string,
      readonly RawVulnerability[]
    >;
    this.snapshot = new Map(Object.entries(raw));
  }

  async queryPackage(
    input: PackageQuery,
  ): Promise<readonly RawVulnerability[]> {
    const key = snapshotKey(input);
    const results = this.snapshot.get(key);
    if (results === undefined) {
      throw new Error(
        `SnapshotOsvProvider: no recorded OSV answer for ${key}. The ` +
          `snapshot (${this.snapshotPath}) is stale relative to the ` +
          `fixtures or cases that queried it -- regenerate it with ` +
          `\`npm run build && node scripts/record-osv-snapshot.mjs\` ` +
          `rather than treating a missing key as "no vulnerabilities".`,
      );
    }
    return results;
  }
}
