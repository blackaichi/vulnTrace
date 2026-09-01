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
 * RWF-003's permanent real-world-shaped fixture assertion (see
 * fixtures/commonjs-anonymous-export/README.md).
 *
 * This exercises the verdict layer's own target-resolution path
 * (`findExportNodeInFile`), which re-derives the canonical-export ->
 * function attribution independently of the call graph's `prepareFile`.
 * Both go through `mapExportsToFunctions`, and before RWF-003 both fell
 * through to a phantom node for an anonymous `module.exports` value.
 */

const FIXTURE = "commonjs-anonymous-export";
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
    id: "GHSA-rwf-003",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-003",
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

describe("RWF-003 fixture: anonymous module.exports function (fixtures/commonjs-anonymous-export)", () => {
  it("reaches the anonymous exported function through the same-package chain -> AFFECTED", async () => {
    const { finding } = await scan({ target: "default" });

    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("attributes the target to the real implementation file, not the facade or the middle hop", async () => {
    const { finding } = await scan({ target: "default" });

    const last = finding?.evidence?.path.at(-1) ?? "";
    expect(last).toContain(path.join("node_modules", "fixture-lib", "lib.js"));
    expect(last).not.toContain(
      path.join("node_modules", "fixture-lib", "index.js"),
    );
    expect(last).not.toContain("middle.js");
  });

  it("never attributes the target to the same-named decoy in the implementation file", async () => {
    // lib.js declares `function vulnerable(input)` that nothing exports,
    // ahead of the real anonymous export. A rule naming it must find no
    // target at all rather than binding to a function the module does not
    // export (VT-301B/RWF-011: coincidence is not provenance).
    const { finding, graph } = await scan({ target: "vulnerable" });

    expect(finding?.verdict).toBe("UNKNOWN");

    const decoy = graph.nodes.find(
      (n) => n.name === "vulnerable" && n.module.endsWith("lib.js"),
    );
    expect(decoy).toBeDefined();
    expect(finding?.evidence?.path ?? []).not.toContain(decoy?.id);
  });

  it("binds the call edge to the ANONYMOUS function node, never to the decoy", async () => {
    const { graph } = await scan({ target: "default" });

    const anonymous = graph.nodes.find(
      (n) =>
        n.kind === "function" &&
        n.name === undefined &&
        n.module.endsWith("lib.js"),
    );
    expect(anonymous).toBeDefined();

    const decoy = graph.nodes.find(
      (n) => n.name === "vulnerable" && n.module.endsWith("lib.js"),
    );
    expect(decoy).toBeDefined();
    expect(
      graph.edges.some(
        (e) =>
          e.resolution.kind === "resolved" && e.resolution.target === decoy?.id,
      ),
    ).toBe(false);

    expect(
      graph.edges.some(
        (e) =>
          e.resolution.kind === "resolved" &&
          e.resolution.target === anonymous?.id,
      ),
    ).toBe(true);
  });

  it("binds to a node owned by the exact canonical PackageInstance", async () => {
    const { graph, root } = await scan({ target: "default" });
    const instance = fixtureLibInstance(root);

    const target = graph.nodes.find(
      (n) =>
        n.kind === "function" &&
        n.name === undefined &&
        n.module.endsWith("lib.js"),
    );
    expect(canonicalizePackageInstancePath(target?.module ?? "")).toContain(
      instance,
    );
  });

  it("stays AFFECTED when the finding's own packageInstance is supplied explicitly", async () => {
    const { root } = await scan({ target: "default" });
    const { finding } = await scan({
      target: "default",
      packageInstance: fixtureLibInstance(root),
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("never reports AFFECTED for a DIFFERENT installed instance of the same package name", async () => {
    const { root } = await scan({ target: "default" });
    const { finding } = await scan({
      target: "default",
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

  it("leaves the cross-package anonymous re-export unattributed -- RWF-004b is NOT implemented", async () => {
    // `fromOtherPackage` is other-lib's own anonymous module.exports
    // function. Making anonymous exports resolvable must not, as a side
    // effect, make them resolvable across a package boundary.
    const { finding } = await scan({ target: "fromOtherPackage" });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("never binds a fixture-lib target to other-lib's anonymous export", async () => {
    const { graph } = await scan({ target: "default" });

    const otherLibFn = graph.nodes.find(
      (n) => n.module.includes("other-lib") && n.kind === "function",
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
