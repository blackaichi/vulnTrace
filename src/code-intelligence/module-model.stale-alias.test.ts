import { describe, expect, it } from "vitest";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-013: a CommonJS export whose value is an identifier the file itself
 * REASSIGNS must not fall back to attributing the export by name — which
 * lands on the binding's stale initializer, because source indexing names
 * an anonymous function expression after the variable it was assigned to
 * (see `ExportBinding.localIdentifierProvenanceRefused` in module-model.ts
 * and `classifyLocalBinding` in commonjs-reexports.ts).
 *
 * The two halves of this file are equally load-bearing. The refusals below
 * are the soundness fix; the resolutions below are the reason the fix is a
 * three-way classification rather than "suppress whenever RWF-003 produced
 * no location". Every shape in the second half produces no
 * `localFunctionLocation` either, and every one of them must keep
 * resolving through the name-based path exactly as it did before.
 */

/** `line:column` of the function a canonical export name resolved to, or `undefined`. */
function exportPosition(text: string, name = "default"): string | undefined {
  const index = indexSourceFile("/pkg/index.js", text);
  const fn = mapExportsToFunctions(index, buildModuleModel(index)).get(name);
  return fn ? `${fn.location.line}:${fn.location.column}` : undefined;
}

/** The `default` export binding the model built for `text`. */
function defaultBinding(text: string) {
  const index = indexSourceFile("/pkg/index.js", text);
  return buildModuleModel(index).exports.find((e) => e.kind === "default");
}

describe("RWF-013: a reassigned local binding is never attributed by name", () => {
  it("refuses a reassigned `let` function expression (matrix 1)", () => {
    // The stale initializer is indexed under the name "fn" -- the exact
    // text the export's own `localName` carries -- so before RWF-013 the
    // name search bound the export to the function `fn` no longer holds.
    expect(
      exportPosition(
        [
          "const other = require('dep');",
          "let fn = function () { return 'stale'; };",
          "fn = other;",
          "module.exports = fn;",
        ].join("\n"),
      ),
    ).toBeUndefined();
  });

  it("refuses a reassigned `let` arrow function (matrix 2)", () => {
    expect(
      exportPosition(
        [
          "const other = require('dep');",
          "let fn = () => 'stale';",
          "fn = other;",
          "module.exports = fn;",
        ].join("\n"),
      ),
    ).toBeUndefined();
  });

  it("refuses a reassigned `var` function expression (matrix 3)", () => {
    expect(
      exportPosition(
        [
          "const other = require('dep');",
          "var impl = function () { return 'stale'; };",
          "impl = other;",
          "module.exports = impl;",
        ].join("\n"),
      ),
    ).toBeUndefined();
  });

  it("refuses a CONDITIONALLY reassigned binding (matrix 4)", () => {
    // Static analysis cannot know whether the branch runs, so it cannot
    // know the binding's value. The safe initializer must never be
    // presented as the answer -- that is the shape that turns a genuine
    // uncertainty into a confident verdict (see ADV2-069).
    expect(
      exportPosition(
        [
          "const native = require('dep');",
          "var impl = function () { return 'safe'; };",
          "if (native.available) {",
          "  impl = native.impl;",
          "}",
          "module.exports = impl;",
        ].join("\n"),
      ),
    ).toBeUndefined();
  });

  it("refuses a reassigned NAMED function expression, whose own name must not make it authoritative (matrix 5)", () => {
    // The export is through `fn`, whose current value is unresolved. That
    // the stale node calls itself `vulnerable` is a fact about the
    // function expression, not about what the module exports.
    const source = [
      "const other = require('dep');",
      "let fn = function vulnerable() { return 'stale'; };",
      "fn = other;",
      "module.exports = fn;",
    ].join("\n");

    expect(exportPosition(source)).toBeUndefined();
    // Nor may it be reachable under the internal name itself.
    expect(exportPosition(source, "vulnerable")).toBeUndefined();
  });

  it("refuses BOTH functions when a binding is overwritten with a second one -- never picks the first (matrix, OVERWRITE)", () => {
    // Both nodes are indexed under the name "fn" (the declaration's and
    // the assignment's), and `Array#find` returns the FIRST -- so the
    // pre-fix answer was the overwritten one, which is precisely the value
    // the module does not export.
    expect(
      exportPosition(
        [
          "let fn = function () { return 'first'; };",
          "fn = function () { return 'second'; };",
          "module.exports = fn;",
        ].join("\n"),
      ),
    ).toBeUndefined();
  });

  it("refuses the same shape through `exports.X = <identifier>`", () => {
    // The property form carries no `localName`, so the fallback's lookup
    // key is the EXPORTED name -- which matches the stale initializer just
    // as readily whenever the two coincide, as they do in real code.
    expect(
      exportPosition(
        [
          "const other = require('dep');",
          "let parse = function () { return 'stale'; };",
          "parse = other;",
          "exports.parse = parse;",
        ].join("\n"),
        "parse",
      ),
    ).toBeUndefined();
  });

  it("refuses the same shape through a `module.exports = { X }` shorthand", () => {
    expect(
      exportPosition(
        [
          "const other = require('dep');",
          "let parse = function () { return 'stale'; };",
          "parse = other;",
          "module.exports = { parse };",
        ].join("\n"),
        "parse",
      ),
    ).toBeUndefined();
  });

  it("records the refusal on the export binding itself, not merely the absence of a location", () => {
    const refused = defaultBinding(
      [
        "let fn = function () { return 'stale'; };",
        "fn = require('dep');",
        "module.exports = fn;",
      ].join("\n"),
    );
    expect(refused?.localFunctionLocation).toBeUndefined();
    expect(refused?.localIdentifierProvenanceRefused).toBe(true);

    // ...and a function DECLARATION is silence, not a refusal: this model
    // never had an opinion about it, so the older name-based attribution
    // stays available (see the next block).
    const declaration = defaultBinding(
      ["function fn() { return 'x'; }", "module.exports = fn;"].join("\n"),
    );
    expect(declaration?.localFunctionLocation).toBeUndefined();
    expect(declaration?.localIdentifierProvenanceRefused).toBeUndefined();
  });
});

