import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import {
  buildKnownPackageRoots,
  canonicalizePackageInstancePath,
} from "../domain/resolved-target.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { fixturePath } from "../testing/fixtures.js";
import { discoverEntrypoints } from "./entrypoints.js";
import { buildFindingForTest } from "../testing/finding.js";

/**
 * RWF-004a's permanent real-world-shaped fixture assertion (see
 * fixtures/commonjs-reexport-same-package/README.md).
 *
 * Kept deliberately separate from any RWF-004b (cross-package re-export)
 * coverage: the fixture contains a cross-package re-export precisely so
 * this suite can assert it stays UNRESOLVED, and the two gaps must never
 * be confounded in one assertion.
 */

const FIXTURE = "commonjs-reexport-same-package";
const ENTRYPOINT = "src/index.cjs";

async function scan(options: {
  readonly target: string;
  readonly packageInstance?: string;
}) {
  const root = fixturePath(FIXTURE);
  const entry = path.join(root, ...ENTRYPOINT.split("/"));
  const resolver = createModuleResolver(loadTsProject(root));
  const knownPackageRoots = buildKnownPackageRoots([], root);

  const [graph, entrypointsResult] = await Promise.all([
    buildCallGraph({ entryFiles: [entry], resolver, knownPackageRoots }),
    discoverEntrypoints({
      projectRoot: root,
      resolver,
      configuredEntrypoints: [ENTRYPOINT],
    }),
  ]);

  const vulnerability: Vulnerability = {
    id: "GHSA-rwf-004a",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-004a",
    package: { name: "fixture-lib" },
    targets: [
      { module: "fixture-lib", export: options.target, kind: "function" },
    ],
  };

  const finding = await buildFindingForTest({
    vulnerability,
    packageName: "fixture-lib",
    packageVersion: "1.0.0",
    packageInstance: options.packageInstance,
    matchResult: "affected",
    rule,
    graph,
    entrypoints: entrypointsResult.entrypoints,
    resolver,
    projectRoot: root,
    knownPackageRoots,
  });

  return { finding, graph, root };
}

function fixtureLibInstance(root: string): string {
  return canonicalizePackageInstancePath(
    path.join(root, "node_modules", "fixture-lib"),
  );
}

describe("RWF-004a fixture: same-package CommonJS re-export (fixtures/commonjs-reexport-same-package)", () => {
  it("reaches the vulnerable target through the multi-hop same-package chain -> AFFECTED", async () => {
    const { finding } = await scan({ target: "vulnerable" });

    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("attributes the target to the REAL implementation file, never the facade or the middle hop", async () => {
    const { finding } = await scan({ target: "vulnerable" });

    const last = finding?.evidence?.path.at(-1) ?? "";
    expect(last).toContain(path.join("node_modules", "fixture-lib", "lib.js"));
    expect(last).not.toContain(
      path.join("node_modules", "fixture-lib", "index.js"),
    );
    expect(last).not.toContain("middle.js");
  });

  it("binds to a node owned by the exact canonical PackageInstance", async () => {
    const { graph, root } = await scan({ target: "vulnerable" });
    const instance = fixtureLibInstance(root);

    const target = graph.nodes.find(
      (n) => n.name === "vulnerable" && n.module.endsWith("lib.js"),
    );
    expect(target).toBeDefined();
    expect(canonicalizePackageInstancePath(target?.module ?? "")).toContain(
      instance,
    );
  });

  it("stays AFFECTED when the finding's own packageInstance is supplied explicitly", async () => {
    const { root } = await scan({ target: "vulnerable" });
    const { finding } = await scan({
      target: "vulnerable",
      packageInstance: fixtureLibInstance(root),
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("never reports AFFECTED for a DIFFERENT installed instance of the same package name", async () => {
    const { root } = await scan({ target: "vulnerable" });
    const { finding } = await scan({
      target: "vulnerable",
      packageInstance: path.join(
        root,
        "node_modules",
        "somewhere-else",
        "node_modules",
        "fixture-lib",
      ),
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
  });

  it("does not report AFFECTED for an export the application never calls", async () => {
    // `safe` is re-exported through the same relation but never called.
    // Whatever the conservative outcome is, it must not be AFFECTED.
    const { finding } = await scan({ target: "safe" });

    expect(finding?.verdict).not.toBe("AFFECTED");
  });

  it("leaves the cross-package re-export unattributed -- RWF-004b is NOT implemented here", async () => {
    // `fromOtherPackage` re-exports other-lib's identically-named
    // `vulnerable`. Binding it would silently make this task implement the
    // cross-package case; it must stay UNKNOWN instead.
    const { finding } = await scan({ target: "fromOtherPackage" });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("never binds a fixture-lib target to the identically-named function in other-lib", async () => {
    const { graph } = await scan({ target: "vulnerable" });

    const otherLibFn = graph.nodes.find(
      (n) => n.name === "vulnerable" && n.module.includes("other-lib"),
    );
    if (otherLibFn) {
      expect(
        graph.edges.some(
          (e) =>
            e.resolution.kind === "resolved" &&
            e.resolution.target === otherLibFn.id,
        ),
      ).toBe(false);
    }
  });
});
