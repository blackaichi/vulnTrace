import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";

export interface OsvCacheKeyInput {
  readonly toolVersion: string;
  readonly query: PackageQuery;
}

/**
 * Deterministic cache key for one OSV query (see docs/SDD.md § 28: "Cache
 * keys must include relevant inputs and tool version"). Both halves
 * matter: the query half (ecosystem/name/version) so different packages
 * never collide, and `toolVersion` so a cache entry written by an older
 * VulnTrace build — whose normalizer, matcher, or OSV mapping may have
 * since changed — is never silently reused as if it came from the
 * current build. Hashed (rather than used as a literal filename) because
 * a package name is untrusted external input (e.g. a scoped package name
 * containing `/`) and must never be interpolated into a file path
 * directly (see docs/SDD.md § 29: "All external data must be parsed
 * defensively").
 */
export function computeOsvCacheKey(input: OsvCacheKeyInput): string {
  const { toolVersion, query } = input;
  const canonical = JSON.stringify({
    toolVersion,
    ecosystem: query.ecosystem,
    name: query.name,
    version: query.version ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Storage boundary for cached OSV query results (see docs/SDD.md § 28),
 * kept behind an interface so the caching strategy (`createCachingProvider`)
 * never depends on a specific storage backend (AGENTS.md: "Keep
 * provider-specific data behind interfaces").
 */
export interface OsvCacheStore {
  get(key: string): readonly RawVulnerability[] | undefined;
  set(key: string, value: readonly RawVulnerability[]): void;
}

/**
 * Filesystem-backed {@link OsvCacheStore}: one JSON file per cache key
 * under `cacheDir`. Reading a file this same cache previously wrote is
 * safe under docs/SDD.md § 29 (parsed as data, never executed) — unlike
 * target-project data, its shape is entirely controlled by VulnTrace
 * itself. A missing, corrupted, or unreadable entry degrades to a cache
 * miss rather than a scan failure: caching is an optimization, and losing
 * it must never be able to abort an otherwise-successful scan.
 */
export class FileOsvCacheStore implements OsvCacheStore {
  private readonly cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
  }

  private filePath(key: string): string {
    return path.join(this.cacheDir, `${key}.json`);
  }

  get(key: string): readonly RawVulnerability[] | undefined {
    const filePath = this.filePath(key);
    if (!existsSync(filePath)) {
      return undefined;
    }
    try {
      return JSON.parse(readFileSync(filePath, "utf-8")) as RawVulnerability[];
    } catch {
      return undefined;
    }
  }

  set(key: string, value: readonly RawVulnerability[]): void {
    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(this.filePath(key), JSON.stringify(value), "utf-8");
  }
}

/**
 * Wraps a {@link VulnerabilityProvider} with a cache-first strategy (see
 * docs/SDD.md § 28). A cache hit never calls the wrapped provider at all,
 * which is what makes repeated scans of the same dependency set both
 * reproducible (the exact same raw records are reused, not re-fetched
 * from a live, potentially-changed database) and able to run offline once
 * the cache is warm.
 */
export function createCachingProvider(
  provider: VulnerabilityProvider,
  store: OsvCacheStore,
  toolVersion: string,
): VulnerabilityProvider {
  return {
    async queryPackage(query) {
      const key = computeOsvCacheKey({ toolVersion, query });
      const cached = store.get(key);
      if (cached) {
        return cached;
      }
      const result = await provider.queryPackage(query);
      store.set(key, result);
      return result;
    },
  };
}
