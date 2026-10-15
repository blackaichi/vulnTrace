import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Plain ESM (run by `scripts/differential.mjs` under bare `node`); its
// types live in the matching `.d.mts` file.
import {
  baseCacheKey,
  CACHE_KEEP,
  readCachedBase,
  writeCachedBase,
  type BaseKey,
  type BaseKeyInput,
  type KeyPart,
} from "../../scripts/differential-cache.mjs";

/**
 * BL-089 — the differential's base-side cache key, attacked one input at a
 * time.
 *
 * A stale base snapshot reports a wrong base verdict, so every input the
 * base side reads must move the key: each test below changes exactly one
 * such input in a planted checkout and requires the key to change, in the
 * part that names it. The other half: what the base side does NOT read
 * (the tool caches named in the module header) must not move it, or the
 * cache never hits; and what cannot be established (a symlink leaving the
 * hashed inputs) must make the run uncacheable, never quietly keyed.
 */

let outer: string;
let repo: string;
let tmpRoot: string;

function write(rel: string, content: string, root = repo): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function input(overrides: Partial<BaseKeyInput> = {}): BaseKeyInput {
  return {
    repoRoot: repo,
    tmpRoot,
    baseSha: "a".repeat(40),
    snapshotFormat: "vulntrace-differential-snapshot/1",
    selection: {},
    runtime: { node: "v22.0.0", platform: "linux", arch: "x64" },
    driverPaths: ["scripts/differential.mjs", "scripts/differential-cache.mjs"],
    instrumentPaths: [
      "src/testing",
      "scripts/differential-lib.mjs",
      "tests/differential",
      "vitest.differential.config.ts",
    ],
    ...overrides,
  };
}

function keyed(key: BaseKey): Extract<BaseKey, { cacheable: true }> {
  if (!key.cacheable) throw new Error(`uncacheable: ${key.reason}`);
  return key;
}

/** The names of the parts whose digest differs between two keys. */
function moved(before: BaseKey, after: BaseKey): KeyPart["name"][] {
  const a = keyed(before);
  const b = keyed(after);
  return a.parts
    .filter((p, i) => p.digest !== b.parts[i]?.digest)
    .map((p) => p.name);
}

beforeEach(() => {
  outer = mkdtempSync(path.join(tmpdir(), "vulntrace-differential-cache-"));
  repo = path.join(outer, "repo");
  tmpRoot = path.join(outer, "tmp");
  mkdirSync(tmpRoot);
  write("scripts/differential.mjs", "driver\n");
  write("scripts/differential-cache.mjs", "cache\n");
  write("scripts/differential-lib.mjs", "lib\n");
  write("src/testing/differential-collect.ts", "collector\n");
  write("tests/differential/collect.run.ts", "run\n");
  write("vitest.differential.config.ts", "config\n");
  write("src/cli/scan.ts", "analyzer: not an input of the base side\n");
  write("tests/validation/cases/cases.json", "[]\n");
  write("tests/validation/osv-snapshot.json", "{}\n");
  write("tests/validation/fixtures/a/index.js", "module.exports = 1;\n");
  write("tests/validation/fixtures/a/node_modules/dep/index.js", "x\n");
  write("tests/adversarial/v1/expected.json", "[]\n");
  write("tests/adversarial/v1/fixtures/b/index.js", "require('dep');\n");
  write("tests/tsconfig.json", "{}\n");
  write("package.json", "{}\n");
  write("package-lock.json", "{}\n");
  write("node_modules/dep/package.json", '{"name":"dep"}\n');
  write("node_modules/dep/index.js", "dep\n");
  write("node_modules/.vite/vitest/results.json", "{}\n");
  symlinkSync("dep/index.js", path.join(repo, "node_modules/.bin-dep"));
});

afterEach(() => {
  rmSync(outer, { recursive: true, force: true });
});

