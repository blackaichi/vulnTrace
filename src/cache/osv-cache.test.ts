import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";
import {
  type CacheStats,
  FileOsvCacheStore,
  computeOsvCacheKey,
  createCachingProvider,
} from "./osv-cache.js";

describe("computeOsvCacheKey", () => {
  const query: PackageQuery = {
    ecosystem: "npm",
    name: "lodash",
    version: "4.17.15",
  };

  it("is deterministic for identical input", () => {
    const a = computeOsvCacheKey({ toolVersion: "1.0.0", query });
    const b = computeOsvCacheKey({ toolVersion: "1.0.0", query });

    expect(a).toBe(b);
  });

  it("changes when the package version changes", () => {
    const a = computeOsvCacheKey({ toolVersion: "1.0.0", query });
    const b = computeOsvCacheKey({
      toolVersion: "1.0.0",
      query: { ...query, version: "4.17.21" },
    });

    expect(a).not.toBe(b);
  });

  it("changes when the ecosystem changes", () => {
    const a = computeOsvCacheKey({ toolVersion: "1.0.0", query });
    const b = computeOsvCacheKey({
      toolVersion: "1.0.0",
      query: { ...query, ecosystem: "PyPI" },
    });

    expect(a).not.toBe(b);
  });

  it("changes when the package name changes", () => {
    const a = computeOsvCacheKey({ toolVersion: "1.0.0", query });
    const b = computeOsvCacheKey({
      toolVersion: "1.0.0",
      query: { ...query, name: "underscore" },
    });

    expect(a).not.toBe(b);
  });

  it("changes when the tool version changes (docs/SDD.md § 28)", () => {
    const a = computeOsvCacheKey({ toolVersion: "1.0.0", query });
    const b = computeOsvCacheKey({ toolVersion: "1.0.1", query });

    expect(a).not.toBe(b);
  });

  it("distinguishes a query with no version from an unrelated but distinct query", () => {
    const withoutVersion = computeOsvCacheKey({
      toolVersion: "1.0.0",
      query: { ecosystem: "npm", name: "lodash" },
    });
    const withVersion = computeOsvCacheKey({ toolVersion: "1.0.0", query });

    expect(withoutVersion).not.toBe(withVersion);
  });
});

describe("FileOsvCacheStore", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function newStore(): FileOsvCacheStore {
    tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-osv-cache-"));
    return new FileOsvCacheStore(tmpDir);
  }

  it("returns undefined for a key that was never written", () => {
    const store = newStore();

    expect(store.get("nonexistent-key")).toBeUndefined();
  });

  it("round-trips a value written with set()", () => {
    const store = newStore();
    const value: RawVulnerability[] = [{ id: "GHSA-test-0001" }];

    store.set("some-key", value);

    expect(store.get("some-key")).toEqual(value);
  });

  it("creates the cache directory on first write if it does not exist", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-osv-cache-"));
    const nestedDir = path.join(tmpDir, "nested", "cache", "dir");
    const store = new FileOsvCacheStore(nestedDir);

    store.set("key", [{ id: "GHSA-test-0001" }]);

    expect(store.get("key")).toEqual([{ id: "GHSA-test-0001" }]);
  });

  it("degrades to a cache miss (not a throw) for a corrupted cache file", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-osv-cache-"));
    const store = new FileOsvCacheStore(tmpDir);
    store.set("key", [{ id: "GHSA-test-0001" }]);
    // Corrupt it after the fact.
    writeFileSync(path.join(tmpDir, "key.json"), "{ not valid json");

    expect(store.get("key")).toBeUndefined();
  });
});

