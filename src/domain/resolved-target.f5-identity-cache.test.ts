import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildKnownPackageRoots,
  canonicalizePackageInstancePath,
  createScanModuleIdentityCache,
  identifyModule,
  type KnownPackageRoots,
} from "./resolved-target.js";
import type { DependencyNode } from "./dependency.js";

/**
 * FOUNDATION F5 — the per-scan module-identity memo.
 *
 * The memo exists for one measured reason: at the F5 baseline,
 * `identifyModule` was called 2,870 times across this repository's
 * real-package validation corpus for 175 distinct files, performing 2,991
 * `realpathSync` calls for 82 distinct inputs and 2,830 `package.json`
 * reads for 45 distinct roots. The cost multiplier is
 * `findings × targets × graph nodes`.
 *
 * Every test here is about the property that makes that optimization
 * admissible rather than about the saving itself: the memo must be
 * INCAPABLE of changing an answer. The two halves are asserted separately
 * and deliberately:
 *
 * 1. EQUIVALENCE — for every shape identity attribution distinguishes
 *    (same-name/same-version twins, scoped vs unscoped siblings, npm
 *    aliases, symlinks, workspace roots, same relative path under two
 *    project roots), the cached and uncached answers are identical. These
 *    are written as DIFFERENTIAL assertions against the uncached function,
 *    not as fixed expected values, so they keep testing equivalence even
 *    if attribution itself changes later.
 * 2. OPERATION COUNT — the redundant filesystem work really is gone.
 *    Asserted on the cache's own counters rather than on elapsed time: a
 *    wall-clock assertion at this granularity measures the machine, and
 *    the claim being made is a call-count claim.
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-f5-identity-"));
  dirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  // `mkdtempSync` hands back a path under the OS temp root, which is a
  // symlink on macOS (`/var` -> `/private/var`). Canonicalizing the root
  // once here means every expectation below is written in the same
  // physical namespace `identifyModule` itself answers in.
  return canonicalizePackageInstancePath(root);
}

function manifest(name: string, version?: string): string {
  return JSON.stringify(version === undefined ? { name } : { name, version });
}

function node(
  name: string,
  version: string,
  ...locations: string[]
): DependencyNode {
  return {
    name,
    version,
    locations,
    direct: true,
    dependencies: [],
  } as unknown as DependencyNode;
}

/**
 * The property every case below rests on: one request through the memo and
 * one request without it produce the same identity.
 *
 * Compared with `toEqual`, not by reference: the uncached path builds a
 * fresh object every time, and the memo's whole point is that it does not.
 */
function expectSameAsUncached(
  files: readonly string[],
  roots: KnownPackageRoots | undefined,
): void {
  const cache = createScanModuleIdentityCache(roots);
  for (const file of files) {
    expect(identifyModule(file, roots, cache)).toEqual(
      identifyModule(file, roots),
    );
  }
  // ...and again, now that every answer is served from the memo rather
  // than computed. A memo that were merely correct on the miss path would
  // pass the loop above.
  for (const file of files) {
    expect(identifyModule(file, roots, cache)).toEqual(
      identifyModule(file, roots),
    );
  }
}

describe("F5 module-identity memo: same-version twins", () => {
  it("keeps two installs of the same name AND version at different roots distinct", () => {
    const root = project({
      "node_modules/foo/package.json": manifest("foo", "1.0.0"),
      "node_modules/foo/index.js": "module.exports = {};\n",
      "node_modules/bar/node_modules/foo/package.json": manifest(
        "foo",
        "1.0.0",
      ),
      "node_modules/bar/node_modules/foo/index.js": "module.exports = {};\n",
    });
    const a = path.join(root, "node_modules/foo/index.js");
    const b = path.join(root, "node_modules/bar/node_modules/foo/index.js");

    const cache = createScanModuleIdentityCache(undefined);
    const identityA = identifyModule(a, undefined, cache);
    const identityB = identifyModule(b, undefined, cache);

    expect(identityA.packageName).toBe("foo");
    expect(identityB.packageName).toBe("foo");
    // The whole point: identical name, identical version, two identities.
    expect(identityA.packageInstance).not.toBe(identityB.packageInstance);
    expect(identityA.packageInstance).toBe(path.join(root, "node_modules/foo"));
    expect(identityB.packageInstance).toBe(
      path.join(root, "node_modules/bar/node_modules/foo"),
    );
    expectSameAsUncached([a, b], undefined);
  });

  it("does not let the first twin's manifest name answer for the second", () => {
    // The two roots differ ONLY in what their own manifests declare, which
    // is the shape a memo keyed on anything less than the whole path would
    // collapse.
    const root = project({
      "node_modules/pkg/package.json": manifest("real-name", "2.0.0"),
      "node_modules/pkg/index.js": "module.exports = {};\n",
      "node_modules/nested/node_modules/pkg/package.json": manifest(
        "other-name",
        "2.0.0",
      ),
      "node_modules/nested/node_modules/pkg/index.js": "module.exports = {};\n",
    });
    const a = path.join(root, "node_modules/pkg/index.js");
    const b = path.join(root, "node_modules/nested/node_modules/pkg/index.js");

    const cache = createScanModuleIdentityCache(undefined);
    expect(identifyModule(a, undefined, cache).packageName).toBe("real-name");
    expect(identifyModule(b, undefined, cache).packageName).toBe("other-name");
    expectSameAsUncached([a, b], undefined);
  });
});

