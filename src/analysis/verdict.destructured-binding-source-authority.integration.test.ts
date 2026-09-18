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
import { buildFindingForTest } from "../testing/finding.js";

/**
 * RWF-045 -- THE VERDICT ORACLE FOR DESTRUCTURED BINDING SOURCE AUTHORITY.
 *
 * The graph-level fabrications live in
 * `src/code-intelligence/call-graph.destructured-binding-source-authority.test.ts`.
 * This file asserts what they COST: that selecting a destructuring pattern
 * by name moves the published verdict, in BOTH directions, on a
 * vulnerability a user would act on.
 *
 * The defect. `findDestructuredBindingSource` took an identifier's TEXT
 * and returned the first `const { <name> } = src` anywhere in the file. So
 * for a file containing two destructurings of the same name -- one from
 * the vulnerable package, one from an innocuous local module -- EVERY
 * reference to that name resolved to whichever was written first,
 * regardless of which one the reference actually binds to.
 *
 * DIRECTION 1 -- FALSE NOT_AFFECTED (the soundness direction).
 * The innocuous destructuring is written first. The function that really
 * destructures `end` off the vulnerable package has its call resolved to
 * the innocuous LOCAL function instead. The vulnerable target is then
 * absent from the reachable subgraph; no unresolved edge remains to
 * withhold `reachableSubgraphComplete`; Family C certifies the subgraph;
 * and the verdict is NOT_AFFECTED for a call the program really makes into
 * the vulnerable export. This is the RWF-043 displacement mechanism
 * reproduced through the destructuring bridge -- the fabricated edge does
 * not JOIN the honest one, it REPLACES it, and what it replaces is the
 * blocker.
 *
 * DIRECTION 2 -- FALSE AFFECTED (the precision direction, which RWF-045's
 * record did not claim and this file establishes).
 * Reverse the two destructurings. Now the function that destructures `end`
 * off the innocuous local module has its call resolved to the VULNERABLE
 * export, and the scan reports AFFECTED against a program that never
 * touches it. Recorded so RWF-045 is not framed as one-directional.
 *
 * After remediation each reference resolves through its OWN binding
 * element: direction 1 is AFFECTED (a real exposure, correctly found) and
 * direction 2 is not, and in neither case does a borrowed pattern decide.
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

/** The vulnerable package: its `end` export is the rule's target. */
const LIB_SRC = "function end(x){ return x; }\nmodule.exports = { end };\n";

/**
 * An innocuous local module exporting the SAME member name. The collision
 * is the whole point: the two `end`s are distinguishable only by which
 * module they live in, which is exactly what a name-keyed lookup cannot
 * see.
 */
const SAFE_SRC = "function end(x){ return x; }\nmodule.exports = { end };\n";

const rule: VulnerableSymbolRule = {
  id: "GHSA-fixture-rwf045",
  package: { name: "trim-newlines" },
  targets: [
    {
      module: "trim-newlines",
      export: "end",
      kind: "function",
      confidence: 1.0,
    },
  ],
};

const vulnerability: Vulnerability = {
  id: "GHSA-fixture-rwf045",
  aliases: [],
  package: "trim-newlines",
  ecosystem: "npm",
  affectedVersions: [],
  fixedVersions: [],
  references: [],
};

interface Outcome {
  readonly verdict: string | undefined;
  /** "C" when the negative proof is a confirmed-unreachable-target proof. */
  readonly family: string;
  readonly reachableSubgraphComplete: boolean;
  readonly graphUnknownEdges: number;
  /** Whether any edge resolves to the innocuous LOCAL `end` in safe.js. */
  readonly borrowedLocalEnd: boolean;
  /** Whether any edge resolves to the VULNERABLE `end` in the package. */
  readonly reachesVulnerableEnd: boolean;
}

