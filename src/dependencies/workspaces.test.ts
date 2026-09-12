import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizePackageInstancePath } from "../domain/resolved-target.js";
import {
  discoverWorkspacePackages,
  interpretWorkspacePattern,
  readWorkspacePatterns,
} from "./workspaces.js";

/**
 * P1-A4 WORKSPACE DISCOVERY / PACKAGE-ROOT AUTHORITY.
 *
 * The question pinned here is narrow and prior to every other P1-A4
 * question: WHICH directories may become package roots, and on whose
 * authority. Entry resolution, forwarding and verdicts are all unchanged
 * P1-A1/A2/A3 machinery that runs afterwards -- it simply could not run at
 * all for a workspace package before, because such a package had no
 * identity (see the integration suite).
 *
 * Two failure directions matter equally:
 *
 * - admitting a directory the repository never declared (a false package
 *   root, which can then answer for an advisory), and
 * - silently dropping a declared one (its target disappears, and a
 *   negative verdict gets built on the absence).
 *
 * Discovery therefore fails CLOSED and VISIBLY: an uninterpretable
 * declaration discovers nothing and is reported.
 */

function scratchRepo(): string {
  return mkdtempSync(path.join(tmpdir(), "vulntrace-p1a4-"));
}

function writeManifest(dir: string, manifest: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
}

function rootsOf(repo: string): string[] {
  return discoverWorkspacePackages(repo).packages.map((workspacePackage) =>
    path
      .relative(
        canonicalizePackageInstancePath(repo),
        workspacePackage.canonicalRoot,
      )
      .split(path.sep)
      .join("/"),
  );
}

// ---------------------------------------------------------------------------
// Pattern interpretation.
// ---------------------------------------------------------------------------

