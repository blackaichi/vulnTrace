import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { buildModuleModel } from "../code-intelligence/module-model.js";
import { mapExportsToFunctions } from "../code-intelligence/module-model.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { indexSourceFileFromDisk } from "../code-intelligence/source-index.js";
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
 * RWF-013's permanent FALSE NOT_AFFECTED regression (see
 * fixtures/commonjs-stale-alias-export/README.md).
 *
 * The fixture's runtime truth is AFFECTED: `fixture-lib`'s `parse` export
 * IS `lib/parse.js`'s function -- index.js reassigns the binding to it
 * unconditionally, before exporting -- and the application calls that
 * exact function object through the package's second published name.
 *
 * Before RWF-013 this scan returned **NOT_AFFECTED**, carrying a complete
 * Family C `confirmedUnreachableTarget` proof. The proof was sound about
 * the node it was given; the node was wrong. The rule's target had been
 * bound, by name alone, to the safe fallback that index.js had already
 * assigned away from -- a function nothing calls, hence trivially
 * unreachable, hence a confident clean bill of health for a package whose
 * exported callable is the vulnerable one.
 *
 * Nothing about the negative-proof machinery is exercised or changed here.
 * The correction is entirely in export attribution, and this test pins the
 * outcome of that: the target must not resolve to the stale node, so no
 * reachability search runs against it at all.
 */

const FIXTURE = "commonjs-stale-alias-export";
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
    id: "GHSA-rwf-013",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-013",
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

describe("RWF-013 fixture: stale reassigned CommonJS alias (fixtures/commonjs-stale-alias-export)", () => {
  it("never returns NOT_AFFECTED for the stale-aliased export", async () => {
    // The single assertion this whole fixture exists for. A false
    // NOT_AFFECTED is a HIGH-SEVERITY soundness defect; UNKNOWN is the
    // honest answer for a binding the analyzer cannot resolve.
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

  it("does not attribute the export to the stale initializer -- the defect itself, asserted directly", async () => {
    const { root } = await scan({ target: "parse" });
    const index = indexSourceFileFromDisk(facadePath(root));

    // The stale node IS indexed, under exactly the export's own name --
    // which is what made it findable. Attribution must still refuse it.
    const stale = index.functions.find((fn) => fn.name === "parse");
    expect(stale).toBeDefined();

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

  it("keeps the stale node out of the evidence path entirely", async () => {
    const { finding, graph, root } = await scan({ target: "parse" });

    const staleNode = graph.nodes.find(
      (n) => n.name === "parse" && n.module === facadePath(root),
    );
    if (staleNode) {
      expect(finding?.evidence?.path ?? []).not.toContain(staleNode.id);
    }
  });

  it("still reaches the REAL implementation in the call graph -- the reason the old verdict was false", async () => {
    // lib/parse.js's anonymous function is genuinely called from the
    // entrypoint. The pre-RWF-013 NOT_AFFECTED was not a graph failure: the
    // graph was right, and target attribution pointed somewhere else.
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
    expect(canonicalizePackageInstancePath(facadePath(root))).toBeTruthy();
  });

  it("leaves the statically resolvable sibling export exactly as it was", async () => {
    // `parseSync` is a plain RWF-004a whole-module re-export. RWF-013 must
    // not change it in either direction -- it is not an identifier binding,
    // so there is nothing for the refusal to apply to.
    const { root } = await scan({ target: "parseSync" });
    const index = indexSourceFileFromDisk(facadePath(root));
    const parseSync = buildModuleModel(index).exports.find(
      (e) => e.exportedName === "parseSync",
    );

    expect(parseSync?.localIdentifierProvenanceRefused).toBeUndefined();
    expect(parseSync?.commonJsReExport).toEqual({ specifier: "./lib/parse" });
  });
});
