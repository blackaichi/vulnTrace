import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import type { CallEdge, CallGraph, GraphNode } from "../domain/graph.js";
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
 * RWF-045 x RWF-046 -- THE CROSS-LAYER ORACLE.
 *
 * WHY THIS FILE EXISTS. The two remediations own two different questions,
 * and until this branch was rebased onto PR #60 there was no tree on
 * which both answers existed at once, so the composition could not be
 * tested at all. It is owed by this PR and discharged here.
 *
 *   RWF-045 answers: WHICH SOURCE IDENTIFIER owns a destructured binding?
 *                    (`const { run } = mod` -- which `mod`, declared where)
 *   RWF-046 answers: WHICH MODULE does that exact source identifier
 *                    denote? (`const mod = require("x")` -- which
 *                    declaration of `mod`, in which scope, and therefore
 *                    which PackageInstance)
 *
 * They compose in the single shape this file is built around:
 *
 *     const mod = require("vuln");   // RWF-046 decides the module
 *     const { run } = mod;           // RWF-045 decides the source
 *     run();                         // one resolution, two authorities
 *
 * The composition is where a defect can hide from BOTH suites. RWF-045's
 * suite always destructures from a source it declares locally, so the
 * require layer underneath is never in doubt. RWF-046's suite mostly
 * calls a member off the required object directly (`dep.parse()`), so the
 * destructuring bridge above it is never in play. A layer that answered
 * its own question correctly and then handed the answer to the other by
 * NAME would pass both suites and fail here.
 *
 * WHAT EACH CASE MUST PROVE. Every negative case asserts the call stayed
 * UNKNOWN, never merely "did not resolve to the wrong module" -- by
 * RWF-043 sec 1's displacement argument a vanished edge is its own
 * defect, and a fabricated edge REPLACES the honest `unknown` blocker
 * rather than joining it, which is how a wrong edge withdraws the blocker
 * that withholds `reachableSubgraphComplete`. Every positive case asserts
 * the exact PackageInstance, never a package name and never an export
 * name: in the twin fixtures below every textual key a name-based lookup
 * could use -- local binding name, property key, package name, version,
 * exported member -- is identical across the two candidates, and only the
 * install path differs.
 *
 * STATUS: CONFIRMATORY. The audit verified this composition on the
 * unrebased tree. These cases are expected to pass on the first run; a
 * failure here is a real finding about the rebase, not a new discovery.
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

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-cross-layer-"));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

async function graphFor(root: string, entry: string): Promise<CallGraph> {
  const resolver = createModuleResolver(loadTsProject(root));
  return buildCallGraph({ entryFiles: [entry], resolver });
}

function edgesFrom(graph: CallGraph, functionName: string): CallEdge[] {
  const from = graph.nodes.find((n) => n.name === functionName);
  return graph.edges.filter((e) => e.from === from?.id);
}

/** The single edge leaving `functionName`, asserted to be the only one. */
function soleEdgeFrom(graph: CallGraph, functionName: string): CallEdge {
  const edges = edgesFrom(graph, functionName);
  expect(edges).toHaveLength(1);
  const [edge] = edges;
  expect(edge).toBeDefined();
  return edge as CallEdge;
}

function targetOf(graph: CallGraph, edge: CallEdge): GraphNode | undefined {
  expect(edge.resolution.kind).toBe("resolved");
  const id =
    edge.resolution.kind === "resolved" ? edge.resolution.target : undefined;
  return graph.nodes.find((n) => n.id === id);
}

/** The module FILE a resolved edge lands in -- the instance-exact answer. */
function resolvedModuleOf(graph: CallGraph, edge: CallEdge): string {
  const target = targetOf(graph, edge);
  expect(target).toBeDefined();
  return target?.module ?? "";
}

function expectUnknown(graph: CallGraph, functionName: string): void {
  const edge = soleEdgeFrom(graph, functionName);
  expect(
    edge.resolution.kind,
    `${functionName} must fail CLOSED (unknown), not resolve and not vanish`,
  ).toBe("unknown");
}

/**
 * A project with distinctly-named packages, each exporting the same
 * member set. Same member names across packages is deliberate: it is what
 * makes a name-keyed answer indistinguishable from an identity-keyed one
 * unless the assertion names the install.
 */
