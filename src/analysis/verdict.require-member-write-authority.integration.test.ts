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
import {
  EDGE_DOMAIN,
  VERDICT_DOMAIN,
  loadDefectRegisters,
  openSoundnessDefectProblems,
  type EdgeObservation,
  type EdgePattern,
  type OpenSoundnessDefect,
  type OutcomeDomain,
  type Verdict,
  type VerdictObservation,
} from "../testing/open-soundness-defect.js";

/**
 * RWF-047 -- THE VERDICT ORACLE FOR A MEMBER WRITE ON A REQUIRE-BOUND
 * MODULE OBJECT.
 *
 * THIS FILE REPRODUCES AN OPEN SOUNDNESS DEFECT WITHOUT PINNING IT. No
 * assertion here states a wrong result as its expected outcome (AGENTS.md
 * section G). Every case the defect reaches is an open-soundness-defect
 * record (`src/testing/open-soundness-defect.ts`): the SOUND outcomes are
 * `admissible`, the fail-closed fix's outcome is `expected`, and the exact
 * wrong result the analyzer gives today -- verdict, proof family, call-site
 * target, completeness flag, unresolved-edge count -- is `observed`, kept
 * apart from the expectation. Each record names RWF-047 and OPEN-DEBTS
 * D-16. It FAILS if the live result changes in any way: when RWF-047 is
 * fixed (the fix PR deletes the record and asserts `expected`), and when
 * the defect drifts into a different wrong result. The fix is a separate
 * task, deliberately, because the fix differs by class and deciding the
 * class under time pressure from a green test is how the class gets
 * assumed rather than established.
 *
 * (History: until the RWF-047 close-out these cases were named `DEFECT:`
 * and asserted the wrong verdict directly. See
 * `docs/tasks/RWF-047-classification-closeout.md`.)
 *
 * THE SHAPE.
 *
 * ```js
 * const mod = require("pkg");
 * mod.run = patched;
 * mod.run();          // the analyzer says pkg#run; node says patched
 * ```
 *
 * `named-bindings.ts` exposes `isMemberAssignedWithin`, and
 * `resolveNamedReceiverBinding` consults it for an OBJECT-LITERAL receiver:
 * `const obj = { m: danger }; obj.m = safe; obj.m()` correctly refuses,
 * because a `const` binding to an object literal freezes the BINDING and
 * not the OBJECT. A require-bound module object has exactly the same
 * property -- `const` freezes `mod`, not `mod.run` -- and the require/import
 * resolution path consults no equivalent check.
 *
 * GROUND TRUTH is established separately and by execution, not by argument:
 * `fixtures/require-member-write-ground-truth/entry.js` is a plain Node
 * program, run with `node entry.js`, whose every claim is `assert`ed
 * in-process. It measures that the write really does displace the export,
 * that the require cache makes the write visible to every other consumer
 * of the same instance, and what each widened shape does.
 *
 * THE LOUD-FIXTURE RULE (RWF-048 § 2) applies here too and is asserted
 * rather than assumed: the fixture package exports every name these cases
 * bind, INCLUDING `patched`. Against a package missing the name a stale
 * attribution would degrade to `unresolved_target` and read as an honest
 * UNKNOWN -- the hiding mechanism that concealed the RWF-046 array hole
 * behind a green suite. `the wrong attribution would have been observable`
 * below asserts that positively.
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

/**
 * The package under advisory. LOUD: it exports `patched` as well as `run`
 * and `danger`, so a fabricated attribution to the LOCAL name `patched`
 * would RESOLVE and be visible rather than degrade into UNKNOWN.
 */
const PKG_SRC = [
  "function run(x) { return x; }",
  "function danger(x) { return x; }",
  "function patched(x) { return x; }",
  "function safe(x) { return x; }",
  "module.exports = { run, danger, patched, safe };",
  "",
].join("\n");

const vulnerability: Vulnerability = {
  id: "GHSA-fixture-rwf047",
  aliases: [],
  package: "pkg",
  ecosystem: "npm",
  affectedVersions: [],
  fixedVersions: [],
  references: [],
};

function ruleFor(exportName: string): VulnerableSymbolRule {
  return {
    id: "GHSA-fixture-rwf047",
    package: { name: "pkg" },
    targets: [
      { module: "pkg", export: exportName, kind: "function", confidence: 1.0 },
    ],
  };
}

