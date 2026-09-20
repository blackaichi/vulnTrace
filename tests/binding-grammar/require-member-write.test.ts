import { afterAll, describe, expect, it } from "vitest";
import {
  disposeTempRoots,
  formatObservation,
  observe,
  prepareProject,
  type Observation,
} from "./harness.js";

/**
 * RWF-047 -- THE WIDENING TABLE FOR A MEMBER WRITE ON A REQUIRE-BOUND
 * MODULE OBJECT.
 *
 * THIS FILE CHARACTERISES AN OPEN DEFECT. Most rows below assert an EXACT
 * attribution that real `node` contradicts. That is the measurement, not an
 * oversight: the fix for RWF-047 is a separate task and is expected to turn
 * these rows into refusals.
 *
 * It lives beside the RWF-048 binding-form sweep rather than inside it
 * because it is not a binding-FORM question. Every cell here binds the
 * module the same, entirely correct way -- `const mod = require("pkg")` --
 * and varies what happens to the OBJECT afterwards. The sweep enumerates
 * the grammar of binding; this enumerates the grammar of invalidation.
 *
 * WHAT IS BEING MEASURED. `named-bindings.ts` exposes
 * `isMemberAssignedWithin`, and `call-graph.ts`'s
 * `resolveNamedReceiverBinding` consults it for an OBJECT-LITERAL receiver.
 * A `const` binding to an object literal freezes the BINDING and not the
 * OBJECT, so `const obj = { m: danger }; obj.m = safe; obj.m()` correctly
 * refuses. A require-bound module object has exactly the same property --
 * `const` freezes `mod`, not `mod.run` -- and the import/require resolution
 * path consults no equivalent check. The CONTROL rows below establish that
 * the object-literal path really does refuse, so the require rows are an
 * ASYMMETRY between two receivers with the same mutability rather than a
 * blanket statement that the analyzer resolves member calls.
 *
 * GROUND TRUTH for every row is established by execution, not argument, in
 * `fixtures/require-member-write-ground-truth/entry.js` -- a plain Node
 * program whose every claim is `assert`ed in-process. Each row names the
 * fixture row that measures it.
 *
 * THE LOUD-FIXTURE RULE (RWF-048 § 2) is inherited from the harness and is
 * asserted again at the bottom of this file. Every fixture package exports
 * every name these cases bind, INCLUDING `patched`. Against a package
 * missing the name a stale attribution would degrade to `unresolved_target`
 * and read as an honest UNKNOWN -- the mechanism that hid the RWF-046 array
 * hole behind a green suite. Because the name is present, a wrong
 * attribution here is a LOUD `EXACT`, and the `a fabrication onto the local
 * spelling would have been visible` case proves that positively.
 */

afterAll(() => disposeTempRoots());

const PKG_RUN = "node_modules/pkg/index.js#run";

interface Row {
  /** The label used in the RWF-047 record's widening table. */
  readonly id: string;
  readonly esm: boolean;
  readonly source: string;
  /** What the analyzer does TODAY. */
  readonly expected: string;
  /** What real `node` does, and the fixture row that asserts it. */
  readonly groundTruth: string;
  /**
   * Whether this row REACHES THE DEFECT -- i.e. whether the analyzer's
   * EXACT attribution names a callable that real `node` does not invoke on
   * this program. Recorded per row and counted at the bottom, so the
   * widening result is machine-checked rather than left to the prose.
   *
   * Three rows are `false`, and each for its own reason:
   *
   * - W7, because an ESM Module Namespace object is SEALED: the write is a
   *   TypeError, so no displacement is possible and the attribution is not
   *   contradicted by a call that happened. (That the analyzer does not
   *   model the abrupt completion is the RWF-016 family's business, not
   *   this finding's.)
   * - W9 and B0, because `mod.run` is genuinely untouched in them. They are
   *   the negative controls: they prove the defect is caused by a write to
   *   THE MEMBER BEING CALLED, and not by the analyzer resolving module
   *   members at all.
   */
  readonly reachesDefect: boolean;
}

