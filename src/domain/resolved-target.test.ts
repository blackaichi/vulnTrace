import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DependencyNode } from "./dependency.js";
import {
  buildKnownPackageRoots,
  buildResolvedTarget,
  canonicalizePackageInstancePath,
  identifyModule,
} from "./resolved-target.js";

/** A minimal synthetic DependencyNode, for building a test's own KnownPackageRoots (VT-307c-fix-4b). */
function dependencyNode(name: string, location: string): DependencyNode {
  return {
    id: `${name}@0`,
    name,
    version: "0.0.0",
    ecosystem: "npm",
    direct: true,
    locations: [location],
    dependencyPaths: [],
  };
}

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-resolved-target-"));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("identifyModule", () => {
  it("identifies a top-level installed package", () => {
    const identity = identifyModule("/project/node_modules/foo/index.js");

    expect(identity).toEqual({
      packageName: "foo",
      packageInstance: "/project/node_modules/foo",
      resolvedFile: "/project/node_modules/foo/index.js",
    });
  });

  it(
    "distinguishes a nested, non-hoisted install from a top-level install of the " +
      "same package name (SDD-v0.2.md § 4.2)",
    () => {
      const topLevel = identifyModule("/project/node_modules/foo/index.js");
      const nested = identifyModule(
        "/project/node_modules/bar/node_modules/foo/index.js",
      );

      expect(topLevel.packageName).toBe("foo");
      expect(nested.packageName).toBe("foo");
      // Same package name, but the two installs must never collapse into
      // one identity.
      expect(nested.packageInstance).not.toBe(topLevel.packageInstance);
      expect(nested.packageInstance).toBe(
        "/project/node_modules/bar/node_modules/foo",
      );
    },
  );

  it("treats a scoped package name as a single segment", () => {
    const identity = identifyModule(
      "/project/node_modules/@scope/pkg/index.js",
    );

    expect(identity).toEqual({
      packageName: "@scope/pkg",
      packageInstance: "/project/node_modules/@scope/pkg",
      resolvedFile: "/project/node_modules/@scope/pkg/index.js",
    });
  });

  it("distinguishes a nested scoped package install from a top-level one", () => {
    const topLevel = identifyModule(
      "/project/node_modules/@scope/pkg/index.js",
    );
    const nested = identifyModule(
      "/project/node_modules/bar/node_modules/@scope/pkg/index.js",
    );

    expect(nested.packageName).toBe(topLevel.packageName);
    expect(nested.packageInstance).not.toBe(topLevel.packageInstance);
    expect(nested.packageInstance).toBe(
      "/project/node_modules/bar/node_modules/@scope/pkg",
    );
  });

  it("resolves a deeper file within the package to the same instance", () => {
    const shallow = identifyModule("/project/node_modules/foo/index.js");
    const deep = identifyModule("/project/node_modules/foo/lib/deep/file.js");

    expect(deep.packageInstance).toBe(shallow.packageInstance);
    expect(deep.packageName).toBe(shallow.packageName);
  });

  it("has no package identity for a file with no node_modules segment", () => {
    const identity = identifyModule("/project/src/index.ts");

    expect(identity).toEqual({ resolvedFile: "/project/src/index.ts" });
  });
});