describe("P1-A4: workspace pattern interpretation", () => {
  it("interprets the three supported shapes", () => {
    expect(interpretWorkspacePattern("packages/foo")).toEqual({
      kind: "literal",
      prefix: path.join("packages", "foo"),
    });
    expect(interpretWorkspacePattern("packages/*")).toEqual({
      kind: "children",
      prefix: "packages",
    });
    expect(interpretWorkspacePattern("packages/**")).toEqual({
      kind: "descendants",
      prefix: "packages",
    });
  });

  it.each([
    ["a negation", "!packages/private"],
    ["a mid-pattern wildcard", "packages/*/lib"],
    ["a partial wildcard", "packages/pkg-*"],
    ["a single-character wildcard", "packages/?"],
    ["brace expansion", "packages/{a,b}"],
    ["a character class", "packages/[ab]"],
    ["an extglob", "packages/+(a|b)"],
    ["a parent-directory escape", "../outside/*"],
    ["an absolute pattern", "/abs/packages/*"],
    ["an empty pattern", ""],
  ])("refuses %s rather than guessing at it", (_label, pattern) => {
    expect(interpretWorkspacePattern(pattern)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Declaration shapes.
// ---------------------------------------------------------------------------

describe("P1-A4: workspaces declaration shapes", () => {
  it("accepts the npm array form and the object form alike", () => {
    expect(readWorkspacePatterns(["packages/*"])).toEqual(["packages/*"]);
    expect(readWorkspacePatterns({ packages: ["packages/*"] })).toEqual([
      "packages/*",
    ]);
  });

  it("treats an absent declaration as no workspaces, not as unsupported", () => {
    expect(readWorkspacePatterns(undefined)).toEqual([]);
    expect(readWorkspacePatterns(null)).toEqual([]);
  });

  it.each([
    ["a bare string", "packages/*"],
    ["a number", 7],
    ["an object with no packages array", { nohoist: ["x"] }],
    ["an array of non-strings", [1, 2]],
  ])("refuses %s", (_label, value) => {
    expect(readWorkspacePatterns(value)).toBeUndefined();
  });

  it("reports an uninterpretable declaration instead of silently finding nothing", () => {
    const repo = scratchRepo();
    writeManifest(repo, { name: "root", workspaces: "packages/*" });
    writeManifest(path.join(repo, "packages", "a"), { name: "a" });

    const discovery = discoverWorkspacePackages(repo);
    expect(discovery.packages).toEqual([]);
    expect(discovery.unsupported).toHaveLength(1);
    expect(discovery.unsupported[0]).toContain("not a supported shape");
  });

  it("reports an unsupported PATTERN while still honoring its supported siblings", () => {
    const repo = scratchRepo();
    writeManifest(repo, {
      name: "root",
      workspaces: ["packages/*", "!packages/secret"],
    });
    writeManifest(path.join(repo, "packages", "a"), { name: "a" });

    const discovery = discoverWorkspacePackages(repo);
    expect(rootsOf(repo)).toEqual(["packages/a"]);
    expect(discovery.unsupported).toHaveLength(1);
    expect(discovery.unsupported[0]).toContain('"!packages/secret"');
  });
});

// ---------------------------------------------------------------------------
// What may become a package root.
// ---------------------------------------------------------------------------

describe("P1-A4: package-root authority", () => {
  it("discovers declared workspace packages", () => {
    const repo = scratchRepo();
    writeManifest(repo, { name: "root", workspaces: ["packages/*"] });
    writeManifest(path.join(repo, "packages", "app"), { name: "app" });
    writeManifest(path.join(repo, "packages", "lib"), { name: "lib" });

    expect(rootsOf(repo)).toEqual(["packages/app", "packages/lib"]);
  });

  it("requires a real package.json -- a matching directory alone is not a package", () => {
    const repo = scratchRepo();
    writeManifest(repo, { name: "root", workspaces: ["packages/*"] });
    writeManifest(path.join(repo, "packages", "real"), { name: "real" });
    // Matches the pattern, looks like a package, declares nothing.
    mkdirSync(path.join(repo, "packages", "notapackage", "src"), {
      recursive: true,
    });

    expect(rootsOf(repo)).toEqual(["packages/real"]);
  });

  it("never admits a directory no pattern declares", () => {
    const repo = scratchRepo();
    writeManifest(repo, { name: "root", workspaces: ["packages/*"] });
    writeManifest(path.join(repo, "packages", "declared"), { name: "d" });
    // A perfectly real package, simply not declared as a workspace.
    writeManifest(path.join(repo, "tools", "undeclared"), { name: "u" });

    expect(rootsOf(repo)).toEqual(["packages/declared"]);
  });

  it("never admits the monorepo ROOT as one of its own child packages", () => {
    const repo = scratchRepo();
    // A pattern that literally names the root directory.
    writeManifest(repo, { name: "root", workspaces: ["."] });

    expect(rootsOf(repo)).toEqual([]);
  });

  it("never admits an installed package under node_modules", () => {
    const repo = scratchRepo();
    writeManifest(repo, { name: "root", workspaces: ["packages/**"] });
    writeManifest(path.join(repo, "packages", "app"), { name: "app" });
    // An installed dependency nested inside a workspace member. It has its
    // own identity authority; workspace discovery must not claim it.
    writeManifest(path.join(repo, "packages", "app", "node_modules", "dep"), {
      name: "dep",
    });

    expect(rootsOf(repo)).toEqual(["packages/app"]);
  });

  it("keeps two same-name, same-version workspace packages DISTINCT", () => {
    const repo = scratchRepo();
    writeManifest(repo, { name: "root", workspaces: ["packages/*"] });
    writeManifest(path.join(repo, "packages", "a"), {
      name: "dup",
      version: "1.0.0",
    });
    writeManifest(path.join(repo, "packages", "b"), {
      name: "dup",
      version: "1.0.0",
    });

    const { packages } = discoverWorkspacePackages(repo);
    expect(packages).toHaveLength(2);
    expect(new Set(packages.map((p) => p.canonicalRoot)).size).toBe(2);
    expect(packages.every((p) => p.packageName === "dup")).toBe(true);
  });

  it("reads name and version as metadata, and tolerates their absence", () => {
    const repo = scratchRepo();
    writeManifest(repo, { name: "root", workspaces: ["packages/*"] });
    writeManifest(path.join(repo, "packages", "named"), {
      name: "named",
      version: "2.1.0",
    });
    // A private workspace package with no name and no version at all --
    // ordinary in real monorepos, and no reason to lose its identity.
    writeManifest(path.join(repo, "packages", "anon"), { private: true });

    const { packages } = discoverWorkspacePackages(repo);
    expect(packages).toHaveLength(2);
    const anon = packages.find((p) => p.canonicalRoot.endsWith("anon"));
    expect(anon?.packageName).toBeUndefined();
    expect(anon?.version).toBeUndefined();
    const named = packages.find((p) => p.canonicalRoot.endsWith("named"));
    expect(named?.packageName).toBe("named");
    expect(named?.version).toBe("2.1.0");
  });

  it("canonicalizes a SYMLINKED workspace member to its physical root", () => {
    const repo = scratchRepo();
    writeManifest(repo, { name: "root", workspaces: ["packages/*"] });
    writeManifest(path.join(repo, "physical", "lib"), { name: "lib" });
    mkdirSync(path.join(repo, "packages"), { recursive: true });
    symlinkSync(
      path.join(repo, "physical", "lib"),
      path.join(repo, "packages", "lib"),
      "dir",
    );

    const { packages } = discoverWorkspacePackages(repo);
    expect(packages).toHaveLength(1);
    expect(packages[0]?.canonicalRoot).toBe(
      canonicalizePackageInstancePath(path.join(repo, "physical", "lib")),
    );
  });

  it("is order-independent: results are sorted by canonical root", () => {
    const repo = scratchRepo();
    writeManifest(repo, {
      name: "root",
      // Declaration order deliberately reversed relative to sort order.
      workspaces: ["packages/z", "packages/a", "packages/*"],
    });
    writeManifest(path.join(repo, "packages", "z"), { name: "z" });
    writeManifest(path.join(repo, "packages", "a"), { name: "a" });
    writeManifest(path.join(repo, "packages", "m"), { name: "m" });

    expect(rootsOf(repo)).toEqual(["packages/a", "packages/m", "packages/z"]);
  });

  it("terminates on a symlink CYCLE rather than walking forever", () => {
    const repo = scratchRepo();
    writeManifest(repo, { name: "root", workspaces: ["packages/**"] });
    writeManifest(path.join(repo, "packages", "app"), { name: "app" });
    // packages/app/loop -> packages, a cycle a naive recursive walk would
    // follow indefinitely.
    symlinkSync(
      path.join(repo, "packages"),
      path.join(repo, "packages", "app", "loop"),
      "dir",
    );

    const discovery = discoverWorkspacePackages(repo);
    // Either it bottoms out at the depth cap (fail closed) or it enumerates
    // the finite set -- what must NOT happen is a hang or a stack overflow.
    expect(Array.isArray(discovery.packages)).toBe(true);
    expect(
      discovery.packages.length > 0 || discovery.unsupported.length > 0,
    ).toBe(true);
  });

  it("returns nothing for a repository with no manifest at all", () => {
    expect(discoverWorkspacePackages(scratchRepo())).toEqual({
      packages: [],
      unsupported: [],
    });
  });
});
