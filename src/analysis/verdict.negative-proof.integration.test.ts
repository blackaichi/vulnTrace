import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import {
  buildKnownPackageRoots,
  canonicalizePackageInstancePath,
} from "../domain/resolved-target.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import { buildGateEligibleModuleLoadClosure } from "./module-load-closure.js";
import { buildFinding } from "./verdict.js";

/**
 * VT-307e -- the two LEGACY soundness fixes, pinned against REAL source
 * files rather than synthetic closures.
 *
 * Both were reproduced end-to-end on the pre-VT-307d base (ec7e0c5)
 * returning NOT_AFFECTED, which is what makes them legacy hardening rather
 * than a VT-307d regression. They are pinned here, at the real
 * builder+graph+finding composition, because both are specifically about a
 * DISAGREEMENT between what the closure sees and what the call graph sees
 * — a disagreement a hand-built closure cannot reproduce, since it would
 * just be asserting the fix's own premise:
 *
 *  - a syntax error makes `indexSourceFileFromDisk` return a partial,
 *    silently reshaped AST. The closure has refused to trust that since
 *    VT-307c-fix-2; `prepareFile` builds real nodes and edges from it and
 *    reports no unresolved edge at all, so the reachability search looks
 *    clean when it is merely blind.
 *  - `Module._extensions['.js'] = ...` is an ASSIGNMENT. It produces no
 *    call edge whatsoever, so VT-300's edge-based guard cannot see it, and
 *    the reachability search again looks clean.
 *
 * In both, a `require` of the vulnerable package and the call that follows
 * could sit exactly in the region the analyzer cannot account for.
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

const LIB_SRC =
  "function vulnerable(x){ return x; }\nmodule.exports = { vulnerable };\n";

const rule: VulnerableSymbolRule = {
  id: "GHSA-fixture-0001",
  package: { name: "vuln-lib" },
  targets: [
    {
      module: "vuln-lib",
      export: "vulnerable",
      kind: "function",
      confidence: 1.0,
    },
  ],
};

const vulnerability: Vulnerability = {
  id: "GHSA-fixture-0001",
  aliases: [],
  package: "vuln-lib",
  ecosystem: "npm",
  affectedVersions: [],
  fixedVersions: [],
  references: [],
};

interface Outcome {
  readonly verdict: string | undefined;
  readonly family: string;
  readonly closureComplete: boolean;
  readonly closureReasons: readonly string[];
  readonly graphUnknownEdges: number;
}

/** Real project -> real closure + real call graph -> real buildFinding. */
async function run(entrySrc: string, extraFiles: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-vt307e-"));
  tempDirs.push(root);
  const write = (rel: string, content: string): string => {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
    return p;
  };

  write("package.json", JSON.stringify({ name: "app" }));
  write(
    "node_modules/vuln-lib/package.json",
    JSON.stringify({ name: "vuln-lib", version: "1.0.0" }),
  );
  write("node_modules/vuln-lib/index.js", LIB_SRC);
  for (const [rel, content] of Object.entries(extraFiles)) {
    write(rel, content);
  }
  const entry = write("src/index.js", entrySrc);

  const project = loadTsProject(root);
  const resolver = createModuleResolver(project);
  const instance = canonicalizePackageInstancePath(
    path.join(root, "node_modules/vuln-lib"),
  );
  const knownPackageRoots = buildKnownPackageRoots(
    [
      {
        id: "vuln-lib@0",
        name: "vuln-lib",
        version: "1.0.0",
        ecosystem: "npm",
        direct: true,
        locations: [path.join(root, "node_modules/vuln-lib")],
        dependencyPaths: [],
      },
    ],
    root,
  );
  const entrypoints: Entrypoint[] = [
    { filePath: entry, source: "configured", reason: "test" },
  ];

  const closure = await buildGateEligibleModuleLoadClosure({
    entrypoints,
    resolver,
    maxFiles: 5000,
    knownPackageRoots,
  });
  const graph = await buildCallGraph({
    entryFiles: [entry],
    resolver,
    project,
  });

  const finding = await buildFinding({
    vulnerability,
    packageName: "vuln-lib",
    packageVersion: "1.0.0",
    packageInstance: instance,
    matchResult: "affected",
    rule,
    graph,
    entrypoints,
    resolver,
    projectRoot: root,
    knownPackageRoots,
    moduleLoadClosure: closure,
    graphTruncated: false,
  });

  const e = finding?.evidence;
  const outcome: Outcome = {
    verdict: finding?.verdict,
    family: e?.confirmedAbsentFromModuleLoadClosure
      ? "A"
      : e?.confirmedAbsentInstance
        ? "B"
        : e?.confirmedUnreachableTarget
          ? "C"
          : "-",
    closureComplete: closure?.complete ?? false,
    closureReasons: [
      ...new Set((closure?.incompleteness ?? []).map((i) => i.reason)),
    ],
    graphUnknownEdges: graph.edges.filter(
      (edge) => edge.resolution.kind === "unknown",
    ).length,
  };
  return outcome;
}