describe("identifyModule: authoritative package.json identity (VT-306, RWF-009)", () => {
  it("uses the installed package's own package.json name for a normal (non-aliased) package", () => {
    const root = tempProject();
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    const file = write(
      root,
      "node_modules/foo/index.js",
      "module.exports = {};\n",
    );

    const identity = identifyModule(file);

    expect(identity.packageName).toBe("foo");
    expect(identity.packageInstance).toBe(path.join(root, "node_modules/foo"));
  });

  it("prefers package.json's declared name over the install directory name for an npm alias", () => {
    const root = tempProject();
    // Real npm-alias shape: "foo-alias": "npm:foo@1.2.3" -- installed at
    // node_modules/foo-alias, but the package's own package.json declares
    // its real name.
    write(
      root,
      "node_modules/foo-alias/package.json",
      JSON.stringify({ name: "foo", version: "1.2.3" }),
    );
    const file = write(
      root,
      "node_modules/foo-alias/index.js",
      "module.exports = {};\n",
    );

    const identity = identifyModule(file);

    expect(identity.packageName).toBe("foo");
    // The install LOCATION is unaffected by the alias -- it's still the
    // real directory the package lives in, never redefined by identity.
    expect(identity.packageInstance).toBe(
      path.join(root, "node_modules/foo-alias"),
    );
  });

  it("gives two different aliases of the same real package the same identity but distinct instances", () => {
    const root = tempProject();
    write(
      root,
      "node_modules/foo-old/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    const oldFile = write(
      root,
      "node_modules/foo-old/index.js",
      "module.exports = {};\n",
    );
    write(
      root,
      "node_modules/foo-new/package.json",
      JSON.stringify({ name: "foo", version: "2.0.0" }),
    );
    const newFile = write(
      root,
      "node_modules/foo-new/index.js",
      "module.exports = {};\n",
    );

    const oldIdentity = identifyModule(oldFile);
    const newIdentity = identifyModule(newFile);

    expect(oldIdentity.packageName).toBe("foo");
    expect(newIdentity.packageName).toBe("foo");
    // Same package identity, but the two installs must never collapse
    // into one instance (VT-212's own invariant, preserved here).
    expect(oldIdentity.packageInstance).not.toBe(newIdentity.packageInstance);
    expect(oldIdentity.packageInstance).toBe(
      path.join(root, "node_modules/foo-old"),
    );
    expect(newIdentity.packageInstance).toBe(
      path.join(root, "node_modules/foo-new"),
    );
  });

  it("uses package.json's declared name for a scoped package", () => {
    const root = tempProject();
    write(
      root,
      "node_modules/@scope/pkg/package.json",
      JSON.stringify({ name: "@scope/pkg", version: "1.0.0" }),
    );
    const file = write(
      root,
      "node_modules/@scope/pkg/index.js",
      "module.exports = {};\n",
    );

    const identity = identifyModule(file);

    expect(identity.packageName).toBe("@scope/pkg");
    expect(identity.packageInstance).toBe(
      path.join(root, "node_modules/@scope/pkg"),
    );
  });

  it("prefers package.json's declared name for a scoped alias (unscoped install dir, scoped real name)", () => {
    const root = tempProject();
    // "scoped-alias": "npm:@scope/pkg@1.0.0" -- installed at a plain,
    // unscoped directory name, but the real package is scoped.
    write(
      root,
      "node_modules/scoped-alias/package.json",
      JSON.stringify({ name: "@scope/pkg", version: "1.0.0" }),
    );
    const file = write(
      root,
      "node_modules/scoped-alias/index.js",
      "module.exports = {};\n",
    );

    const identity = identifyModule(file);

    expect(identity.packageName).toBe("@scope/pkg");
    expect(identity.packageInstance).toBe(
      path.join(root, "node_modules/scoped-alias"),
    );
  });

  it("falls back to the path-derived name when package.json is missing entirely", () => {
    const root = tempProject();
    // No package.json written at all for this install.
    const file = write(
      root,
      "node_modules/bare-pkg/index.js",
      "module.exports = {};\n",
    );

    const identity = identifyModule(file);

    expect(identity.packageName).toBe("bare-pkg");
    expect(identity.packageInstance).toBe(
      path.join(root, "node_modules/bare-pkg"),
    );
  });

  it("falls back to the path-derived name when package.json has no valid name field", () => {
    const root = tempProject();
    write(
      root,
      "node_modules/no-name-pkg/package.json",
      JSON.stringify({ version: "1.0.0" }),
    );
    const file = write(
      root,
      "node_modules/no-name-pkg/index.js",
      "module.exports = {};\n",
    );

    const identity = identifyModule(file);

    expect(identity.packageName).toBe("no-name-pkg");
  });

  it("falls back to the path-derived name when package.json is malformed JSON", () => {
    const root = tempProject();
    write(root, "node_modules/broken-pkg/package.json", "{ not valid json");
    const file = write(
      root,
      "node_modules/broken-pkg/index.js",
      "module.exports = {};\n",
    );

    const identity = identifyModule(file);

    expect(identity.packageName).toBe("broken-pkg");
  });

  it("never lets a fallback-derived identity override a valid package.json name, even for a deeper file within the package", () => {
    const root = tempProject();
    write(
      root,
      "node_modules/foo-alias/package.json",
      JSON.stringify({ name: "foo", version: "1.2.3" }),
    );
    const deepFile = write(
      root,
      "node_modules/foo-alias/lib/deep/file.js",
      "module.exports = {};\n",
    );

    const identity = identifyModule(deepFile);

    expect(identity.packageName).toBe("foo");
    expect(identity.packageInstance).toBe(
      path.join(root, "node_modules/foo-alias"),
    );
  });
});