const ROWS: readonly Row[] = [
  {
    id: "W1 direct member write",
    reachesDefect: true,
    esm: false,
    source: `const mod = require("pkg");
function patched() {}
function probe() {
  mod.run = patched;
  mod.run();
}
probe();`,
    expected: `EXACT ${PKG_RUN}`,
    groundTruth: "D1: calls the local `patched`; pkg#run never entered",
  },
  {
    id: "W2 Object.defineProperty",
    reachesDefect: true,
    esm: false,
    source: `const mod = require("pkg");
function patched() {}
function probe() {
  Object.defineProperty(mod, "run", { value: patched });
  mod.run();
}
probe();`,
    expected: `EXACT ${PKG_RUN}`,
    groundTruth:
      "W2: the CommonJS exports property is configurable+writable, so this redefines it; calls `patched`",
  },
  {
    id: "W3 delete mod.run",
    reachesDefect: true,
    esm: false,
    source: `const mod = require("pkg");
function probe() {
  delete mod.run;
  mod.run();
}
probe();`,
    expected: `EXACT ${PKG_RUN}`,
    groundTruth:
      "W3: the delete SUCCEEDS and the call is a TypeError; pkg#run is not called, and nothing is",
  },
  {
    id: "W4 write through an alias",
    reachesDefect: true,
    esm: false,
    source: `const mod = require("pkg");
function patched() {}
const m2 = mod;
function probe() {
  m2.run = patched;
  mod.run();
}
probe();`,
    expected: `EXACT ${PKG_RUN}`,
    groundTruth:
      "W4: `const m2 = mod` copies the reference, so the write lands on the same object; calls `patched`",
  },
  {
    id: "W5 write inside a called function",
    reachesDefect: true,
    esm: false,
    source: `const mod = require("pkg");
function patched() {}
function install() { mod.run = patched; }
install();
function probe() {
  mod.run();
}
probe();`,
    expected: `EXACT ${PKG_RUN}`,
    groundTruth:
      "W5: the object is reached through the closure; the effect is identical; calls `patched`",
  },
  {
    id: "W6 module-scope write, call in a function",
    reachesDefect: true,
    esm: false,
    source: `const mod = require("pkg");
function patched() {}
mod.run = patched;
function probe() {
  mod.run();
}
probe();`,
    expected: `EXACT ${PKG_RUN}`,
    groundTruth:
      "D1: the write unconditionally precedes the call, so there is EXACTLY ONE runtime value and it is `patched`",
  },
  {
    id: "W7 ESM namespace import",
    reachesDefect: false,
    esm: true,
    source: `import * as mod from "pkg";
function patched() {}
export function probe() {
  mod.run = patched;
  mod.run();
}
probe();`,
    expected: `EXACT ${PKG_RUN}`,
    groundTruth:
      "W7: a Module Namespace object is SEALED, so the write is a TypeError in ESM strict mode and the call never happens",
  },
  {
    id: "W8 ESM default import of a CommonJS module",
    reachesDefect: true,
    esm: true,
    source: `import mod from "pkg";
function patched() {}
export function probe() {
  mod.run = patched;
  mod.run();
}
probe();`,
    expected: `EXACT ${PKG_RUN}`,
    groundTruth:
      "W8: the default import IS `module.exports`, an ordinary mutable object; the write succeeds and calls `patched`",
  },
  {
    id: "W9 write of a DIFFERENT member (negative control)",
    reachesDefect: false,
    esm: false,
    source: `const mod = require("pkg");
function patched() {}
function probe() {
  mod.execute = patched;
  mod.run();
}
probe();`,
    expected: `EXACT ${PKG_RUN}`,
    groundTruth:
      "W9: `mod.run` is untouched, so the call really does reach pkg#run -- here the analyzer is CORRECT",
  },
  {
    id: "B0 no write at all (baseline)",
    reachesDefect: false,
    esm: false,
    source: `const mod = require("pkg");
function probe() {
  mod.run();
}
probe();`,
    expected: `EXACT ${PKG_RUN}`,
    groundTruth: "the honest resolution; nothing displaces it",
  },
];

/**
 * The covered receiver. `isMemberAssignedWithin` governs an object literal,
 * so the write is seen and the resolution withheld. Both rows are needed:
 * without the no-write row, the refusal could be an inability to resolve
 * object-literal members at all rather than an invalidation.
 */