describe("createCachingProvider", () => {
  function countingProvider(results: readonly RawVulnerability[]): {
    provider: VulnerabilityProvider;
    callCount: () => number;
  } {
    let calls = 0;
    return {
      provider: {
        queryPackage(): Promise<readonly RawVulnerability[]> {
          calls++;
          return Promise.resolve(results);
        },
      },
      callCount: () => calls,
    };
  }

  function memoryStore(): FileOsvCacheStore {
    const dir = mkdtempSync(path.join(tmpdir(), "vulntrace-osv-cache-"));
    return new FileOsvCacheStore(dir);
  }

  const query: PackageQuery = {
    ecosystem: "npm",
    name: "lodash",
    version: "4.17.15",
  };

  it("calls the wrapped provider on a cache miss and stores the result", async () => {
    const results: RawVulnerability[] = [{ id: "GHSA-test-0001" }];
    const { provider, callCount } = countingProvider(results);
    const caching = createCachingProvider(provider, memoryStore(), "1.0.0");

    const result = await caching.queryPackage(query);

    expect(result).toEqual(results);
    expect(callCount()).toBe(1);
  });

  it("serves a second identical query from the cache without calling the wrapped provider again", async () => {
    const results: RawVulnerability[] = [{ id: "GHSA-test-0001" }];
    const { provider, callCount } = countingProvider(results);
    const store = memoryStore();
    const caching = createCachingProvider(provider, store, "1.0.0");

    await caching.queryPackage(query);
    const second = await caching.queryPackage(query);

    expect(second).toEqual(results);
    expect(callCount()).toBe(1);
  });

  it("calls the wrapped provider again for a query with a different tool version (reproducibility across a version bump)", async () => {
    const results: RawVulnerability[] = [{ id: "GHSA-test-0001" }];
    const { provider, callCount } = countingProvider(results);
    const store = memoryStore();

    await createCachingProvider(provider, store, "1.0.0").queryPackage(query);
    await createCachingProvider(provider, store, "1.0.1").queryPackage(query);

    expect(callCount()).toBe(2);
  });

  // Task B-1, PRM-65. Before B-1 the provider returned OSV's FIRST PAGE as
  // the whole answer, and this cache stored it under a key of tool version
  // and query only, with no expiry. A cache warmed before the fix would
  // otherwise keep serving that first page forever, and the fix would never
  // reach it: an entry written under the pre-B-1 key is never reused.
  it("never serves an entry written under the pre-pagination key (B-1)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vulntrace-osv-cache-"));
    const store = new FileOsvCacheStore(dir);
    const prePaginationKey = createHash("sha256")
      .update(
        JSON.stringify({
          toolVersion: "1.0.0",
          ecosystem: query.ecosystem,
          name: query.name,
          version: query.version ?? null,
        }),
      )
      .digest("hex");
    store.set(prePaginationKey, [{ id: "GHSA-first-page-only" }]);

    const results: RawVulnerability[] = [
      { id: "GHSA-first-page-only" },
      { id: "GHSA-second-page" },
    ];
    const { provider, callCount } = countingProvider(results);
    const answer = await createCachingProvider(
      provider,
      store,
      "1.0.0",
    ).queryPackage(query);

    expect(callCount()).toBe(1);
    expect(answer).toEqual(results);
  });

  it("records a miss then a hit in the optional stats accumulator (docs/SDD.md § 30)", async () => {
    const results: RawVulnerability[] = [{ id: "GHSA-test-0001" }];
    const { provider } = countingProvider(results);
    const store = memoryStore();
    const stats: CacheStats = { hits: 0, misses: 0 };
    const caching = createCachingProvider(provider, store, "1.0.0", stats);

    await caching.queryPackage(query);
    expect(stats).toEqual({ hits: 0, misses: 1 });

    await caching.queryPackage(query);
    expect(stats).toEqual({ hits: 1, misses: 1 });
  });
});

/**
 * Task B-3 (AUD-06, AUD-07, PRM-35). A served entry replaces the
 * provider's answer with zero provider queries, so the store serves only
 * its own, current, well-formed entry for the exact key; everything else
 * is a miss, and a failed write never fails the query.
 */