describe("baseCacheKey", () => {
  it("is stable while nothing changes", () => {
    const first = keyed(baseCacheKey(input()));
    const second = keyed(baseCacheKey(input()));
    expect(second.key).toBe(first.key);
    expect(first.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not move for the analyzer's own source in this checkout (the base side reads the base commit's)", () => {
    const before = baseCacheKey(input());
    write("src/cli/scan.ts", "a head-side analyzer change\n");
    expect(moved(before, baseCacheKey(input()))).toEqual([]);
  });

  it.each([
    ["base commit", { baseSha: "b".repeat(40) }, "base"],
    ["snapshot format", { snapshotFormat: "other/2" }, "format"],
    ["--corpus", { selection: { corpora: "validation" } }, "selection"],
    ["--case", { selection: { cases: "RWB-03" } }, "selection"],
    [
      "--use-head-dependencies",
      { selection: { useHeadDependencies: true } },
      "selection",
    ],
    [
      "Node version",
      { runtime: { node: "v26.0.0", platform: "linux", arch: "x64" } },
      "runtime",
    ],
  ] as const)("moves with the %s", (_what, overrides, part) => {
    const before = baseCacheKey(input());
    expect(moved(before, baseCacheKey(input(overrides)))).toEqual([part]);
  });

  it.each([
    ["the driver", "scripts/differential.mjs", "driver"],
    ["the cache module", "scripts/differential-cache.mjs", "driver"],
    [
      "the collector under src/testing",
      "src/testing/differential-collect.ts",
      "instrument",
    ],
    [
      "a new, untracked file under src/testing",
      "src/testing/new-provider.ts",
      "instrument",
    ],
    ["the differential library", "scripts/differential-lib.mjs", "instrument"],
    [
      "the collector entry point",
      "tests/differential/collect.run.ts",
      "instrument",
    ],
    [
      "the collector's vitest config",
      "vitest.differential.config.ts",
      "instrument",
    ],
    ["a validation fixture", "tests/validation/fixtures/a/index.js", "corpus"],
    [
      "a validation fixture's vendored package",
      "tests/validation/fixtures/a/node_modules/dep/index.js",
      "corpus",
    ],
    ["the validation cases", "tests/validation/cases/cases.json", "corpus"],
    ["the OSV snapshot", "tests/validation/osv-snapshot.json", "corpus"],
    [
      "an adversarial fixture",
      "tests/adversarial/v1/fixtures/b/index.js",
      "corpus",
    ],
    [
      "the adversarial expected verdicts",
      "tests/adversarial/v1/expected.json",
      "corpus",
    ],
    ["the checkout's package.json", "package.json", "around"],
    ["the checkout's package-lock.json", "package-lock.json", "around"],
    ["a file directly in tests/", "tests/tsconfig.json", "around"],
    ["an installed package's file", "node_modules/dep/index.js", "around"],
    ["a new installed package", "node_modules/other/package.json", "around"],
    [
      "a node_modules directly in tests/",
      "tests/node_modules/dep/package.json",
      "around",
    ],
  ] as const)("moves with %s", (_what, rel, part) => {
    const before = baseCacheKey(input());
    write(rel, "changed\n");
    expect(moved(before, baseCacheKey(input()))).toEqual([part]);
  });

  it("moves with a file's executable bit", () => {
    const before = baseCacheKey(input());
    chmodSync(path.join(repo, "tests/validation/fixtures/a/index.js"), 0o755);
    expect(moved(before, baseCacheKey(input()))).toEqual(["corpus"]);
  });

  it("moves with a file removed", () => {
    const before = baseCacheKey(input());
    rmSync(path.join(repo, "tests/adversarial/v1/fixtures/b/index.js"));
    expect(moved(before, baseCacheKey(input()))).toEqual(["corpus"]);
  });

  it("moves with a symlink's target", () => {
    write("tests/validation/fixtures/a/node_modules/dep/other.js", "y\n");
    const link = path.join(
      repo,
      "tests/validation/fixtures/a/node_modules/.bin/dep",
    );
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync("../dep/index.js", link);
    const before = baseCacheKey(input());
    rmSync(link);
    symlinkSync("../dep/other.js", link);
    expect(moved(before, baseCacheKey(input()))).toEqual(["corpus"]);
  });

  it("moves with a package.json or a node_modules appearing above the checkout (Node's upward lookups)", () => {
    const before = baseCacheKey(input());
    write("package.json", "{}\n", outer);
    expect(moved(before, baseCacheKey(input()))).toEqual(["around"]);
    const middle = baseCacheKey(input());
    write("node_modules/dep/package.json", '{"name":"dep"}\n', outer);
    expect(moved(middle, baseCacheKey(input()))).toEqual(["around"]);
  });

  it("moves with a package.json or a node_modules appearing in the temp directory the validation corpus is copied under", () => {
    const before = baseCacheKey(input());
    write("package.json", "{}\n", tmpRoot);
    expect(moved(before, baseCacheKey(input()))).toEqual(["around"]);
    const middle = baseCacheKey(input());
    write("node_modules/dep/index.js", "dep\n", tmpRoot);
    expect(moved(middle, baseCacheKey(input()))).toEqual(["around"]);
  });

  it("does not move with other files in the temp directory (other processes' scratch)", () => {
    const before = baseCacheKey(input());
    write("vulntrace-oracle-xyz/index.js", "scratch\n", tmpRoot);
    write("unrelated.txt", "scratch\n", tmpRoot);
    expect(moved(before, baseCacheKey(input()))).toEqual([]);
  });

  it("hashes node_modules/.vite and node_modules/.cache by name only (tool caches, rewritten by every test run)", () => {
    const before = baseCacheKey(input());
    write("node_modules/.vite/vitest/results.json", '{"changed":true}\n');
    expect(moved(before, baseCacheKey(input()))).toEqual([]);
    // ...but their appearing or disappearing is still a change.
    write("node_modules/.cache/prettier/x", "x\n");
    expect(moved(before, baseCacheKey(input()))).toEqual(["around"]);
  });

  it("is uncacheable when a symlink leaves the hashed inputs", () => {
    write("elsewhere/real.js", "outside\n", outer);
    symlinkSync(
      path.join(outer, "elsewhere/real.js"),
      path.join(repo, "tests/adversarial/v1/fixtures/b/escape.js"),
    );
    const key = baseCacheKey(input());
    expect(key.cacheable).toBe(false);
    expect(key.cacheable ? "" : key.reason).toContain("escape.js");
  });
});