describe("RWF-013: every legitimately attributable export keeps resolving", () => {
  it("resolves a safe `const` single-assignment alias (matrix 6)", () => {
    expect(
      exportPosition(
        [
          "function decoy() {}",
          "const fn = function () { return 'x'; };",
          "module.exports = fn;",
        ].join("\n"),
      ),
    ).toBe("2:12");
  });

  it("resolves a safe `let` single-assignment alias (matrix 7)", () => {
    expect(
      exportPosition(
        [
          "function decoy() {}",
          "let fn = function () { return 'x'; };",
          "module.exports = fn;",
        ].join("\n"),
      ),
    ).toBe("2:10");
  });

  it("resolves a safe `var` single-assignment alias (matrix 8)", () => {
    expect(
      exportPosition(
        [
          "function decoy() {}",
          "var fn = function () { return 'x'; };",
          "module.exports = fn;",
        ].join("\n"),
      ),
    ).toBe("2:10");
  });

  it("resolves a direct anonymous `module.exports` function (matrix 9, RWF-003)", () => {
    expect(
      exportPosition(
        ["function decoy() {}", "module.exports = function () {};"].join("\n"),
      ),
    ).toBe("2:18");
  });

  it("resolves a direct arrow export (matrix 10, RWF-003)", () => {
    expect(
      exportPosition(
        ["function decoy() {}", "module.exports = async () => {};"].join("\n"),
      ),
    ).toBe("2:18");
  });

  it("resolves a function DECLARATION export through the legacy name path (matrix 11)", () => {
    // The single-assignment model binds no variable called `fn` here, so it
    // has nothing to say and must not suppress anything. This is the case
    // that makes `localFunctionLocation === undefined` unusable as the
    // suppression signal on its own.
    expect(
      exportPosition(
        ["function fn() { return 'x'; }", "module.exports = fn;"].join("\n"),
      ),
    ).toBe("1:1");
  });

  it("resolves a class alias through the legacy name path (single-assignment, but not a function value)", () => {
    // `const C = class {}` passes the single-assignment proof yet yields no
    // function location -- a class's callable target is its constructor,
    // attributed by name. Classifying this as "refused" rather than
    // "proven, just not a function" would silently drop class attribution
    // and everything findExportedClassMembers builds on it.
    expect(
      exportPosition(
        ["const C = class { constructor() {} };", "module.exports = C;"].join(
          "\n",
        ),
      ),
    ).toBe("1:19");
  });

  it("resolves `exports.X = <single-assignment identifier>` by name, unchanged", () => {
    expect(
      exportPosition(
        [
          "const parse = function () { return 'x'; };",
          "exports.parse = parse;",
        ].join("\n"),
        "parse",
      ),
    ).toBe("1:15");
  });

  it("leaves an alias chain longer than one hop exactly as conservative as before (matrix 12, RWF-012 boundary)", () => {
    // `b` IS provably single-assignment -- its initializer is just an
    // identifier, not a function. Unchanged: unresolved, not refused, and
    // deliberately not chased.
    const source = [
      "const a = function () { return 'x'; };",
      "const b = a;",
      "module.exports = b;",
    ].join("\n");

    expect(exportPosition(source)).toBeUndefined();
    expect(defaultBinding(source)?.localIdentifierProvenanceRefused).toBe(
      undefined,
    );
  });

  it("leaves ambient CommonJS shadowing exactly as conservative as before (matrix 13)", () => {
    // A file that declares its own `module` is not the CommonJS construct
    // it resembles, and RWF-003/RWF-004a already refuse it outright.
    expect(
      exportPosition(
        [
          "const module = { exports: null };",
          "module.exports = function () {};",
        ].join("\n"),
      ),
    ).toBeUndefined();
  });
});