describe("FileOsvCacheStore: what is served (task B-3)", () => {
  const HOUR_MS = 60 * 60 * 1000;
  const T0 = Date.UTC(2026, 9, 10);
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function cacheDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "vulntrace-osv-cache-b3-"));
    dirs.push(dir);
    return dir;
  }

  function clock(start: number): {
    now: () => number;
    at: (t: number) => void;
  } {
    let current = start;
    return { now: () => current, at: (t) => (current = t) };
  }

  const VALUE: RawVulnerability[] = [{ id: "GHSA-b3-unit" }];

  it("serves an entry until it is exactly `ttlMs` old, and never at or after that age (AUD-06)", () => {
    const dir = cacheDir();
    const time = clock(T0);
    const store = new FileOsvCacheStore(dir, {
      ttlMs: 24 * HOUR_MS,
      now: time.now,
    });
    store.set("key", VALUE);

    time.at(T0 + 24 * HOUR_MS - 1);
    expect(store.get("key")).toEqual(VALUE);
    time.at(T0 + 24 * HOUR_MS);
    expect(store.get("key")).toBeUndefined();
  });

  // B-3's audit, finding 1: a TTL finite in hours overflowed to Infinity in
  // milliseconds, and an Infinity TTL served an entry forever.
  it.each([Number.POSITIVE_INFINITY, Number.NaN, 0, -1, 1e308 * 3_600_000])(
    "refuses a TTL that is not a finite, positive number of milliseconds (%s)",
    (ttlMs) => {
      expect(() => new FileOsvCacheStore(cacheDir(), { ttlMs })).toThrow(
        RangeError,
      );
    },
  );

  it("defaults to a 24-hour expiry", () => {
    const dir = cacheDir();
    const time = clock(T0);
    const store = new FileOsvCacheStore(dir, { now: time.now });
    store.set("key", VALUE);

    time.at(T0 + 24 * HOUR_MS - 1);
    expect(store.get("key")).toEqual(VALUE);
    time.at(T0 + 24 * HOUR_MS);
    expect(store.get("key")).toBeUndefined();
  });

  it("does not serve an entry stamped in the future", () => {
    const dir = cacheDir();
    const time = clock(T0 + HOUR_MS);
    const store = new FileOsvCacheStore(dir, { now: time.now });
    store.set("key", VALUE);

    time.at(T0);
    expect(store.get("key")).toBeUndefined();
  });

  it("stores an envelope naming its format, key and fetch time", () => {
    const dir = cacheDir();
    new FileOsvCacheStore(dir, { now: () => T0 }).set("key", VALUE);

    const stored: unknown = JSON.parse(
      readFileSync(path.join(dir, "key.json"), "utf-8"),
    );
    expect(stored).toEqual({
      format: expect.any(String),
      key: "key",
      fetchedAt: T0,
      vulns: VALUE,
    });
  });

  function storedEntry(dir: string): Record<string, unknown> {
    new FileOsvCacheStore(dir, { now: () => T0 }).set("key", VALUE);
    return JSON.parse(
      readFileSync(path.join(dir, "key.json"), "utf-8"),
    ) as Record<string, unknown>;
  }

  it.each<[string, (entry: Record<string, unknown>) => unknown]>([
    ["a bare array (the pre-B-3 shape)", () => VALUE],
    [
      "another format",
      (entry) => ({ ...entry, format: "osv-query-all-pages" }),
    ],
    ["another key", (entry) => ({ ...entry, key: "other" })],
    ["no fetch time", (entry) => ({ ...entry, fetchedAt: undefined })],
    ["a string fetch time", (entry) => ({ ...entry, fetchedAt: String(T0) })],
    ["a fractional fetch time", (entry) => ({ ...entry, fetchedAt: T0 + 0.5 })],
    ["a negative fetch time", (entry) => ({ ...entry, fetchedAt: -1 })],
    ["an extra field", (entry) => ({ ...entry, extra: true })],
    ["`vulns` not an array", (entry) => ({ ...entry, vulns: {} })],
    ["`vulns` holding a non-record", (entry) => ({ ...entry, vulns: [5] })],
    ["`vulns` holding an array", (entry) => ({ ...entry, vulns: [[]] })],
    ["`vulns` holding null", (entry) => ({ ...entry, vulns: [null] })],
    ["null", () => null],
  ])("an entry that is not this cache's own (%s) is a miss", (_label, edit) => {
    const dir = cacheDir();
    const entry = storedEntry(dir);
    writeFileSync(path.join(dir, "key.json"), JSON.stringify(edit(entry)));

    const store = new FileOsvCacheStore(dir, { now: () => T0 });
    expect(store.get("key")).toBeUndefined();
  });

  it("control: the unedited entry is served", () => {
    const dir = cacheDir();
    const entry = storedEntry(dir);
    writeFileSync(path.join(dir, "key.json"), JSON.stringify(entry));

    expect(new FileOsvCacheStore(dir, { now: () => T0 }).get("key")).toEqual(
      VALUE,
    );
  });

  it("a cache path that is a directory, not a file, is a miss", () => {
    const dir = cacheDir();
    mkdirSync(path.join(dir, "key.json"));

    expect(new FileOsvCacheStore(dir).get("key")).toBeUndefined();
  });

  it("writes atomically: no temporary file is left behind", () => {
    const dir = cacheDir();
    new FileOsvCacheStore(dir).set("key", VALUE);

    expect(readdirSync(dir)).toEqual(["key.json"]);
  });

  it("throws when it cannot write, and leaves no temporary file", () => {
    const dir = cacheDir();
    mkdirSync(path.join(dir, "key.json"));
    const store = new FileOsvCacheStore(dir);

    expect(() => store.set("key", VALUE)).toThrow();
    expect(readdirSync(dir)).toEqual(["key.json"]);
  });
});