describe("readCachedBase / writeCachedBase", () => {
  const FORMAT = "vulntrace-differential-snapshot/1";
  const entry = {
    baseSha: "a".repeat(40),
    collectedAt: "2026-10-15T00:00:00.000Z",
    seconds: "140.0",
    snapshot: { format: FORMAT, label: "base main (aaaaaaa)" },
  };

  it("finds what it stored, under the key it stored it", () => {
    const dir = path.join(outer, "cache");
    const key = "1".repeat(64);
    writeCachedBase(dir, key, entry);
    expect(readCachedBase(dir, key, FORMAT)?.snapshot).toEqual(entry.snapshot);
    expect(readCachedBase(dir, "2".repeat(64), FORMAT)).toBeUndefined();
  });

  it("ignores, and removes, an entry whose snapshot format or key disagrees", () => {
    const dir = path.join(outer, "cache");
    const key = "1".repeat(64);
    writeCachedBase(dir, key, entry);
    expect(
      readCachedBase(dir, key, "vulntrace-differential-snapshot/2"),
    ).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);

    writeCachedBase(dir, key, entry);
    const forged = path.join(dir, `base-${"3".repeat(64)}.json`);
    writeFileSync(
      forged,
      JSON.stringify({
        cacheFormat: "vulntrace-differential-base-cache/1",
        key,
        ...entry,
      }),
    );
    expect(readCachedBase(dir, "3".repeat(64), FORMAT)).toBeUndefined();
  });

  it(`keeps the newest ${String(CACHE_KEEP)} entries`, () => {
    const dir = path.join(outer, "cache");
    for (let i = 0; i < CACHE_KEEP + 3; i += 1) {
      const key = i.toString(16).padStart(64, "0");
      const file = writeCachedBase(dir, key, entry);
      const when = new Date(Date.UTC(2026, 0, 1, 0, i));
      utimesSync(file, when, when);
    }
    const kept = readdirSync(dir).sort();
    expect(kept).toHaveLength(CACHE_KEEP);
    expect(kept[0]).toBe(`base-${(3).toString(16).padStart(64, "0")}.json`);
  });
});
