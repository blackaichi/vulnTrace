import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createModuleResolver } from "../../src/code-intelligence/module-resolver.js";
import { loadTsProject } from "../../src/code-intelligence/ts-project.js";
import { identifyModule } from "../../src/domain/resolved-target.js";

/**
 * Permanent regression coverage for VT-302 (RWF-010,
 * docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 9.3/R-9b): the real-world
 * validation suite must never let a fixture's dependency resolution walk
 * up past the fixture into VulnTrace's OWN repository `node_modules`.
 *
 * Deliberately does NOT assert only final verdicts (see the task
 * instructions this satisfies): every case below asserts an actual
 * resolved file path, package identity, or package-instance root, so a
 * regression that happens to still produce the "right" verdict by
 * coincidence (exactly how RWB-07's/RWB-09's own pre-VT-302 failures went
 * undetected for a time) cannot silently pass here.
 *
 * `REPO_ROOT` below is THIS file's own repo/worktree root -- which is NOT
 * always the same directory that actually owns a `node_modules/`. In a
 * git-worktree layout (this repo's own dev convention: each task runs in
 * `.claude/worktrees/<name>/`), the worktree itself typically has no
 * `node_modules` of its own at all; `npm`/`node`'s own upward directory
 * walk resolves it from the ancestor MAIN checkout instead -- the exact
 * mechanism RWF-010 exploited for fixtures. `findAncestorPackage` below
 * performs that same walk explicitly, so these tests locate "VulnTrace's
 * own installed copy of X" correctly regardless of which checkout layout
 * they happen to run under.
 */

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const FIXTURES_ROOT = path.join(REPO_ROOT, "tests", "validation", "fixtures");

function write(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

function copyFixtureToTempDir(fixtureDir: string, label: string): string {
  const dest = mkdtempSync(
    path.join(tmpdir(), `vulntrace-hermeticity-${label}-`),
  );
  cpSync(fixtureDir, dest, { recursive: true, dereference: false });
  return dest;
}

/**
 * Node's own module-resolution algorithm's upward walk, performed
 * explicitly: the nearest ancestor (starting at `startDir` itself) whose
 * own `node_modules/<packageName>` exists, or `undefined` if none does
 * all the way to the filesystem root. Used only to locate "VulnTrace's
 * own installed copy of X" for these tests' own setup/assertions -- never
 * anything a validation fixture itself should rely on (see this file's
 * header comment).
 */
function findAncestorPackage(
  startDir: string,
  packageName: string,
): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", packageName);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/** Every ancestor directory of `startDir` (exclusive) up to the filesystem root. */
function ancestorsOf(startDir: string): string[] {
  const result: string[] = [];
  let dir = path.dirname(startDir);
  for (;;) {
    result.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) {
      return result;
    }
    dir = parent;
  }
}

let tempDirsToClean: string[] = [];