describe("F5 module-identity memo: scoped, unscoped and aliased packages", () => {
  it("does not collide a scoped package with a same-suffix unscoped sibling", () => {
    const root = project({
      "node_modules/@scope/pkg/package.json": manifest("@scope/pkg", "1.0.0"),
      "node_modules/@scope/pkg/index.js": "module.exports = {};\n",
      "node_modules/pkg/package.json": manifest("pkg", "1.0.0"),
      "node_modules/pkg/index.js": "module.exports = {};\n",
    });
    const scoped = path.join(root, "node_modules/@scope/pkg/index.js");
    const unscoped = path.join(root, "node_modules/pkg/index.js");

    const cache = createScanModuleIdentityCache(undefined);
    expect(identifyModule(scoped, undefined, cache).packageName).toBe(
      "@scope/pkg",
    );
    expect(identifyModule(unscoped, undefined, cache).packageName).toBe("pkg");
    expect(identifyModule(scoped, undefined, cache).packageInstance).not.toBe(
      identifyModule(unscoped, undefined, cache).packageInstance,
    );
    expectSameAsUncached([scoped, unscoped], undefined);
  });

  it("does not collide two scoped packages sharing a suffix", () => {
    const root = project({
      "node_modules/@a/pkg/package.json": manifest("@a/pkg", "1.0.0"),
      "node_modules/@a/pkg/index.js": "module.exports = {};\n",
      "node_modules/@b/pkg/package.json": manifest("@b/pkg", "1.0.0"),
      "node_modules/@b/pkg/index.js": "module.exports = {};\n",
    });
    const files = [
      path.join(root, "node_modules/@a/pkg/index.js"),
      path.join(root, "node_modules/@b/pkg/index.js"),
    ];
    const cache = createScanModuleIdentityCache(undefined);
    const names = files.map(
      (file) => identifyModule(file, undefined, cache).packageName,
    );
    expect(names).toEqual(["@a/pkg", "@b/pkg"]);
    expectSameAsUncached(files, undefined);
  });

  it("keeps an npm alias's declared name and its install directory apart", () => {
    // `"semver-vulnerable": "npm:semver@7.5.1"` — the install directory and
    // the package's own declared name deliberately disagree.
    const root = project({
      "node_modules/semver-vulnerable/package.json": manifest(
        "semver",
        "7.5.1",
      ),
      "node_modules/semver-vulnerable/index.js": "module.exports = {};\n",
      "node_modules/semver/package.json": manifest("semver", "7.5.1"),
      "node_modules/semver/index.js": "module.exports = {};\n",
    });
    const aliased = path.join(root, "node_modules/semver-vulnerable/index.js");
    const canonical = path.join(root, "node_modules/semver/index.js");

    const cache = createScanModuleIdentityCache(undefined);
    const aliasIdentity = identifyModule(aliased, undefined, cache);
    const canonicalIdentity = identifyModule(canonical, undefined, cache);

    // Same declared name, same version — and still two instances.
    expect(aliasIdentity.packageName).toBe("semver");
    expect(canonicalIdentity.packageName).toBe("semver");
    expect(aliasIdentity.packageInstance).toBe(
      path.join(root, "node_modules/semver-vulnerable"),
    );
    expect(canonicalIdentity.packageInstance).toBe(
      path.join(root, "node_modules/semver"),
    );
    expectSameAsUncached([aliased, canonical], undefined);
  });
});

