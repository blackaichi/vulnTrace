import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import { buildKnownPackageRoots } from "../domain/resolved-target.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { discoverEntrypoints } from "./entrypoints.js";
import { buildFindingForTest } from "../testing/finding.js";

/**
 * P0-Z round 3: THE ROOT MATERIALIZATION CONTRACT, end to end.
 *
 * A candidate NAME is not a root; a NODE is. This suite pins the invariant
 * that protects against future name/identity mismatches beyond the exact
 * alias syntax that motivated it: whenever a binding that can publish a
 * callable contributes candidates and NONE of them matches a node, root
 * derivation must be incomplete and Family C must be unavailable.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(entry: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "p0z-mat-"));
  dirs.push(dir);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { "fixture-lib": "1.0.0" },
    }),
    "package-lock.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "app",
          version: "1.0.0",
          dependencies: { "fixture-lib": "1.0.0" },
        },
        "node_modules/fixture-lib": { version: "1.0.0" },
      },
    }),
    "node_modules/fixture-lib/package.json": JSON.stringify({
      name: "fixture-lib",
      version: "1.0.0",
      main: "index.js",
    }),
    "node_modules/fixture-lib/index.js":
      "function dangerousOp(i){ return 'danger:' + i; }\n" +
      "function neverCalled(i){ return 'never:' + i; }\n" +
      "exports.dangerousOp = dangerousOp;\nexports.neverCalled = neverCalled;\n",
    "src/index.js": entry,
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

async function scan(entry: string, exportName: string) {
  const root = project(entry);
  const resolver = createModuleResolver(loadTsProject(root));
  const knownPackageRoots = buildKnownPackageRoots([], root);
  const [graph, entrypointsResult] = await Promise.all([
    buildCallGraph({
      entryFiles: [path.join(root, "src", "index.js")],
      resolver,
      knownPackageRoots,
    }),
    discoverEntrypoints({
      projectRoot: root,
      resolver,
      configuredEntrypoints: ["src/index.js"],
    }),
  ]);
  const vulnerability: Vulnerability = {
    id: "GHSA-p0z-mat",
    aliases: [],
    package: "fixture-lib",
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-p0z-mat",
    package: { name: "fixture-lib" },
    targets: [{ module: "fixture-lib", export: exportName, kind: "function" }],
  };
  return buildFindingForTest({
    vulnerability,
    packageName: "fixture-lib",
    packageVersion: "1.0.0",
    matchResult: "affected",
    rule,
    graph,
    entrypoints: entrypointsResult.entrypoints,
    resolver,
    projectRoot: root,
    knownPackageRoots,
  });
}

const DEP =
  "const dep = require('fixture-lib');\n" +
  "function dangerous(u){ return dep.dangerousOp(u); }\n" +
  "function safeOne(u){ return 'safe:' + u; }\n";

describe("P0-Z: a candidate that cannot materialize blocks Family C", () => {
  const UNMATERIALIZABLE: ReadonlyArray<readonly [string, string]> = [
    [
      "reassigned alias",
      "let alias = safeOne;\nalias = dangerous;\nmodule.exports.run = alias;\n",
    ],
    [
      "conditional alias",
      "const alias = process.env.F ? dangerous : safeOne;\nmodule.exports.run = alias;\n",
    ],
    [
      "member alias",
      "const obj = { dangerous };\nmodule.exports.run = obj.dangerous;\n",
    ],
    [
      "destructured alias",
      "const obj = { dangerous };\nconst { dangerous: alias } = obj;\nmodule.exports.run = alias;\n",
    ],
    [
      "call-expression initializer",
      "const alias = makeIt();\nmodule.exports.run = alias;\n",
    ],
  ];

  for (const [label, entry] of UNMATERIALIZABLE) {
    it(`${label}: no Family C proof`, async () => {
      const finding = await scan(DEP + entry, "neverCalled");
      expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
      expect(finding?.verdict).not.toBe("NOT_AFFECTED");
    });
  }

  it("reports the ROOT-CANDIDATE gap, not a re-export or forwarding gap", async () => {
    const finding = await scan(
      DEP +
        "const alias = process.env.F ? dangerous : safeOne;\nmodule.exports.run = alias;\n",
      "neverCalled",
    );
    expect(finding?.evidence?.reasons?.join(" ")).toContain(
      "unresolved_entrypoint_root_candidate",
    );
  });
});

describe("P0-Z: materializable candidates keep Family C available", () => {
  const MATERIALIZABLE: ReadonlyArray<readonly [string, string]> = [
    ["direct callable", "module.exports.run = dangerous;\n"],
    [
      "one-hop alias",
      "const alias = dangerous;\nmodule.exports.run = alias;\n",
    ],
    [
      "two-hop alias",
      "const a = dangerous;\nconst b = a;\nmodule.exports.run = b;\n",
    ],
    [
      "function-expression alias",
      "const alias = function inner(u){ return dep.dangerousOp(u); };\nmodule.exports.run = alias;\n",
    ],
    [
      "arrow alias",
      "const alias = (u) => dep.dangerousOp(u);\nmodule.exports.run = alias;\n",
    ],
    [
      "object-literal alias export",
      "const alias = dangerous;\nmodule.exports = { run: alias };\n",
    ],
    [
      "bracket alias export",
      'const alias = dangerous;\nmodule.exports["run"] = alias;\n',
    ],
    [
      "exports-alias export",
      "const alias = dangerous;\nexports.run = alias;\n",
    ],
    ["non-callable export", "const alias = 42;\nmodule.exports.run = alias;\n"],
    ["no callable export at all", "module.exports = 42;\n"],
  ];

  for (const [label, entry] of MATERIALIZABLE) {
    it(`${label}: genuine Family C for an unreachable target`, async () => {
      const finding = await scan(DEP + entry, "neverCalled");
      expect(finding?.verdict).toBe("NOT_AFFECTED");
      expect(finding?.evidence?.confirmedUnreachableTarget).toMatchObject({
        reachableSubgraphComplete: true,
      });
    });
  }
});

describe("P0-Z: alias roots find the real path, and invent none", () => {
  it("one-hop alias to the vulnerable callable is AFFECTED with a concrete path", async () => {
    const finding = await scan(
      DEP + "const alias = dangerous;\nmodule.exports.run = alias;\n",
      "dangerousOp",
    );
    expect(finding?.verdict).toBe("AFFECTED");
    expect((finding?.evidence?.path ?? []).length).toBeGreaterThan(0);
  });

  it("a SAFE alias is never AFFECTED merely because vulnerable code exists", async () => {
    const finding = await scan(
      DEP + "const alias = safeOne;\nmodule.exports.run = alias;\n",
      "dangerousOp",
    );
    expect(finding?.verdict).not.toBe("AFFECTED");
  });

  it("a reassigned alias never roots the STALE declaration", async () => {
    // Live value is safe; the stale one reaches the sink. Rooting the
    // stale declaration would manufacture a false AFFECTED.
    const finding = await scan(
      DEP +
        "let alias = dangerous;\nalias = safeOne;\nmodule.exports.run = alias;\n",
      "dangerousOp",
    );
    expect(finding?.verdict).not.toBe("AFFECTED");
  });
});