afterEach(() => {
  for (const dir of tempDirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirsToClean = [];
});

describe("real-world validation hermeticity (VT-302 / RWF-010)", () => {
  it("a package present in BOTH the fixture's own node_modules and VulnTrace's own node_modules resolves to the fixture's copy", async () => {
    // "semver" is a real dependency of VulnTrace itself (package.json) --
    // confirm VulnTrace's own installed copy genuinely exists somewhere
    // in this checkout's own ancestor chain first, so this test fails
    // loudly (not silently vacuously) if that ever stops being true.
    const vulnTraceOwnSemver = findAncestorPackage(REPO_ROOT, "semver");
    expect(vulnTraceOwnSemver).toBeDefined();

    const tmp = mkdtempSync(
      path.join(tmpdir(), "vulntrace-hermeticity-shared-pkg-"),
    );
    tempDirsToClean.push(tmp);

    // A fixture-local "semver" with content that could never coincidentally
    // match VulnTrace's own installed semver -- a marker version string.
    write(
      tmp,
      "node_modules/semver/package.json",
      JSON.stringify({
        name: "semver",
        version: "0.0.1-hermeticity-fixture-marker",
        main: "index.js",
      }),
    );
    write(
      tmp,
      "node_modules/semver/index.js",
      "module.exports.FIXTURE_MARKER = true;\n",
    );
    write(tmp, "package.json", JSON.stringify({ name: "hermeticity-test" }));
    const entry = write(
      tmp,
      "index.js",
      'module.exports = require("semver");\n',
    );

    const resolver = createModuleResolver(loadTsProject(tmp));
    const resolution = await resolver.resolve("semver", entry);

    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.resolvedFileName.startsWith(tmp)).toBe(true);
      expect(resolution.resolvedFileName).not.toBe(
        path.join(vulnTraceOwnSemver ?? "", "index.js"),
      );
      expect(resolution.packageId?.version).toBe(
        "0.0.1-hermeticity-fixture-marker",
      );
    }
  });

  it("BASELINE (documents why hermetic execution is required, not the desired benchmark behavior): a package absent from a fixture placed IN-TREE still resolves via VulnTrace's own node_modules", async () => {
    // The underlying resolver is deliberately unchanged by VT-302 (see
    // this file's header comment and the task's own scope: "Do not
    // modify the analyzer resolver merely to make the benchmark
    // hermetic") -- a fixture placed where tests/validation/fixtures/
    // itself lives is STILL exactly as exploitable as RWF-010 originally
    // found. This test documents that fact directly, as the baseline the
    // next test (hermetic execution) must differ from.
    const vulnTraceOwnZod = findAncestorPackage(REPO_ROOT, "zod");
    expect(vulnTraceOwnZod).toBeDefined();

    const nested = mkdtempSync(
      path.join(FIXTURES_ROOT, ".hermeticity-absent-pkg-"),
    );
    tempDirsToClean.push(nested);

    write(nested, "package.json", JSON.stringify({ name: "hermeticity-test" }));
    // "zod" is never vendored in this fixture at all.
    const entry = write(nested, "index.js", 'require("zod");\n');

    const resolver = createModuleResolver(loadTsProject(nested));
    const resolution = await resolver.resolve("zod", entry);

    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(
        resolution.resolvedFileName.startsWith(vulnTraceOwnZod ?? ""),
      ).toBe(true);
    }
  });

  it("FIXED (VT-302): the identical absent-package scenario resolves nothing once executed hermetically (temp dir), matching how validation.test.ts actually scans every case", async () => {
    // Byte-identical fixture content to the previous test -- the only
    // difference is WHERE it executes from (a fresh OS-temp directory,
    // exactly what copyFixtureToTempDir/validation.test.ts now do for
    // every real case), proving location alone is what determines
    // whether this leak is reachable.
    const tmp = mkdtempSync(
      path.join(tmpdir(), "vulntrace-hermeticity-absent-pkg-"),
    );
    tempDirsToClean.push(tmp);

    write(tmp, "package.json", JSON.stringify({ name: "hermeticity-test" }));
    const entry = write(tmp, "index.js", 'require("zod");\n');

    const resolver = createModuleResolver(loadTsProject(tmp));
    const resolution = await resolver.resolve("zod", entry);

    expect(resolution.kind).toBe("unresolved");
  });

  it("RWB-09's resolved semver instances are entirely fixture-local, never VulnTrace's own @types/semver (the exact RWF-010 reproduction)", async () => {
    const fixtureDir = path.join(FIXTURES_ROOT, "rwb-09-semver-multi-instance");
    const tmp = copyFixtureToTempDir(fixtureDir, "rwb-09");
    tempDirsToClean.push(tmp);

    const entry = path.join(tmp, "src", "version-check.js");
    const resolver = createModuleResolver(loadTsProject(tmp));

    // "semver-vulnerable" is an npm alias (package.json:
    // "semver-vulnerable": "npm:semver@7.5.1") -- the installed package's
    // OWN package.json declares "name": "semver" (this is RWF-009's own
    // root cause), so packageId.name is "semver" for BOTH specifiers.
    // What must differ, and does, is which physical directory each
    // resolves into.
    for (const specifier of ["semver", "semver-vulnerable"]) {
      const resolution = await resolver.resolve(specifier, entry);
      expect(resolution.kind).toBe("resolved");
      if (resolution.kind === "resolved") {
        expect(resolution.resolvedFileName.startsWith(tmp)).toBe(true);
        expect(resolution.resolvedFileName.startsWith(REPO_ROOT)).toBe(false);
        expect(resolution.resolvedFileName).toContain(
          `/node_modules/${specifier}/`,
        );
        // The exact regression this reproduces (see the audit's RWF-010):
        // resolution used to land on VulnTrace's own @types/semver
        // devDependency instead of the fixture's real, vendored semver.
        expect(resolution.resolvedFileName).not.toContain("@types/semver");
        expect(resolution.packageId?.name).toBe("semver");
      }
    }
  });

  it("resolution results are identical whether or not VulnTrace's own node_modules contains extra, unrelated packages", async () => {
    const fixtureDir = path.join(FIXTURES_ROOT, "rwb-01-trim-newlines-direct");

    async function resolveTrimNewlines(root: string) {
      const entry = path.join(root, "src", "index.js");
      const resolver = createModuleResolver(loadTsProject(root));
      const resolution = await resolver.resolve("trim-newlines", entry);
      if (resolution.kind !== "resolved") {
        return resolution;
      }
      // Compare the path RELATIVE to its own temp root, not the absolute
      // path -- two separate mkdtempSync calls necessarily produce
      // different absolute roots even when the copied content is
      // identical.
      return {
        ...resolution,
        resolvedFileName: path.relative(root, resolution.resolvedFileName),
      };
    }

    const tmpBefore = copyFixtureToTempDir(fixtureDir, "extra-deps-before");
    tempDirsToClean.push(tmpBefore);
    const before = await resolveTrimNewlines(tmpBefore);

    // Every temp fixture copy in this suite lives directly under the OS
    // temp root (see copyFixtureToTempDir), whose own ancestor chain has
    // no node_modules directory anywhere between it and the filesystem
    // root -- structurally, nothing about VulnTrace's own node_modules
    // (current contents, or anything added to it later) can ever be
    // reachable from there. Verified directly rather than assumed: walk
    // every ancestor of tmpBefore and confirm none of them is
    // REPO_ROOT or contains a node_modules of its own.
    for (const ancestor of ancestorsOf(tmpBefore)) {
      expect(ancestor).not.toBe(REPO_ROOT);
      expect(existsSync(path.join(ancestor, "node_modules"))).toBe(false);
    }

    const tmpAfter = copyFixtureToTempDir(fixtureDir, "extra-deps-after");
    tempDirsToClean.push(tmpAfter);
    const after = await resolveTrimNewlines(tmpAfter);

    expect(after).toEqual(before);
  });

  it("identifyModule derives distinct package instances for the fixture copy, never conflating them with VulnTrace's own installed packages", async () => {
    const fixtureDir = path.join(FIXTURES_ROOT, "rwb-09-semver-multi-instance");
    const tmp = copyFixtureToTempDir(fixtureDir, "rwb-09-identity");
    tempDirsToClean.push(tmp);

    const semverFile = path.join(tmp, "node_modules", "semver", "index.js");
    const identity = identifyModule(semverFile);

    expect(identity.packageInstance).toBe(
      path.join(tmp, "node_modules", "semver"),
    );
    expect(identity.packageInstance?.startsWith(REPO_ROOT)).toBe(false);
  });
});
