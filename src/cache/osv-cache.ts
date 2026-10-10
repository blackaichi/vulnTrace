import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";
import { DEFAULT_CACHE_TTL_HOURS } from "../config/schema.js";
import { OsvVulnerabilityListSchema } from "../vulnerabilities/osv-provider.js";

/**
 * What a cached answer IS, in the key and in the stored entry (task B-1,
 * PRM-65). Before B-1 the provider returned OSV's first results page as
 * the whole answer: without this, a cache warmed before the fix would
 * serve a first page under the same tool version, and the fix would never
 * reach it. Change it whenever what a provider answer contains, or the
 * stored entry's shape, changes. Task B-3 changed the shape (an envelope
 * with a fetch time, {@link CachedAnswerSchema}).
 */
const CACHED_ANSWER_FORMAT = "osv-query-all-pages/fetched-at";

const HOUR_MS = 60 * 60 * 1000;

/**
 * One stored entry (task B-3, AUD-06, AUD-07). Strict: anything else in
 * the file is not an entry this cache wrote. `key` is the key the entry
 * was written under, so a file copied or renamed to another key is not
 * served there; `fetchedAt` (epoch milliseconds) is when the provider
 * answered; `vulns` is validated with the provider's own schema, exactly
 * as a live answer is.
 */
const CachedAnswerSchema = z
  .object({
    format: z.literal(CACHED_ANSWER_FORMAT),
    key: z.string(),
    fetchedAt: z.number().int().nonnegative(),
    vulns: OsvVulnerabilityListSchema,
  })
  .strict();

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
 *
 * {@link CACHED_ANSWER_FORMAT} is the third half (task B-1, PRM-65).
 */
export function computeOsvCacheKey(input: OsvCacheKeyInput): string {
  const { toolVersion, query } = input;
  const canonical = JSON.stringify({
    answerFormat: CACHED_ANSWER_FORMAT,
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

export interface FileOsvCacheStoreOptions {
  /** How long an entry is served; defaults to {@link DEFAULT_CACHE_TTL_HOURS}. */
  readonly ttlMs?: number;
  /** The clock (epoch milliseconds); defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Filesystem-backed {@link OsvCacheStore}: one JSON file per cache key
 * under `cacheDir`. A served entry stands in for the provider's answer
 * with zero provider queries, so `get` serves only what it can show is
 * this cache's own, current answer for this key (task B-3): a file it
 * cannot read, parse or validate ({@link CachedAnswerSchema}), an entry
 * written under another key, one stamped in the future, and one as old as
 * the TTL or older are all misses, and the provider is asked again
 * (AUD-06, AUD-07). Before B-3 the parsed file was cast and returned, on
 * the false premise that its shape "is entirely controlled by VulnTrace
 * itself": the directory lived in the scanned project, which controls it.
 *
 * Validation cannot tell a planted `[]` from a real "no advisories"; only
 * the location can. Where the directory may be is decided by the caller
 * (`cache-location.ts`): never inside the scanned project.
 *
 * `set` writes a temporary file and renames it into place, so a reader
 * never sees half an entry. It throws on failure; `createCachingProvider`
 * turns that into a reported write failure, never a failed query.
 */
export class FileOsvCacheStore implements OsvCacheStore {
  private readonly cacheDir: string;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(cacheDir: string, options: FileOsvCacheStoreOptions = {}) {
    this.cacheDir = cacheDir;
    this.ttlMs = options.ttlMs ?? cacheTtlMs(DEFAULT_CACHE_TTL_HOURS);
    // An infinite or non-positive TTL is never "configured": it would serve
    // an entry forever (AUD-06) or never. Refused loudly, not clamped.
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError(
        `OSV cache TTL must be a finite, positive number of milliseconds, got ${this.ttlMs}`,
      );
    }
    this.now = options.now ?? Date.now;
  }

  private filePath(key: string): string {
    return path.join(this.cacheDir, `${key}.json`);
  }

  get(key: string): readonly RawVulnerability[] | undefined {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(this.filePath(key), "utf-8"));
    } catch {
      return undefined;
    }
    const parsed = CachedAnswerSchema.safeParse(json);
    if (!parsed.success || parsed.data.key !== key) {
      return undefined;
    }
    const age = this.now() - parsed.data.fetchedAt;
    if (!(age >= 0 && age < this.ttlMs)) {
      return undefined;
    }
    return parsed.data.vulns;
  }

  set(key: string, value: readonly RawVulnerability[]): void {
    mkdirSync(this.cacheDir, { recursive: true });
    const entry = {
      format: CACHED_ANSWER_FORMAT,
      key,
      fetchedAt: this.now(),
      vulns: value,
    };
    const filePath = this.filePath(key);
    const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(entry), "utf-8");
      renameSync(temporary, filePath);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}

/** `vulnerabilities.cache.ttlHours` in the store's milliseconds. */
export function cacheTtlMs(ttlHours: number): number {
  return ttlHours * HOUR_MS;
}

/** Cumulative cache hit/miss counts (see docs/SDD.md § 30: "Performance instrumentation must record ... cache hit/miss"). */
export interface CacheStats {
  hits: number;
  misses: number;
}

/**
 * Wraps a {@link VulnerabilityProvider} with a cache-first strategy (see
 * docs/SDD.md § 28). A cache hit never calls the wrapped provider at all,
 * which is what makes repeated scans of the same dependency set both
 * reproducible (the exact same raw records are reused, not re-fetched
 * from a live, potentially-changed database) and able to run offline once
 * the cache is warm -- within the TTL (task B-3).
 *
 * `stats`, when supplied, is mutated in place with each query's outcome —
 * an optional out-parameter rather than a return-type change, so every
 * existing caller that doesn't need hit/miss counts is unaffected.
 *
 * A failed `store.set` never fails the query (task B-3, PRM-35): the
 * provider's answer is returned as it came, and the failure goes to
 * `onWriteFailure`. Before B-3 it propagated, and the scan exited 4 as a
 * "vulnerability provider failure" over a local filesystem error.
 */
export function createCachingProvider(
  provider: VulnerabilityProvider,
  store: OsvCacheStore,
  toolVersion: string,
  stats?: CacheStats,
  onWriteFailure?: (error: unknown) => void,
): VulnerabilityProvider {
  return {
    async queryPackage(query) {
      const key = computeOsvCacheKey({ toolVersion, query });
      const cached = store.get(key);
      if (cached) {
        if (stats) {
          stats.hits++;
        }
        return cached;
      }
      if (stats) {
        stats.misses++;
      }
      const result = await provider.queryPackage(query);
      try {
        store.set(key, result);
      } catch (error) {
        onWriteFailure?.(error);
      }
      return result;
    },
  };
}
