import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discoverWorkspacePackages } from "./workspaces.js";

/**
 * FOUNDATION F1-A -- WORKSPACE DISCOVERY INCOMPLETENESS, at the discovery
 * layer.
 *
 * Everything this module already refuses to interpret must come back as a
 * REASON, deduplicated and order-independent, because the CLI turns each
 * one into a machine-readable diagnostic. A reason that depends on
 * declaration order, or that arrives twice for one condition, is not a
 * usable diagnostic -- two scans of the same repository would disagree
 * about what is wrong with it.
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "vulntrace-f1a-"));
  dirs.push(root);
  return root;
}

function write(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function manifest(root: string, relativeDir: string, value: unknown): void {
  write(root, path.join(relativeDir, "package.json"), JSON.stringify(value));
}

describe("F1-A: pnpm-workspace.yaml-only layouts are explicit, not empty", () => {
  it("reports an unsupported layout rather than silently discovering nothing", () => {
    const root = repo();
    manifest(root, ".", { name: "root", version: "1.0.0" });
    write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    manifest(root, "packages/lib", { name: "lib", version: "1.0.0" });

    const discovery = discoverWorkspacePackages(root);

    expect(discovery.unsupported).toHaveLength(1);
    expect(discovery.unsupported[0]).toContain("pnpm-workspace.yaml");
    expect(discovery.unsupported[0]).toContain("incomplete");
    // Reported, NOT guessed at: no YAML is parsed and no package instance
    // is invented from the file's presence.
    expect(discovery.packages).toEqual([]);
  });

  it("says nothing when package.json also declares workspaces (control)", () => {
    const root = repo();
    manifest(root, ".", {
      name: "root",
      version: "1.0.0",
      workspaces: ["packages/*"],
    });
    write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    manifest(root, "packages/lib", { name: "lib", version: "1.0.0" });

    const discovery = discoverWorkspacePackages(root);

    expect(discovery.unsupported).toEqual([]);
    expect(discovery.packages).toHaveLength(1);
  });

  it("says nothing for an ordinary single-package project (control)", () => {
    const root = repo();
    manifest(root, ".", { name: "root", version: "1.0.0" });

    expect(discoverWorkspacePackages(root)).toEqual({
      packages: [],
      unsupported: [],
    });
  });

  it("reports the pnpm layout even when the declaration is an empty array", () => {
    const root = repo();
    manifest(root, ".", { name: "root", version: "1.0.0", workspaces: [] });
    write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');

    expect(discoverWorkspacePackages(root).unsupported).toHaveLength(1);
  });

  it("does not treat a pnpm-workspace.yml misspelling as a pnpm layout", () => {
    // pnpm itself reads only `pnpm-workspace.yaml`; reporting `.yml` would
    // blame a file pnpm ignores for a layout it does not drive.
    const root = repo();
    manifest(root, ".", { name: "root", version: "1.0.0" });
    write(root, "pnpm-workspace.yml", 'packages:\n  - "packages/*"\n');

    expect(discoverWorkspacePackages(root).unsupported).toEqual([]);
  });
});

describe("F1-A: reasons are deduplicated and order-independent", () => {
  it("reports one reason for a pattern the manifest lists twice", () => {
    const root = repo();
    manifest(root, ".", {
      name: "root",
      version: "1.0.0",
      workspaces: ["packages/!secret", "packages/!secret"],
    });

    expect(discoverWorkspacePackages(root).unsupported).toHaveLength(1);
  });

  it("returns the same reason SET whichever order the patterns are declared in", () => {
    const build = (patterns: readonly string[]): string => {
      const root = repo();
      manifest(root, ".", {
        name: "root",
        version: "1.0.0",
        workspaces: patterns,
      });
      manifest(root, "packages/lib", { name: "lib", version: "1.0.0" });
      return root;
    };

    const forward = discoverWorkspacePackages(
      build(["packages/*", "pkg-*", "packages/!secret"]),
    );
    const backward = discoverWorkspacePackages(
      build(["packages/!secret", "pkg-*", "packages/*"]),
    );

    expect(forward.unsupported).toHaveLength(2);
    // Not merely "the same members" -- the same ARRAY, in the same order.
    expect(forward.unsupported).toEqual(backward.unsupported);
    expect(forward.packages.map((p) => p.packageName)).toEqual(
      backward.packages.map((p) => p.packageName),
    );
  });

  it("states that truncation may have hidden package instances", () => {
    const root = repo();
    manifest(root, ".", {
      name: "root",
      version: "1.0.0",
      workspaces: ["packages/**"],
    });
    let dir = "packages";
    for (let i = 0; i < 14; i++) {
      dir = path.join(dir, `d${i}`);
      manifest(root, dir, { name: `pkg${i}`, version: "1.0.0" });
    }

    const discovery = discoverWorkspacePackages(root);

    expect(discovery.unsupported).toHaveLength(1);
    expect(discovery.unsupported[0]).toContain("could not be enumerated");
    expect(discovery.unsupported[0]).toContain("may not have been analyzed");
  });
});

describe("F1-A: an empty version string is not a version claim", () => {
  it("carries no version for a workspace manifest declaring the empty string", () => {
    const root = repo();
    manifest(root, ".", {
      name: "root",
      version: "1.0.0",
      workspaces: ["packages/*"],
    });
    manifest(root, "packages/lib", { name: "lib", version: "" });

    const [discovered] = discoverWorkspacePackages(root).packages;

    expect(discovered?.packageName).toBe("lib");
    expect(discovered?.version).toBeUndefined();
  });
});
