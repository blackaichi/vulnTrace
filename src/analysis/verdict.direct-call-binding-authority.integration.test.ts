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
 * P1-B3b -- THE FALSE-NOT_AFFECTED ORACLE FOR RWF-043.
 *
 * RWF-042 and RWF-043 both recorded the same inherited claim: a
 * fabricated call edge can only ADD reachability, so it might cost
 * precision but could never turn a real exposure into a negative proof.
 * That claim is FALSE, and this test is the counter-example that retires
 * it.
 *
 * THE MECHANISM, which is displacement rather than addition:
 *
 *  1. `applyFn(end, value)` calls `end(value)`, where `end` is its own
 *     PARAMETER. The analyzer genuinely cannot say what that parameter
 *     holds -- the argument at the call site is `trimNewlines.end`, a
 *     member of an imported package, which VT-210's single-hop
 *     identifier-only rule does not carry. The honest edge is `unknown`.
 *  2. An `unknown` edge inside the reachable subgraph is exactly what
 *     withholds `reachableSubgraphComplete`, and therefore Family C.
 *  3. The same-name matcher, running BEFORE every authoritative path,
 *     saw the identifier text `end`, found the unrelated local
 *     `function end(x)` in the file's flat function index, and RESOLVED
 *     the edge to it.
 *  4. The blocker was not merely joined by a fabricated edge -- it was
 *     REPLACED by one. The subgraph now contained no unresolved edge at
 *     all, so it looked exhaustively searched.
 *  5. Family C certified it and the verdict became NOT_AFFECTED, for a
 *     vulnerable function the program really does invoke.
 *
 * The real path (`trimNewlines.end` flowing into `applyFn`) is a genuine
 * exposure this analyzer does not model. The correct answer is therefore
 * UNKNOWN -- not AFFECTED, which would require an authoritative path, and
 * emphatically not NOT_AFFECTED, which claims a proof that does not
 * exist. Missing the resolution is a precision cost; claiming the proof
 * is a soundness defect.
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

const rule: VulnerableSymbolRule = {
  id: "GHSA-fixture-b3b1",
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
  id: "GHSA-fixture-b3b1",
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
  /** Whether any edge in the graph resolves to the innocuous local `end`. */
  readonly borrowedLocalEnd: boolean;
}

async function run(entrySrc: string): Promise<Outcome> {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-b3b-oracle-"));
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
  // The innocuous local `end` lives in the ENTRY file; the vulnerable one
  // lives in the package. Distinguishing them by module is what makes
  // "the matcher borrowed the local" observable rather than inferred.
  const localEnd = graph.nodes.find(
    (node) => node.name === "end" && node.module === entry,
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
    borrowedLocalEnd: graph.edges.some(
      (edge) =>
        edge.resolution.kind === "resolved" &&
        edge.resolution.target === localEnd?.id,
    ),
  };
}

/**
 * The strategic review's shape, verbatim in structure: a local helper
 * whose name collides with the vulnerable export, and a higher-order
 * function whose parameter carries that same name.
 */
const SHADOWED_PARAMETER_SRC = [
  "const trimNewlines = require('trim-newlines');",
  "",
  "function end(x) {",
  "  return x;",
  "}",
  "",
  "function applyFn(end, value) {",
  "  return end(value);",
  "}",
  "",
  "function normalize(input) {",
  "  return applyFn(trimNewlines.end, input);",
  "}",
  "",
  "module.exports = { normalize, end };",
  "",
].join("\n");

describe("P1-B3b: a fabricated edge CAN produce a false negative proof", () => {
  it("does not borrow the innocuous local `end` for the shadowed parameter call", async () => {
    const outcome = await run(SHADOWED_PARAMETER_SRC);
    expect(
      outcome.borrowedLocalEnd,
      "`end(value)` inside `applyFn` is a call on a PARAMETER; nothing proves it is the file's own `function end`",
    ).toBe(false);
  });

  it("keeps the honest blocker that the fabricated edge used to displace", async () => {
    const outcome = await run(SHADOWED_PARAMETER_SRC);
    expect(
      outcome.graphUnknownEdges,
      "the unattributable parameter call must remain an unresolved edge",
    ).toBeGreaterThan(0);
  });

  it("does not certify the reachable subgraph as exhaustively searched", async () => {
    const outcome = await run(SHADOWED_PARAMETER_SRC);
    expect(outcome.reachableSubgraphComplete).toBe(false);
  });

  it("returns UNKNOWN rather than a Family C NOT_AFFECTED", async () => {
    const outcome = await run(SHADOWED_PARAMETER_SRC);
    expect(
      outcome.family,
      "no negative proof family may certify this program",
    ).toBe("-");
    expect(outcome.verdict).toBe("UNKNOWN");
  });
});
