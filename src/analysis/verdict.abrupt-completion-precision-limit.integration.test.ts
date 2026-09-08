import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import { buildKnownPackageRoots } from "../domain/resolved-target.js";
import { discoverEntrypoints } from "./entrypoints.js";
import { buildFindingForTest } from "../testing/finding.js";

/**
 * A KNOWN FALSE-AFFECTED PRECISION LIMIT, pinned deliberately.
 *
 * ============================ READ THIS FIRST ============================
 * Every `AFFECTED` this file asserts is WRONG about the language. In every
 * pinned row below, `key()` provably does NOT execute at runtime. These
 * assertions record what the analyzer currently answers; they are NOT a
 * claim that the code runs, and in particular this file must NEVER be read
 * as evidence that a computed class-element key executes after a throwing
 * heritage expression. It does not. See the runtime table below.
 * =========================================================================
 *
 * ## The limitation
 *
 * `analyzeReachability` walks the call graph, and the call graph is a
 * purely structural MAY-reachability over-approximation: it does not model
 * abrupt completion at all. Nothing prunes the statements that follow a
 * `throw`, a call that can only throw, or a class definition that cannot
 * finish. Abrupt-completion reasoning exists in this repository only in
 * module-model.ts, where RWF-016/017/018/019/020/022 use it to decide which
 * CommonJS export WRITE is authoritative -- a different question, on a
 * different graph, with a different (MUST-execute) quantifier.
 *
 * The limitation is therefore cross-family and predates RWF-023. It is
 * visible on plain sequential statements with no class involved at all:
 *
 * ```js
 * bail();   // throws
 * key();    // never runs -- but the analyzer reports it reachable
 * ```
 *
 * ## Runtime truth for every row pinned here (real node v26.7.0)
 *
 * | shape                                          | does key() run? |
 * | ---------------------------------------------- | --------------- |
 * | `bail(); key();`                               | NO              |
 * | `throw new Error("x"); key();`                 | NO              |
 * | `class C extends bail() { [key()] = 1; }`      | NO              |
 * | `class C extends bail() { get [key()]() {} }`  | NO              |
 * | `class C extends bail() { set [key()](v) {} }` | NO              |
 * | `class C extends bail() { [key()]() {} }`      | NO              |
 * | `class C extends bail() { static [key()]() {}}`| NO              |
 * | `throw ...; class C { [key()]() {} }`          | NO              |
 * | `class C { [false && key()] = 1; }`            | NO              |
 * | `class C { [false && key()]() {} }`            | NO              |
 *
 * A class's heritage expression is evaluated FIRST, before any element and
 * therefore before any computed key -- the superclass has to exist before
 * the prototype chain can be built. A heritage call that throws leaves the
 * element list entirely unevaluated. (RWF-020's fixture README documents
 * the same ordering fact from the abrupt side, and RWF-022's covers the
 * contrasting case where the heritage call RETURNS an invalid value, which
 * DOES let the keys run first.)
 *
 * ## Why RWF-023 pinned it rather than fixed it
 *
 * Before RWF-023, a computed key on a METHOD was mis-attributed to the
 * method's own deferred node, so these shapes came back UNKNOWN or
 * NOT_AFFECTED -- accidentally, and for a reason unrelated to abrupt
 * completion. RWF-023 corrected that ownership, which made the method
 * spelling answer the same way its FIELD, GETTER and SETTER siblings
 * already did on base:
 *
 * | shape                                          | base `86c8669` | now      |
 * | ---------------------------------------------- | -------------- | -------- |
 * | `bail(); key();`                               | AFFECTED       | AFFECTED |
 * | `throw ...; key();`                            | AFFECTED       | AFFECTED |
 * | throwing heritage + FIELD key                  | AFFECTED       | AFFECTED |
 * | throwing heritage + GETTER key                 | AFFECTED       | AFFECTED |
 * | throwing heritage + SETTER key                 | AFFECTED       | AFFECTED |
 * | throwing heritage + METHOD key                 | UNKNOWN        | AFFECTED |
 * | throwing heritage + STATIC METHOD key          | UNKNOWN        | AFFECTED |
 * | `throw ...;` then class + METHOD key           | UNKNOWN        | AFFECTED |
 * | `[false && key()]` FIELD                       | AFFECTED       | AFFECTED |
 * | `[false && key()]` GETTER                      | AFFECTED       | AFFECTED |
 * | `[false && key()]` METHOD                      | NOT_AFFECTED   | AFFECTED |
 *
 * So RWF-023 did not invent an abrupt-completion model and did not widen
 * one; it removed an inconsistency, and the pre-existing imprecision became
 * visible through one more spelling. Every movement is toward AFFECTED. No
 * false NOT_AFFECTED and no Family C consequence follows from any of it --
 * an over-approximation can only add findings, never license a negative
 * proof.
 *
 * A local fix inside RWF-023 was rejected deliberately. Gating the new
 * computed-key edge on RWF-020's `isDefinitelyAbruptClassHeritage` would
 * introduce a call-graph -> module-model dependency, would leave the FIELD,
 * GETTER, SETTER and plain-statement spellings untouched, and to be
 * consistent would have to move those from AFFECTED to NOT_AFFECTED -- the
 * one direction a reachability change must never take unilaterally. The
 * proper fix is a unified abrupt-completion-aware reachability model
 * applied across all of these forms at once. See FINDINGS.md, "Reachability
 * does not prune paths after definitely-abrupt evaluation".
 *
 * ## What this file also guards
 *
 * The last test is the positive control: where the analyzer DOES hold a
 * proof that a branch cannot be taken (`if (false)`, via
 * `evaluateConstantBoolean`), RWF-023's new edge respects it. The fix
 * participates in the existing traversal rather than blanket-rooting every
 * computed key, and that distinction is worth a permanent regression.
 */

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(
    path.join(os.tmpdir(), "vulntrace-abrupt-precision-"),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

const PRELUDE = `"use strict";
const dep = require("./danger");

function key() {
  dep.dangerousOp("from-computed-key");
  return "x";
}

function bail() {
  throw new Error("always throws");
}
`;

/** Scans a one-module package whose body is `shape`, for `fixture-lib/danger#dangerousOp`. */
async function verdictFor(shape: string): Promise<{
  readonly verdict: string | undefined;
  readonly familyC: unknown;
}> {
  const root = tempProject();
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "node_modules", "fixture-lib"), {
    recursive: true,
  });

  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "abrupt-precision",
      version: "1.0.0",
      private: true,
      dependencies: { "fixture-lib": "1.0.0" },
    }),
  );
  writeFileSync(
    path.join(root, "node_modules", "fixture-lib", "package.json"),
    JSON.stringify({ name: "fixture-lib", version: "1.0.0", main: "index.js" }),
  );
  writeFileSync(
    path.join(root, "node_modules", "fixture-lib", "danger.js"),
    `"use strict";\nfunction dangerousOp(i) { return "danger:" + i; }\nexports.dangerousOp = dangerousOp;\n`,
  );
  writeFileSync(
    path.join(root, "node_modules", "fixture-lib", "index.js"),
    `${PRELUDE}\n${shape}\n\nmodule.exports = function safeMain(i) { return "safe:" + i; };\n`,
  );
  writeFileSync(
    path.join(root, "src", "index.cjs"),
    `const f = require("fixture-lib");\nmodule.exports = function main(i) { return f(i); };\n`,
  );

  const entry = path.join(root, "src", "index.cjs");
  const resolver = createModuleResolver(loadTsProject(root));
  const knownPackageRoots = buildKnownPackageRoots([], root);

  const [graph, entrypointsResult] = await Promise.all([
    buildCallGraph({ entryFiles: [entry], resolver, knownPackageRoots }),
    discoverEntrypoints({
      projectRoot: root,
      resolver,
      configuredEntrypoints: ["src/index.cjs"],
    }),
  ]);

  const finding = await buildFindingForTest({
    vulnerability: {
      id: "GHSA-rwf-023-precision",
      aliases: [],
      package: "fixture-lib",
      ecosystem: "npm",
      affectedVersions: [{ introduced: "0" }],
      fixedVersions: [],
      references: [],
    },
    packageName: "fixture-lib",
    packageVersion: "1.0.0",
    matchResult: "affected",
    rule: {
      id: "GHSA-rwf-023-precision",
      package: { name: "fixture-lib" },
      targets: [
        {
          module: "fixture-lib/danger",
          export: "dangerousOp",
          kind: "function",
        },
      ],
    },
    graph,
    entrypoints: entrypointsResult.entrypoints,
    resolver,
    projectRoot: root,
    knownPackageRoots,
  });

  return {
    verdict: finding?.verdict,
    familyC: finding?.evidence?.confirmedUnreachableTarget,
  };
}

