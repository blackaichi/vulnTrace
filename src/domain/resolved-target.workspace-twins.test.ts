import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverWorkspacePackages } from "../dependencies/workspaces.js";
import { fixturePath } from "../testing/fixtures.js";
import {
  buildKnownPackageRoots,
  canonicalizePackageInstancePath,
  identifyModule,
} from "./resolved-target.js";

/**
 * P1-A4 PACKAGEINSTANCE TWIN MATRIX.
 *
 * One rule, stated five ways: **the canonical root is the identity.**
 *
 * Two packages are the same package when, and only when, they are the same
 * physical directory. Not when their manifests agree on `name`. Not when
 * they agree on `version`. Not when both. And conversely, two references
 * that reach one physical directory by different spellings -- a
 * `node_modules` symlink and the workspace path it points at -- are ONE
 * package, because that is what Node itself does: it loads and caches by
 * realpath, so both spellings really are the same loaded code.
 *
 * Every row below is a pair that a name-based or version-based identity
 * would get wrong in one direction or the other. The fixture's own runtime
 * oracle (`fixtures/workspaces/verify.cjs`) independently confirms, under
 * real `node`, both that the twins are physically distinct and that the
 * symlink pair really is one module.
 */

const FIXTURE = "workspaces";

function workspaceRoots() {
  const root = fixturePath(FIXTURE);
  const discovery = discoverWorkspacePackages(root);
  return {
    root,
    knownPackageRoots: buildKnownPackageRoots(
      [],
      root,
      discovery.packages.map((workspacePackage) => ({
        canonicalRoot: workspacePackage.canonicalRoot,
        packageName:
          workspacePackage.packageName ??
          path.basename(workspacePackage.canonicalRoot),
      })),
    ),
  };
}

/** The instance a file in the fixture is attributed to. */
function instanceOf(...segments: string[]): string | undefined {
  const { root, knownPackageRoots } = workspaceRoots();
  return identifyModule(path.join(root, ...segments), knownPackageRoots)
    .packageInstance;
}

function expectedRoot(...segments: string[]): string {
  return canonicalizePackageInstancePath(
    path.join(fixturePath(FIXTURE), ...segments),
  );
}

describe("P1-A4 PackageInstance twin matrix", () => {
  it("1. workspace copy vs installed copy — same name AND version, DISTINCT", () => {
    const workspace = instanceOf("packages", "twinlib", "index.js");
    const installed = instanceOf("node_modules", "twinlib", "index.js");

    expect(workspace).toBe(expectedRoot("packages", "twinlib"));
    expect(installed).toBe(expectedRoot("node_modules", "twinlib"));
    expect(workspace).not.toBe(installed);
  });

  it("2. two workspace packages with the same name and version — DISTINCT", () => {
    const a = instanceOf("packages", "dupa", "index.js");
    const b = instanceOf("packages", "dupb", "index.js");

    expect(a).toBe(expectedRoot("packages", "dupa"));
    expect(b).toBe(expectedRoot("packages", "dupb"));
    expect(a).not.toBe(b);
  });

  it("3. nested install vs root-level install — DISTINCT", () => {
    const nested = instanceOf(
      "packages",
      "app",
      "node_modules",
      "nestedlib",
      "index.js",
    );
    const rootLevel = instanceOf("node_modules", "nestedlib", "index.js");

    expect(nested).toBe(
      expectedRoot("packages", "app", "node_modules", "nestedlib"),
    );
    expect(rootLevel).toBe(expectedRoot("node_modules", "nestedlib"));
    expect(nested).not.toBe(rootLevel);
  });

  it("4. scoped workspace twins — same scoped name and version, DISTINCT", () => {
    const linked = instanceOf("packages", "scopedlib", "dist", "index.js");
    const twin = instanceOf("packages", "scopedtwin", "index.js");

    expect(linked).toBe(expectedRoot("packages", "scopedlib"));
    expect(twin).toBe(expectedRoot("packages", "scopedtwin"));
    expect(linked).not.toBe(twin);
  });

  it("5. symlink spelling vs canonical workspace path — CONVERGE to one", () => {
    // The opposite failure. `node_modules/lib` is a link to `packages/lib`;
    // treating them as two instances would split one package's evidence in
    // half and could report a confident negative about the half that was
    // not traversed.
    const throughLink = instanceOf("node_modules", "lib", "index.js");
    const throughPhysical = instanceOf("packages", "lib", "index.js");

    expect(throughLink).toBe(throughPhysical);
    expect(throughPhysical).toBe(expectedRoot("packages", "lib"));
  });

  it("5b. the scoped symlink spelling converges too", () => {
    expect(instanceOf("node_modules", "@scope", "lib", "dist", "api.js")).toBe(
      expectedRoot("packages", "scopedlib"),
    );
  });

  it("names every twin from its OWN manifest, never from its directory", () => {
    const { root, knownPackageRoots } = workspaceRoots();
    // The directory is `scopedlib`; the package is `@scope/lib`. Identity
    // and name are independent, and neither is derived from the other.
    expect(
      identifyModule(
        path.join(root, "packages", "scopedlib", "dist", "index.js"),
        knownPackageRoots,
      ).packageName,
    ).toBe("@scope/lib");
    expect(
      identifyModule(
        path.join(root, "packages", "dupa", "index.js"),
        knownPackageRoots,
      ).packageName,
    ).toBe("dup");
  });

  it("attributes a file to the MOST SPECIFIC enclosing root", () => {
    // packages/app is itself a workspace package AND contains a nested
    // install. A file under the nested install must never be attributed to
    // the enclosing workspace member.
    expect(
      instanceOf("packages", "app", "node_modules", "nestedlib", "index.js"),
    ).not.toBe(expectedRoot("packages", "app"));
    expect(instanceOf("packages", "app", "src", "lib-consumer.cjs")).toBe(
      expectedRoot("packages", "app"),
    );
  });
});
