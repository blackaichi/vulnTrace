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
 * RWF-011's permanent FALSE NOT_AFFECTED regression (see
 * fixtures/commonjs-coincidental-export-name/README.md).
 *
 * The fixture's runtime truth is AFFECTED: `fixture-lib`'s `parse` export
 * IS `lib/parse.js`'s function -- `exports.parse = registry.impl`, and
 * `registry.impl` is `require("./lib/parse")` -- and the application calls
 * that exact function object through the package's second published name.
 *
 * Before RWF-011 this scan returned **NOT_AFFECTED**, carrying a complete
 * Family C `confirmedUnreachableTarget` proof. The proof was sound about
 * the node it was given; the node was wrong. The rule's target had been
 * bound to an unrelated same-file `function parse()` for one reason only:
 * `mapExportsToFunctions`'s lookup key fell back from the (absent)
 * `localName` to the export's own PUBLIC NAME, and a function in the file
 * happened to spell it the same way.
 *
 * Distinct from the RWF-013/RWF-013b fixtures next door: nothing here is
 * reassigned, so `localIdentifierProvenanceRefused` never fires. This
 * export has no provenance of any kind, and the defect was treating its
 * public name as if that were provenance.
 *
 * Nothing about the negative-proof machinery is exercised or changed here.
 * The correction is entirely in export attribution, and this test pins the
 * outcome of that: the target must not resolve to the decoy, so no
 * reachability search runs against it at all.
 */

const FIXTURE = "commonjs-coincidental-export-name";
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
    id: "GHSA-rwf-011",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-011",
    package: { name: "fixture-lib" },
    targets: [
      { module: "fixture-lib", export: options.target, kind: "function" },
    ],
  };

  const finding = await buildFindingForTest({
    vulnerability,
    packageName: "fixture-lib",
    packageVersion: "1.0.0",
    // Pinned to the TOP-LEVEL install by default. The fixture deliberately
    // installs fixture-lib twice at the same version (see its README's
    // negative control 4), and only this instance carries the
    // coincidental-name shape -- so a finding about it has to name it.
    packageInstance:
      options.packageInstance ?? path.join(root, "node_modules", "fixture-lib"),
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

describe("RWF-011 fixture: coincidental same-name CommonJS export (fixtures/commonjs-coincidental-export-name)", () => {
  it("never returns NOT_AFFECTED for the coincidentally-named export", async () => {
    // The single assertion this whole fixture exists for. A false
    // NOT_AFFECTED is a HIGH-SEVERITY soundness defect; UNKNOWN is the
    // honest answer for an export whose value nothing here can resolve.
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

  it("does not attribute the export to the same-name decoy -- the defect itself, asserted directly", async () => {
    const { root } = await scan({ target: "parse" });
    const index = indexSourceFileFromDisk(facadePath(root));

    // The decoy IS indexed, under exactly the export's own name -- which is
    // what made it findable. Attribution must still refuse it.
    const decoy = index.functions.find((fn) => fn.name === "parse");
    expect(decoy).toBeDefined();

    expect(
      mapExportsToFunctions(index, buildModuleModel(index)).get("parse"),
    ).toBeUndefined();
  });

  it("is refused for want of provenance, NOT by RWF-013's reassignment refusal", async () => {
    // What makes this fixture a distinct case rather than a duplicate of
    // fixtures/commonjs-stale-alias-export/: `registry` is a `const` this
    // file never writes to, so the reassignment relation has nothing to
    // say. The export is unattributable because its right-hand side
    // establishes nothing, full stop.
    const { root } = await scan({ target: "parse" });
    const index = indexSourceFileFromDisk(facadePath(root));
    const parse = buildModuleModel(index).exports.find(
      (e) => e.exportedName === "parse",
    );

    expect(parse).toBeDefined();
    expect(parse?.localIdentifierProvenanceRefused).toBeUndefined();
    expect(parse?.localName).toBeUndefined();
    expect(parse?.localFunctionLocation).toBeUndefined();
    expect(parse?.commonJsReExport).toBeUndefined();
  });

  it("keeps the decoy's source location out of the evidence path entirely", async () => {
    const { finding, graph, root } = await scan({ target: "parse" });

    const decoyNode = graph.nodes.find(
      (n) => n.name === "parse" && n.module === facadePath(root),
    );
    if (decoyNode) {
      expect(finding?.evidence?.path ?? []).not.toContain(decoyNode.id);
    }
  });

  it("still reaches the REAL implementation in the call graph -- the reason the old verdict was false", async () => {
    // lib/parse.js's anonymous function is genuinely called from the
    // entrypoint. The pre-RWF-011 NOT_AFFECTED was not a graph failure: the
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

  it("does not borrow the DUPLICATE instance's attributable, reachable `parse`", async () => {
    // The fixture installs fixture-lib twice at the same version. The
    // nested copy's `parse` has real provenance and IS called from the
    // entrypoint; the top-level copy's `parse` has none. Attribution is
    // per-SourceIndex, so the top-level export must stay unresolved rather
    // than pick up a same-named candidate from the other install.
    const { root } = await scan({ target: "parse" });
    const nested = path.join(
      root,
      "node_modules",
      "nested-consumer",
      "node_modules",
      "fixture-lib",
      "index.js",
    );

    // The nested instance really does attribute its own `parse`, so this
    // test cannot pass merely because nothing anywhere resolved.
    const nestedIndex = indexSourceFileFromDisk(nested);
    expect(
      mapExportsToFunctions(nestedIndex, buildModuleModel(nestedIndex)).get(
        "parse",
      ),
    ).toBeDefined();

    const { finding } = await scan({
      target: "parse",
      packageInstance: path.join(root, "node_modules", "fixture-lib"),
    });
    expect(finding?.verdict).toBe("UNKNOWN");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });

  it("still reports the DUPLICATE instance AFFECTED on its own merits", async () => {
    // The other half of the cross-instance control, and the reason the
    // test above is not passing for a trivial reason: the nested install's
    // `parse` has real provenance and is genuinely called, so a finding
    // pinned to THAT instance must resolve and reach it. The restriction
    // is specific to exports without provenance, not a blanket refusal.
    const { root } = await scan({ target: "parse" });
    const { finding } = await scan({
      target: "parse",
      packageInstance: path.join(
        root,
        "node_modules",
        "nested-consumer",
        "node_modules",
        "fixture-lib",
      ),
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("leaves the statically resolvable sibling export exactly as it was", async () => {
    // `parseSync` is a plain RWF-004a whole-module re-export. RWF-011 must
    // not change it in either direction -- its provenance comes from the
    // `require()` on its own right-hand side, which is exactly the kind of
    // positive relation this task preserves.
    const { root } = await scan({ target: "parseSync" });
    const index = indexSourceFileFromDisk(facadePath(root));
    const parseSync = buildModuleModel(index).exports.find(
      (e) => e.exportedName === "parseSync",
    );

    expect(parseSync?.localIdentifierProvenanceRefused).toBeUndefined();
    expect(parseSync?.commonJsReExport).toEqual({ specifier: "./lib/parse" });
  });
});