interface Outcome {
  readonly verdict: string | undefined;
  /** "C" when the negative proof is a confirmed-unreachable-target proof. */
  readonly family: string;
  readonly reachableSubgraphComplete: boolean;
  readonly unknownEdges: number;
  /** Whether any edge resolves to the named export of the package. */
  resolvesTo(exportName: string): boolean;
  /**
   * The single call edge leaving `normalize` -- the `mod.run(input)` /
   * `holder.run(input)` call site every program here probes.
   */
  readonly callSite: EdgeObservation;
  /** The verdict-level observation an open-defect record compares. */
  readonly observation: VerdictObservation;
}

function formatEdge(e: EdgeObservation): string {
  switch (e.kind) {
    case "exact":
      return e.target;
    case "unknown":
      return `UNKNOWN ${e.reason}`;
    case "no-edge":
      return "NO-EDGE";
    case "ambiguous":
      return `AMBIGUOUS(${e.count})`;
    case "no-probe":
      return "NO-PROBE";
  }
}

async function run(options: {
  readonly entrySrc: string;
  readonly target: string;
}): Promise<Outcome> {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-rwf047-oracle-"));
  tempDirs.push(root);
  const write = (rel: string, content: string): string => {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
    return p;
  };

  write("package.json", JSON.stringify({ name: "app" }));
  write(
    "node_modules/pkg/package.json",
    JSON.stringify({ name: "pkg", version: "1.0.0", main: "index.js" }),
  );
  write("node_modules/pkg/index.js", PKG_SRC);
  const entry = write("src/index.js", options.entrySrc);

  const project = loadTsProject(root);
  const resolver = createModuleResolver(project);
  const instance = canonicalizePackageInstancePath(
    path.join(root, "node_modules/pkg"),
  );
  const knownPackageRoots = buildKnownPackageRoots(
    [
      {
        id: "pkg@0",
        name: "pkg",
        version: "1.0.0",
        ecosystem: "npm",
        direct: true,
        locations: [path.join(root, "node_modules/pkg")],
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
    packageName: "pkg",
    packageVersion: "1.0.0",
    packageInstance: instance,
    matchResult: "affected",
    rule: ruleFor(options.target),
    graph,
    entrypoints,
    resolver,
    projectRoot: root,
    knownPackageRoots,
    moduleLoadClosure: closure,
    graphTruncated: false,
  });

  const evidence = finding?.evidence;
  const family = evidence?.confirmedAbsentFromModuleLoadClosure
    ? "A"
    : evidence?.confirmedAbsentInstance
      ? "B"
      : evidence?.confirmedUnreachableTarget
        ? "C"
        : "-";
  const reachableSubgraphComplete =
    evidence?.confirmedUnreachableTarget?.reachableSubgraphComplete ?? false;
  const unknownEdges = graph.edges.filter(
    (e) => e.resolution.kind === "unknown",
  ).length;

  let callSite: EdgeObservation;
  const probe = graph.nodes.find((n) => n.name === "normalize");
  const probeEdges = probe
    ? graph.edges.filter((e) => e.from === probe.id && e.type !== "module_load")
    : [];
  const [edge] = probeEdges;
  if (!probe) {
    callSite = { kind: "no-probe" };
  } else if (!edge) {
    callSite = { kind: "no-edge" };
  } else if (probeEdges.length > 1) {
    callSite = { kind: "ambiguous", count: probeEdges.length };
  } else if (edge.resolution.kind === "unknown") {
    callSite = { kind: "unknown", reason: edge.resolution.reason };
  } else {
    const targetId = edge.resolution.target;
    const node = graph.nodes.find((n) => n.id === targetId);
    callSite = node
      ? {
          kind: "exact",
          target: `${path
            .relative(root, node.module)
            .split(path.sep)
            .join("/")}#${node.name ?? "<anonymous>"}`,
        }
      : { kind: "no-edge" };
  }

  return {
    verdict: finding?.verdict,
    family,
    reachableSubgraphComplete,
    unknownEdges,
    callSite,
    observation: {
      verdict: finding?.verdict as Verdict | undefined,
      proofFamily: family,
      target: formatEdge(callSite),
      reachableSubgraphComplete,
      unknownEdges,
    },
    resolvesTo(exportName: string): boolean {
      const node = graph.nodes.find(
        (n) => n.name === exportName && n.module.includes("node_modules/pkg"),
      );
      return (
        node !== undefined &&
        graph.edges.some(
          (e) =>
            e.resolution.kind === "resolved" && e.resolution.target === node.id,
        )
      );
    },
  };
}

// ---------------------------------------------------------------------------
// STEP 1 -- THE FALSE-AFFECTED DIRECTION.
//
// `run` is the vulnerable export; `patched` is a SAFE local function. The
// program overwrites the export before calling it, so `pkg#run`'s body never
// executes. Ground truth, asserted in the fixture (row D1):
//
//   mod.run = patched; mod.run()  ->  local#patched, and `pkg#run` never ran.
// ---------------------------------------------------------------------------
const OVERWRITES_THE_VULNERABLE_EXPORT = [
  "const mod = require('pkg');",
  "",
  "function patched(x) { return x; }",
  "",
  "function normalize(input) {",
  "  mod.run = patched;",
  "  return mod.run(input);",
  "}",
  "",
  "module.exports = { normalize };",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// STEP 2 -- THE FALSE-NOT_AFFECTED DIRECTION (the displacement case).
//
// `danger` is the vulnerable export; `run` is a SAFE one. The program
// replaces `mod.run` with a local wrapper WHOSE BODY CALLS THE VULNERABLE
// EXPORT, and then calls `mod.run()`. Real node therefore executes
// `pkg#danger` on this path -- asserted in the fixture (row P3).
//
// The analyzer instead resolves `mod.run()` to the stale `pkg#run`. Two
// things follow, and the SECOND is the one that settles the class:
//
//   1. the wrong callable is named; and
//   2. the call site carries a RESOLVED edge where the honest answer is
//      unresolved, so no `unknown` blocker survives at that site.
//
// `wrapper` is then an orphan -- nothing in the graph calls it -- so the
// vulnerable export is absent from the REACHABLE subgraph, the subgraph
// reads as completely enumerated, Family C certifies it, and the published
// verdict is NOT_AFFECTED over a call the program really makes.
// ---------------------------------------------------------------------------
const DISPLACES_THE_HONEST_BLOCKER = [
  "const mod = require('pkg');",
  "",
  "function wrapper(x) { return mod.danger(x); }",
  "",
  "function normalize(input) {",
  "  mod.run = wrapper;",
  "  return mod.run(input);",
  "}",
  "",
  "module.exports = { normalize };",
  "",
].join("\n");

/**
 * STEP 2's CONTROL. The identical program with the member write REMOVED,
 * so `mod.run()` honestly does reach `pkg#run` and `pkg#danger` honestly is
 * unreachable. A NOT_AFFECTED here is CORRECT. It is the row that proves
 * the Step 2 result is caused by the write and not by the fixture merely
 * being unable to reach anything.
 */
const HONEST_UNREACHABLE = [
  "const mod = require('pkg');",
  "",
  "function wrapper(x) { return mod.danger(x); }",
  "",
  "function normalize(input) {",
  "  return mod.run(input);",
  "}",
  "",
  "module.exports = { normalize };",
  "",
].join("\n");

/**
 * STEP 2's TWIN, with the receiver changed to a LOCAL OBJECT LITERAL and
 * NOTHING else. Same wrapper, same write, same call, same advisory. This
 * is the sharpest statement of the asymmetry: the displacement chain that
 * closes for a require-bound receiver does NOT close here, because
 * `isMemberAssignedWithin` withholds the resolution, the `unknown` edge
 * survives, and `reachableSubgraphComplete` is withheld with it.
 */
const DISPLACEMENT_OBJECT_LITERAL_TWIN = [
  "const mod = require('pkg');",
  "",
  "const holder = { run: mod.safe };",
  "function wrapper(x) { return mod.danger(x); }",
  "",
  "function normalize(input) {",
  "  holder.run = wrapper;",
  "  return holder.run(input);",
  "}",
  "",
  "module.exports = { normalize };",
  "",
].join("\n");

/**
 * THE ASYMMETRY CONTROL. The covered case: the same write against a LOCAL
 * OBJECT LITERAL. `isMemberAssignedWithin` governs this receiver, the
 * resolution is refused, and the verdict is UNKNOWN. Without this row the
 * Step 1/Step 2 results would merely be "the analyzer resolves member
 * calls"; with it they are an asymmetry between two receivers that have
 * the same mutability property.
 */
const OBJECT_LITERAL_CONTROL = [
  "const pkg = require('pkg');",
  "",
  "const obj = { run: pkg.danger };",
  "function patched(x) { return x; }",
  "",
  "function normalize(input) {",
  "  obj.run = patched;",
  "  return obj.run(input);",
  "}",
  "",
  "module.exports = { normalize };",
  "",
].join("\n");

const registers = loadDefectRegisters();

function expectOpenDefect<Pattern, Outcome>(
  record: OpenSoundnessDefect<Pattern, Outcome>,
  domain: OutcomeDomain<Pattern, Outcome>,
  live: Outcome,
): void {
  expect(
    openSoundnessDefectProblems(record, domain, live, registers),
    `${record.rwf} / ${record.debt}: ${record.caseId}`,
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// THE OPEN-DEFECT RECORDS. Each `observed` is the measured wrong result on
// `main`; none is an expectation. The admissible sets and expectations are
// the ones decided for the RWF-047 close-out (see the task file's
// Corrections).
// ---------------------------------------------------------------------------

/**
 * STEP 1, verdict. Real node never enters `pkg#run` (fixture row D1), so
 * `AFFECTED` is unsound. `NOT_AFFECTED` would be sound but needs a proof
 * this analyzer does not have, so the fail-closed fix gives `UNKNOWN`.
 */
const STEP1_VERDICT: OpenSoundnessDefect<Verdict, VerdictObservation> = {
  caseId: "step 1: vulnerable export overwritten before the call",
  rwf: "RWF-047",
  debt: "D-16",
  admissible: ["UNKNOWN", "NOT_AFFECTED"],
  expected: "UNKNOWN",
  observed: {
    verdict: "AFFECTED",
    proofFamily: "-",
    target: "node_modules/pkg/index.js#run",
    reachableSubgraphComplete: false,
    unknownEdges: 0,
  },
};

/**
 * STEP 1, call site. The write displaces `pkg#run` with the local
 * `patched`, so the only sound EXACT is `patched`'s own declaration. The
 * fail-closed fix refuses; no reason code is pinned, the fix chooses it.
 */
const STEP1_CALL_SITE: OpenSoundnessDefect<EdgePattern, EdgeObservation> = {
  caseId: "step 1: the mod.run(input) call site after mod.run = patched",
  rwf: "RWF-047",
  debt: "D-16",
  admissible: [
    { kind: "refusal" },
    { kind: "exact", target: "src/index.js#patched" },
  ],
  expected: { kind: "refusal" },
  observed: { kind: "exact", target: "node_modules/pkg/index.js#run" },
};

/**
 * STEP 2, verdict. Real node reaches `pkg#danger` through the displacing
 * wrapper (fixture row P3), so `NOT_AFFECTED` is unsound -- the critical
 * failure. `AFFECTED` would be sound; the fail-closed fix gives `UNKNOWN`.
 */
const STEP2_VERDICT: OpenSoundnessDefect<Verdict, VerdictObservation> = {
  caseId: "step 2: a displacing wrapper reaches pkg#danger",
  rwf: "RWF-047",
  debt: "D-16",
  admissible: ["UNKNOWN", "AFFECTED"],
  expected: "UNKNOWN",
  observed: {
    verdict: "NOT_AFFECTED",
    proofFamily: "C",
    target: "node_modules/pkg/index.js#run",
    reachableSubgraphComplete: true,
    unknownEdges: 0,
  },
};

/** STEP 2, call site: the written value is the local `wrapper`. */
const STEP2_CALL_SITE: OpenSoundnessDefect<EdgePattern, EdgeObservation> = {
  caseId: "step 2: the mod.run(input) call site after mod.run = wrapper",
  rwf: "RWF-047",
  debt: "D-16",
  admissible: [
    { kind: "refusal" },
    { kind: "exact", target: "src/index.js#wrapper" },
  ],
  expected: { kind: "refusal" },
  observed: { kind: "exact", target: "node_modules/pkg/index.js#run" },
};

describe("RWF-047: a member write on a require-bound module object (open soundness defect, recorded)", () => {
  // ------------------------------------------------------------------
  // STEP 1 -- the false-AFFECTED direction
  // ------------------------------------------------------------------

  it("is not AFFECTED over an export the program overwrote before calling (known open defect RWF-047)", async () => {
    const outcome = await run({
      entrySrc: OVERWRITES_THE_VULNERABLE_EXPORT,
      target: "run",
    });

    // Ground truth (fixture row D1): `pkg#run`'s body never executes.
    expectOpenDefect(STEP1_VERDICT, VERDICT_DOMAIN, outcome.observation);
  });

  it("refuses the call site after the export is overwritten (known open defect RWF-047)", async () => {
    const outcome = await run({
      entrySrc: OVERWRITES_THE_VULNERABLE_EXPORT,
      target: "run",
    });

    // The evidence the wrong verdict rests on is not a hedge: it is a
    // RESOLVED attribution to a callable the runtime does not reach. The
    // record keeps that measurement without calling it correct.
    expectOpenDefect(STEP1_CALL_SITE, EDGE_DOMAIN, outcome.callSite);
  });

  it("the wrong attribution would have been observable (loud-fixture rule)", async () => {
    const outcome = await run({
      entrySrc: OVERWRITES_THE_VULNERABLE_EXPORT,
      target: "run",
    });

    // `patched` IS an export of the fixture package. Had the analyzer
    // instead attributed the call to the LOCAL name, that attribution
    // would have RESOLVED to `pkg#patched` rather than degrading to
    // `unresolved_target` and reading as an honest UNKNOWN. The name is
    // present, so neither outcome could hide; the one observed is the one
    // that happened.
    expect(
      PKG_SRC.includes("function patched"),
      "the fixture package exports every name these cases bind",
    ).toBe(true);
    expect(
      outcome.resolvesTo("patched"),
      "the analyzer did NOT fabricate onto the local spelling -- this is a text-authority NEGATIVE, distinct from the stale-attribution defect above",
    ).toBe(false);
  });

  // ------------------------------------------------------------------
  // STEP 2 -- the false-NOT_AFFECTED direction (the displacement chain)
  // ------------------------------------------------------------------

  it("is not NOT_AFFECTED when a displacing wrapper reaches the vulnerable export (known open defect RWF-047)", async () => {
    const outcome = await run({
      entrySrc: DISPLACES_THE_HONEST_BLOCKER,
      target: "danger",
    });

    // Ground truth (fixture row P3): the patched wrapper executes and
    // reaches the vulnerable sink on this load. The record's `observed`
    // carries the whole closed chain -- a Family C proof, a complete
    // reachable subgraph, zero unresolved edges -- so ANY link changing
    // fails this test.
    expectOpenDefect(STEP2_VERDICT, VERDICT_DOMAIN, outcome.observation);
  });

  it("refuses the call site after the displacing write (known open defect RWF-047)", async () => {
    const outcome = await run({
      entrySrc: DISPLACES_THE_HONEST_BLOCKER,
      target: "danger",
    });

    // Link 2 of the chain, as its own record. The honest answer at
    // `mod.run()` is "unresolved: a write to this member is in scope"; such
    // an edge is an `unknown` and withholds `reachableSubgraphComplete`.
    expectOpenDefect(STEP2_CALL_SITE, EDGE_DOMAIN, outcome.callSite);
  });

  it("indexes the wrapper's own resolved edge into pkg#danger", async () => {
    const outcome = await run({
      entrySrc: DISPLACES_THE_HONEST_BLOCKER,
      target: "danger",
    });

    // CORRECT today, and stated so the records above cannot be read as
    // "the vulnerable call is invisible". `pkg#danger` DOES carry a
    // resolved incoming edge -- from `wrapper`'s body, which the graph
    // indexes correctly. The displacement does not delete that edge; it
    // orphans `wrapper`, so the edge sits outside the REACHABLE subgraph.
    // That is why the wrong proof is Family C ("confirmed unreachable
    // target") rather than an absence.
    expect(outcome.resolvesTo("danger")).toBe(true);
  });

  it("the identical displacement against an object literal keeps an unresolved edge and is not NOT_AFFECTED", async () => {
    const outcome = await run({
      entrySrc: DISPLACEMENT_OBJECT_LITERAL_TWIN,
      target: "danger",
    });

    // One token changed -- the receiver -- and the chain breaks at exactly
    // the link the require path is missing. This is the asymmetry stated as
    // a differential rather than as two separate observations.
    expect(outcome.verdict).not.toBe("NOT_AFFECTED");
    expect(outcome.reachableSubgraphComplete).toBe(false);
    expect(outcome.unknownEdges).toBeGreaterThan(0);
  });

  it("CONTROL: the same program without the write is honestly NOT_AFFECTED", async () => {
    const outcome = await run({
      entrySrc: HONEST_UNREACHABLE,
      target: "danger",
    });

    // Here NOT_AFFECTED is CORRECT: nothing calls `wrapper`, so `pkg#danger`
    // genuinely is unreachable. This row exists so the Step 2 result cannot
    // be explained by the fixture simply never reaching anything.
    expect(outcome.verdict).toBe("NOT_AFFECTED");
    expect(outcome.family).toBe("C");
  });

  // ------------------------------------------------------------------
  // THE ASYMMETRY -- the covered receiver, same mutability, different answer
  // ------------------------------------------------------------------

  it("CONTROL: the identical write against an object literal is refused", async () => {
    const outcome = await run({
      entrySrc: OBJECT_LITERAL_CONTROL,
      target: "danger",
    });

    // `isMemberAssignedWithin` governs this receiver. The resolution is
    // withheld, an `unknown` edge survives, and the verdict is UNKNOWN --
    // the direction this engine is permitted to fail in.
    expect(outcome.verdict).toBe("UNKNOWN");
    expect(outcome.unknownEdges).toBeGreaterThan(0);
  });
});
