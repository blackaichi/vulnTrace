import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildModuleModel, entrypointRootCandidates } from "./module-model.js";
import { indexSourceFileFromDisk } from "./source-index.js";

/**
 * P0-Z: the root-derivation COMPLETENESS half of
 * {@link entrypointRootCandidates}, unit level.
 *
 * The property under test is the one the six false NOT_AFFECTED verdicts
 * turned on: an empty root set must no longer be ambiguous. "This file
 * exports no callable" and "this file exports a callable I cannot root"
 * both produce zero names, and only the second may block a negative proof.
 */

let dir: string | undefined;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function candidatesFor(fileName: string, source: string) {
  dir = mkdtempSync(path.join(tmpdir(), "p0z-roots-"));
  const file = path.join(dir, fileName);
  writeFileSync(file, source);
  const index = indexSourceFileFromDisk(file);
  return entrypointRootCandidates(index, buildModuleModel(index));
}

describe("P0-Z: root derivation reports its own completeness", () => {
  const COMPLETE: ReadonlyArray<readonly [string, string, string]> = [
    [
      "a directly exported named callable",
      "direct.js",
      "function run(){}\nmodule.exports = run;\n",
    ],
    [
      "a directly exported object literal",
      "object.js",
      "module.exports = { run(){} };\n",
    ],
    ["an ESM named export", "esm.mjs", "export const run = () => 1;\n"],
    [
      "a file exporting NO callable at all",
      "none.js",
      "const x = 1;\nmodule.exports = 42;\n",
    ],
    [
      "a file with no exports whatsoever",
      "empty.js",
      "const x = 1;\nvoid x;\n",
    ],
    [
      "a mention of the export object outside first-argument position",
      "mention.js",
      "module.exports = { run(){} };\nconsole.log('x', module.exports);\n",
    ],
  ];

  for (const [label, file, source] of COMPLETE) {
    it(`reports COMPLETE for ${label}`, () => {
      const candidates = candidatesFor(file, source);
      expect(candidates.complete).toBe(true);
      expect(candidates.incompleteness).toEqual([]);
    });
  }

  const INCOMPLETE: ReadonlyArray<readonly [string, string, string, string]> = [
    [
      "a whole-module CommonJS re-export",
      "b1.js",
      "module.exports = require('./x.js');\n",
      "unresolved_entrypoint_reexport",
    ],
    [
      "Object.assign export forwarding",
      "b2.js",
      "Object.assign(module.exports, require('./x.js'));\n",
      "unresolved_export_forwarding",
    ],
    [
      "a CommonJS property re-export",
      "b3.js",
      "module.exports.run = require('./x.js').run;\n",
      "unresolved_entrypoint_reexport",
    ],
    [
      "an ESM named re-export",
      "b4.mjs",
      "export { run } from './x.js';\n",
      "unresolved_entrypoint_reexport",
    ],
    [
      "an ESM export *",
      "b5.mjs",
      "export * from './x.js';\n",
      "unresolved_entrypoint_reexport",
    ],
    [
      "a package re-export",
      "b7.js",
      "module.exports = require('vlib');\n",
      "unresolved_entrypoint_reexport",
    ],
    [
      "Object.defineProperty on the export object",
      "define.js",
      "Object.defineProperty(module.exports, 'run', { value: 1 });\n",
      "unresolved_export_forwarding",
    ],
    [
      "forwarding onto the bare `exports` alias",
      "bare.js",
      "Object.assign(exports, require('./x.js'));\n",
      "unresolved_export_forwarding",
    ],
  ];

  for (const [label, file, source, reason] of INCOMPLETE) {
    it(`reports INCOMPLETE (${reason}) for ${label}`, () => {
      const candidates = candidatesFor(file, source);
      expect(candidates.complete).toBe(false);
      expect(candidates.incompleteness.map((i) => i.reason)).toContain(reason);
    });
  }

  it("distinguishes zero roots from undrivable roots -- the whole point", () => {
    const noExport = candidatesFor("none.js", "module.exports = 42;\n");
    const reExport = candidatesFor(
      "re.js",
      "module.exports = require('./x.js');\n",
    );

    // Identical root sets...
    expect([...noExport.names]).toEqual([]);
    expect([...reExport.names]).toEqual([]);
    // ...and now distinguishable answers.
    expect(noExport.complete).toBe(true);
    expect(reExport.complete).toBe(false);
  });

  it("keeps the re-export's origin specifier for diagnostics", () => {
    const candidates = candidatesFor(
      "spec.js",
      "module.exports = require('./sibling.js');\n",
    );

    expect(candidates.incompleteness[0]).toMatchObject({
      reason: "unresolved_entrypoint_reexport",
      specifier: "./sibling.js",
    });
  });

  it("does not shrink the root set it already derived (monotonicity)", () => {
    // A file with BOTH a rootable local export and an unrootable re-export
    // must keep the local root AND report the gap -- incompleteness is
    // additional information, never a replacement for the roots found.
    const candidates = candidatesFor(
      "mixed.js",
      "function local(){}\n" +
        "module.exports.local = local;\n" +
        "module.exports.re = require('./x.js').re;\n",
    );

    expect([...candidates.names]).toContain("local");
    expect(candidates.complete).toBe(false);
  });
});
