import { describe, expect, it } from "vitest";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile, type IndexedFunction } from "./source-index.js";

/**
 * RWF-003: `module.exports = <function>` bound to its CONCRETE function
 * node, by source position rather than by name (see
 * `ExportBinding.localFunctionLocation` and
 * `directExportedFunctionLocation` in module-model.ts;
 * tests/validation/FINDINGS.md RWF-003).
 *
 * Every assertion here checks the *identity* the export resolves to, not
 * merely that it resolved to something: each fixture deliberately contains
 * a second, similar function that a looser mechanism (a bare same-file name
 * search, "the first function in the file", "any anonymous function") would
 * bind to instead.
 */

function attributionOf(text: string): ReadonlyMap<string, IndexedFunction> {
  const index = indexSourceFile("/pkg/index.js", text);
  return mapExportsToFunctions(index, buildModuleModel(index));
}

/** `line:column` of the function the canonical export name resolved to, or `undefined`. */
function defaultExportPosition(text: string): string | undefined {
  const fn = attributionOf(text).get("default");
  return fn ? `${fn.location.line}:${fn.location.column}` : undefined;
}

/** A decoy declared BEFORE the export, so "first function in the file" is always wrong. */
const DECOY = "function vulnerable(x) { return x; }\n";

describe("RWF-003: the callable exported as module.exports resolves to its own function node", () => {
  it("binds a directly-assigned ANONYMOUS function expression", () => {
    // Form A. Before RWF-003 this resolved to nothing at all: the export
    // has no name, and a name lookup was the only mechanism available.
    expect(
      defaultExportPosition(`${DECOY}module.exports = function () {};\n`),
    ).toBe("2:18");
  });

  it("binds a directly-assigned anonymous ASYNC function expression", () => {
    // Form C.
    expect(
      defaultExportPosition(`${DECOY}module.exports = async function () {};\n`),
    ).toBe("2:18");
  });

  it("binds a directly-assigned ARROW function", () => {
    // Form D. Arrows are indexed and walked as first-class function nodes
    // (source-index.ts's `isFunctionLike`), so this integrates an existing
    // authoritative representation rather than adding a partial one.
    expect(defaultExportPosition(`${DECOY}module.exports = () => {};\n`)).toBe(
      "2:18",
    );
  });

  it("binds a directly-assigned ASYNC arrow function", () => {
    // Form E.
    expect(
      defaultExportPosition(`${DECOY}module.exports = async () => {};\n`),
    ).toBe("2:18");
  });

  it("binds a parenthesized function expression", () => {
    expect(
      defaultExportPosition(`${DECOY}module.exports = (function () {});\n`),
    ).toBe("2:19");
  });

  it("binds TypeScript's `export = function () {}` the same way", () => {
    const index = indexSourceFile(
      "/pkg/index.ts",
      `${DECOY}export = function () {};\n`,
    );
    const fn = mapExportsToFunctions(index, buildModuleModel(index)).get(
      "default",
    );
    expect(fn?.location.line).toBe(2);
    expect(fn?.location.column).toBe(10);
  });

  it("binds a NAMED function expression to its own node, not to a same-named function elsewhere", () => {
    // Form B. The internal name is not the public binding: the canonical
    // export is "default", and a file may contain another function that
    // merely shares the internal name's text. Identity must win.
    const text =
      "function chosen(x) { return x; }\nmodule.exports = function chosen() {};\n";
    expect(defaultExportPosition(text)).toBe("2:18");
  });

  it("binds through ONE provable local binding to a function expression", () => {
    // Form F.
    const text = `${DECOY}const fn = function () {};\nmodule.exports = fn;\n`;
    expect(defaultExportPosition(text)).toBe("2:12");
  });

  it("binds through ONE provable local binding to an arrow function", () => {
    // Form G.
    const text = `${DECOY}const fn = () => {};\nmodule.exports = fn;\n`;
    expect(defaultExportPosition(text)).toBe("2:12");
  });

  it("preserves the pre-existing function-declaration attribution", () => {
    // Form H -- already worked before RWF-003 via the name path, and still
    // does. The identity field is deliberately absent here (a declaration
    // is not an assigned value), so this proves the fallback is intact.
    const text = "function fn(x) { return x; }\nmodule.exports = fn;\n";
    const index = indexSourceFile("/pkg/index.js", text);
    const model = buildModuleModel(index);
    expect(
      model.exports.find((e) => e.kind === "default")?.localFunctionLocation,
    ).toBeUndefined();
    expect(defaultExportPosition(text)).toBe("1:1");
  });

  it('does not fabricate the name "exports" for an anonymous exported function', () => {
    // The assignment target's last segment is the CommonJS construct, not a
    // name the function has. A fabricated name is both misleading in
    // evidence output and exactly the text a name-based match could latch
    // onto (see source-index.ts's `isWholeModuleExportsTarget`).
    const index = indexSourceFile(
      "/pkg/index.js",
      "module.exports = function () {};\n",
    );
    expect(index.functions[0]?.name).toBeUndefined();
  });

  it("still names a function assigned to an exports PROPERTY after that property", () => {
    // The narrow un-naming above must not touch `exports.foo = function () {}`
    // / `module.exports.foo = ...`, whose inferred name IS accurate and is
    // relied on by mapExportsToFunctions' own lookup key.
    const index = indexSourceFile(
      "/pkg/index.js",
      "module.exports.foo = function () {};\nexports.bar = function () {};\n",
    );
    expect(index.functions.map((fn) => fn.name)).toEqual(["foo", "bar"]);
  });
});