async function run(entrySrc: string): Promise<Outcome> {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-rwf045-oracle-"));
  tempDirs.push(root);
  const write = (rel: string, content: string): string => {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
    return p;
  };

  write("package.json", JSON.stringify({ name: "app" }));
  write(
    "node_modules/trim-newlines/package.json",
    JSON.stringify({ name: "trim-newlines", version: "1.0.0" }),
  );
  write("node_modules/trim-newlines/index.js", LIB_SRC);
  const safeFile = write("src/safe.js", SAFE_SRC);
  const entry = write("src/index.js", entrySrc);

  const project = loadTsProject(root);
  const resolver = createModuleResolver(project);
  const instance = canonicalizePackageInstancePath(
    path.join(root, "node_modules/trim-newlines"),
  );
  const knownPackageRoots = buildKnownPackageRoots(
    [
      {
        id: "trim-newlines@0",
        name: "trim-newlines",
        version: "1.0.0",
        ecosystem: "npm",
        direct: true,
        locations: [path.join(root, "node_modules/trim-newlines")],
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

  const finding = await buildFindingForTest({
    vulnerability,
    packageName: "trim-newlines",
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

  const evidence = finding?.evidence;
  const localEnd = graph.nodes.find(
    (node) => node.name === "end" && node.module === safeFile,
  );
  const vulnerableEnd = graph.nodes.find(
    (node) => node.name === "end" && node.module.includes("trim-newlines"),
  );
  const resolvedTo = (id: string | undefined): boolean =>
    id !== undefined &&
    graph.edges.some(
      (edge) =>
        edge.resolution.kind === "resolved" && edge.resolution.target === id,
    );

  return {
    verdict: finding?.verdict,
    family: evidence?.confirmedAbsentFromModuleLoadClosure
      ? "A"
      : evidence?.confirmedAbsentInstance
        ? "B"
        : evidence?.confirmedUnreachableTarget
          ? "C"
          : "-",
    reachableSubgraphComplete:
      evidence?.confirmedUnreachableTarget?.reachableSubgraphComplete ?? false,
    graphUnknownEdges: graph.edges.filter(
      (edge) => edge.resolution.kind === "unknown",
    ).length,
    borrowedLocalEnd: resolvedTo(localEnd?.id),
    reachesVulnerableEnd: resolvedTo(vulnerableEnd?.id),
  };
}

/**
 * DIRECTION 1. `unused` destructures `end` from the innocuous local module
 * and is written FIRST, so it is what a whole-file first-match search
 * finds. `normalize` destructures `end` from the VULNERABLE package and
 * calls it -- a real exposure.
 */
const HIDES_THE_VULNERABLE_CALL = [
  "const trimNewlines = require('trim-newlines');",
  "const safeLib = require('./safe.js');",
  "",
  "function unused() {",
  "  const { end } = safeLib;",
  "  return end;",
  "}",
  "",
  "function normalize(input) {",
  "  const { end } = trimNewlines;",
  "  return end(input);",
  "}",
  "",
  "module.exports = { normalize, unused };",
  "",
].join("\n");

/**
 * DIRECTION 2. The same file with the two sources swapped. `normalize`
 * now calls the INNOCUOUS `end`; the vulnerable destructuring is the one
 * that is merely returned, never invoked.
 */
const INVENTS_A_VULNERABLE_CALL = [
  "const trimNewlines = require('trim-newlines');",
  "const safeLib = require('./safe.js');",
  "",
  "function unused() {",
  "  const { end } = trimNewlines;",
  "  return end;",
  "}",
  "",
  "function normalize(input) {",
  "  const { end } = safeLib;",
  "  return end(input);",
  "}",
  "",
  "module.exports = { normalize, unused };",
  "",
].join("\n");

describe("RWF-045: a borrowed destructuring source moves the verdict", () => {
  // ------------------------------------------------------------------
  // DIRECTION 1 -- the soundness direction
  // ------------------------------------------------------------------

  it("attributes the vulnerable destructuring to the package it really reads", async () => {
    const outcome = await run(HIDES_THE_VULNERABLE_CALL);
    expect(
      outcome.borrowedLocalEnd,
      "`end(input)` in `normalize` binds to `const { end } = trimNewlines`; the local module's `end` is a different binding entirely",
    ).toBe(false);
    expect(
      outcome.reachesVulnerableEnd,
      "the call really does reach the vulnerable export",
    ).toBe(true);
  });

  it("does not certify a negative proof over the hidden vulnerable call", async () => {
    const outcome = await run(HIDES_THE_VULNERABLE_CALL);
    expect(
      outcome.verdict,
      "the program calls the vulnerable export; NOT_AFFECTED would be a false negative proof",
    ).not.toBe("NOT_AFFECTED");
    expect(outcome.family).not.toBe("C");
    expect(outcome.reachableSubgraphComplete).toBe(false);
  });

  it("reports the real exposure it had been hiding", async () => {
    const outcome = await run(HIDES_THE_VULNERABLE_CALL);
    expect(outcome.verdict).toBe("AFFECTED");
  });

  // ------------------------------------------------------------------
  // DIRECTION 2 -- the false-AFFECTED direction
  // ------------------------------------------------------------------

  it("does not borrow the vulnerable source for an innocuous destructuring", async () => {
    const outcome = await run(INVENTS_A_VULNERABLE_CALL);
    expect(
      outcome.reachesVulnerableEnd,
      "`end(input)` in `normalize` binds to `const { end } = safeLib`; nothing in this program invokes the vulnerable export",
    ).toBe(false);
    expect(
      outcome.borrowedLocalEnd,
      "the honest target is the local module's `end`",
    ).toBe(true);
  });

  it("does not report AFFECTED against a program that never calls the export", async () => {
    const outcome = await run(INVENTS_A_VULNERABLE_CALL);
    expect(outcome.verdict).not.toBe("AFFECTED");
  });
});