describe("F5 module-identity memo: symlink convergence", () => {
  it("converges two references that really are one physical instance", () => {
    const root = project({
      "packages/lib/package.json": manifest("lib", "1.0.0"),
      "packages/lib/index.js": "module.exports = {};\n",
      "node_modules/.keep": "",
    });
    symlinkSync(
      path.join(root, "packages/lib"),
      path.join(root, "node_modules/lib"),
      "dir",
    );
    const viaLink = path.join(root, "node_modules/lib/index.js");
    const viaReal = path.join(root, "packages/lib/index.js");

    const roots = buildKnownPackageRoots(
      [node("lib", "1.0.0", "packages/lib")],
      root,
    );
    const cache = createScanModuleIdentityCache(roots);

    // The link path carries a `node_modules/lib` segment, so it is
    // attributed through that branch; the real path has none and is
    // attributed through the known-roots walk. Both must land on the same
    // physical instance — that is what `realpathSync` is for.
    expect(identifyModule(viaLink, roots, cache).packageInstance).toBe(
      identifyModule(viaReal, roots, cache).packageInstance,
    );
    expect(identifyModule(viaReal, roots, cache).packageInstance).toBe(
      path.join(root, "packages/lib"),
    );
    expectSameAsUncached([viaLink, viaReal], roots);
  });

  it("does not converge two symlinks pointing at genuinely different targets", () => {
    const root = project({
      "packages/one/package.json": manifest("twin", "1.0.0"),
      "packages/one/index.js": "module.exports = {};\n",
      "packages/two/package.json": manifest("twin", "1.0.0"),
      "packages/two/index.js": "module.exports = {};\n",
      "node_modules/.keep": "",
    });
    symlinkSync(
      path.join(root, "packages/one"),
      path.join(root, "node_modules/a"),
      "dir",
    );
    symlinkSync(
      path.join(root, "packages/two"),
      path.join(root, "node_modules/b"),
      "dir",
    );

    const cache = createScanModuleIdentityCache(undefined);
    const a = identifyModule(
      path.join(root, "node_modules/a/index.js"),
      undefined,
      cache,
    );
    const b = identifyModule(
      path.join(root, "node_modules/b/index.js"),
      undefined,
      cache,
    );
    // Both manifests declare the same name at the same version, and both
    // are reached through a `node_modules` symlink. Only the physical
    // target separates them, which is exactly what `realpathSync` reads
    // and what the memo must not blur.
    expect(a.packageName).toBe("twin");
    expect(b.packageName).toBe("twin");
    expect(a.packageInstance).toBe(path.join(root, "packages/one"));
    expect(b.packageInstance).toBe(path.join(root, "packages/two"));
    expectSameAsUncached(
      [
        path.join(root, "node_modules/a/index.js"),
        path.join(root, "node_modules/b/index.js"),
      ],
      undefined,
    );
  });
});

describe("F5 module-identity memo: cross-root key collisions", () => {
  it("does not let the same relative path under two project roots collide", () => {
    const first = project({
      "node_modules/shared/package.json": manifest("shared", "1.0.0"),
      "node_modules/shared/index.js": "module.exports = {};\n",
    });
    const second = project({
      "node_modules/shared/package.json": manifest("shared", "1.0.0"),
      "node_modules/shared/index.js": "module.exports = {};\n",
    });
    const relative = "node_modules/shared/index.js";

    // ONE cache, both roots — the exact shape a key built from anything
    // less than the whole absolute path would merge.
    const cache = createScanModuleIdentityCache(undefined);
    const a = identifyModule(path.join(first, relative), undefined, cache);
    const b = identifyModule(path.join(second, relative), undefined, cache);

    expect(a.packageInstance).toBe(path.join(first, "node_modules/shared"));
    expect(b.packageInstance).toBe(path.join(second, "node_modules/shared"));
    expect(a.packageInstance).not.toBe(b.packageInstance);
  });

  it("refuses to answer from a memo bound to a different registry", () => {
    const root = project({
      "packages/lib/package.json": manifest("lib", "1.0.0"),
      "packages/lib/index.js": "module.exports = {};\n",
    });
    const file = path.join(root, "packages/lib/index.js");
    const withRoot = buildKnownPackageRoots(
      [node("lib", "1.0.0", "packages/lib")],
      root,
    );
    const withoutRoot: KnownPackageRoots = new Map();

    // A memo built for a registry that KNOWS this root, then consulted by
    // a caller holding a registry that does not. The caller must get its
    // own registry's answer (no identity), not the memo's.
    const cache = createScanModuleIdentityCache(withRoot);
    expect(identifyModule(file, withRoot, cache).packageInstance).toBe(
      path.join(root, "packages/lib"),
    );
    expect(
      identifyModule(file, withoutRoot, cache).packageInstance,
    ).toBeUndefined();
    // ...and the mismatched call left nothing behind that could poison the
    // memo for the registry it really belongs to.
    expect(identifyModule(file, withRoot, cache).packageInstance).toBe(
      path.join(root, "packages/lib"),
    );
  });
});