describe("KNOWN PRECISION LIMIT: reachability does not prune paths after definitely-abrupt evaluation", () => {
  describe("the limitation predates RWF-023 and is not about classes at all", () => {
    it("reports a call after a throwing call as reachable (AFFECTED on base too)", async () => {
      // RUNTIME: key() never runs. AFFECTED is wrong, and was already the
      // answer on base `86c8669`. Nothing about RWF-023 is involved.
      const { verdict } = await verdictFor(`bail();\nkey();`);
      expect(verdict).toBe("AFFECTED");
    });

    it("reports a call after a bare `throw` statement as reachable (AFFECTED on base too)", async () => {
      // RUNTIME: key() never runs. The statement is literally unreachable
      // code, and the call graph still walks it.
      const { verdict } = await verdictFor(`throw new Error("x");\nkey();`);
      expect(verdict).toBe("AFFECTED");
    });
  });

  describe("throwing class heritage -- the spellings that were ALREADY imprecise on base", () => {
    // The heritage expression is evaluated before ANY element, so a
    // throwing heritage call leaves every computed key unevaluated. All
    // three of these answered AFFECTED on base `86c8669` as well, because a
    // field and an accessor were never pushed as the walk's owner.
    it("FIELD key under a throwing heritage", async () => {
      const { verdict } = await verdictFor(
        `class C extends bail() { [key()] = 1; }`,
      );
      expect(verdict).toBe("AFFECTED");
    });

    it("GETTER key under a throwing heritage", async () => {
      const { verdict } = await verdictFor(
        `class C extends bail() { get [key()]() { return 1; } }`,
      );
      expect(verdict).toBe("AFFECTED");
    });

    it("SETTER key under a throwing heritage", async () => {
      const { verdict } = await verdictFor(
        `class C extends bail() { set [key()](v) {} }`,
      );
      expect(verdict).toBe("AFFECTED");
    });
  });

  describe("throwing class heritage -- the METHOD spellings RWF-023 brought into line", () => {
    it("METHOD key under a throwing heritage is a KNOWN FALSE AFFECTED", async () => {
      // ==================== THE PINNED AUDIT FINDING ====================
      // RUNTIME: `bail()` throws while the heritage expression is being
      // evaluated, which happens BEFORE any element is defined. The
      // computed key is never evaluated, `key()` never runs, and the
      // vulnerable sink never runs. AFFECTED is a FALSE AFFECTED.
      //
      // It is pinned, not fixed, because the cause is the cross-family
      // limitation this file documents -- the same answer the FIELD,
      // GETTER and SETTER rows above already gave on base -- and not
      // anything specific to computed keys. On base this spelling happened
      // to answer UNKNOWN, for the unrelated reason that the key's call was
      // mis-owned by the deferred method node.
      //
      // This assertion must NEVER be cited as evidence that a computed key
      // executes after a throwing heritage. It does not.
      // ==================================================================
      const { verdict } = await verdictFor(
        `class C extends bail() { [key()]() {} }`,
      );
      expect(verdict).toBe("AFFECTED");
    });

    it("STATIC METHOD key under a throwing heritage is a KNOWN FALSE AFFECTED", async () => {
      const { verdict } = await verdictFor(
        `class C extends bail() { static [key()]() {} }`,
      );
      expect(verdict).toBe("AFFECTED");
    });

    it("a class after a bare `throw` is a KNOWN FALSE AFFECTED", async () => {
      // The plain-statement row above with a class wrapped around the key.
      // Same cause, same direction, no class-specific rule involved.
      const { verdict } = await verdictFor(
        `throw new Error("x");\nclass C { [key()]() {} }`,
      );
      expect(verdict).toBe("AFFECTED");
    });
  });

  describe("short-circuited key operands -- no constant folding is claimed", () => {
    // `false && key()` cannot evaluate its right operand. The call graph
    // folds constants only in `if` conditions (`evaluateConstantBoolean`),
    // never inside arbitrary expressions, so the call is still walked.
    // RWF-023 deliberately did NOT add folding: inventing new positive
    // proofs is how a false NOT_AFFECTED gets built.
    it("FIELD key with a short-circuited call (AFFECTED on base too)", async () => {
      const { verdict } = await verdictFor(`class C { [false && key()] = 1; }`);
      expect(verdict).toBe("AFFECTED");
    });

    it("METHOD key with a short-circuited call is a KNOWN FALSE AFFECTED", async () => {
      // RUNTIME: key() never runs. Base answered NOT_AFFECTED for the
      // unrelated ownership reason; the FIELD row above shows AFFECTED was
      // already the answer for the sibling spelling.
      const { verdict } = await verdictFor(`class C { [false && key()]() {} }`);
      expect(verdict).toBe("AFFECTED");
    });
  });

  describe("the boundary is respected where a real proof exists", () => {
    it("does NOT root a computed key inside a provably untaken `if (false)` branch", async () => {
      // The positive control, and the reason this whole family is an
      // over-approximation rather than a blanket one. `evaluateConstantBoolean`
      // gives the walk a genuine proof that the branch is not taken, and
      // RWF-023's new edge is only emitted for nodes the walk actually
      // visits -- so it inherits that proof instead of overriding it.
      const { verdict, familyC } = await verdictFor(
        `if (false) { class C { [key()]() {} } }`,
      );

      expect(verdict).toBe("NOT_AFFECTED");
      expect(familyC).toMatchObject({ reachableSubgraphComplete: true });
    });

    it("still reports the canonical RWF-023 shape as AFFECTED with no negative proof", async () => {
      // The anchor. None of the above may be allowed to erode the P0 fix:
      // a computed method key with nothing abrupt anywhere really does run
      // on every load, and must stay AFFECTED with no Family C proof.
      const { verdict, familyC } = await verdictFor(`class C { [key()]() {} }`);

      expect(verdict).toBe("AFFECTED");
      expect(familyC).toBeUndefined();
    });
  });
});