/**
 * The combinations swept during RWF-013's final soundness attack. Each one
 * composes the stale-alias shape with a different way of losing the
 * binding's value, and each one previously bound the export to a function
 * the module does not export -- because every one of these spellings still
 * leaves a same-named node in `index.functions`.
 *
 * Kept as a table rather than prose: what matters is that the refusal is
 * driven by the single-assignment proof itself, so it covers every
 * assignment form that proof already understands, not an enumeration of
 * syntaxes someone remembered to list.
 */
const STALE_SHAPES: ReadonlyArray<readonly [string, string, string]> = [
  [
    "the function expression's own name equals the variable's",
    "let fn = function fn() { return 'stale'; };\nfn = require('d');\nmodule.exports = fn;",
    "default",
  ],
  [
    "reassigned from inside a function body",
    "var fn = function () { return 'stale'; };\nfunction init() { fn = require('d'); }\nmodule.exports = fn;",
    "default",
  ],
  [
    "shadowed by a block-scoped redeclaration",
    "let fn = function () { return 'stale'; };\n{ let fn = require('d'); void fn; }\nmodule.exports = fn;",
    "default",
  ],
  [
    "replaced by a logical assignment",
    "let fn = function () { return 'stale'; };\nfn ||= require('d');\nmodule.exports = fn;",
    "default",
  ],
  [
    "rebound by a for-of loop",
    "let fn = function () { return 'stale'; };\nfor (fn of [1]) { void fn; }\nmodule.exports = fn;",
    "default",
  ],
  [
    "rebound by a destructuring assignment",
    "let fn = function () { return 'stale'; };\n({ fn } = require('d'));\nmodule.exports = fn;",
    "default",
  ],
  [
    "exported through module.exports.X",
    "let fn = function () { return 'stale'; };\nfn = require('d');\nmodule.exports.fn = fn;",
    "fn",
  ],
  [
    "exported through an explicit object-literal property",
    "let fn = function () { return 'stale'; };\nfn = require('d');\nmodule.exports = { fn: fn };",
    "fn",
  ],
  [
    "conditionally reassigned, named expression, same name",
    "let fn = function fn() { return 'safe'; };\nif (process.env.X) { fn = require('d'); }\nmodule.exports = fn;",
    "default",
  ],
  [
    "an arrow re-exported through a property",
    "let fn = () => 'stale';\nfn = require('d');\nexports.fn = fn;",
    "fn",
  ],
  [
    "declared twice at top level",
    "var fn = function () { return 'a'; };\nvar fn = function () { return 'b'; };\nmodule.exports = fn;",
    "default",
  ],
  [
    "a conditional module.exports assignment over a stale alias",
    "let fn = function () { return 'stale'; };\nfn = require('d');\nif (process.env.X) { module.exports = fn; }",
    "default",
  ],
];

describe("RWF-013: final soundness attack -- no combination binds a stale node", () => {
  for (const [label, source, exportName] of STALE_SHAPES) {
    it(label, () => {
      // The same-named node really is there to be found; that is the point.
      const index = indexSourceFile("/pkg/index.js", source);
      expect(index.functions.length).toBeGreaterThan(0);

      expect(exportPosition(source, exportName)).toBeUndefined();
    });
  }
});
