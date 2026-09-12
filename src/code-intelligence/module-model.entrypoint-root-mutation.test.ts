import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildModuleModel, entrypointRootCandidates } from "./module-model.js";
import { indexSourceFileFromDisk } from "./source-index.js";

/**
 * P0-Z: bounded MUTATION matrix for root-derivation completeness.
 *
 * Each row is a PAIR of near-identical entrypoints differing by one edit.
 * The claim under test is directional and is what makes the fix meaningful
 * rather than incidental: breaking the "this root is derivable" assumption
 * must flip completeness to false, and restoring it must flip it back.
 *
 * A fix that simply reported everything incomplete would pass the first
 * half of every row and fail the second; a fix that reported nothing
 * incomplete would do the reverse.
 */

let dir: string | undefined;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function candidatesFor(fileName: string, source: string) {
  dir = mkdtempSync(path.join(tmpdir(), "p0z-mut-"));
  const file = path.join(dir, fileName);
  writeFileSync(file, source);
  const index = indexSourceFileFromDisk(file);
  return entrypointRootCandidates(index, buildModuleModel(index));
}

function completeness(fileName: string, source: string): boolean {
  return candidatesFor(fileName, source).complete;
}

function rootNames(fileName: string, source: string): ReadonlySet<string> {
  return candidatesFor(fileName, source).names;
}

interface Mutation {
  readonly label: string;
  readonly file: string;
  /** The form whose roots ARE derivable. */
  readonly sound: string;
  /** The same entrypoint with the assumption broken. */
  readonly mutated: string;
}

const MUTATIONS: readonly Mutation[] = [
  {
    label: "direct export -> whole-module re-export",
    file: "m1.js",
    sound: "function run(){}\nmodule.exports = { run };\n",
    mutated: "module.exports = require('./other.js');\n",
  },
  {
    label: "direct export -> property re-export",
    file: "m2.js",
    sound: "function run(){}\nmodule.exports.run = run;\n",
    mutated: "module.exports.run = require('./other.js').run;\n",
  },
  {
    label: "direct export -> Object.assign forwarding",
    file: "m3.js",
    sound: "function run(){}\nmodule.exports = { run };\n",
    mutated: "Object.assign(module.exports, require('./other.js'));\n",
  },
  {
    label: "exact ESM named export -> export *",
    file: "m4.mjs",
    sound: "export function run(){}\n",
    mutated: "export * from './other.js';\n",
  },
  {
    label: "exact ESM named export -> ESM named RE-export",
    file: "m5.mjs",
    sound: "export function run(){}\n",
    mutated: "export { run } from './other.js';\n",
  },
  {
    label: "known local callable -> unresolved require member",
    file: "m6.js",
    sound: "const run = () => 1;\nmodule.exports = { run };\n",
    mutated: "module.exports = { run: require('./other.js').run };\n",
  },
  {
    label: "local package use -> re-export of the package itself",
    file: "m7.js",
    sound:
      "const dep = require('vlib');\nfunction run(){ return dep.op(); }\nmodule.exports = { run };\n",
    mutated: "module.exports = require('vlib');\n",
  },
];

describe("P0-Z: breaking a root assumption flips completeness, restoring it flips back", () => {
  for (const mutation of MUTATIONS) {
    it(`${mutation.label}: sound form stays COMPLETE`, () => {
      expect(completeness(mutation.file, mutation.sound)).toBe(true);
    });

    it(`${mutation.label}: mutated form becomes INCOMPLETE`, () => {
      expect(completeness(mutation.file, mutation.mutated)).toBe(false);
    });
  }

  it("removing the exported callable entirely stays COMPLETE (nothing to root)", () => {
    // The direction that matters most for precision: absence of a root is
    // not absence of an answer.
    expect(completeness("none.js", "module.exports = 42;\n")).toBe(true);
  });

  it("restoring an exact local callable after a re-export flips back to COMPLETE", () => {
    expect(
      completeness("restored.js", "module.exports = require('./other.js');\n"),
    ).toBe(false);
    expect(
      completeness(
        "restored.js",
        "function run(){}\nmodule.exports = { run };\n",
      ),
    ).toBe(true);
  });

  it("a dynamic computed export name is INCOMPLETE, not a silent zero-root file", () => {
    // Found by this very matrix: not a re-export, but the identical root
    // loss. The callable is local and rootable; only the NAME it is
    // published under is unknown, and the model produces no binding for
    // it. Before the fix this was a live false NOT_AFFECTED carrying a
    // complete Family C proof.
    expect(
      completeness("dyn.js", "function run(){}\nmodule.exports[k] = run;\n"),
    ).toBe(false);
  });

  it("a LITERAL computed export name is COMPLETE because it is now MODELED", () => {
    // This assertion predates the focused re-audit, which found its stated
    // justification ("statically named and already modeled") to be false:
    // `describeCommonJsExportTarget` recognised only the dot spelling, so
    // the bracket form produced no export binding at all. COMPLETE with
    // zero roots was therefore a false NOT_AFFECTED waiting to happen, and
    // it was reproduced as exactly that.
    //
    // The verdict is unchanged and the REASON is now true: the form is
    // modeled, so a concrete root really is derived. Asserted here rather
    // than left implicit, because "complete" alone is precisely what
    // failed to distinguish the two situations.
    const source = 'function run(){}\nmodule.exports["run"] = run;\n';
    expect(completeness("lit.js", source)).toBe(true);
    expect([...rootNames("lit.js", source)]).toContain("run");
  });
});