const CONTROLS: readonly Row[] = [
  {
    id: "C1 object literal, member written",
    reachesDefect: false,
    esm: false,
    source: `function danger() {}
function patched() {}
const obj = { run: danger };
function probe() {
  obj.run = patched;
  obj.run();
}
probe();`,
    expected: "UNKNOWN unsupported_receiver_binding",
    groundTruth:
      "the write displaces the literal's property exactly as it displaces a module member",
  },
  {
    id: "C2 object literal, no write",
    reachesDefect: false,
    esm: false,
    source: `function danger() {}
const obj = { run: danger };
function probe() {
  obj.run();
}
probe();`,
    expected: "EXACT case.js#danger",
    groundTruth: "the honest resolution the write above withholds",
  },
];

let caseCounter = 0;
async function observeRow(row: Row): Promise<Observation> {
  caseCounter += 1;
  const file = `case.${row.esm ? "mjs" : "js"}`;
  const project = prepareProject(
    { esm: row.esm },
    new Map([[`c${caseCounter}/${file}`, row.source]]),
  );
  const graph = await project.graph(`c${caseCounter}/${file}`);
  return observe(graph, project.root, "probe");
}

describe("RWF-047 widening: which invalidation shapes reach the defect (OPEN DEFECT, characterised)", () => {
  describe("require- and import-bound module objects", () => {
    for (const row of ROWS) {
      it(`${row.id} -> ${row.expected}`, async () => {
        const observed = await observeRow(row);
        expect(
          formatObservation(observed).replace(/^EXACT c\d+\//, "EXACT "),
          `ground truth -- ${row.groundTruth}`,
        ).toBe(row.expected);
      });
    }
  });

  describe("CONTROL: the object-literal receiver, which IS governed", () => {
    for (const row of CONTROLS) {
      it(`${row.id} -> ${row.expected}`, async () => {
        const observed = await observeRow(row);
        expect(
          formatObservation(observed).replace(/^EXACT c\d+\//, "EXACT "),
          `ground truth -- ${row.groundTruth}`,
        ).toBe(row.expected);
      });
    }
  });

  it("the widening result, counted: 7 of 10 module-receiver rows reach the defect", () => {
    // The widening was bounded in advance to the shapes RWF-047 named, and
    // this pins the answer so the prose in the record cannot drift from it.
    const reaching = ROWS.filter((r) => r.reachesDefect).map((r) => r.id);
    expect(reaching).toEqual([
      "W1 direct member write",
      "W2 Object.defineProperty",
      "W3 delete mod.run",
      "W4 write through an alias",
      "W5 write inside a called function",
      "W6 module-scope write, call in a function",
      "W8 ESM default import of a CommonJS module",
    ]);

    // And every row that does NOT reach it is a row where the runtime agrees
    // with the analyzer, or where the write could not happen at all. No row
    // is excluded merely because it was inconvenient.
    expect(ROWS.filter((r) => !r.reachesDefect).map((r) => r.id)).toEqual([
      "W7 ESM namespace import",
      "W9 write of a DIFFERENT member (negative control)",
      "B0 no write at all (baseline)",
    ]);

    // The controls are the covered receiver, so by construction none of them
    // reaches the defect -- that is what "covered" means.
    expect(CONTROLS.every((r) => !r.reachesDefect)).toBe(true);
  });

  it("a fabrication onto the LOCAL spelling would have been visible (loud-fixture rule)", async () => {
    // `patched` is an export of every fixture package. Had the analyzer
    // attributed `mod.run()` to the local identifier's TEXT -- the
    // text-authority class of RWF-043/045/046/046a -- the observation would
    // have been a loud `EXACT node_modules/pkg/index.js#patched` rather than
    // a refusal. It is neither, which establishes two separate facts: the
    // text-authority class does NOT reproduce here, and the stale
    // attribution measured above could not have been hiding as an UNKNOWN.
    const observed = await observeRow({
      id: "loud",
      esm: false,
      source: `const mod = require("pkg");
function patched() {}
function probe() {
  mod.run = patched;
  mod.run();
}
probe();`,
      expected: "",
      groundTruth: "",
      reachesDefect: true,
    });
    const text = formatObservation(observed);
    expect(text, "no fabrication onto the local spelling").not.toContain(
      "#patched",
    );
    expect(
      text,
      "and not an UNKNOWN either -- the wrong answer is stated, loudly",
    ).toContain("#run");
  });
});
