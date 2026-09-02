import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import {
  buildKnownPackageRoots,
  canonicalizePackageInstancePath,
} from "../domain/resolved-target.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { discoverEntrypoints } from "./entrypoints.js";
import { buildFindingForTest } from "../testing/finding.js";

/**
 * RWF-004b at the VERDICT layer: what a cross-package CommonJS façade does
 * to a finding, not merely to an edge.
 *
 * The call-graph suite
 * (code-intelligence/call-graph.cross-package-reexport.test.ts) proves the
 * chase lands on the right node. This suite proves the two things only a
 * finding can show: that the resulting AFFECTED is attributed to the exact
 * installed instance the façade resolves, and — the reason the gate was
 * examined at all — that widening the chase never converts an honest
 * UNKNOWN into a NOT_AFFECTED the code does not support.
 */

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-xpkg-verdict-"));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function pkgJson(name: string, version = "1.0.0"): string {
  return JSON.stringify({ name, version, main: "index.js" });
}

/** Builds the graph + finding for `packageName#export` against `root`. */
async function scan(options: {
  readonly root: string;
  readonly packageName: string;
  readonly exportName: string;
  readonly packageInstance?: string;
}) {
  const { root, packageName, exportName } = options;
  const entry = path.join(root, "src", "app.js");
  const resolver = createModuleResolver(loadTsProject(root));
  const knownPackageRoots = buildKnownPackageRoots([], root);

  const [graph, entrypointsResult] = await Promise.all([
    buildCallGraph({ entryFiles: [entry], resolver, knownPackageRoots }),
    discoverEntrypoints({
      projectRoot: root,
      resolver,
      configuredEntrypoints: ["src/app.js"],
    }),
  ]);

  const vulnerability: Vulnerability = {
    id: "GHSA-rwf-004b",
    aliases: [],
    package: packageName,
    ecosystem: "npm",
    affectedVersions: [{ introduced: "0" }],
    fixedVersions: [],
    references: [],
  };
  const rule: VulnerableSymbolRule = {
    id: "GHSA-rwf-004b",
    package: { name: packageName },
    targets: [{ module: packageName, export: exportName, kind: "function" }],
  };

  const finding = await buildFindingForTest({
    vulnerability,
    packageName,
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

  return { finding, graph };
}

/** app -> wrapper façade -> vuln-pkg, the RWB-08 shape in miniature. */
function writeFacadeProject(root: string, facadeBody: string): void {
  write(root, "node_modules/wrapper/package.json", pkgJson("wrapper"));
  write(root, "node_modules/wrapper/index.js", facadeBody);
  write(root, "node_modules/vuln-pkg/package.json", pkgJson("vuln-pkg"));
  write(
    root,
    "node_modules/vuln-pkg/index.js",
    "function parse(x) { return x; }\nexports.parse = parse;\n",
  );
  write(
    root,
    "src/app.js",
    `const wrapper = require("wrapper");\nfunction main(input) {\n  return wrapper.parse(input);\n}\nmodule.exports = { main };\n`,
  );
}

describe("RWF-004b: a cross-package CommonJS façade produces an authoritative AFFECTED", () => {
  it("reaches the foreign package's implementation -> AFFECTED", async () => {
    const root = tempProject();
    writeFacadeProject(root, `exports.parse = require("vuln-pkg").parse;\n`);

    const { finding } = await scan({
      root,
      packageName: "vuln-pkg",
      exportName: "parse",
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("ends the evidence path in the FOREIGN package's file, never the façade's", async () => {
    const root = tempProject();
    writeFacadeProject(root, `exports.parse = require("vuln-pkg").parse;\n`);

    const { finding } = await scan({
      root,
      packageName: "vuln-pkg",
      exportName: "parse",
    });

    const last = finding?.evidence?.path.at(-1) ?? "";
    expect(last).toContain(path.join("node_modules", "vuln-pkg", "index.js"));
    expect(last).not.toContain(path.join("node_modules", "wrapper"));
    expect(finding?.evidence?.path[0]).toContain(path.join("src", "app.js"));
  });

  it("stays AFFECTED when the finding's own packageInstance is supplied explicitly", async () => {
    const root = tempProject();
    writeFacadeProject(root, `exports.parse = require("vuln-pkg").parse;\n`);

    const { finding } = await scan({
      root,
      packageName: "vuln-pkg",
      exportName: "parse",
      packageInstance: canonicalizePackageInstancePath(
        path.join(root, "node_modules", "vuln-pkg"),
      ),
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });

  it("the FAÇADE's own package never inherits the foreign target's AFFECTED", async () => {
    const root = tempProject();
    writeFacadeProject(root, `exports.parse = require("vuln-pkg").parse;\n`);

    // A rule aimed at `wrapper#parse`: the name exists in wrapper's export
    // table, but the callable it holds is vuln-pkg's. Whatever the honest
    // outcome is, `wrapper` must not be reported AFFECTED on the strength
    // of another package's function.
    const { finding } = await scan({
      root,
      packageName: "wrapper",
      exportName: "parse",
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
  });
});

describe("RWF-004b: duplicate same-name, same-version instances stay separate findings", () => {
  function writeDuplicateInstanceProject(root: string): void {
    // Two installs of vuln-pkg@1.0.0, identical export name. The façade's
    // own `require("vuln-pkg")` resolves the NESTED one.
    for (const dir of [
      "node_modules/vuln-pkg",
      "node_modules/wrapper/node_modules/vuln-pkg",
    ]) {
      write(root, `${dir}/package.json`, pkgJson("vuln-pkg"));
      write(
        root,
        `${dir}/index.js`,
        "function parse(x) { return x; }\nexports.parse = parse;\n",
      );
    }
    write(root, "node_modules/wrapper/package.json", pkgJson("wrapper"));
    write(
      root,
      "node_modules/wrapper/index.js",
      `exports.parse = require("vuln-pkg").parse;\n`,
    );
    write(
      root,
      "src/app.js",
      `const wrapper = require("wrapper");\nfunction main(input) {\n  return wrapper.parse(input);\n}\nmodule.exports = { main };\n`,
    );
  }

  it("reports AFFECTED for the exact NESTED instance the façade resolves", async () => {
    const root = tempProject();
    writeDuplicateInstanceProject(root);

    const { finding } = await scan({
      root,
      packageName: "vuln-pkg",
      exportName: "parse",
      packageInstance: canonicalizePackageInstancePath(
        path.join(root, "node_modules", "wrapper", "node_modules", "vuln-pkg"),
      ),
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(finding?.evidence?.path.at(-1)).toContain(
      path.join("wrapper", "node_modules", "vuln-pkg"),
    );
  });

  it("never reports AFFECTED for the unrelated same-name, same-version twin", async () => {
    const root = tempProject();
    writeDuplicateInstanceProject(root);

    const { finding } = await scan({
      root,
      packageName: "vuln-pkg",
      exportName: "parse",
      packageInstance: canonicalizePackageInstancePath(
        path.join(root, "node_modules", "vuln-pkg"),
      ),
    });

    expect(finding?.verdict).not.toBe("AFFECTED");
  });

  it("does not let the reached instance's evidence contaminate the twin's finding", async () => {
    const root = tempProject();
    writeDuplicateInstanceProject(root);

    const { finding } = await scan({
      root,
      packageName: "vuln-pkg",
      exportName: "parse",
      packageInstance: canonicalizePackageInstancePath(
        path.join(root, "node_modules", "vuln-pkg"),
      ),
    });

    for (const step of finding?.evidence?.path ?? []) {
      expect(step).not.toContain(
        path.join("wrapper", "node_modules", "vuln-pkg"),
      );
    }
  });
});

describe("RWF-004b: a conditional export assignment never manufactures a clean bill of health", () => {
  /**
   * The soundness case that shaped this task's implementation.
   *
   * `exports.parse` is written in BOTH branches of an `if`/`else`, each
   * from a different package. Every export-provenance fact in
   * module-model.ts is read out of a LAST-WRITE-WINS map keyed by source
   * order, so an ungated chase forwards `wrapper.parse` to `pkg-b` alone
   * and silently asserts that `pkg-a`'s function is not what the export
   * holds. `pkg-a`'s target then resolves to a real node nothing points
   * at, and Family C proves it unreachable with
   * `reachableSubgraphComplete: true` -- a false NOT_AFFECTED for code that
   * calls `pkg-a.parse` whenever the condition is true. Reproduced
   * directly before `isUnconditionalExportAssignment` was extended to gate
   * `commonJsReExport` too.
   */
  function writeConditionalBranchProject(root: string): void {
    write(root, "node_modules/wrapper/package.json", pkgJson("wrapper"));
    write(
      root,
      "node_modules/wrapper/index.js",
      `if (process.env.X) {\n  exports.parse = require("pkg-a").parse;\n} else {\n  exports.parse = require("pkg-b").parse;\n}\n`,
    );
    for (const name of ["pkg-a", "pkg-b"]) {
      write(root, `node_modules/${name}/package.json`, pkgJson(name));
      write(
        root,
        `node_modules/${name}/index.js`,
        "function parse(x) { return x; }\nexports.parse = parse;\n",
      );
    }
    write(
      root,
      "src/app.js",
      `const wrapper = require("wrapper");\nfunction main(input) {\n  return wrapper.parse(input);\n}\nmodule.exports = { main };\n`,
    );
  }

  it("does not report NOT_AFFECTED for the branch the last-write-wins map drops", async () => {
    const root = tempProject();
    writeConditionalBranchProject(root);

    const { finding } = await scan({
      root,
      packageName: "pkg-a",
      exportName: "parse",
    });

    expect(finding?.verdict).not.toBe("NOT_AFFECTED");
    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("does not report AFFECTED for the branch it happens to keep either", async () => {
    const root = tempProject();
    writeConditionalBranchProject(root);

    const { finding } = await scan({
      root,
      packageName: "pkg-b",
      exportName: "parse",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
  });

  it("refuses a try/catch whole-module re-export the same way", async () => {
    const root = tempProject();
    write(root, "node_modules/wrapper/package.json", pkgJson("wrapper"));
    write(
      root,
      "node_modules/wrapper/index.js",
      `try {\n  module.exports = require("vuln-pkg");\n} catch (e) {\n  module.exports = {};\n}\n`,
    );
    write(root, "node_modules/vuln-pkg/package.json", pkgJson("vuln-pkg"));
    write(
      root,
      "node_modules/vuln-pkg/index.js",
      "function parse(x) { return x; }\nexports.parse = parse;\n",
    );
    write(
      root,
      "src/app.js",
      `const wrapper = require("wrapper");\nfunction main(input) {\n  return wrapper.parse(input);\n}\nmodule.exports = { main };\n`,
    );

    const { finding } = await scan({
      root,
      packageName: "vuln-pkg",
      exportName: "parse",
    });

    expect(finding?.verdict).not.toBe("NOT_AFFECTED");
  });

  it("still chases the CHAINED unconditional form real debug@2.0.0 uses", async () => {
    // `exports = module.exports = require("vuln-pkg")` is one unconditional
    // top-level statement, and is exactly how debug's node.js forwards to
    // debug.js (RWB-08's first hop). It must keep resolving.
    const root = tempProject();
    writeFacadeProject(
      root,
      `exports = module.exports = require("vuln-pkg");\n`,
    );

    const { finding } = await scan({
      root,
      packageName: "vuln-pkg",
      exportName: "parse",
    });

    expect(finding?.verdict).toBe("AFFECTED");
  });
});