describe("RWF-003: shapes that must NOT produce a function identity", () => {
  it("refuses a file that shadows the CommonJS ambient `module` binding", () => {
    // RWF-004a's ambient-provenance protection, applied to this relation:
    // `const module = { exports: null }` is a plain user object, so nothing
    // here is a CommonJS export at all.
    expect(
      defaultExportPosition(
        "const module = { exports: null };\nmodule.exports = function () {};\n",
      ),
    ).toBeUndefined();
  });

  it("refuses a file that shadows `exports` or `require` anywhere in it", () => {
    for (const shadow of [
      "function wrap() { const exports = {}; return exports; }\n",
      "function wrap() { const require = null; return require; }\n",
    ]) {
      expect(
        defaultExportPosition(`${shadow}module.exports = function () {};\n`),
      ).toBeUndefined();
    }
  });

  it("refuses a CONDITIONAL export assignment rather than picking a branch", () => {
    // Node's `module.exports` is last-write-wins at runtime; this task has
    // no control-flow semantics, and source order is not execution order.
    expect(
      defaultExportPosition(
        "if (x) {\n  module.exports = function () {};\n} else {\n  module.exports = function () {};\n}\n",
      ),
    ).toBeUndefined();
  });

  it("refuses an export assigned inside a function body", () => {
    expect(
      defaultExportPosition(
        "function install() {\n  module.exports = function () {};\n}\ninstall();\n",
      ),
    ).toBeUndefined();
  });

  it("takes the LAST module-scope assignment, never a stale earlier one", () => {
    // Overwrite semantics: the first assignment's function is genuinely not
    // the module's exported value.
    expect(
      defaultExportPosition(
        "module.exports = function () {};\nmodule.exports = function () {};\n",
      ),
    ).toBe("2:18");
  });

  it("refuses when the final assignment is conditional even if an earlier one is not", () => {
    expect(
      defaultExportPosition(
        "module.exports = function () {};\nif (x) {\n  module.exports = other;\n}\n",
      ),
    ).toBeUndefined();
  });

  it("follows a two-hop alias chain to the function node (RWF-012)", () => {
    expect(
      defaultExportPosition(
        "const a = function () {};\nconst b = a;\nmodule.exports = b;\n",
      ),
    ).toBe("1:11");
  });

  it("follows a three-hop alias chain to the function node (RWF-012)", () => {
    expect(
      defaultExportPosition(
        "const a = () => {};\nconst b = a;\nconst c = b;\nmodule.exports = c;\n",
      ),
    ).toBe("1:11");
  });

  it("refuses a chain whose FIRST hop is reassigned (RWF-012)", () => {
    expect(
      defaultExportPosition(
        "const a = function () {};\nlet b = a;\nb = other;\nmodule.exports = b;\n",
      ),
    ).toBeUndefined();
  });

  it("refuses a chain whose MIDDLE hop is reassigned (RWF-012)", () => {
    expect(
      defaultExportPosition(
        "const a = function () {};\nlet b = a;\nb = other;\nconst c = b;\nmodule.exports = c;\n",
      ),
    ).toBeUndefined();
  });

  it("refuses a chain whose TERMINAL hop is reassigned (RWF-012)", () => {
    expect(
      defaultExportPosition(
        "let a = function () {};\na = other;\nconst b = a;\nconst c = b;\nmodule.exports = c;\n",
      ),
    ).toBeUndefined();
  });

  it("refuses a conditionally-initialized binding anywhere on the chain (RWF-012)", () => {
    expect(
      defaultExportPosition(
        "let a;\nif (cond) {\n  a = function () {};\n}\nconst b = a;\nmodule.exports = b;\n",
      ),
    ).toBeUndefined();
  });

  it("terminates on a cyclic alias chain instead of overflowing (RWF-012)", () => {
    expect(
      defaultExportPosition(
        "const a = b;\nconst b = a;\nmodule.exports = a;\n",
      ),
    ).toBeUndefined();
    expect(
      defaultExportPosition("let a = b;\nconst b = a;\nmodule.exports = a;\n"),
    ).toBeUndefined();
  });

  it("terminates on a LONG cycle instead of overflowing the stack (RWF-012)", () => {
    const ring = Array.from(
      { length: 200 },
      (_, i) => `const n${i} = n${(i + 1) % 200};`,
    ).join("\n");
    expect(
      defaultExportPosition(`${ring}\nmodule.exports = n0;\n`),
    ).toBeUndefined();
  });

  it("refuses when a hop's name is declared more than once in the file (RWF-012)", () => {
    // The nested `const a` makes "a" ambiguous for a relation with no
    // scope model, so the chain must stop rather than pick a binding.
    expect(
      defaultExportPosition(
        "const a = function () {};\nfunction nested() {\n  const a = other;\n  return a;\n}\nconst b = a;\nmodule.exports = b;\n",
      ),
    ).toBeUndefined();
  });

  it("does not chase a chain whose terminal is a function DECLARATION (RWF-012 limitation)", () => {
    // `const a = fn` over `function fn() {}` is "unmodeled", not proven:
    // {@link CommonJsFacts.localBindings} covers variable bindings, and a
    // function declaration leaves no entry there. The chain therefore stops
    // with no function identity, and the export's `localName` is still the
    // right-hand side's own text ("b"), which matches no function -- so the
    // export stays unattributed rather than name-matching its way to `fn`.
    //
    // Deliberate: making a declaration an authoritative terminal would be a
    // NEW terminal form, and it would have to prove the declaration is the
    // file's only one. Recorded here so the boundary is explicit rather
    // than accidental.
    expect(
      defaultExportPosition(
        "function fn() {}\nconst a = fn;\nconst b = a;\nmodule.exports = b;\n",
      ),
    ).toBeUndefined();
  });

  it("keeps the ONE-hop function-declaration export resolving, unchanged (RWF-012)", () => {
    // The counterpart to the case above: `module.exports = fn` still
    // resolves through `localName`, exactly as it did before RWF-012.
    expect(
      defaultExportPosition("function fn() {}\nmodule.exports = fn;\n"),
    ).toBe("1:1");
  });

  it("does not chase a chain whose terminal is a CLASS declaration (RWF-012 limitation)", () => {
    // Same boundary, plus RWF-003's own standing decision not to extend
    // identity-based attribution to classes. The one-hop
    // `module.exports = C` form is unaffected and still resolves.
    expect(
      defaultExportPosition(
        "class C { m() {} }\nconst A = C;\nconst B = A;\nmodule.exports = B;\n",
      ),
    ).toBeUndefined();
    expect(
      defaultExportPosition("class C { m() {} }\nmodule.exports = C;\n"),
    ).toBe("1:7");
  });

  it("refuses a chain that bottoms out in a non-function value (RWF-012)", () => {
    expect(
      defaultExportPosition(
        "const a = makeHandler();\nconst b = a;\nmodule.exports = b;\n",
      ),
    ).toBeUndefined();
  });

  it("refuses a CONDITIONAL chained assignment's value (RWF-012 blocker)", () => {
    // The value of `x = v` is `v`, but WHICH `module.exports = ...`
    // statement runs is a control-flow question this module has no
    // semantics for. `findLastModuleExportsAssignment` keeps only the LAST
    // one in SOURCE order, so trusting the chained value here would bind
    // the export to `second` and assert that `first` is not what the
    // module exports -- a branch chosen arbitrarily, presented as
    // certainty. Reproduced end to end as a false NOT_AFFECTED before the
    // `isUnconditionalExportAssignment` guard was added to this path.
    expect(
      defaultExportPosition(
        "function first() {}\nfunction second() {}\nif (c) {\n  module.exports = alias = first;\n} else {\n  module.exports = alias = second;\n}\n",
      ),
    ).toBeUndefined();
  });

  it("refuses a chained assignment inside a FUNCTION BODY (RWF-012 blocker)", () => {
    // Same guard, different non-authoritative position: an assignment in a
    // function body may never run at all.
    expect(
      defaultExportPosition(
        "function impl() {}\nfunction configure() {\n  module.exports = alias = impl;\n}\nconfigure();\n",
      ),
    ).toBeUndefined();
  });

  it("refuses a chained assignment inside try/catch and loops (RWF-012 blocker)", () => {
    for (const wrapper of [
      "try {\n  module.exports = alias = impl;\n} catch (e) {}\n",
      "for (;;) {\n  module.exports = alias = impl;\n}\n",
      "switch (k) {\n  case 1:\n    module.exports = alias = impl;\n}\n",
    ]) {
      expect(
        defaultExportPosition(`function impl() {}\n${wrapper}`),
      ).toBeUndefined();
    }
  });

  it("still reads an UNCONDITIONAL top-level chained assignment (RWF-012 control)", () => {
    // The shape RWF-012 exists to resolve, and the one real `ini@1.3.5`
    // uses. One unconditional module-scope statement: no branch to choose.
    expect(
      defaultExportPosition(
        "function impl() {}\nmodule.exports = alias = impl;\n",
      ),
    ).toBe("1:1");
  });

  it("leaves the PLAIN-IDENTIFIER conditional form exactly as it was (out of RWF-012 scope)", () => {
    // Deliberately unchanged, and pinned so the boundary is explicit: this
    // relation has always taken a `localName` off a raw identifier
    // right-hand side without asking whether the assignment is
    // unconditional. That is a separate, older gap in the same relation --
    // it reproduces identically on main -- and closing it here would be an
    // unrelated behaviour change smuggled into RWF-012. RWF-012's guard
    // covers only what RWF-012 introduced: reading THROUGH an assignment.
    expect(
      defaultExportPosition(
        "function first() {}\nfunction second() {}\nif (c) {\n  module.exports = first;\n} else {\n  module.exports = second;\n}\n",
      ),
    ).toBe("2:1");
  });

  it("follows a chained ASSIGNMENT to the function it publishes (RWF-012)", () => {
    // `module.exports = exports.decode = function () {}` -- the value of
    // `x = v` IS `v`.
    expect(
      defaultExportPosition(
        "module.exports = exports.decode = function () {};\n",
      ),
    ).toBe("1:35");
  });

  it("refuses a local binding that is reassigned elsewhere in the file", () => {
    const index = indexSourceFile(
      "/pkg/index.js",
      "let fn = function () {};\nfn = somethingElse;\nmodule.exports = fn;\n",
    );
    expect(
      buildModuleModel(index).exports.find((e) => e.kind === "default")
        ?.localFunctionLocation,
    ).toBeUndefined();
  });

  it("refuses a value that is not statically a function", () => {
    expect(
      defaultExportPosition("module.exports = someUnknownValue;\n"),
    ).toBeUndefined();
    expect(
      defaultExportPosition("module.exports = makeHandler();\n"),
    ).toBeUndefined();
  });

  it("never selects an unrelated function that is not the exported value", () => {
    // Negative control: a function declared in the same file, and another
    // nested inside an unrelated function, neither of which is exported.
    const text =
      "function notExported() {}\nfunction outer() { const inner = function () {}; return inner; }\nmodule.exports = function () {};\n";
    expect(defaultExportPosition(text)).toBe("3:18");
  });

  it("keeps a whole-module callable export and a property export distinct", () => {
    // `module.exports = f` and `module.exports.foo = g` are different
    // exported APIs and must resolve to different function nodes.
    const attribution = attributionOf(
      "module.exports = function () {};\nmodule.exports.foo = function () {};\n",
    );
    expect(attribution.get("default")?.location.line).toBe(1);
    expect(attribution.get("foo")?.location.line).toBe(2);
  });

  it("does not turn a property-only export into a whole-module callable", () => {
    const attribution = attributionOf("module.exports.foo = function () {};\n");
    expect(attribution.get("default")).toBeUndefined();
    expect(attribution.get("foo")).toBeDefined();
  });

  it("leaves an anonymous exported CLASS unattributed", () => {
    // Deliberately out of scope: a class's callable target is its
    // constructor and its members are attributed by a name-keyed relation
    // (findExportedClassMembers). Refusing costs only precision it already
    // lacked.
    expect(
      defaultExportPosition("module.exports = class { run() {} };\n"),
    ).toBeUndefined();
  });

  it("preserves the RWF-004a re-export origin on an anonymous whole-module re-export", () => {
    // `module.exports = require("./impl")` forwards a namespace; it names
    // no local function and must keep producing a re-export ORIGIN (which
    // the call graph chases) rather than a function identity.
    const index = indexSourceFile(
      "/pkg/index.js",
      'module.exports = require("./impl");\n',
    );
    const binding = buildModuleModel(index).exports.find(
      (e) => e.kind === "default",
    );
    expect(binding?.commonJsReExport).toEqual({ specifier: "./impl" });
    expect(binding?.localFunctionLocation).toBeUndefined();
  });
});
