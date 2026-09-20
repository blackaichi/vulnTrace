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
 * RWF-047 -- THE VERDICT ORACLE FOR A MEMBER WRITE ON A REQUIRE-BOUND
 * MODULE OBJECT.
 *
 * THIS FILE CHARACTERISES AN OPEN DEFECT. Every `it` here asserts what the
 * analyzer does TODAY, and several of those assertions record answers that
 * are WRONG against the runtime. The wrongness is not incidental to the
 * test -- it is the measurement the test exists to take, and each such case
 * is named `DEFECT:` and carries the real-`node` row that contradicts it.
 * The fix for RWF-047 is expected to INVERT those cases; it is a separate
 * task, deliberately, because the fix differs by class and deciding the
 * class under time pressure from a green test is how the class gets
 * assumed rather than established.
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

describe("RWF-047: a member write on a require-bound module object (OPEN DEFECT, characterised)", () => {
  // ------------------------------------------------------------------
  // STEP 1 -- false AFFECTED
  // ------------------------------------------------------------------

  it("DEFECT: reports AFFECTED over an export the program overwrote before calling", async () => {
    const outcome = await run({
      entrySrc: OVERWRITES_THE_VULNERABLE_EXPORT,
      target: "run",
    });

    // Ground truth (fixture row D1): `pkg#run`'s body never executes.
    expect(
      outcome.verdict,
      "real node calls the local `patched`; `pkg#run` is never entered",
    ).toBe("AFFECTED");
  });

  it("DEFECT: the AFFECTED verdict rests on a RESOLVED edge into pkg#run", async () => {
    const outcome = await run({
      entrySrc: OVERWRITES_THE_VULNERABLE_EXPORT,
      target: "run",
    });

    // The evidence is not a hedge or a potential target -- it is a fully
    // resolved attribution to a callable the runtime does not reach.
    expect(outcome.resolvesTo("run")).toBe(true);
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
  // STEP 2 -- false NOT_AFFECTED (the displacement chain)
  // ------------------------------------------------------------------

  it("DEFECT: certifies a Family C negative proof over an export the program really reaches", async () => {
    const outcome = await run({
      entrySrc: DISPLACES_THE_HONEST_BLOCKER,
      target: "danger",
    });

    // Ground truth (fixture row P3): the patched wrapper executes and
    // reaches the vulnerable sink on this load.
    expect(outcome.verdict).toBe("NOT_AFFECTED");
    expect(outcome.family, "a confirmed-unreachable-target proof").toBe("C");
    expect(
      outcome.reachableSubgraphComplete,
      "the subgraph reads as completely enumerated because the stale attribution left no unresolved edge at the call site",
    ).toBe(true);
  });

  it("DEFECT: the displacement is what closes the chain -- the honest blocker is gone", async () => {
    const outcome = await run({
      entrySrc: DISPLACES_THE_HONEST_BLOCKER,
      target: "danger",
    });

    // This is link 2 of the chain, stated as its own measurement. The
    // honest answer at `mod.run()` is "unresolved: a write to this member
    // is in scope". Such an edge is an `unknown` and withholds
    // `reachableSubgraphComplete`. There is no such edge.
    expect(
      outcome.unknownEdges,
      "no unresolved edge survives anywhere in the graph",
    ).toBe(0);
    expect(outcome.resolvesTo("run"), "the stale attribution").toBe(true);

    // NOTE on what is NOT asserted here. `pkg#danger` DOES carry a resolved
    // incoming edge -- from `wrapper`'s body, which the graph indexes
    // correctly. The displacement does not delete that edge; it orphans
    // `wrapper`, so the edge sits outside the REACHABLE subgraph. That is
    // precisely why the proof is Family C ("confirmed unreachable target")
    // rather than an absence: the analyzer can see the vulnerable call and
    // certifies that nothing reaches it, because the one thing that does
    // reach it -- the member write -- is the thing it did not model.
    expect(outcome.resolvesTo("danger")).toBe(true);
  });

  it("DEFECT: the identical displacement against an object literal does NOT close", async () => {
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
