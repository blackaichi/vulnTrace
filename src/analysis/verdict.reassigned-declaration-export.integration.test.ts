import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import {
  buildModuleModel,
  mapExportsToFunctions,
} from "../code-intelligence/module-model.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { indexSourceFileFromDisk } from "../code-intelligence/source-index.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import { buildKnownPackageRoots } from "../domain/resolved-target.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { fixturePath } from "../testing/fixtures.js";
import { discoverEntrypoints } from "./entrypoints.js";
import { buildFindingForTest } from "../testing/finding.js";

/**
 * RWF-013b's permanent FALSE NOT_AFFECTED regression (see
 * fixtures/commonjs-reassigned-declaration-export/README.md).
 *
 * The sibling of verdict.stale-alias-export.integration.test.ts. That one
 * pins the reassigned VARIABLE binding; this one pins the reassigned
 * FUNCTION DECLARATION, which RWF-013 left open and which reproduced the
 * same false NOT_AFFECTED — carrying a complete Family C
 * `confirmedUnreachableTarget` proof — on the tree that already contained
 * RWF-013.
 *
 * Nothing in the negative-proof machinery is exercised or changed here.
 * Family C was never wrong; it was handed a stale target. The correction
 * is entirely in export attribution, and this test pins its outcome.
 */

const FIXTURE = "commonjs-reassigned-declaration-export";
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
    id: "GHSA-rwf-013b",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-013b",
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

function facadePath(root: string): string {
  return path.join(root, "node_modules", "fixture-lib", "index.js");
}

describe("RWF-013b fixture: reassigned function declaration (fixtures/commonjs-reassigned-declaration-export)", () => {
  it("never returns NOT_AFFECTED for the reassigned-declaration export", async () => {
    // The single assertion this fixture exists for. A false NOT_AFFECTED
    // is a HIGH-SEVERITY soundness defect; UNKNOWN is the honest answer
    // for a binding the analyzer cannot resolve.
    const { finding } = await scan({ target: "parse" });

    expect(finding?.verdict).not.toBe("NOT_AFFECTED");
    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("carries no unreachability proof at all, rather than one over the wrong node", async () => {
    const { finding } = await scan({ target: "parse" });

    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
    expect(finding?.evidence?.reasons ?? []).not.toContain(
      "vulnerable symbol confirmed unreachable from all analyzed entrypoints",
    );
  });

  it("does not attribute the export to the stale function declaration", async () => {
    const { root } = await scan({ target: "parse" });
    const index = indexSourceFileFromDisk(facadePath(root));

    // The stale declaration is indexed under exactly the export's own
    // name -- it is literally `function parse()`, so no name inference is
    // even involved. Attribution must still refuse it.
    const stale = index.functions.find((fn) => fn.name === "parse");
    expect(stale).toBeDefined();
    expect(stale?.kind).toBe("function");

    expect(
      mapExportsToFunctions(index, buildModuleModel(index)).get("parse"),
    ).toBeUndefined();
  });

  it("records the refusal as an examined-and-rejected identifier, not as silence", async () => {
    const { root } = await scan({ target: "parse" });
    const index = indexSourceFileFromDisk(facadePath(root));
    const parse = buildModuleModel(index).exports.find(
      (e) => e.exportedName === "parse",
    );

    expect(parse?.localIdentifierProvenanceRefused).toBe(true);
  });

  it("keeps the stale declaration out of the evidence path entirely", async () => {
    const { finding, graph, root } = await scan({ target: "parse" });

    const staleNode = graph.nodes.find(
      (n) => n.name === "parse" && n.module === facadePath(root),
    );
    if (staleNode) {
      expect(finding?.evidence?.path ?? []).not.toContain(staleNode.id);
    }
  });

  it("still reaches the REAL implementation in the call graph", async () => {
    // The pre-fix NOT_AFFECTED was not a graph failure: the graph was
    // right, and target attribution pointed somewhere else.
    const { graph } = await scan({ target: "parse" });

    const real = graph.nodes.find(
      (n) =>
        n.kind === "function" &&
        n.name === undefined &&
        n.module.endsWith(path.join("lib", "parse.js")),
    );
    expect(real).toBeDefined();
    expect(
      graph.edges.some(
        (e) =>
          e.resolution.kind === "resolved" && e.resolution.target === real?.id,
      ),
    ).toBe(true);
  });

  it("never reports AFFECTED for a DIFFERENT installed instance of the same package name", async () => {
    const { root } = await scan({ target: "parse" });
    const { finding } = await scan({
      target: "parse",
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

  it("leaves the statically resolvable sibling export exactly as it was", async () => {
    const { root } = await scan({ target: "parseSync" });
    const index = indexSourceFileFromDisk(facadePath(root));
    const parseSync = buildModuleModel(index).exports.find(
      (e) => e.exportedName === "parseSync",
    );

    expect(parseSync?.localIdentifierProvenanceRefused).toBeUndefined();
    expect(parseSync?.commonJsReExport).toEqual({ specifier: "./lib/parse" });
  });
});