describe("VT-307e: parse_failure invalidates call-graph negative proofs", () => {
  it("a syntax error in the ENTRYPOINT forces UNKNOWN, not NOT_AFFECTED", async () => {
    const outcome = await run(
      "function f(){ return 1; }\nconst broken = `unterminated template\nmodule.exports = { f };\n",
    );

    expect(outcome.closureReasons).toContain("parse_failure");
    // The decisive part: the call graph reports a perfectly clean search.
    expect(
      outcome.graphUnknownEdges,
      "the call graph sees no blocker at all here -- that is exactly the problem",
    ).toBe(0);
    expect(outcome.verdict).toBe("UNKNOWN");
    expect(outcome.family).toBe("-");
  });

  it("a syntax error in a TRANSITIVELY loaded file forces UNKNOWN too", async () => {
    const outcome = await run(
      "const h = require('./helper.js');\nfunction f(){ return h; }\nmodule.exports = { f };\n",
      {
        "src/helper.js": "const broken = `unterminated\nmodule.exports = {};\n",
      },
    );

    expect(outcome.closureReasons).toContain("parse_failure");
    expect(outcome.graphUnknownEdges).toBe(0);
    expect(outcome.verdict).toBe("UNKNOWN");
    expect(outcome.family).toBe("-");
  });
});

describe("VT-307e: loader_hook_mutation invalidates call-graph negative proofs", () => {
  it("a non-call loader assignment forces UNKNOWN, not NOT_AFFECTED", async () => {
    const outcome = await run(
      "const Module = require('module');\n" +
        "Module._extensions['.js'] = function(){};\n" +
        "function f(){ return 1; }\nmodule.exports = { f };\n",
    );

    expect(outcome.closureReasons).toContain("loader_hook_mutation");
    // No call edge exists for an assignment, so VT-300's edge-based guard
    // is structurally unable to see this one.
    expect(
      outcome.graphUnknownEdges,
      "an assignment produces no unresolved CALL edge for VT-300 to catch",
    ).toBe(0);
    expect(outcome.verdict).toBe("UNKNOWN");
    expect(outcome.family).toBe("-");
  });
});

describe("VT-307e: the paired control keeps precision intact", () => {
  it("an identical project with no widening condition still proves NOT_AFFECTED", async () => {
    // Same shape, same installed-but-unused package, nothing unaccounted
    // for. Proves the two UNKNOWNs above come from the specific condition
    // under test and not from the harness or a blanket policy.
    const outcome = await run(
      "function f(){ return 1; }\nmodule.exports = { f };\n",
    );

    expect(outcome.closureComplete).toBe(true);
    expect(outcome.closureReasons).toEqual([]);
    expect(outcome.verdict).toBe("NOT_AFFECTED");
    expect(outcome.family).toBe("A");
  });
});
