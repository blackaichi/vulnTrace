import { describe, expect, it } from "vitest";
import { findClosureWideningConstructs } from "./loader-constructs.js";
import { buildModuleModel } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * Task BL-097 (docs/tasks/BL-097-wrapper-arguments-frame.md): the loader
 * classifier counts a read of a caller's frame -- a sloppy function's
 * `caller`, V8's call sites' `getFunction` and `getThis` -- as a loader
 * capability escape, by every spelling the export census reads (RWF-137):
 * the frame of a function called at a module's top level is the module
 * wrapper's, whose arguments hold `require` and `module`. Real Node's
 * answers: `tests/oracle/bl097-wrapper-arguments-frame.test.ts`. These pin
 * the classifier's answer per spelling, so a mutation of any one is caught
 * by name.
 */

function reasons(source: string): string[] {
  const index = indexSourceFile("/virtual/index.js", source);
  return findClosureWideningConstructs({
    index,
    model: buildModuleModel(index),
  }).map((construct) => construct.reason);
}

describe("a caller's frame, by a name it spells (RWF-137)", () => {
  it.each([
    ["a member", "function g() { return g.caller.arguments[2]; }\ng();\n"],
    [
      "a member, not returned",
      "let m;\nfunction g() { m = g.caller.arguments[2]; }\ng();\n",
    ],
    ["a literal element key", 'function g() { return g["caller"]; }\n'],
    [
      "a reflective call's string",
      'function g() { return Reflect.get(g, "caller"); }\n',
    ],
    [
      "a template string with no substitution",
      "function g() { return g[`caller`]; }\n",
    ],
    [
      "a destructuring declaration",
      "function g() { const { caller } = g; return caller; }\n",
    ],
    [
      "a renamed destructuring declaration",
      "function g() { const { caller: c } = g; return c; }\n",
    ],
    [
      "a string-keyed destructuring declaration",
      'function g() { const { "caller": c } = g; return c; }\n',
    ],
    [
      "a destructuring assignment",
      "let c;\nfunction g() { ({ caller: c } = g); }\n",
    ],
    [
      "a shorthand destructuring assignment",
      "let caller;\nfunction g() { ({ caller } = g); }\n",
    ],
    ["a call site's function", "frames[0].getFunction().arguments[2];\n"],
    ["a call site's receiver", "frames[0].getThis();\n"],
    [
      "a call site's function by a literal key",
      'frames[0]["getFunction"]();\n',
    ],
    [
      "a regular expression's pattern (audit F-3)",
      "function g() { return g[/caller/.source]; }\n",
    ],
    [
      "a bare name in a with body (audit F-1)",
      "function g() { with (g) { return caller.arguments[2]; } }\n",
    ],
    [
      "a call site's function as a bare name in a with body (audit F-1)",
      "with (frames[0]) { getFunction(); }\n",
    ],
    [
      "a bare name in a function nested in a with body",
      "with (g) { (function () { return caller; })(); }\n",
    ],
  ])("%s is loader_capability_escape", (_label, source) => {
    expect(reasons(source)).toContain("loader_capability_escape");
  });

  it("a function's own arguments, and names that read no frame, stay proven (precision control)", () => {
    expect(
      reasons(
        "function g(a) { return g.arguments[0] + arguments.length + g.callee + g.name; }\n" +
          "g(1);\n" +
          'const o = { called: true, "call": 1 };\n' +
          "frames[0].getFileName();\n" +
          "const r = /callers/.test(s) || /^caller$/i.test(s);\n" +
          "with (o) { getFileName(); }\n" +
          "function f(caller) { with (caller) { x(); } return caller; }\n",
      ),
    ).toEqual([]);
  });
});

/**
 * RWF-144 (open, backlog `BL-080`): a frame name built at run time, or a
 * frame member reached by enumerating an object's properties, spells no
 * name, and the classifier does not see it. Not pinned as a verdict; the
 * open-soundness-defect records in
 * `tests/oracle/bl097-wrapper-arguments-frame.test.ts` carry the live false
 * NOT_AFFECTEDs.
 */