function packagesProject(names: readonly string[]): string {
  const root = tempProject();
  write(root, "package.json", JSON.stringify({ name: "app" }));
  for (const name of names) {
    write(
      root,
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, version: "1.0.0", main: "index.js" }),
    );
    write(
      root,
      `node_modules/${name}/index.js`,
      [
        "function run() {}",
        "function other() {}",
        "function a() {}",
        "function rest() {}",
        "module.exports = { run, other, a, rest };",
      ].join("\n"),
    );
  }
  return root;
}

// --------------------------------------------------------------------
// Section 1 -- the composition positive control.
// --------------------------------------------------------------------

describe("cross-layer sec 1: the composition resolves exactly", () => {
  it('resolves `const mod = require("vuln"); const { run } = mod; run()` to the exact export of the exact install', async () => {
    const root = packagesProject(["vuln"]);
    const entry = write(
      root,
      "index.js",
      [
        'const mod = require("vuln");',
        "const { run } = mod;",
        "function main() { return run(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    const edge = soleEdgeFrom(graph, "main");
    const target = targetOf(graph, edge);

    expect(target?.name, "the exact EXPORT").toBe("run");
    expect(
      target?.module,
      "the exact PackageInstance, not merely a package named `vuln`",
    ).toBe(path.join(root, "node_modules", "vuln", "index.js"));
  });

  it("keeps the two layers separable: the source identifier is what RWF-046 answers about", async () => {
    // `mod` is required once and destructured twice under different local
    // names. Both must land on the same install; neither may be decided
    // by the local name it was bound to.
    const root = packagesProject(["vuln"]);
    const entry = write(
      root,
      "index.js",
      [
        'const mod = require("vuln");',
        "const { run } = mod;",
        "const { run: aliased } = mod;",
        "function first() { return run(); }",
        "function second() { return aliased(); }",
        "module.exports = { first, second };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    const expected = path.join(root, "node_modules", "vuln", "index.js");
    expect(resolvedModuleOf(graph, soleEdgeFrom(graph, "first"))).toBe(
      expected,
    );
    expect(resolvedModuleOf(graph, soleEdgeFrom(graph, "second"))).toBe(
      expected,
    );
  });
});

// --------------------------------------------------------------------
// Section 2 -- the false AFFECTED direction.
// --------------------------------------------------------------------

/**
 * Outer require is VULNERABLE, the inner function-local require is SAFE,
 * and the destructuring happens in the inner scope. The inner call must
 * be decided by the inner binding.
 *
 * This is the shape where the two layers can quietly disagree: RWF-045
 * correctly selects the inner `mod` as the destructuring's source, and
 * then RWF-046 must be asked about THAT declaration. Asking about the
 * name `mod` instead finds the file-scope vulnerable require and reports
 * an exposure the program does not have.
 */
describe("cross-layer sec 2: an inner safe require must not inherit outer vulnerable provenance", () => {
  it("resolves the inner destructuring to the INNER install", async () => {
    const root = packagesProject(["vulnerable-mod", "safe-mod"]);
    const entry = write(
      root,
      "index.js",
      [
        'const mod = require("vulnerable-mod");',
        "function inner() {",
        '  const mod = require("safe-mod");',
        "  const { run } = mod;",
        "  return run();",
        "}",
        "module.exports = { inner };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    const module = resolvedModuleOf(graph, soleEdgeFrom(graph, "inner"));

    expect(module).toBe(
      path.join(root, "node_modules", "safe-mod", "index.js"),
    );
    expect(
      module,
      "the outer vulnerable require must not reach the inner call",
    ).not.toContain(path.join("node_modules", "vulnerable-mod"));
  });

  it("does not contaminate the outer reference either", async () => {
    const root = packagesProject(["vulnerable-mod", "safe-mod"]);
    const entry = write(
      root,
      "index.js",
      [
        'const mod = require("vulnerable-mod");',
        "const { run } = mod;",
        "function outer() { return run(); }",
        "function inner() {",
        '  const mod = require("safe-mod");',
        "  const { run } = mod;",
        "  return run();",
        "}",
        "module.exports = { outer, inner };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expect(resolvedModuleOf(graph, soleEdgeFrom(graph, "outer"))).toBe(
      path.join(root, "node_modules", "vulnerable-mod", "index.js"),
    );
    expect(resolvedModuleOf(graph, soleEdgeFrom(graph, "inner"))).toBe(
      path.join(root, "node_modules", "safe-mod", "index.js"),
    );
  });
});

// --------------------------------------------------------------------
// Section 3 -- the false NOT_AFFECTED direction, with the proof checked.
// --------------------------------------------------------------------

const RULE: VulnerableSymbolRule = {
  id: "GHSA-fixture-cross-layer",
  package: { name: "vulnerable-mod" },
  targets: [
    {
      module: "vulnerable-mod",
      export: "run",
      kind: "function",
      confidence: 1.0,
    },
  ],
};

const VULNERABILITY: Vulnerability = {
  id: "GHSA-fixture-cross-layer",
  aliases: [],
  package: "vulnerable-mod",
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
  readonly unknownEdges: number;
  readonly reachesVulnerableRun: boolean;
  readonly reachesSafeRun: boolean;
  /**
   * Whether BOTH twins exist as nodes. Without this the "did not borrow"
   * assertion is vacuous: a graph that never built the safe `run` node at
   * all would satisfy it while proving nothing. This is D-15's rule -- a
   * negative test needs a fixture that can fail loudly.
   */
  readonly bothRunNodesExist: boolean;
}

/**
 * Builds the project, the graph, the closure and the finding, and reports
 * the negative-proof shape as OBJECTS rather than prose -- the same rule
 * RWF-045's verdict oracle follows, because a reason string can say
 * "unreachable" while the evidence that licenses NOT_AFFECTED is absent,
 * and the converse.
 */
async function runVerdict(entrySrc: string): Promise<Outcome> {
  const root = packagesProject(["vulnerable-mod", "safe-mod"]);
  const entry = write(root, "index.js", entrySrc);

  const project = loadTsProject(root);
  const resolver = createModuleResolver(project);
  const instanceDir = path.join(root, "node_modules", "vulnerable-mod");
  const instance = canonicalizePackageInstancePath(instanceDir);
  const knownPackageRoots = buildKnownPackageRoots(
    [
      {
        id: "vulnerable-mod@0",
        name: "vulnerable-mod",
        version: "1.0.0",
        ecosystem: "npm",
        direct: true,
        locations: [instanceDir],
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
    vulnerability: VULNERABILITY,
    packageName: "vulnerable-mod",
    packageVersion: "1.0.0",
    packageInstance: instance,
    matchResult: "affected",
    rule: RULE,
    graph,
    entrypoints,
    resolver,
    projectRoot: root,
    knownPackageRoots,
    moduleLoadClosure: closure,
    graphTruncated: false,
  });

  const evidence = finding?.evidence;
  const nodeIn = (dir: string): GraphNode | undefined =>
    graph.nodes.find(
      (n) =>
        n.name === "run" &&
        n.module === path.join(root, "node_modules", dir, "index.js"),
    );
  const resolvedTo = (id: string | undefined): boolean =>
    id !== undefined &&
    graph.edges.some(
      (e) => e.resolution.kind === "resolved" && e.resolution.target === id,
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
    unknownEdges: graph.edges.filter((e) => e.resolution.kind === "unknown")
      .length,
    reachesVulnerableRun: resolvedTo(nodeIn("vulnerable-mod")?.id),
    reachesSafeRun: resolvedTo(nodeIn("safe-mod")?.id),
    bothRunNodesExist:
      nodeIn("vulnerable-mod") !== undefined &&
      nodeIn("safe-mod") !== undefined,
  };
}

/**
 * Outer require is SAFE; the inner function-local require is VULNERABLE
 * and its destructured export is really called. Borrowing the outer safe
 * provenance would hide a real exposure, and -- by the displacement
 * argument -- would ALSO remove the unresolved edge that withholds
 * `reachableSubgraphComplete`, letting family C certify the subgraph.
 * That is what makes it a false NOT_AFFECTED rather than merely a missed
 * edge.
 */
const INNER_IS_VULNERABLE = [
  'const mod = require("safe-mod");',
  "function inner() {",
  '  const mod = require("vulnerable-mod");',
  "  const { run } = mod;",
  "  return run();",
  "}",
  "module.exports = { inner };",
  "",
].join("\n");

describe("cross-layer sec 3: an inner vulnerable require must not borrow safe outer provenance", () => {
  it("reaches the VULNERABLE run and does not publish NOT_AFFECTED", async () => {
    const outcome = await runVerdict(INNER_IS_VULNERABLE);

    expect(
      outcome.bothRunNodesExist,
      "both `run` targets must exist, so borrowing the safe one was POSSIBLE",
    ).toBe(true);
    expect(
      outcome.reachesVulnerableRun,
      "the real call into the vulnerable export must be in the graph",
    ).toBe(true);
    expect(
      outcome.reachesSafeRun,
      "the outer safe require must not have answered for the inner call",
    ).toBe(false);
    expect(outcome.verdict).not.toBe("NOT_AFFECTED");
  });

  it("builds NO negative proof on this resolution", async () => {
    const outcome = await runVerdict(INNER_IS_VULNERABLE);

    // The specific thing a borrowed safe provenance would have bought:
    // a family C proof certifying the vulnerable target unreachable.
    expect(
      outcome.family,
      "no confirmed-unreachable-target proof may be built here",
    ).not.toBe("C");
    expect(outcome.reachableSubgraphComplete).toBe(false);
  });

  /**
   * The refusal control. If the composition ever degrades to a REFUSAL
   * instead of a resolution, that is acceptable for precision -- but the
   * refusal must not then be laundered into a negative proof. An
   * `unknown` edge is a blocker, and a blocker must withhold family C.
   */
  it("never converts a refusal into a negative proof", async () => {
    const outcome = await runVerdict(INNER_IS_VULNERABLE);
    if (outcome.unknownEdges > 0) {
      expect(
        outcome.family,
        "an unresolved edge must withhold family C, never license it",
      ).not.toBe("C");
    }
    expect(outcome.verdict).not.toBe("NOT_AFFECTED");
  });
});

// --------------------------------------------------------------------
// Section 4 -- sibling same-name locals, each with its own require.
// --------------------------------------------------------------------

describe("cross-layer sec 4: sibling functions destructure from their own require", () => {
  it("keeps two same-named locals in different functions apart", async () => {
    const root = packagesProject(["pkg-a", "pkg-b"]);
    const entry = write(
      root,
      "index.js",
      [
        "function a() {",
        '  const mod = require("pkg-a");',
        "  const { run } = mod;",
        "  return run();",
        "}",
        "function b() {",
        '  const mod = require("pkg-b");',
        "  const { run } = mod;",
        "  return run();",
        "}",
        "module.exports = { a, b };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);

    expect(resolvedModuleOf(graph, soleEdgeFrom(graph, "a"))).toBe(
      path.join(root, "node_modules", "pkg-a", "index.js"),
    );
    expect(resolvedModuleOf(graph, soleEdgeFrom(graph, "b"))).toBe(
      path.join(root, "node_modules", "pkg-b", "index.js"),
    );
  });
});

// --------------------------------------------------------------------
// Section 5 -- a reassigned source feeding a destructuring.
// --------------------------------------------------------------------

/**
 * `mod` is require-bound and then REASSIGNED before the destructuring
 * reads it. RWF-046's reassignment rule makes the require provenance
 * stale, and RWF-045's bridge must not resolve the source anyway. The
 * composition has to fail CLOSED: one layer proving the source
 * identifier exactly must not resurrect provenance the other layer
 * withdrew.
 */
describe("cross-layer sec 5: a reassigned source fails closed", () => {
  it('refuses `let mod = require("safe"); mod = other; const { run } = mod; run()`', async () => {
    const root = packagesProject(["safe", "other-pkg"]);
    const entry = write(
      root,
      "index.js",
      [
        'let mod = require("safe");',
        'const other = require("other-pkg");',
        "mod = other;",
        "const { run } = mod;",
        "function main() { return run(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expectUnknown(graph, "main");
  });

  it("refuses a reassignment written AFTER the destructuring too", async () => {
    // Textual order must not be what licenses the answer: the binding is
    // rebound somewhere in its scope, which is the whole rule.
    const root = packagesProject(["safe", "other-pkg"]);
    const entry = write(
      root,
      "index.js",
      [
        'let mod = require("safe");',
        "const { run } = mod;",
        "function main() { return run(); }",
        'mod = require("other-pkg");',
        "module.exports = { main };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expectUnknown(graph, "main");
  });
});

// --------------------------------------------------------------------
// Section 6 -- a refused key on an exactly-resolved source.
// --------------------------------------------------------------------

/**
 * The layering test that matters most for regression: RWF-045 resolves
 * the SOURCE exactly (`mod` is unambiguous, const, and require-bound in
 * the same scope), and the binding element is nonetheless one RWF-046's
 * boundary refuses -- a rest element, a default, a computed key, or an
 * array position. Proving the source must not be mistaken for proving
 * the KEY. These are exactly the shapes RWF-046a fabricated by falling
 * back to the local identifier's text.
 *
 * The fixture package exports every name these cases bind, so a
 * regression RESOLVES loudly rather than degrading to
 * `unresolved_target` -- the sec J rule, carried across the layer
 * boundary.
 */
describe("cross-layer sec 6: a refused key survives an exactly-resolved source", () => {
  const refused: ReadonlyArray<readonly [string, readonly string[]]> = [
    [
      "rest element",
      ['const mod = require("vuln");', "const { ...run } = mod;"],
    ],
    [
      "rest element after a named one",
      ['const mod = require("vuln");', "const { a, ...run } = mod;"],
    ],
    [
      "defaulted element",
      [
        'const mod = require("vuln");',
        "const fallback = () => {};",
        "const { run = fallback } = mod;",
      ],
    ],
    [
      "computed key",
      [
        'const mod = require("vuln");',
        'const k = "run";',
        "const { [k]: run } = mod;",
      ],
    ],
    [
      "array pattern position 0",
      ['const mod = require("vuln");', "const [run] = mod;"],
    ],
    [
      "array pattern position 1",
      ['const mod = require("vuln");', "const [, run] = mod;"],
    ],
  ];

  for (const [label, declaration] of refused) {
    it(`REFUSES ${label} even though the source resolves exactly`, async () => {
      const root = packagesProject(["vuln"]);
      const entry = write(
        root,
        "index.js",
        [
          ...declaration,
          "function main() { return run(); }",
          "module.exports = { main };",
        ].join("\n"),
      );
      const graph = await graphFor(root, entry);
      expectUnknown(graph, "main");
    });
  }

  it("positive control: the same source with a plain key DOES resolve", async () => {
    // Without this, every assertion above would pass against a layer that
    // had simply stopped resolving anything through a require-bound source.
    const root = packagesProject(["vuln"]);
    const entry = write(
      root,
      "index.js",
      [
        'const mod = require("vuln");',
        "const { run } = mod;",
        "function main() { return run(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expect(resolvedModuleOf(graph, soleEdgeFrom(graph, "main"))).toBe(
      path.join(root, "node_modules", "vuln", "index.js"),
    );
  });
});

// --------------------------------------------------------------------
// Section 7 -- PackageInstance twins, and what a collapse actually costs.
// --------------------------------------------------------------------

/**
 * Two installs of the SAME package at the SAME version, one top-level and
 * one nested under `wrapper`, both exporting `run`, both reached through
 * a local binding spelled `mod`. Every textual key is identical; only the
 * install path differs.
 *
 * `wrapper`'s own code requires and destructures in its own file, so the
 * honest answer is wrapper's NESTED install. The top-level twin is a live,
 * resolvable node in the same graph -- the app resolves to it directly --
 * which is what makes the mutation below a BORROW rather than a loss.
 */
describe("cross-layer sec 7: PackageInstance twins", () => {
  interface Twins {
    readonly graph: CallGraph;
    readonly nestedFile: string;
    readonly topFile: string;
  }

  async function twinGraph(): Promise<Twins> {
    const root = tempProject();
    write(root, "package.json", JSON.stringify({ name: "app" }));

    const manifest = JSON.stringify({
      name: "lib",
      version: "1.0.0",
      main: "index.js",
    });
    const libSource = (which: string): string =>
      `function run() {\n  return "${which}";\n}\nmodule.exports = { run };\n`;

    // The top-level install -- the decoy, and a legitimate target.
    write(root, "node_modules/lib/package.json", manifest);
    write(root, "node_modules/lib/index.js", libSource("top"));

    // The nested install -- same name, same version, same export.
    write(root, "node_modules/wrapper/node_modules/lib/package.json", manifest);
    write(
      root,
      "node_modules/wrapper/node_modules/lib/index.js",
      libSource("nested"),
    );
    write(
      root,
      "node_modules/wrapper/package.json",
      JSON.stringify({ name: "wrapper", version: "1.0.0", main: "index.js" }),
    );
    write(
      root,
      "node_modules/wrapper/index.js",
      [
        'const mod = require("lib");',
        "const { run } = mod;",
        "function callIt() { return run(); }",
        "module.exports = { callIt };",
      ].join("\n"),
    );

    const entry = write(
      root,
      "src/index.js",
      [
        'const wrapper = require("wrapper");',
        'const mod = require("lib");',
        "const { run } = mod;",
        "function viaWrapper() { return wrapper.callIt(); }",
        "function viaTop() { return run(); }",
        "module.exports = { viaWrapper, viaTop };",
      ].join("\n"),
    );

    const resolver = createModuleResolver(loadTsProject(root));
    const graph = await buildCallGraph({ entryFiles: [entry], resolver });
    return {
      graph,
      nestedFile: path.join(
        root,
        "node_modules",
        "wrapper",
        "node_modules",
        "lib",
        "index.js",
      ),
      topFile: path.join(root, "node_modules", "lib", "index.js"),
    };
  }

  it("resolves wrapper's destructuring to wrapper's OWN nested install", async () => {
    const { graph, nestedFile, topFile } = await twinGraph();
    const callIt = graph.nodes.find(
      (n) => n.name === "callIt" && n.module.includes("wrapper"),
    );
    expect(callIt, "wrapper's callIt should be in the graph").toBeDefined();

    const edges = graph.edges.filter((e) => e.from === callIt?.id);
    expect(edges).toHaveLength(1);
    const target = targetOf(graph, edges[0] as CallEdge);

    expect(target?.name).toBe("run");
    expect(
      target?.module,
      "must be wrapper's own nested lib, never the top-level twin",
    ).toBe(nestedFile);
    expect(target?.module).not.toBe(topFile);
  });

  it("resolves the app's own destructuring to the TOP-LEVEL install", async () => {
    // The sibling is a real, resolvable target in this same graph. That is
    // what the next test needs in order to distinguish a borrow from a loss.
    const { graph, topFile } = await twinGraph();
    expect(resolvedModuleOf(graph, soleEdgeFrom(graph, "viaTop"))).toBe(
      topFile,
    );
  });

  /**
   * THE MUTATION. A name-keyed collapse does not delete wrapper's edge --
   * it redirects it onto the SIBLING install, because the sibling is what
   * a file-wide, first-match lookup for the name `mod` finds. Those two
   * failure modes are not interchangeable: a lost edge leaves an
   * `unknown` blocker standing, while a borrowed edge is RESOLVED and
   * therefore withdraws the blocker (RWF-043 sec 1). This test asserts the
   * mutation is the borrowing one by constructing it and checking it is
   * observably different from the deletion.
   */
  it("a collapse BORROWS the sibling install rather than losing the edge", async () => {
    const { graph, nestedFile, topFile } = await twinGraph();
    const callIt = graph.nodes.find(
      (n) => n.name === "callIt" && n.module.includes("wrapper"),
    );
    const honest = graph.edges.find((e) => e.from === callIt?.id);
    expect(honest).toBeDefined();
    const siblingRun = graph.nodes.find(
      (n) => n.name === "run" && n.module === topFile,
    );
    expect(
      siblingRun,
      "the sibling twin must exist as a resolvable node for this to be a borrow",
    ).toBeDefined();

    // The collapse: wrapper's edge redirected onto the sibling.
    const borrowed: CallGraph = {
      nodes: graph.nodes,
      edges: graph.edges.map((e) =>
        e === honest
          ? {
              ...e,
              resolution: {
                kind: "resolved" as const,
                target: (siblingRun as GraphNode).id,
              },
            }
          : e,
      ),
    };
    // The deletion, for contrast.
    const lost: CallGraph = {
      nodes: graph.nodes,
      edges: graph.edges.filter((e) => e !== honest),
    };

    const resolvedRunModules = (g: CallGraph): string[] =>
      g.edges
        .filter((e) => e.resolution.kind === "resolved")
        .map((e) =>
          g.nodes.find(
            (n) =>
              e.resolution.kind === "resolved" && n.id === e.resolution.target,
          ),
        )
        .filter((n): n is GraphNode => n?.name === "run")
        .map((n) => n.module);

    // The honest graph attributes the nested install and no sibling edge
    // from wrapper.
    expect(resolvedRunModules(graph)).toContain(nestedFile);

    // The borrow ADDS an attribution to the sibling and REMOVES the
    // nested one -- a wrong resolved edge, not an absent one.
    const borrowedModules = resolvedRunModules(borrowed);
    expect(
      borrowedModules.filter((m) => m === nestedFile),
      "the collapse removes the honest nested attribution",
    ).toEqual([]);
    expect(
      borrowedModules.filter((m) => m === topFile).length,
      "and replaces it with the SIBLING install -- the borrow",
    ).toBeGreaterThan(
      resolvedRunModules(lost).filter((m) => m === topFile).length,
    );

    // And the two mutations are genuinely distinguishable: deletion loses
    // the edge, the borrow keeps an edge count identical to the honest graph.
    expect(borrowed.edges).toHaveLength(graph.edges.length);
    expect(lost.edges).toHaveLength(graph.edges.length - 1);
  });
});

// --------------------------------------------------------------------
// Section 8 -- the const-ness divergence, pinned deliberately.
// --------------------------------------------------------------------

/**
 * THE DIVERGENCE, RECORDED RATHER THAN RECONCILED.
 *
 * The two layers apply DIFFERENT stability rules, and the audit recorded
 * it as a real divergence rather than an accident:
 *
 *   RWF-045's destructuring bridge requires the destructuring declaration
 *   to be `const`. A `let` pattern is refused whether or not anything
 *   ever writes to it.
 *
 *   RWF-046's require path uses the REASSIGNMENT rule instead: a `let`
 *   binding with no write in scope is stable enough to carry provenance,
 *   so `let { run } = require("pkg")` resolves.
 *
 * So the same `let` is accepted on one path and refused on the other, and
 * which path a declaration takes is decided by its INITIALIZER SHAPE --
 * a `require("literal")` call takes RWF-046's, a plain identifier takes
 * RWF-045's. These tests pin that divergence so it is visible and
 * deliberate. Reconciling the two rules is explicitly NOT this task; if
 * one is later changed to match the other, these assertions are where the
 * decision has to be made consciously.
 */
describe("cross-layer sec 8: the const-ness divergence is deliberate", () => {
  it('RWF-046\'s path PERMITS `let { run } = require("pkg")` with no write', async () => {
    const root = packagesProject(["pkg"]);
    const entry = write(
      root,
      "index.js",
      [
        'let { run } = require("pkg");',
        "function main() { return run(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expect(
      resolvedModuleOf(graph, soleEdgeFrom(graph, "main")),
      "the require path uses the reassignment rule, not const-ness",
    ).toBe(path.join(root, "node_modules", "pkg", "index.js"));
  });

  it("and still REFUSES the same `let` once it is written to", async () => {
    const root = packagesProject(["pkg"]);
    const entry = write(
      root,
      "index.js",
      [
        'let { run } = require("pkg");',
        "run = null;",
        "function main() { return run(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expectUnknown(graph, "main");
  });

  it("RWF-045's bridge REFUSES `let { run } = mod` with no write at all", async () => {
    const root = packagesProject(["pkg"]);
    const entry = write(
      root,
      "index.js",
      [
        'const mod = require("pkg");',
        "let { run } = mod;",
        "function main() { return run(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    const graph = await graphFor(root, entry);
    expectUnknown(graph, "main");
  });

  it("the divergence is decided by INITIALIZER SHAPE, not by the pattern", async () => {
    // Identical pattern, identical local name, identical package, one
    // `let` each. The only difference is whether the initializer is the
    // require call itself or an identifier bound to it -- and that is
    // what selects which rule applies.
    const root = packagesProject(["pkg"]);
    const direct = write(
      root,
      "direct.js",
      [
        'let { run } = require("pkg");',
        "function main() { return run(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    const indirect = write(
      root,
      "indirect.js",
      [
        'const mod = require("pkg");',
        "let { run } = mod;",
        "function main() { return run(); }",
        "module.exports = { main };",
      ].join("\n"),
    );
    const directGraph = await graphFor(root, direct);
    const indirectGraph = await graphFor(root, indirect);

    expect(soleEdgeFrom(directGraph, "main").resolution.kind).toBe("resolved");
    expect(soleEdgeFrom(indirectGraph, "main").resolution.kind).toBe("unknown");
  });
});
