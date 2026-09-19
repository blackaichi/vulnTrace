import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import { buildKnownPackageRoots } from "../domain/resolved-target.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { discoverEntrypoints } from "./entrypoints.js";
import { buildFindingForTest } from "../testing/finding.js";

/**
 * RWF-046 § J, END TO END: a rest element must not manufacture a
 * resolved target.
 *
 * The unit suite (`code-intelligence/require-binding-authority.test.ts`)
 * pins the EDGE. This pins the VERDICT, because an edge assertion cannot
 * see the thing that actually matters: whether a fabricated target
 * reaches a finding, and whether a wrong resolution displaces the
 * `unknown` blocker that withholds a Family-C proof.
 *
 * THE SHAPE. `const { ...vulnerable } = require("fixture-lib")` binds an
 * OBJECT holding the module's remaining properties. It does not bind
 * `fixture-lib`'s `vulnerable` export, and calling it is a `TypeError`
 * at runtime. But the local identifier is spelled exactly like the
 * advisory's export name, so any resolution that reads the LOCAL NAME as
 * a property key lands precisely on the vulnerable target the advisory
 * names -- with a concrete, entirely fictional path to it.
 *
 * WHY THIS EXISTS. The first RWF-046 implementation accepted any
 * `BindingElement` under a require-initialized declaration and let
 * `symbol-binder.ts` take `element.propertyName ?? element.name` as the
 * export name. An independent audit found that fabricating
 * `pkg#run` from `const [, run] = require("pkg")`. The remediation
 * states the boundary as a property proof rather than patching the array
 * case, and a rest element is the clause most likely to be dropped by a
 * later refactor precisely because it looks like a detail.
 *
 * A TEMP PROJECT, NOT A COMMITTED FIXTURE, on purpose: adding a fixture
 * would change the corpus the RWF-046 graph differential is measured
 * over, and that differential has to stay comparable to the run recorded
 * for the first implementation.
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function write(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

/**
 * A project whose application binds the advisory's export name with a
 * REST element and then calls it.
 */
function restElementProject(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-rwf046-rest-"));
  tempDirs.push(root);

  write(
    root,
    "package.json",
    JSON.stringify({ name: "app", version: "1.0.0" }),
  );
  write(
    root,
    "node_modules/fixture-lib/package.json",
    JSON.stringify({ name: "fixture-lib", version: "1.0.0", main: "index.js" }),
  );
  write(
    root,
    "node_modules/fixture-lib/index.js",
    [
      "function vulnerable(input) { return input; }",
      "function safe(input) { return input; }",
      "module.exports = { vulnerable, safe };",
      "",
    ].join("\n"),
  );
  write(
    root,
    "src/index.cjs",
    [
      "// `vulnerable` here is an OBJECT of the remaining properties, not",
      "// the package's `vulnerable` export. Calling it throws at runtime.",
      'const { safe, ...vulnerable } = require("fixture-lib");',
      "function main(input) {",
      "  return vulnerable(input);",
      "}",
      "module.exports = { main };",
      "",
    ].join("\n"),
  );
  return root;
}

const ENTRYPOINT = "src/index.cjs";

async function scan(root: string) {
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
    id: "GHSA-rwf-046",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-046",
    package: { name: "fixture-lib" },
    targets: [
      { module: "fixture-lib", export: "vulnerable", kind: "function" },
    ],
  };

  const finding = await buildFindingForTest({
    vulnerability,
    packageName: "fixture-lib",
    packageVersion: "1.0.0",
    packageInstance: path.join(root, "node_modules", "fixture-lib"),
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

describe("RWF-046: a rest element cannot manufacture a resolved target", () => {
  it("never reports AFFECTED for a rest element spelled like the advisory's export", async () => {
    const { finding } = await scan(restElementProject());

    // The whole point. A resolution that read the LOCAL name as a
    // property key would land on `fixture-lib#vulnerable` and hand this
    // finding a concrete, fictional path.
    expect(finding?.verdict).not.toBe("AFFECTED");
  });

  it("emits no resolved call edge into the vulnerable export", async () => {
    const { graph, root } = await scan(restElementProject());
    const libFile = path.join(root, "node_modules", "fixture-lib", "index.js");

    const resolvedIntoVulnerable = graph.edges.filter((edge) => {
      const { resolution } = edge;
      if (resolution.kind !== "resolved") {
        return false;
      }
      const target = graph.nodes.find((n) => n.id === resolution.target);
      return target?.module === libFile && target.name === "vulnerable";
    });

    expect(resolvedIntoVulnerable).toEqual([]);
  });

  it("keeps the call as an explicit unknown rather than dropping it", async () => {
    // A vanished edge is its own defect: the reachability search would
    // never account for the call at all. The refusal has to be visible.
    const { graph } = await scan(restElementProject());
    const main = graph.nodes.find((n) => n.name === "main");
    const edges = graph.edges.filter((e) => e.from === main?.id);

    expect(edges).toHaveLength(1);
    expect(edges[0]?.resolution.kind).toBe("unknown");
  });

  it("does not carry a Family-C unreachability proof built on the refusal", async () => {
    // If the fabricated edge had been the only thing standing between
    // this finding and a negative proof, removing it must not instead
    // produce a CONFIRMED-unreachable claim over a target the analyzer
    // never actually resolved.
    const { finding } = await scan(restElementProject());

    if (finding?.verdict === "NOT_AFFECTED") {
      expect(finding.evidence?.confirmedUnreachableTarget).toBeDefined();
    }
    expect(finding?.verdict).toBe("UNKNOWN");
  });
});
