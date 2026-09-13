import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizePackageInstancePath } from "../domain/resolved-target.js";
import { discoverWorkspacePackages } from "./workspaces.js";

/**
 * P1-A4 REMEDIATION — AN INCOMPLETE ENUMERATION MUST NEVER LOOK COMPLETE.
 *
 * The independent audit found that a `packages/**` walk which hit its
 * depth cap returned the roots it happened to reach as though that were
 * the whole answer, and reported nothing. Packages silently lost their
 * identity, which (before the Site B gate) certified a false NOT_AFFECTED.
 *
 * The cap itself is correct and stays — discovery must be bounded. What
 * was wrong was inferring truncation AFTER the walk from state the walk
 * could never be left in (`queue.length > 0` following a loop that only
 * exits when the queue is empty). Truncation is a fact about the walk, so
 * the walk records it as it happens.
 *
 * Chosen semantics: a pattern that cannot be enumerated completely
 * contributes NO roots and is reported as unsupported. Discarding roots it
 * did find is deliberate — there is no way to tell a reader, or a later
 * negative proof, WHICH packages are missing, and a partial set presented
 * as complete is exactly the failure being fixed.
 */

function repo(): string {
  return mkdtempSync(path.join(tmpdir(), "vulntrace-p1a4-trunc-"));
}

function manifest(dir: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(value));
}

function roots(root: string): string[] {
  return discoverWorkspacePackages(root)
    .packages.map((p) =>
      path
        .relative(canonicalizePackageInstancePath(root), p.canonicalRoot)
        .split(path.sep)
        .join("/"),
    )
    .sort();
}

/** A chain of `depth` nested packages below `packages/`. */
function nestedChain(root: string, depth: number): void {
  let dir = path.join(root, "packages");
  for (let i = 0; i < depth; i++) {
    dir = path.join(dir, `d${i}`);
    manifest(dir, { name: `pkg${i}`, version: "1.0.0" });
  }
}

describe("P1-A4 remediation: descendant traversal completeness", () => {
  it("reports truncation instead of silently returning a partial set", () => {
    const root = repo();
    manifest(root, { name: "root", workspaces: ["packages/**"] });
    nestedChain(root, 14); // deeper than the depth cap

    const discovery = discoverWorkspacePackages(root);

    // The defect: 8 of 14 returned, `unsupported` empty.
    expect(discovery.packages).toEqual([]);
    expect(discovery.unsupported).toHaveLength(1);
    expect(discovery.unsupported[0]).toContain("could not be enumerated");
    expect(discovery.unsupported[0]).toContain("packages/**");
  });

  it("still enumerates a `**` tree that fits inside the bounds", () => {
    const root = repo();
    manifest(root, { name: "root", workspaces: ["packages/**"] });
    nestedChain(root, 3);

    expect(roots(root)).toEqual([
      "packages/d0",
      "packages/d0/d1",
      "packages/d0/d1/d2",
    ]);
    expect(discoverWorkspacePackages(root).unsupported).toEqual([]);
  });

  it("does not let one truncated pattern discard a sibling pattern's roots", () => {
    const root = repo();
    manifest(root, { name: "root", workspaces: ["deep/**", "packages/*"] });
    let dir = path.join(root, "deep");
    for (let i = 0; i < 14; i++) {
      dir = path.join(dir, `d${i}`);
      manifest(dir, { name: `deep${i}`, version: "1.0.0" });
    }
    manifest(path.join(root, "packages", "lib"), { name: "lib" });

    const discovery = discoverWorkspacePackages(root);
    expect(roots(root)).toEqual(["packages/lib"]);
    expect(discovery.unsupported).toHaveLength(1);
  });

  it("keeps discovery bounded -- it does not simply walk deeper now", () => {
    const root = repo();
    manifest(root, { name: "root", workspaces: ["packages/**"] });
    nestedChain(root, 40);

    // Bounded and explicit, not unbounded traversal.
    const started = Date.now();
    const discovery = discoverWorkspacePackages(root);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(discovery.packages).toEqual([]);
    expect(discovery.unsupported).toHaveLength(1);
  });
});

describe("P1-A4 remediation: declaration-order independence", () => {
  /** A wide tree that exhausts one pattern's directory budget on its own. */
  function wideRepo(order: readonly string[]): string {
    const root = repo();
    manifest(root, { name: "root", workspaces: order });
    for (let i = 0; i < 5000; i++) {
      manifest(path.join(root, "big", `b${i}`), { name: `b${i}` });
    }
    manifest(path.join(root, "small", "alpha"), { name: "alpha" });
    manifest(path.join(root, "small", "beta"), { name: "beta" });
    return root;
  }

  it("gives the same roots whichever order the patterns are declared in", () => {
    // The audit's finding: with ONE budget shared across patterns, a wide
    // pattern listed first starved the pattern after it, so
    // ["big/**","small/*"] found nothing while ["small/*","big/**"] found
    // two packages -- the same repository, the same declaration set, a
    // different answer. Declaration order must never decide identity.
    const first = roots(wideRepo(["big/**", "small/*"]));
    const second = roots(wideRepo(["small/*", "big/**"]));

    expect(first).toEqual(second);
    expect(first).toEqual(["small/alpha", "small/beta"]);
  });

  it("reports the same unsupported patterns in either order", () => {
    const a = discoverWorkspacePackages(wideRepo(["big/**", "small/*"]));
    const b = discoverWorkspacePackages(wideRepo(["small/*", "big/**"]));

    expect(a.unsupported).toHaveLength(1);
    expect(b.unsupported).toHaveLength(1);
    expect(a.unsupported[0]).toContain("big/**");
    expect(b.unsupported[0]).toContain("big/**");
  });

  it("is order-independent for ordinary patterns too", () => {
    const build = (order: readonly string[]): string => {
      const root = repo();
      manifest(root, { name: "root", workspaces: order });
      manifest(path.join(root, "packages", "lib"), { name: "lib" });
      manifest(path.join(root, "packages", "app"), { name: "app" });
      manifest(path.join(root, "tools", "t1"), { name: "t1" });
      return root;
    };
    const expected = ["packages/app", "packages/lib", "tools/t1"];
    expect(roots(build(["packages/*", "tools/*"]))).toEqual(expected);
    expect(roots(build(["tools/*", "packages/*"]))).toEqual(expected);
    expect(roots(build(["packages/lib", "tools/*", "packages/*"]))).toEqual(
      expected,
    );
  });
});
