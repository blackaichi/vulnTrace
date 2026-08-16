import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";
import {
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
});