describe("F5 module-identity memo: failures are never cached as success", () => {
  it("re-attempts canonicalization of a path that does not exist", () => {
    const root = project({});
    const missing = path.join(root, "node_modules/ghost/index.js");
    const cache = createScanModuleIdentityCache(undefined);

    const first = identifyModule(missing, undefined, cache);
    // The fallback is the normalized absolute path, exactly as uncached.
    expect(first.packageInstance).toBe(path.join(root, "node_modules/ghost"));
    expect(first).toEqual(identifyModule(missing, undefined));
    // Nothing was memoized for the failed realpath.
    expect(cache.canonicalPaths.size).toBe(0);
    // Nor for the absent manifest.
    expect(cache.manifestNames.size).toBe(0);
  });

  it("sees a manifest that becomes readable, rather than the earlier absence", () => {
    const root = project({
      "node_modules/late/index.js": "module.exports = {};\n",
    });
    const file = path.join(root, "node_modules/late/index.js");
    const cache = createScanModuleIdentityCache(undefined);

    // No manifest yet: the path-derived name stands.
    expect(identifyModule(file, undefined, cache).packageName).toBe("late");
    expect(cache.manifestNames.size).toBe(0);

    // A fresh memo, as a new request would see — the identity memo itself
    // holds the earlier whole answer by design (one scan, one answer per
    // file), so this asserts the MANIFEST layer specifically.
    writeFileSync(
      path.join(root, "node_modules/late/package.json"),
      manifest("declared-name", "1.0.0"),
    );
    const later = createScanModuleIdentityCache(undefined);
    expect(identifyModule(file, undefined, later).packageName).toBe(
      "declared-name",
    );
    expect(later.manifestNames.get(path.join(root, "node_modules/late"))).toBe(
      "declared-name",
    );
  });

  it("does not memoize a malformed manifest as a name", () => {
    const root = project({
      "node_modules/broken/package.json": "{ not json",
      "node_modules/broken/index.js": "module.exports = {};\n",
    });
    const file = path.join(root, "node_modules/broken/index.js");
    const cache = createScanModuleIdentityCache(undefined);
    expect(identifyModule(file, undefined, cache).packageName).toBe("broken");
    expect(cache.manifestNames.size).toBe(0);
    expect(identifyModule(file, undefined, cache)).toEqual(
      identifyModule(file, undefined),
    );
  });

  it("does not memoize a manifest with no usable name", () => {
    const root = project({
      "node_modules/nameless/package.json": JSON.stringify({
        version: "1.0.0",
      }),
      "node_modules/nameless/index.js": "module.exports = {};\n",
    });
    const file = path.join(root, "node_modules/nameless/index.js");
    const cache = createScanModuleIdentityCache(undefined);
    expect(identifyModule(file, undefined, cache).packageName).toBe("nameless");
    expect(cache.manifestNames.size).toBe(0);
  });
});

