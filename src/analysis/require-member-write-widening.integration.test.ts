import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import {
  EDGE_DOMAIN,
  loadDefectRegisters,
  openSoundnessDefectProblems,
  type EdgeObservation,
  type EdgePattern,
  type OpenSoundnessDefect,
} from "../testing/open-soundness-defect.js";

/**
 * RWF-047 -- THE WIDENING TABLE FOR A MEMBER WRITE ON A REQUIRE-BOUND
 * MODULE OBJECT.
 *
 * THIS FILE REPRODUCES AN OPEN SOUNDNESS DEFECT WITHOUT PINNING IT. The
 * rows the defect reaches are open-soundness-defect records
 * (`src/testing/open-soundness-defect.ts`): the SOUND edge outcomes are
 * `admissible` (a refusal, or an EXACT to the real declaration of the
 * written value), the fail-closed fix's outcome is `expected` (a refusal,
 * with no reason code pinned -- the fix chooses the existing reason and
 * pins it then), and the stale `EXACT node_modules/pkg/index.js#run` the
 * analyzer gives today is `observed`, kept apart from the expectation. Each
 * record names RWF-047 and OPEN-DEBTS D-16, and FAILS if the live result
 * changes in any way -- fixed or drifted.
 *
 * WHY IT LIVES HERE AND NOT IN `tests/binding-grammar/`. It was written
 * there, beside the RWF-048 binding-form sweep, and moved by the RWF-047
 * close-out. That suite's contract is that a wrong EXACT fails
 * unconditionally; a record of a KNOWN wrong EXACT must not live inside
 * it. The RWF-047 fix will add a member-write column to the matrix proper.
 * The question here is also not a binding-FORM question: every row binds
 * the module the same, entirely correct way -- `const mod = require("pkg")`
 * -- and varies what happens to the OBJECT afterwards.
 *
 * WHAT IS BEING MEASURED. `named-bindings.ts` exposes
 * `isMemberAssignedWithin`, and `call-graph.ts`'s
 * `resolveNamedReceiverBinding` consults it for an OBJECT-LITERAL receiver.
 * A `const` binding to an object literal freezes the BINDING and not the
 * OBJECT, so `const obj = { m: danger }; obj.m = safe; obj.m()` correctly
 * refuses. A require-bound module object has exactly the same property --
 * `const` freezes `mod`, not `mod.run` -- and the import/require resolution
 * path consults no equivalent check. The CONTROL rows establish that the
 * object-literal path really does refuse, so the require rows are an
 * ASYMMETRY between two receivers with the same mutability rather than a
 * blanket statement that the analyzer resolves member calls.
 *
 * GROUND TRUTH for every row is established by execution, not argument, in
 * `fixtures/require-member-write-ground-truth/` -- plain Node programs whose
 * every claim is `assert`ed in-process. Each row names the fixture row that
 * measures it.
 *
 * THE FIXTURE MIRRORS THAT GROUND TRUTH. `pkg` is a CommonJS package, as it
 * is there; an ESM row is an `.mjs` file importing it. It is LOUD: it
 * exports every name these rows bind, INCLUDING `patched`, so a fabrication
 * onto the local spelling would resolve to `pkg#patched` and be visible
 * rather than degrade to `unresolved_target` and read as an honest UNKNOWN.
 * `the fixture package exports every name these rows bind` asserts that
 * property by resolving it, rather than assuming it.
 *
 * (History: in `tests/binding-grammar/` this file borrowed the sweep's
 * harness, whose loud vocabulary does NOT include `patched`, and whose ESM
 * mode makes `pkg` an ESM package with no default export -- so its
 * docblock's claim that the fixture exported `patched` did not hold, and
 * W8 did not import a CommonJS module. See
 * `docs/tasks/RWF-047-classification-closeout.md`.)
 */