describe("buildResolvedTarget", () => {
  it("derives moduleId and top-level package identity consistently from the same resolved file", () => {
    const target = buildResolvedTarget(
      "/project/node_modules/bar/node_modules/foo/index.js",
      { exportedSymbol: "vulnerable", packageVersion: "1.0.0" },
    );

    expect(target.moduleId).toEqual(
      identifyModule("/project/node_modules/bar/node_modules/foo/index.js"),
    );
    expect(target.packageName).toBe("foo");
    expect(target.packageInstance).toBe(
      "/project/node_modules/bar/node_modules/foo",
    );
    expect(target.packageVersion).toBe("1.0.0");
    expect(target.exportedSymbol).toBe("vulnerable");
    expect(target.resolvedFile).toBe(
      "/project/node_modules/bar/node_modules/foo/index.js",
    );
  });

  it("defaults resolutionEvidence to an empty array when not provided", () => {
    const target = buildResolvedTarget("/project/src/index.ts");

    expect(target.resolutionEvidence).toEqual([]);
    expect(target.packageName).toBeUndefined();
    expect(target.packageInstance).toBeUndefined();
  });

  it("preserves supplied resolutionEvidence and symbolId", () => {
    const target = buildResolvedTarget("/project/node_modules/foo/index.js", {
      exportedSymbol: "vulnerable",
      symbolId: "/project/node_modules/foo/index.js#vulnerable@1:1",
      resolutionEvidence: ["resolved via named ESM import"],
    });

    expect(target.symbolId).toBe(
      "/project/node_modules/foo/index.js#vulnerable@1:1",
    );
    expect(target.resolutionEvidence).toEqual([
      "resolved via named ESM import",
    ]);
  });
});

describe("canonicalizePackageInstancePath (VT-307c-fix-4)", () => {
  it("falls back to a normalized absolute path when the target does not exist", () => {
    expect(canonicalizePackageInstancePath("/definitely/not/a/real/path")).toBe(
      path.resolve("/definitely/not/a/real/path"),
    );
  });

  it("is idempotent for an already-canonical existing path", () => {
    const root = tempProject();
    const once = canonicalizePackageInstancePath(root);
    const twice = canonicalizePackageInstancePath(once);
    expect(once).toBe(twice);
  });
});