describe("createCachingProvider: write failures (task B-3, PRM-35)", () => {
  const query: PackageQuery = {
    ecosystem: "npm",
    name: "lodash",
    version: "4.17.15",
  };
  const VALUE: RawVulnerability[] = [{ id: "GHSA-b3-write" }];
  const provider: VulnerabilityProvider = {
    queryPackage: () => Promise.resolve(VALUE),
  };
  const failingStore = {
    get: () => undefined,
    set: () => {
      throw new Error("ENOTDIR: not a directory");
    },
  };

  it("returns the provider's answer when the store cannot write, and reports the failure", async () => {
    const failures: unknown[] = [];
    const caching = createCachingProvider(
      provider,
      failingStore,
      "1.0.0",
      undefined,
      (error) => failures.push(error),
    );

    await expect(caching.queryPackage(query)).resolves.toEqual(VALUE);
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toMatch(/ENOTDIR/);
  });

  it("does not fail the query when no failure callback is given", async () => {
    const caching = createCachingProvider(provider, failingStore, "1.0.0");

    await expect(caching.queryPackage(query)).resolves.toEqual(VALUE);
  });

  it("still fails the query when the provider itself fails", async () => {
    const failing: VulnerabilityProvider = {
      queryPackage: () => Promise.reject(new Error("provider down")),
    };
    const caching = createCachingProvider(failing, failingStore, "1.0.0");

    await expect(caching.queryPackage(query)).rejects.toThrow(/provider down/);
  });

  // An entry stored before B-3 sits under the old format marker's key, as
  // a bare array, and never expires. It is never served: the key changed
  // (the marker is part of it), and its shape is not an envelope.
  it("never serves an entry written before B-3 (old key, bare array)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vulntrace-osv-cache-b3-"));
    try {
      const preB3Key = createHash("sha256")
        .update(
          JSON.stringify({
            answerFormat: "osv-query-all-pages",
            toolVersion: "1.0.0",
            ecosystem: query.ecosystem,
            name: query.name,
            version: query.version ?? null,
          }),
        )
        .digest("hex");
      writeFileSync(path.join(dir, `${preB3Key}.json`), "[]");
      writeFileSync(
        path.join(
          dir,
          `${computeOsvCacheKey({ toolVersion: "1.0.0", query })}.json`,
        ),
        "[]",
      );
      let calls = 0;
      const counting: VulnerabilityProvider = {
        queryPackage: () => {
          calls++;
          return Promise.resolve(VALUE);
        },
      };

      const answer = await createCachingProvider(
        counting,
        new FileOsvCacheStore(dir),
        "1.0.0",
      ).queryPackage(query);

      expect(preB3Key).not.toBe(
        computeOsvCacheKey({ toolVersion: "1.0.0", query }),
      );
      expect(calls).toBe(1);
      expect(answer).toEqual(VALUE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