const tempRoots: string[] = [];
afterAll(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

const PKG_RUN = "node_modules/pkg/index.js#run";

/** Every name any row binds on the module object, including `patched`. */
const PKG_EXPORTS = ["run", "execute", "patched", "safe", "danger"] as const;

const PKG_SRC = [
  ...PKG_EXPORTS.map((n) => `function ${n}() {}`),
  `module.exports = { ${PKG_EXPORTS.join(", ")} };`,
  "",
].join("\n");

function write(root: string, rel: string, content: string): void {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/**
 * The single call edge leaving `probe`. `module_load` edges are excluded:
 * such an edge is a fact about the module system and never a claim that a
 * function was called.
 */
async function observeProbe(
  source: string,
  esm: boolean,
): Promise<{ readonly observation: EdgeObservation; readonly file: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-rwf047-widen-"));
  tempRoots.push(root);
  write(
    root,
    "package.json",
    JSON.stringify({ name: "host", version: "1.0.0", type: "commonjs" }),
  );
  write(
    root,
    "node_modules/pkg/package.json",
    JSON.stringify({
      name: "pkg",
      version: "1.0.0",
      main: "index.js",
      type: "commonjs",
    }),
  );
  write(root, "node_modules/pkg/index.js", PKG_SRC);
  const file = esm ? "case.mjs" : "case.js";
  write(root, file, source);

  const resolver = createModuleResolver(loadTsProject(root));
  const graph = await buildCallGraph({
    entryFiles: [path.join(root, file)],
    resolver,
  });

  const probe = graph.nodes.find((n) => n.name === "probe");
  if (!probe) {
    return { observation: { kind: "no-probe" }, file };
  }
  const edges = graph.edges.filter(
    (e) => e.from === probe.id && e.type !== "module_load",
  );
  const [edge] = edges;
  if (!edge) {
    return { observation: { kind: "no-edge" }, file };
  }
  if (edges.length > 1) {
    return { observation: { kind: "ambiguous", count: edges.length }, file };
  }
  if (edge.resolution.kind === "unknown") {
    return {
      observation: { kind: "unknown", reason: edge.resolution.reason },
      file,
    };
  }
  const targetId = edge.resolution.target;
  const node = graph.nodes.find((n) => n.id === targetId);
  if (!node) {
    return { observation: { kind: "no-edge" }, file };
  }
  const rel = path.relative(root, node.module).split(path.sep).join("/");
  return {
    observation: {
      kind: "exact",
      target: `${rel}#${node.name ?? "<anonymous>"}`,
    },
    file,
  };
}

interface Row {
  /** The label used in the RWF-047 record's widening table. */
  readonly id: string;
  readonly esm: boolean;
  readonly source: string;
  /** What real `node` does, and the fixture row that asserts it. */
  readonly groundTruth: string;
}

/**
 * A row the defect reaches: the analyzer's EXACT attribution names a
 * callable real `node` does not invoke on this program. Recorded, never
 * expected.
 */
interface DefectRow extends Row {
  readonly defect: OpenSoundnessDefect<EdgePattern, EdgeObservation>;
}

/**
 * A row the defect does NOT reach: the analyzer's answer is one the
 * runtime does not contradict, and it is asserted as the expectation.
 */
interface CorrectRow extends Row {
  readonly expected: EdgeObservation;
}

const STALE_RUN: EdgeObservation = { kind: "exact", target: PKG_RUN };

/**
 * The record for a defect row. `writtenValue` is the local declaration the
 * write installs, or `undefined` when nothing is installed (a `delete`), in
 * which case only a refusal is sound.
 */
function defectRecord(
  caseId: string,
  writtenValue: string | undefined,
): OpenSoundnessDefect<EdgePattern, EdgeObservation> {
  const admissible: EdgePattern[] = [{ kind: "refusal" }];
  if (writtenValue !== undefined) {
    admissible.push({ kind: "exact", target: writtenValue });
  }
  return {
    caseId,
    rwf: "RWF-047",
    debt: "D-16",
    admissible,
    expected: { kind: "refusal" },
    observed: STALE_RUN,
  };
}

const DEFECT_ROWS: readonly DefectRow[] = [
  {
    id: "W1 direct member write",
    esm: false,
    source: `const mod = require("pkg");
function patched() {}
function probe() {
  mod.run = patched;
  mod.run();
}
probe();`,
    groundTruth: "D1: calls the local `patched`; pkg#run never entered",
    defect: defectRecord("W1 direct member write", "case.js#patched"),
  },
  {
    id: "W2 Object.defineProperty",
    esm: false,
    source: `const mod = require("pkg");
function patched() {}
function probe() {
  Object.defineProperty(mod, "run", { value: patched });
  mod.run();
}
probe();`,
    groundTruth:
      "W2: the CommonJS exports property is configurable+writable, so this redefines it; calls `patched`",
    defect: defectRecord("W2 Object.defineProperty", "case.js#patched"),
  },
  {
    id: "W3 delete mod.run",
    esm: false,
    source: `const mod = require("pkg");
function probe() {
  delete mod.run;
  mod.run();
}
probe();`,
    groundTruth:
      "W3: the delete SUCCEEDS and the call is a TypeError; pkg#run is not called, and nothing is",
    // Nothing is installed, so no EXACT is sound: only a refusal.
    defect: defectRecord("W3 delete mod.run", undefined),
  },
  {
    id: "W4 write through an alias",
    esm: false,
    source: `const mod = require("pkg");
function patched() {}
const m2 = mod;
function probe() {
  m2.run = patched;
  mod.run();
}
probe();`,
    groundTruth:
      "W4: `const m2 = mod` copies the reference, so the write lands on the same object; calls `patched`",
    defect: defectRecord("W4 write through an alias", "case.js#patched"),
  },
  {
    id: "W5 write inside a called function",
    esm: false,
    source: `const mod = require("pkg");
function patched() {}
function install() { mod.run = patched; }
install();
function probe() {
  mod.run();
}
probe();`,
    groundTruth:
      "W5: the object is reached through the closure; the effect is identical; calls `patched`",
    defect: defectRecord(
      "W5 write inside a called function",
      "case.js#patched",
    ),
  },
  {
    id: "W6 module-scope write, call in a function",
    esm: false,
    source: `const mod = require("pkg");
function patched() {}
mod.run = patched;
function probe() {
  mod.run();
}
probe();`,
    groundTruth:
      "D1: the write unconditionally precedes the call, so there is EXACTLY ONE runtime value and it is `patched`",
    defect: defectRecord(
      "W6 module-scope write, call in a function",
      "case.js#patched",
    ),
  },
  {
    id: "W8 ESM default import of a CommonJS module",
    esm: true,
    source: `import mod from "pkg";
function patched() {}
export function probe() {
  mod.run = patched;
  mod.run();
}
probe();`,
    groundTruth:
      "W8: the default import IS `module.exports`, an ordinary mutable object; the write succeeds and calls `patched`",
    defect: defectRecord(
      "W8 ESM default import of a CommonJS module",
      "case.mjs#patched",
    ),
  },
];

/**
 * The module-receiver rows the defect does NOT reach, each for its own
 * reason:
 *
 * - W7, because a Module Namespace object is SEALED: the write is a
 *   TypeError, so no displacement is possible and the attribution is not
 *   contradicted by a call that happened. (That the analyzer does not model
 *   the abrupt completion is the RWF-016 family's business, not this
 *   finding's.)
 * - W9 and B0, because `mod.run` is genuinely untouched in them. They are
 *   the negative controls: they prove the defect is caused by a write to
 *   THE MEMBER BEING CALLED, and not by the analyzer resolving module
 *   members at all.
 */
const CORRECT_ROWS: readonly CorrectRow[] = [
  {
    id: "W7 ESM namespace import",
    esm: true,
    source: `import * as mod from "pkg";
function patched() {}
export function probe() {
  mod.run = patched;
  mod.run();
}
probe();`,
    expected: STALE_RUN,
    groundTruth:
      "W7: a Module Namespace object is SEALED, so the write is a TypeError in ESM strict mode and the call never happens",
  },
  {
    id: "W9 write of a DIFFERENT member (negative control)",
    esm: false,
    source: `const mod = require("pkg");
function patched() {}
function probe() {
  mod.execute = patched;
  mod.run();
}
probe();`,
    expected: STALE_RUN,
    groundTruth:
      "W9: `mod.run` is untouched, so the call really does reach pkg#run -- here the analyzer is CORRECT",
  },
  {
    id: "B0 no write at all (baseline)",
    esm: false,
    source: `const mod = require("pkg");
function probe() {
  mod.run();
}
probe();`,
    expected: STALE_RUN,
    groundTruth: "the honest resolution; nothing displaces it",
  },
];

/**
 * The covered receiver. `isMemberAssignedWithin` governs an object literal,
 * so the write is seen and the resolution withheld. Both rows are needed:
 * without the no-write row, the refusal could be an inability to resolve
 * object-literal members at all rather than an invalidation.
 */
const CONTROLS: readonly CorrectRow[] = [
  {
    id: "C1 object literal, member written",
    esm: false,
    source: `function danger() {}
function patched() {}
const obj = { run: danger };
function probe() {
  obj.run = patched;
  obj.run();
}
probe();`,
    expected: { kind: "unknown", reason: "unsupported_receiver_binding" },
    groundTruth:
      "the write displaces the literal's property exactly as it displaces a module member",
  },
  {
    id: "C2 object literal, no write",
    esm: false,
    source: `function danger() {}
const obj = { run: danger };
function probe() {
  obj.run();
}
probe();`,
    expected: { kind: "exact", target: "case.js#danger" },
    groundTruth: "the honest resolution the write above withholds",
  },
];

const registers = loadDefectRegisters();

describe("RWF-047 widening: which invalidation shapes reach the defect (open soundness defect, recorded)", () => {
  describe("module-object rows the defect reaches", () => {
    for (const row of DEFECT_ROWS) {
      it(`${row.id} -> a refusal (known open defect RWF-047)`, async () => {
        const { observation } = await observeProbe(row.source, row.esm);
        expect(
          openSoundnessDefectProblems(
            row.defect,
            EDGE_DOMAIN,
            observation,
            registers,
          ),
          `ground truth -- ${row.groundTruth}`,
        ).toEqual([]);
      });
    }
  });

  describe("module-object rows the defect does not reach", () => {
    for (const row of CORRECT_ROWS) {
      it(`${row.id} -> ${JSON.stringify(row.expected)}`, async () => {
        const { observation } = await observeProbe(row.source, row.esm);
        expect(observation, `ground truth -- ${row.groundTruth}`).toEqual(
          row.expected,
        );
      });
    }
  });

  describe("CONTROL: the object-literal receiver, which IS governed", () => {
    for (const row of CONTROLS) {
      it(`${row.id} -> ${JSON.stringify(row.expected)}`, async () => {
        const { observation } = await observeProbe(row.source, row.esm);
        expect(observation, `ground truth -- ${row.groundTruth}`).toEqual(
          row.expected,
        );
      });
    }
  });

  it("the widening result, counted: 7 of 10 module-receiver rows reach the defect", () => {
    // The widening was bounded in advance to the shapes RWF-047 named, and
    // this pins the answer so the prose in the record cannot drift from it.
    expect(DEFECT_ROWS.map((r) => r.id)).toEqual([
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
    expect(CORRECT_ROWS.map((r) => r.id)).toEqual([
      "W7 ESM namespace import",
      "W9 write of a DIFFERENT member (negative control)",
      "B0 no write at all (baseline)",
    ]);
  });

  it("the fixture package exports every name these rows bind (loud-fixture rule)", async () => {
    // Asserted by RESOLVING each name, not by reading the source: a name the
    // export model could not see would be as silent as a missing one. With
    // `patched` resolvable, a fabrication onto the local spelling `patched`
    // would have been a loud `EXACT node_modules/pkg/index.js#patched`
    // rather than an UNKNOWN, so no row above can be hiding one.
    for (const name of PKG_EXPORTS) {
      const { observation } = await observeProbe(
        `const mod = require("pkg");
function probe() {
  mod.${name}();
}
probe();`,
        false,
      );
      expect(observation, `pkg exports \`${name}\``).toEqual({
        kind: "exact",
        target: `node_modules/pkg/index.js#${name}`,
      });
    }
  });
});