describe("identifyModule: canonical PackageInstance identity across symlinks (VT-307c-fix-4, VT-307d review Blocker A)", () => {
  it("(A, pnpm-style) a logical node_modules symlink and its physical pnpm-store target canonicalize to the same PackageInstance", () => {
    const root = tempProject();
    const real = "node_modules/.pnpm/foo@1.0.0/node_modules/foo";
    write(
      root,
      `${real}/package.json`,
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    const file = write(root, `${real}/index.js`, "module.exports = {};\n");
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(root, real),
      path.join(root, "node_modules/foo"),
      "dir",
    );

    // Finding side (VT-212): the LOGICAL, lockfile-derived install location.
    const findingInstance = canonicalizePackageInstancePath(
      path.join(root, "node_modules/foo"),
    );
    // Closure/call-graph side: the resolver already reports the physical
    // (post-symlink) file.
    const closureIdentity = identifyModule(file);

    expect(closureIdentity.packageInstance).toBe(findingInstance);
  });

  it("(C, plain npm control) a regular install directory already agrees on both sides with no symlink involved", () => {
    const root = tempProject();
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    const file = write(
      root,
      "node_modules/foo/index.js",
      "module.exports = {};\n",
    );

    const findingInstance = canonicalizePackageInstancePath(
      path.join(root, "node_modules/foo"),
    );
    const closureIdentity = identifyModule(file);

    expect(closureIdentity.packageInstance).toBe(findingInstance);
    expect(closureIdentity.packageInstance).toBe(
      path.join(root, "node_modules/foo"),
    );
  });

  it("(B, workspace/external symlink) a node_modules symlink to a physical target OUTSIDE node_modules still resolves to a stable PackageInstance", () => {
    // Real monorepo topology: the SCANNED sub-project (`projectRoot`) and
    // the workspace member it depends on are SIBLINGS under a common
    // workspace root -- `packages/foo` is never inside `app` itself. A
    // test that nested `packages/foo` under `projectRoot` would trivially
    // satisfy "escapes the project" for the wrong reason.
    const workspaceRoot = tempProject();
    const projectRoot = path.join(workspaceRoot, "app");
    write(
      workspaceRoot,
      "packages/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    const file = write(
      workspaceRoot,
      "packages/foo/lib/index.js",
      "module.exports = {};\n",
    );
    mkdirSync(path.join(projectRoot, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(workspaceRoot, "packages/foo"),
      path.join(projectRoot, "node_modules/foo"),
      "dir",
    );

    const findingInstance = canonicalizePackageInstancePath(
      path.join(projectRoot, "node_modules/foo"),
    );
    // Without `knownPackageRoots`, this must NOT silently drop identity,
    // but it has no way to escape the node_modules-segment assumption
    // either -- confirms the registry-gated fallback is what actually
    // recovers it (VT-307c-fix-4b: provenance, never mere containment).
    expect(identifyModule(file)).toEqual({ resolvedFile: file });

    const knownPackageRoots = buildKnownPackageRoots(
      [dependencyNode("foo", "node_modules/foo")],
      projectRoot,
    );
    const closureIdentity = identifyModule(file, knownPackageRoots);

    expect(closureIdentity.packageName).toBe("foo");
    expect(closureIdentity.packageInstance).toBe(findingInstance);
    expect(closureIdentity.packageInstance).toBe(
      path.join(workspaceRoot, "packages/foo"),
    );
  });

  it("(VT-307c-fix-4b Blocker A) an in-tree workspace symlink, scanned AT the monorepo root, still resolves to a stable PackageInstance", () => {
    // The shape fix-4's own `projectRoot`-escape check silently missed: the
    // physical target (packages/foo) is INSIDE projectRoot -- a workspace
    // scanned from its own monorepo root has every member inside
    // projectRoot by definition. Provenance must not depend on containment.
    const root = tempProject();
    write(
      root,
      "packages/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    const file = write(
      root,
      "packages/foo/lib/index.js",
      "module.exports = {};\n",
    );
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(root, "packages/foo"),
      path.join(root, "node_modules/foo"),
      "dir",
    );

    const findingInstance = canonicalizePackageInstancePath(
      path.join(root, "node_modules/foo"),
    );
    const knownPackageRoots = buildKnownPackageRoots(
      [dependencyNode("foo", "node_modules/foo")],
      root,
    );
    const identity = identifyModule(file, knownPackageRoots);

    expect(identity.packageName).toBe("foo");
    expect(identity.packageInstance).toBe(findingInstance);
    expect(identity.packageInstance).toBe(path.join(root, "packages/foo"));
  });

  it("never attributes package identity to the scanned project's own source, even with no node_modules segment", () => {
    const root = tempProject();
    write(root, "package.json", JSON.stringify({ name: "app" }));
    const file = write(root, "src/index.js", "module.exports = {};\n");

    // Empty registry: the scanned project's own package.json is never a
    // DependencyNode location, so it can never appear here regardless of
    // containment (VT-307c-fix-4b).
    const knownPackageRoots = buildKnownPackageRoots([], root);
    const identity = identifyModule(file, knownPackageRoots);

    expect(identity).toEqual({ resolvedFile: file });
  });

  it("(unknown in-tree package.json) an in-tree directory with its own package.json that is NOT a known dependency location gets no identity", () => {
    const root = tempProject();
    write(root, "package.json", JSON.stringify({ name: "app" }));
    write(
      root,
      "internal/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    const file = write(root, "internal/foo/index.js", "module.exports = {};\n");

    // `internal/foo` looks exactly like an installed package (its own
    // package.json, a plausible name) but was never named by the
    // dependency graph -- provenance, not "has a package.json", must be
    // the deciding criterion (VT-307c-fix-4b Part 11).
    const knownPackageRoots = buildKnownPackageRoots([], root);
    const identity = identifyModule(file, knownPackageRoots);

    expect(identity).toEqual({ resolvedFile: file });
  });

  it("(negative control) two logical installs pointing to DIFFERENT physical pnpm-store targets remain distinct instances", () => {
    const root = tempProject();
    const realA = "node_modules/.pnpm/foo@1.0.0/node_modules/foo";
    const realB = "node_modules/.pnpm/foo@2.0.0/node_modules/foo";
    write(
      root,
      `${realA}/package.json`,
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    const fileA = write(root, `${realA}/index.js`, "module.exports = {};\n");
    write(
      root,
      `${realB}/package.json`,
      JSON.stringify({ name: "foo", version: "2.0.0" }),
    );
    const fileB = write(root, `${realB}/index.js`, "module.exports = {};\n");

    const a = identifyModule(fileA);
    const b = identifyModule(fileB);

    expect(a.packageInstance).not.toBe(b.packageInstance);
  });

  it("(negative control, external) two node_modules symlinks to DIFFERENT external physical targets remain distinct instances", () => {
    const workspaceRoot = tempProject();
    const projectRoot = path.join(workspaceRoot, "app");
    mkdirSync(projectRoot, { recursive: true });
    write(
      workspaceRoot,
      "packages/foo-a/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    const fileA = write(
      workspaceRoot,
      "packages/foo-a/index.js",
      "module.exports = {};\n",
    );
    write(
      workspaceRoot,
      "packages/foo-b/package.json",
      JSON.stringify({ name: "foo", version: "2.0.0" }),
    );
    const fileB = write(
      workspaceRoot,
      "packages/foo-b/index.js",
      "module.exports = {};\n",
    );
    mkdirSync(path.join(projectRoot, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(workspaceRoot, "packages/foo-a"),
      path.join(projectRoot, "node_modules/foo-a"),
      "dir",
    );
    symlinkSync(
      path.join(workspaceRoot, "packages/foo-b"),
      path.join(projectRoot, "node_modules/foo-b"),
      "dir",
    );

    const knownPackageRoots = buildKnownPackageRoots(
      [
        dependencyNode("foo", "node_modules/foo-a"),
        dependencyNode("foo", "node_modules/foo-b"),
      ],
      projectRoot,
    );
    const a = identifyModule(fileA, knownPackageRoots);
    const b = identifyModule(fileB, knownPackageRoots);

    expect(a.packageInstance).not.toBe(b.packageInstance);
    expect(a.packageInstance).toBe(path.join(workspaceRoot, "packages/foo-a"));
    expect(b.packageInstance).toBe(path.join(workspaceRoot, "packages/foo-b"));
  });

  it("(collapse) two DIFFERENT logical dependency-graph locations that are both symlinks to the SAME physical target canonicalize to the SAME PackageInstance", () => {
    // Mirrors real Node.js module-cache semantics (without
    // --preserve-symlinks): two logical names resolving to one physical
    // file really do share one loaded module instance at runtime (VT-307c-
    // fix-4 Part 12). This must not be confused with fix-1's own
    // architecture, which still gives each logical DependencyNode its own
    // independent buildFinding call -- only the packageInstance VALUE the
    // two findings carry happens to coincide here.
    const root = tempProject();
    write(
      root,
      "packages/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    const target = path.join(root, "packages/foo");
    write(root, "packages/foo/index.js", "module.exports = {};\n");
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(target, path.join(root, "node_modules/foo-a"), "dir");
    symlinkSync(target, path.join(root, "node_modules/foo-b"), "dir");

    const instanceA = canonicalizePackageInstancePath(
      path.join(root, "node_modules/foo-a"),
    );
    const instanceB = canonicalizePackageInstancePath(
      path.join(root, "node_modules/foo-b"),
    );

    expect(instanceA).toBe(instanceB);
    expect(instanceA).toBe(canonicalizePackageInstancePath(target));
  });

  it("(scoped package, pnpm-style symlink) canonicalizes correctly and keeps its scoped name", () => {
    const root = tempProject();
    const real = "node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg";
    write(
      root,
      `${real}/package.json`,
      JSON.stringify({ name: "@scope/pkg", version: "1.0.0" }),
    );
    const file = write(root, `${real}/index.js`, "module.exports = {};\n");
    mkdirSync(path.join(root, "node_modules/@scope"), { recursive: true });
    symlinkSync(
      path.join(root, real),
      path.join(root, "node_modules/@scope/pkg"),
      "dir",
    );

    const findingInstance = canonicalizePackageInstancePath(
      path.join(root, "node_modules/@scope/pkg"),
    );
    const closureIdentity = identifyModule(file);

    expect(closureIdentity.packageName).toBe("@scope/pkg");
    expect(closureIdentity.packageInstance).toBe(findingInstance);
  });
});