describe("F5 module-identity memo: operation counts", () => {
  it("answers 100 requests for the same path with one realpath and one manifest read", () => {
    const root = project({
      "node_modules/hot/package.json": manifest("hot", "1.0.0"),
      "node_modules/hot/index.js": "module.exports = {};\n",
    });
    const file = path.join(root, "node_modules/hot/index.js");
    const cache = createScanModuleIdentityCache(undefined);

    for (let i = 0; i < 100; i += 1) {
      identifyModule(file, undefined, cache);
    }

    expect(cache.operations.identityMisses).toBe(1);
    expect(cache.operations.identityHits).toBe(99);
    expect(cache.operations.realpathCalls).toBe(1);
    expect(cache.operations.manifestReads).toBe(1);
  });

  it("answers many files of one package with one realpath and one manifest read", () => {
    // The shape the baseline profile found dominating: a graph with
    // hundreds of nodes spread over a handful of files inside ONE install.
    const files: Record<string, string> = {
      "node_modules/wide/package.json": manifest("wide", "1.0.0"),
    };
    for (let i = 0; i < 50; i += 1) {
      files[`node_modules/wide/lib/m${i}.js`] = "module.exports = {};\n";
    }
    const root = project(files);
    const cache = createScanModuleIdentityCache(undefined);

    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 50; i += 1) {
        identifyModule(
          path.join(root, `node_modules/wide/lib/m${i}.js`),
          undefined,
          cache,
        );
      }
    }

    expect(cache.operations.identityMisses).toBe(50);
    expect(cache.operations.identityHits).toBe(100);
    // 50 distinct files, but ONE package root — so one of each.
    expect(cache.operations.realpathCalls).toBe(1);
    expect(cache.operations.manifestReads).toBe(1);
  });

  it("without a cache, performs no memoization at all", () => {
    // The control: the counters above are not an artifact of the test
    // calling a different function. This is the same call with the memo
    // omitted, and it must still be correct.
    const root = project({
      "node_modules/hot/package.json": manifest("hot", "1.0.0"),
      "node_modules/hot/index.js": "module.exports = {};\n",
    });
    const file = path.join(root, "node_modules/hot/index.js");
    const answers = new Set<string | undefined>();
    for (let i = 0; i < 10; i += 1) {
      answers.add(identifyModule(file, undefined).packageInstance);
    }
    expect([...answers]).toEqual([path.join(root, "node_modules/hot")]);
  });
});

describe("F5 module-identity memo: bounds and isolation", () => {
  it("is bounded by the files and roots it was actually asked about", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) {
      files[`node_modules/p${i}/package.json`] = manifest(`p${i}`, "1.0.0");
      files[`node_modules/p${i}/index.js`] = "module.exports = {};\n";
      files[`node_modules/p${i}/other.js`] = "module.exports = {};\n";
    }
    const root = project(files);
    const cache = createScanModuleIdentityCache(undefined);
    for (let i = 0; i < 20; i += 1) {
      identifyModule(
        path.join(root, `node_modules/p${i}/index.js`),
        undefined,
        cache,
      );
      identifyModule(
        path.join(root, `node_modules/p${i}/other.js`),
        undefined,
        cache,
      );
    }
    // One entry per distinct file asked about, one per distinct root
    // beneath them. Nothing is keyed by an advisory, a rule or a package
    // name, so nothing an input file can say grows this beyond the file
    // set the analyzer already holds.
    expect(cache.identities.size).toBe(40);
    expect(cache.canonicalPaths.size).toBe(20);
    expect(cache.manifestNames.size).toBe(20);
  });

  it("shares nothing between two caches", () => {
    const root = project({
      "node_modules/iso/package.json": manifest("iso", "1.0.0"),
      "node_modules/iso/index.js": "module.exports = {};\n",
    });
    const file = path.join(root, "node_modules/iso/index.js");
    const first = createScanModuleIdentityCache(undefined);
    identifyModule(file, undefined, first);
    expect(first.operations.identityMisses).toBe(1);

    // A second scan in the same process starts cold. If any state were
    // module-scope, this would read 0 misses and 1 hit.
    const second = createScanModuleIdentityCache(undefined);
    identifyModule(file, undefined, second);
    expect(second.operations.identityMisses).toBe(1);
    expect(second.operations.identityHits).toBe(0);
    expect(second.operations.realpathCalls).toBe(1);
  });
});

describe("F5 module-identity memo: unreadable manifests", () => {
  it("degrades to the path-derived name and memoizes nothing", () => {
    const root = project({
      "node_modules/locked/package.json": manifest("locked", "1.0.0"),
      "node_modules/locked/index.js": "module.exports = {};\n",
    });
    const manifestPath = path.join(root, "node_modules/locked/package.json");
    const file = path.join(root, "node_modules/locked/index.js");
    chmodSync(manifestPath, 0o000);
    try {
      const cache = createScanModuleIdentityCache(undefined);
      const cached = identifyModule(file, undefined, cache);
      const uncached = identifyModule(file, undefined);
      // Running as root defeats the permission bit; in that case the file
      // is readable and BOTH sides simply see the declared name. Either
      // way the assertion that matters is that they agree.
      expect(cached).toEqual(uncached);
      if (cached.packageName === "locked") {
        expect(cache.manifestNames.size).toBe(0);
      }
    } finally {
      chmodSync(manifestPath, 0o644);
    }
  });
});
