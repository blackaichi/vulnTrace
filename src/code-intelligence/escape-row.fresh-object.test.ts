import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  declarationStoreOf,
  escapingValuesOf,
  ownMemberBookkeepingCounts,
  escapingAssignmentOf,
  escapingForOfStoreOf,
  isProvenFreshObject,
  storeReadsUnseen,
} from "./escape-row.js";

/**
 * Task BL-081 (RWF-110, RWF-063, RWF-120): which objects the escape row
 * proves are the program's own (`isProvenFreshObject`), so that a store
 * onto one of their members is no escape -- and which stores are.
 *
 * Every proof has a test that keeps it, and every refusal one that keeps
 * it refused: each case writes `X.probe = f` and asks about `X`. The
 * real-Node grounding of each proof is the oracle suite's `control.*` and
 * `fresh.*` cases (`tests/oracle/bl081-builtin-replaced-without-name.cases.ts`).
 */

function parse(source: string, fileName = "index.js"): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
}

/** The store `… .probe = …` in `source` (the last one, when several). */
function probeStore(source: string, fileName?: string): ts.BinaryExpression {
  const found: ts.BinaryExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "probe"
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source, fileName));
  const store = found.at(-1);
  expect(store, "a `.probe = …` store").toBeDefined();
  return store!;
}

/** Whether the object `.probe` is stored onto is proven to be the program's own. */
function proven(source: string, fileName?: string): boolean {
  const left = probeStore(source, fileName).left as ts.PropertyAccessExpression;
  return isProvenFreshObject(left.expression);
}

const isBuiltin = (specifier: string): boolean =>
  ["fs", "path", "node:fs"].includes(specifier);

describe("an object the program created is proven its own (task BL-081)", () => {
  it.each([
    ["an object literal", "({}).probe = f;"],
    ["an array literal", "[].probe = f;"],
    ["a function expression", "(function () {}).probe = f;"],
    ["an arrow function", "(() => 1).probe = f;"],
    ["a class expression", "(class {}).probe = f;"],
    ["a regular expression literal", "/x/.probe = f;"],
    ["a const bound to an object literal", "const o = {};\no.probe = f;"],
    [
      "a const alias of a const bound to an object literal",
      "const o = {};\nconst p = o;\np.probe = f;",
    ],
    ["a function declaration", "function F() {}\nF.probe = f;"],
    ["a class declaration", "class C {}\nC.probe = f;"],
    ["the value of a chained assignment", "let a;\n(a = {}).probe = f;"],
    ["`exports` in a CommonJS module", "exports.probe = f;"],
    [
      "`exports` whose every store holds the program's object",
      "function F() {}\nexports = module.exports = F;\nexports.probe = f;",
    ],
    ["`module` in a CommonJS module", "module.probe = f;"],
    ["`module.exports`, never stored", "module.exports.probe = f;"],
    [
      "`module.exports`, every store an object literal",
      "module.exports = { a: 1 };\nmodule.exports.probe = f;",
    ],
    ["`this` at a module's top level", "this.probe = f;"],
    [
      "`this` in an arrow at a module's top level",
      "const g = () => { this.probe = f; };",
    ],
    [
      "`this` in a base class's constructor",
      "class K { constructor() { this.probe = f; } }",
    ],
    [
      "`this` in a base class's instance field initializer",
      "class K { x = (this.probe = f); }",
    ],
    [
      "`this` in a static field initializer (the class)",
      "class B {}\nclass K extends B { static x = (this.probe = f); }",
    ],
    [
      "`this` in a static block (the class)",
      "class B {}\nclass K extends B { static { this.probe = f; } }",
    ],
    ["a class's `prototype`", "class C {}\nC.prototype.probe = f;"],
    [
      "a function's `prototype`, never stored",
      "function F() {}\nF.prototype.probe = f;",
    ],
    [
      "a function's `prototype`, every store an object literal",
      "function F() {}\nF.prototype = { a: 1 };\nF.prototype.probe = f;",
    ],
  ])("%s", (_name, source) => {
    expect(proven(source)).toBe(true);
  });
});

describe("every other object may be a builtin (task BL-081, RWF-110, RWF-063)", () => {
  it.each([
    ["a parameter", "function g(O) { O.probe = f; }"],
    ["a call result", "get().probe = f;"],
    [
      "a `new` result (a constructor may return any object)",
      "new K().probe = f;",
    ],
    [
      "`Object.create(…)` (`Object.create` may have been replaced)",
      "Object.create(null).probe = f;",
    ],
    ["a member read", "({}).constructor.probe = f;"],
    [
      "a member of an object literal binding",
      "const o = { a: {} };\no.a.probe = f;",
    ],
    ["a load", 'require("./o").probe = f;'],
    ["a destructured binding", "const { constructor: C } = {};\nC.probe = f;"],
    ["a reassigned binding", "let o = {};\no = Object;\no.probe = f;"],
    ["an undeclared name", "O.probe = f;"],
    ["`this` in a function (its receiver)", "function g() { this.probe = f; }"],
    ["`this` in a method", "const o = { m() { this.probe = f; } };"],
    [
      "`this` in a static method (its receiver)",
      "class K { static m() { this.probe = f; } }",
    ],
    [
      "`this` in a derived class's constructor (what the base returned)",
      "class K extends B { constructor() { super(); this.probe = f; } }",
    ],
    [
      "`this` in a derived class's instance field initializer",
      "class K extends B { x = (this.probe = f); }",
    ],
    ["`super`", "const o = { m() { super.probe = f; } };"],
    ["`arguments[0]`", "function g() { arguments[0].probe = f; }"],
    ["a name inside a `with` body", "const o = {};\nwith (w) { o.probe = f; }"],
    [
      "`exports` reassigned to another object",
      "exports = Object;\nexports.probe = f;",
    ],
    [
      "`exports` reassigned through a destructuring store",
      "({ a: exports } = src);\nexports.probe = f;",
    ],
    ["`module` reassigned", "module = Object;\nmodule.probe = f;"],
    [
      "`module.exports` stored another object",
      "module.exports = Object;\nmodule.exports.probe = f;",
    ],
    [
      "`module.exports` stored through an alias of `module`",
      "const m = module;\nm.exports = Object;\nmodule.exports.probe = f;",
    ],
    [
      "`module.exports` with a computed-key store onto `module`",
      "module[k] = Object;\nmodule.exports.probe = f;",
    ],
    [
      "`module.exports` stored through a destructuring store",
      "({ a: module.exports } = src);\nmodule.exports.probe = f;",
    ],
    [
      "a function's `prototype` stored another object",
      "function F() {}\nF.prototype = Object;\nF.prototype.probe = f;",
    ],
    [
      "a function's `prototype` stored through an alias",
      "function F() {}\nconst G = F;\nG.prototype = Object;\nF.prototype.probe = f;",
    ],
    [
      "a function's `prototype` stored a call result",
      "function F() {}\nF.prototype = Object.create(B.prototype);\nF.prototype.probe = f;",
    ],
    [
      "the `prototype` of a parameter",
      "function g(F) { F.prototype.probe = f; }",
    ],
    [
      "a derived class's `prototype` (it inherits from its base's: task BL-091, RWF-124)",
      "function X() {}\nX.prototype = globalThis;\nclass C extends X {}\nC.prototype.probe = f;",
    ],
    [
      "a derived class expression's `prototype` (task BL-091, RWF-124)",
      "function X() {}\nconst C = class extends X {};\nC.prototype.probe = f;",
    ],
    [
      "a class derived from a value that is not the program's own (its static side: task BL-091, RWF-126)",
      "class K extends B {}\nK.probe = f;",
    ],
    [
      "a derived class expression's static side (task BL-091, RWF-126)",
      "(class extends B {}).probe = f;",
    ],
    [
      "a class derived from a class derived from an ambient value",
      "class A extends B {}\nclass K extends A {}\nK.probe = f;",
    ],
    [
      "`this` in a derived class's static block, base not the program's own",
      "class K extends B { static { this.probe = f; } }",
    ],
    [
      "`this` in a derived class's static field, base not the program's own",
      "class K extends B { static x = (this.probe = f); }",
    ],
    ["a reassigned class", "class C {}\nC = Object;\nC.probe = f;"],
    [
      "the `prototype` of a reassigned class",
      "class C {}\nC = Object;\nC.prototype.probe = f;",
    ],
    [
      "a const alias of a class, taken after the class was reassigned",
      "class C {}\nC = Object;\nconst D = C;\nD.probe = f;",
    ],
    ["a reassigned function", "function F() {}\nF = Object;\nF.probe = f;"],
    [
      "`this` in a computed member name (the enclosing scope's)",
      "function g() { class K { [(this.probe = f, 'k')] = 1; } }",
    ],
    [
      "`this` in a decorator (the enclosing scope's)",
      "function g() { class K { @d(this.probe = f) x = 1; } }",
    ],
  ])("%s", (_name, source) => {
    expect(proven(source)).toBe(false);
  });

  it("`module` and `exports` in an ES module are the global object's, not the wrapper's", () => {
    expect(proven("exports.probe = f;", "index.mjs")).toBe(false);
    expect(proven("module.exports.probe = f;", "index.mjs")).toBe(false);
    expect(proven("export {};\nexports.probe = f;")).toBe(false);
  });

  it("a decorated class (a class decorator may hand back any value the name is then bound to)", () => {
    expect(
      proven(
        "function dec(c: unknown): any { return Object; }\n@dec class C {}\nC.probe = f;",
        "index.ts",
      ),
    ).toBe(false);
    expect(proven("@dec class C {}\nC.prototype.probe = f;", "index.ts")).toBe(
      false,
    );
    expect(proven("const C = @dec class {};\nC.probe = f;", "index.ts")).toBe(
      false,
    );
    expect(proven("class C { @dec m() {} }\nC.probe = f;", "index.ts")).toBe(
      true,
    );
  });

  it("static `this` of a decorated class (TC39 decorators run static code on the decorator's result)", () => {
    expect(
      proven("@dec class C { static { this.probe = f; } }", "index.ts"),
    ).toBe(false);
    expect(
      proven("@dec class C { static x = (this.probe = f); }", "index.ts"),
    ).toBe(false);
    expect(proven("class C { static { this.probe = f; } }", "index.ts")).toBe(
      true,
    );
  });

  it("`this` in a TypeScript enum initializer (it compiles to a function's `this`)", () => {
    expect(proven("enum E { A = (this.probe = f, 1) }", "index.ts")).toBe(
      false,
    );
  });

  it("`this` in a TypeScript namespace body (it compiles to a function's `this`)", () => {
    expect(proven("namespace N { this.probe = f; }", "index.ts")).toBe(false);
  });

  it("`module` and `exports` when the wrapper's `arguments` are read (they may be rebound)", () => {
    expect(proven("arguments[0] = Object;\nexports.probe = f;")).toBe(false);
  });
});

describe("which stores are escapes (task BL-081)", () => {
  function storeRoot(source: string): string | undefined {
    return escapingAssignmentOf(probeStore(source), isBuiltin)?.kind;
  }

  it("a store onto an unproven object is an escape; onto the program's own, none", () => {
    expect(storeRoot("function g(O) { O.probe = f; }")).toBe("unproven_object");
    expect(storeRoot("const o = {};\no.probe = f;")).toBeUndefined();
  });

  it("a provably primitive value is never an escape, whatever the object", () => {
    expect(storeRoot("function g(O) { O.probe = 1; }")).toBeUndefined();
  });

  it("the roots A-3a named keep their kinds", () => {
    expect(storeRoot("Object.probe = f;")).toBe("ambient");
    expect(storeRoot('const fs = require("fs");\nfs.probe = f;')).toBe(
      "builtin",
    );
  });

  it("a bare name stored in a `with` body may be a member of the `with` object (RWF-120)", () => {
    const [store] = (() => {
      const found: ts.BinaryExpression[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isBinaryExpression(node)) {
          found.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(parse("with (Object) { keys = f; }"));
      return found;
    })();
    expect(escapingAssignmentOf(store!, isBuiltin)?.kind).toBe(
      "unproven_object",
    );
  });

  it("a `for…of` head stores each element (RWF-120); a `for…in` head stores keys", () => {
    const forOf = (source: string): ts.ForOfStatement => {
      let found: ts.ForOfStatement | undefined;
      const visit = (node: ts.Node): void => {
        if (ts.isForOfStatement(node)) {
          found = node;
        }
        ts.forEachChild(node, visit);
      };
      visit(parse(source));
      return found!;
    };
    expect(
      escapingForOfStoreOf(forOf("for (Object.keys of [f]) {}"), isBuiltin)
        ?.kind,
    ).toBe("ambient");
    expect(
      escapingForOfStoreOf(
        forOf("function g(O) { for (O.keys of fns) {} }"),
        isBuiltin,
      )?.kind,
    ).toBe("unproven_object");
    expect(
      escapingForOfStoreOf(forOf("for (Object of [f]) {}"), isBuiltin)?.kind,
    ).toBe("ambient");
    // An iterable of primitives stores too: its iterator may be replaced.
    expect(
      escapingForOfStoreOf(forOf("for (Object.keys of ['a']) {}"), isBuiltin)
        ?.kind,
    ).toBe("ambient");
    expect(
      escapingForOfStoreOf(
        forOf("const o = {};\nfor (o.keys of fns) {}"),
        isBuiltin,
      ),
    ).toBeUndefined();
    expect(
      escapingForOfStoreOf(forOf("for (const k of fns) {}"), isBuiltin),
    ).toBeUndefined();
  });
});

describe("stores with no assignment expression (task BL-081's audit)", () => {
  function first<T extends ts.Node>(
    source: string,
    is: (node: ts.Node) => node is T,
    fileName = "index.js",
  ): T {
    let found: T | undefined;
    const visit = (node: ts.Node): void => {
      if (found === undefined && is(node)) {
        found = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(source, fileName));
    return found!;
  }

  it("a `var` with an initializer in a `with` body stores; `let`, `const` and a `var` elsewhere do not", () => {
    const at = (source: string) =>
      declarationStoreOf(first(source, ts.isVariableDeclaration));
    expect(at("with (o) { var keys = f; }")).toBeDefined();
    expect(at("with (o) { let keys = f; }")).toBeUndefined();
    expect(at("with (o) { const keys = f; }")).toBeUndefined();
    expect(at("var keys = f;")).toBeUndefined();
    expect(at("with (o) { var keys = 1; }")).toBeUndefined();
    // A pattern stores its defaults whatever its source.
    expect(at("with (o) { var { keys = f } = 0; }")).toBeDefined();
  });

  it("an instance field of a derived class stores; of a base class, or a static one, not", () => {
    const at = (source: string) =>
      declarationStoreOf(first(source, ts.isPropertyDeclaration));
    expect(at("class D extends B { keys = f; }")).toBeDefined();
    expect(at("class K { keys = f; }")).toBeUndefined();
    expect(at("class D extends B { static keys = f; }")).toBeUndefined();
  });

  it("a static field of a class whose base is not the program's own stores in a TypeScript file, whose emit may assign it (task BL-091, RWF-127)", () => {
    const at = (source: string, fileName: string) =>
      declarationStoreOf(first(source, ts.isPropertyDeclaration, fileName));
    expect(
      at("class D extends B { static keys = f; }", "index.ts"),
    ).toBeDefined();
    expect(
      at("const D = class extends B { static keys = f; };", "index.ts"),
    ).toBeDefined();
    // A base the program owns, or no base: no inherited setter.
    expect(
      at("class B {}\nclass D extends B { static keys = f; }", "index.ts"),
    ).toBeUndefined();
    expect(at("class K { static keys = f; }", "index.ts")).toBeUndefined();
    // JavaScript defines a static field: no setter runs.
    expect(
      at("class D extends B { static keys = f; }", "index.js"),
    ).toBeUndefined();
  });

  it("a decorated instance field of a derived class stores, whatever its initializer (a TC39 field decorator may replace it)", () => {
    const at = (source: string) =>
      declarationStoreOf(first(source, ts.isPropertyDeclaration, "index.ts"));
    expect(at("class D extends B { @dec keys = 1; }")).toBeDefined();
    expect(at("class D extends B { @dec keys; }")).toBeDefined();
    expect(at("class D extends B { keys = 1; }")).toBeUndefined();
  });

  it("a parameter property of a derived class's constructor stores", () => {
    const at = (source: string) =>
      declarationStoreOf(first(source, ts.isParameter, "index.ts"));
    expect(
      at("class D extends B { constructor(public keys: any) { super(); } }"),
    ).toBeDefined();
    expect(at("class K { constructor(public keys: any) {} }")).toBeUndefined();
    expect(
      at("class D extends B { constructor(keys: any) { super(); } }"),
    ).toBeUndefined();
  });

  it("what a pattern or a `for…of` head stores is attributed only from an object literal, one level deep", () => {
    const binary = (source: string) => {
      const node = first(source, ts.isBinaryExpression);
      return storeReadsUnseen(node, node.right);
    };
    const forOf = (source: string) => {
      const node = first(source, ts.isForOfStatement);
      return storeReadsUnseen(node, node.expression);
    };
    // An iteration: the iterator may yield anything, an array literal's
    // too (`Array.prototype[Symbol.iterator]` can be replaced).
    expect(binary("[O.k] = [f];")).toBe(true);
    expect(binary("[O.k] = it;")).toBe(true);
    expect(forOf("for (O.k of [f]) {}")).toBe(true);
    expect(forOf("for (O.k of 'ab') {}")).toBe(true);
    // A member read: only an object literal's members are its own.
    expect(binary("({ a: O.k } = { a: f });")).toBe(false);
    expect(binary("({ a: O.k = g } = { a: f });")).toBe(false);
    expect(binary("({ a: O.k } = fn);")).toBe(true);
    expect(binary("({ a: { b: O.k } } = { a: { b: f } });")).toBe(true);
    expect(binary("({ a: [O.k] } = { a: [f] });")).toBe(true);
    // A plain assignment reads nothing.
    expect(binary("O.k = fn;")).toBe(false);
  });
});

describe("a function or class handed over carries its own members (task BL-081's audit rounds 2 and 3)", () => {
  function kindsOfStored(source: string, fileName = "index.js"): string[] {
    const store = probeStore(source, fileName);
    return escapingValuesOf(store.right).map((value) => value.kind);
  }

  it("is opaque too when it may carry own members, through every route a freshness proof accepts", () => {
    expect(kindsOfStored("function K() {}\nG.probe = K;")).toEqual([
      "function",
    ]);
    expect(kindsOfStored("function K() {}\nK.max = f;\nG.probe = K;")).toEqual([
      "function",
      "opaque",
    ]);
    expect(
      kindsOfStored("function K() {}\nlet a;\n(a = K).max = f;\nG.probe = K;"),
    ).toEqual(["function", "opaque"]);
    expect(
      kindsOfStored(
        "function K() {}\nfunction Fn() {}\nFn.prototype = K;\nFn.prototype.max = f;\nG.probe = K;",
      ),
    ).toEqual(["function", "opaque"]);
    expect(kindsOfStored("class K { static max() {} }\nG.probe = K;")).toEqual([
      "class",
      "opaque",
    ]);
    expect(kindsOfStored("class K extends B {}\nG.probe = K;")).toEqual([
      "class",
      "opaque",
    ]);
  });

  it("a merged TypeScript namespace adds own members", () => {
    expect(
      kindsOfStored(
        "function K() {}\nnamespace K { export const max = f; }\nG.probe = K;",
        "index.ts",
      ),
    ).toEqual(["function", "opaque"]);
  });
});

describe("one relation for every route a freshness proof accepts (task BL-081's fourth audit round)", () => {
  // Each route to a definition `X` that `isProvenFreshObject` accepts as
  // the program's own object, written as [setup, route]: a store through
  // a stable name bound to it must count as a store onto `X` -- for its
  // own members and for its `prototype` -- or the proofs drift apart.
  const ROUTES: readonly (readonly [string, string, string])[] = [
    ["the name", "", "X"],
    ["an assignment's value", "let b;\n", "(b = X)"],
    [
      "a function's prototype",
      "function H() {}\nH.prototype = X;\n",
      "H.prototype",
    ],
    ["module.exports", "module.exports = X;\n", "module.exports"],
    ["exports", "exports = X;\n", "exports"],
  ];

  it.each(
    ROUTES.flatMap(([name, setup, route]) => [
      [`${name}, through a const`, setup, `const a = ${route};\n`],
      [
        `${name}, through two consts`,
        setup,
        `const a0 = ${route};\nconst a = a0;\n`,
      ],
    ]),
  )(
    "a member stored through %s marks X as carrying members",
    (_n, setup, alias) => {
      const store = probeStore(
        `function X() {}\n${setup}${alias}a.max = f;\nG.probe = X;`,
      );
      expect(escapingValuesOf(store.right).map((v) => v.kind)).toContain(
        "opaque",
      );
    },
  );

  it.each(
    ROUTES.flatMap(([name, setup, route]) => [
      [`${name}, through a const`, setup, `const a = ${route};\n`],
    ]),
  )("a prototype stored through %s refuses X.prototype", (_n, setup, alias) => {
    expect(
      proven(
        `function X() {}\n${setup}${alias}a.prototype = Object;\nX.prototype.probe = f;`,
      ),
    ).toBe(false);
  });

  it("a route that cannot be followed (a cycle through the stores) fails closed: may carry members", () => {
    const store = probeStore(
      "function X() {}\nfunction H() {}\nH.prototype = H.prototype;\nH.prototype.max = f;\nG.probe = X;",
    );
    expect(escapingValuesOf(store.right).map((v) => v.kind)).toContain(
      "opaque",
    );
  });

  it("a chain of aliases too long to follow (through assignment values, which the binder does not follow) fails closed: may carry members", () => {
    const store = probeStore(
      "function X() {}\nlet b1;\nconst a1 = (b1 = X);\nlet b2;\nconst a2 = (b2 = a1);\nlet b3;\nconst a3 = (b3 = a2);\nlet b4;\nconst a4 = (b4 = a3);\na4.max = f;\nG.probe = X;",
    );
    expect(escapingValuesOf(store.right).map((v) => v.kind)).toContain(
      "opaque",
    );
  });

  it("the control: no store through the route keeps both proofs", () => {
    const store = probeStore("function X() {}\nconst a = X;\nG.probe = X;");
    expect(escapingValuesOf(store.right).map((v) => v.kind)).toEqual([
      "function",
    ]);
    expect(
      proven("function X() {}\nconst a = X;\nX.prototype.probe = f;"),
    ).toBe(true);
  });
});

describe("the own-member and freshness bookkeeping is linear in a file's member stores (ARCHITECTURE § 10; task BL-081's fifth audit round)", () => {
  function measure(n: number): { builds: number; checks: number } {
    let source = "";
    for (let i = 0; i < n; i += 1) {
      source += `function F${i}() {}\nF${i}.prototype = { a: 1 };\nF${i}.prototype.m = function () {};\n`;
    }
    source += "function K() {}\nG.probe = K;\n";
    const store = probeStore(source);
    const before = ownMemberBookkeepingCounts();
    escapingValuesOf(store.right);
    const after = ownMemberBookkeepingCounts();
    return {
      builds: after.indexBuilds - before.indexBuilds,
      checks: after.fullSameObjectChecks - before.fullSameObjectChecks,
    };
  }

  it("checks `exports.x = …` stores against the file's bare-name stores through one index (task BL-081's sixth audit round)", () => {
    let source = "";
    for (let i = 0; i < 400; i += 1) {
      source += `exports.f${i} = function () {};\n`;
    }
    const stores: ts.BinaryExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node)) {
        stores.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(source));
    const before = ownMemberBookkeepingCounts();
    for (const store of stores) {
      expect(escapingAssignmentOf(store, isBuiltin)).toBeUndefined();
    }
    const after = ownMemberBookkeepingCounts();
    expect(after.indexBuilds - before.indexBuilds).toBeLessThanOrEqual(2);
    expect(after.fullSameObjectChecks - before.fullSameObjectChecks).toBe(0);
  });

  it("checks `__proto__` and computed-key stores onto many distinct objects without a per-pair check (task BL-081's eighth audit round)", () => {
    for (const store of ["__proto__ = null", "[k] = v"]) {
      let source = "";
      for (let i = 0; i < 300; i += 1) {
        source += `const o${i} = {};\no${i}${store.startsWith("[") ? "" : "."}${store};\no${i}.probe = f;\n`;
      }
      const sf = parse(source);
      const before = ownMemberBookkeepingCounts();
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "probe") {
          isProvenFreshObject(node.expression);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      const after = ownMemberBookkeepingCounts();
      expect(after.fullSameObjectChecks - before.fullSameObjectChecks).toBe(0);
    }
  });

  it("checks stores through aliasing bases by index, not per pair (task BL-081's ninth audit round)", () => {
    for (const shape of [
      (i: number) =>
        `const o${i} = {};\nconst a${i} = o${i};\na${i}.__proto__ = null;\no${i}.probe = f;\n`,
      (i: number) =>
        `const o${i} = {};\nconst p${i} = q.r;\np${i}[k] = 1;\no${i}.probe = f;\n`,
    ]) {
      let source = "";
      for (let i = 0; i < 200; i += 1) {
        source += shape(i);
      }
      const sf = parse(source);
      const before = ownMemberBookkeepingCounts();
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "probe") {
          isProvenFreshObject(node.expression);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      const after = ownMemberBookkeepingCounts();
      expect(after.fullSameObjectChecks - before.fullSameObjectChecks).toBe(0);
    }
  });

  describe("stores onto bases whose aliases cannot be followed (task BL-091, observation 1)", () => {
    // `c6` is five aliases from `{}`: `definitionsDenotedBy` follows at most
    // `MAX_ALIAS_HOPS` of them and answers "unknown" (every question about
    // a store onto it is "may be any object"). Every store below is onto
    // `c6`, so every question about any object gets the whole list.
    const chain = Array.from(
      { length: 7 },
      (_, i) => `const c${i} = ${i === 0 ? "{}" : `c${i - 1}`};\n`,
    ).join("");

    function visits(shape: (i: number) => string, n: number): number {
      let source = chain;
      for (let i = 0; i < n; i += 1) {
        source += shape(i);
      }
      const before = ownMemberBookkeepingCounts();
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "probe") {
          isProvenFreshObject(node.expression);
        }
        ts.forEachChild(node, visit);
      };
      visit(parse(source));
      return ownMemberBookkeepingCounts().storeVisits - before.storeVisits;
    }

    it.each([
      [
        "a `prototype` store of a function, asked of every function",
        (i: number) =>
          `function F${i}() {}\nc6.prototype = {};\nF${i}.prototype.probe = f;\n`,
      ],
      [
        "a `prototype` store of a function, asked through names bound to `F.prototype` that a computed-key store names",
        (i: number) =>
          `function F${i}() {}\nconst p${i} = F${i}.prototype;\np${i}[k] = 1;\nc6.prototype = function () {};\nF${i}.prototype.probe = f;\n`,
      ],
      [
        "a `__proto__` store, asked of every object",
        (i: number) =>
          `const o${i} = {};\nc6.__proto__ = null;\no${i}.probe = f;\n`,
      ],
    ])("reads each store a constant number of times: %s", (_name, shape) => {
      const small = visits(shape, 100);
      const large = visits(shape, 400);
      // Linear: four times the stores, about four times the reads. The
      // per-object copy and walk of the whole list was N squared (160,000
      // reads at 400 stores, measured before task BL-091).
      expect(large).toBeLessThanOrEqual(20 * 400);
      expect(large).toBeLessThanOrEqual(5 * small);
    });
  });

  it("builds each file's member-store index once, and runs no full same-object check per pair of objects", () => {
    const small = measure(50);
    const large = measure(400);
    expect(small.builds).toBe(1);
    expect(large.builds).toBe(1);
    // Every base here names its function directly: no full check at all.
    expect(large.checks).toBe(0);
  });
});

describe("a store through a name whose aliases cannot be followed may be onto any object (task BL-091: the shared list)", () => {
  // Twenty aliases: more than `definitionsDenotedBy` follows, and more
  // than `resolveNamedBinding` follows in one step, so a store through
  // `a20` is filed in the list every object's answer shares.
  const chain = (head: string) =>
    Array.from(
      { length: 20 },
      (_, i) => `const a${i + 1} = ${i === 0 ? head : `a${i}`};\n`,
    ).join("");

  it("its value is checked: a `prototype` stored through it is not the program's own", () => {
    expect(
      proven(
        `function F() {}\n${chain("F")}a20.prototype = globalThis;\nF.prototype.probe = f;`,
      ),
    ).toBe(false);
  });

  it("its presence is checked: a `__proto__` stored through it may change any object's [[Prototype]]", () => {
    expect(
      proven(
        `const o = {};\n${chain("o")}a20.__proto__ = globalThis;\no.probe = f;`,
      ),
    ).toBe(false);
  });

  // The store through `a20` is itself an escape (its base is not proven
  // the program's own), and an escaping store under a `prototype` key makes
  // its value opaque on its own: this answer does not depend on the shared
  // list being followed (dropping it from `storeValueDefinitions` is an
  // equivalent mutant), but it must not change if either rule goes.
  it("its value is followed: a function stored as a `prototype` through it carries the members stored there", () => {
    const store = probeStore(
      `function F() {}\nfunction K() {}\n${chain("F")}a20.prototype = K;\nF.prototype.max = f;\nG.probe = K;`,
    );
    expect(escapingValuesOf(store.right).map((v) => v.kind)).toContain(
      "opaque",
    );
  });
});

describe("a memoized answer is shared only by names it is the same answer for (task BL-091, observation 2)", () => {
  // Every unresolved name of one spelling shares one memo slot per file and
  // key. A parameter named `exports` is unresolved, and so is the module's
  // own `exports` -- which `definitionsDenotedBy` follows through the
  // values stored to it (`exports = G`), and the parameter not. Whichever
  // was asked first used to fix the answer for the other.
  const shadowed =
    "function g(exports) { const s = exports.prototype; s.z = f; }\n";
  // `q` is `F` (`exports = G; G.prototype = F`).
  const alias =
    "function G() {}\nexports = G;\nfunction F() {}\nG.prototype = F;\n" +
    "const q = exports.prototype;\n";

  /** The store `<name>.probe = …`, and the store `Z.handed = F`. */
  function storesOf(source: string): {
    probe: ts.BinaryExpression;
    handed: ts.BinaryExpression;
  } {
    const found: Record<string, ts.BinaryExpression> = {};
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        ts.isPropertyAccessExpression(node.left) &&
        ["probe", "handed"].includes(node.left.name.text)
      ) {
        found[node.left.name.text] = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(source));
    return { probe: found.probe!, handed: found.handed! };
  }

  it.each([
    ["alone", "", ""],
    ["after the shadowing parameter's question", shadowed, ""],
    ["before the shadowing parameter's question", "", shadowed],
  ])(
    "`F`'s [[Prototype]] may be changed through `q`, whatever was asked first: %s",
    (_name, before, after) => {
      // `q.__proto__ = X` is `F.__proto__ = X`: `F` is not the program's own.
      const source = `${before}${alias}q.__proto__ = globalThis;\nF.probe = f;\nZ.handed = F;\n${after}`;
      const { probe, handed } = storesOf(source);
      // The shadowing parameter's question first: what `F` hands over.
      escapingValuesOf(handed.right);
      expect(
        isProvenFreshObject(
          (probe.left as ts.PropertyAccessExpression).expression,
        ),
      ).toBe(false);
    },
  );

  it.each([
    ["alone", "", ""],
    ["after the shadowing parameter's question", shadowed, ""],
    ["before the shadowing parameter's question", "", shadowed],
  ])(
    "`F` carries the member stored through `q`, whatever was asked first: %s",
    (_name, before, after) => {
      const source = `${before}${alias}q.max = f;\nZ.handed = F;\n${after}`;
      const kinds = escapingValuesOf(storesOf(source).handed.right).map(
        (value) => value.kind,
      );
      expect(kinds).toEqual(["function", "opaque"]);
    },
  );
});

describe("a name bound to a function expression denotes it through a longer alias chain than the denotation relation follows (task BL-091, observation 3)", () => {
  // `denotedDefinitionOf` asks `resolveNamedBinding`, which follows an alias
  // chain in one step; `definitionsDenotedBy` follows one hop at a time for
  // at most `MAX_ALIAS_HOPS` (four). A name four or more aliases from a
  // function expression (measured: four to twelve) is therefore denoted
  // precisely only through the shortcut: without it the relation answers
  // "unknown", and every function of the file may carry the member stored.
  const chain = (length: number) =>
    "const k = function () {};\n" +
    Array.from(
      { length },
      (_, i) => `const a${i + 1} = ${i === 0 ? "k" : `a${i}`};\n`,
    ).join("") +
    `a${length}.max = f;\n` +
    "const other = function () {};\n";

  const kindsHandedOver = (source: string, name: string): string[] => {
    const handed = parse(`${source}Z.handed = ${name};\n`);
    const stores: ts.BinaryExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.name.text === "handed"
      ) {
        stores.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(handed);
    return escapingValuesOf(stores[0]!.right).map((value) => value.kind);
  };

  it.each([1, 3, 4, 6, 12])(
    "a store through a chain of %i aliases is a store onto the function expression, and onto no other",
    (length) => {
      expect(kindsHandedOver(chain(length), "k")).toEqual([
        "function",
        "opaque",
      ]);
      expect(kindsHandedOver(chain(length), "other")).toEqual(["function"]);
    },
  );
});

describe("a class's `prototype` may be replaced under TypeScript's ES5 emit (task BL-091, RWF-128)", () => {
  it.each([
    [
      "a store onto the `prototype` of a class whose `prototype` is stored",
      "class C {}\n(C as any).prototype = globalThis;\nC.prototype.probe = f;",
    ],
    [
      "`this` in the constructor of a class whose `prototype` is stored",
      "class C { constructor() { this.probe = f; } }\n(C as any).prototype = globalThis;",
    ],
    [
      "`this` in an instance field initializer, a `prototype` stored through a computed key",
      "class C { x = (this.probe = f); }\n(C as any)[k] = globalThis;",
    ],
  ])("%s is not proven the program's own", (_name, source) => {
    expect(proven(source, "index.ts")).toBe(false);
  });

  it.each([
    [
      "`this` in a constructor",
      "class C { constructor() { this.probe = f; } }",
    ],
    ["a class's `prototype`", "class C {}\nC.prototype.probe = f;"],
  ])("%s, no `prototype` stored, stays proven", (_name, source) => {
    expect(proven(source, "index.ts")).toBe(true);
  });

  it("`this` stored as a class's `prototype` from its own constructor is not proven, and the proof ends (task BL-091's independent audit: it recursed without bound)", () => {
    expect(
      proven(
        "class C { constructor() { (C as any).prototype = this; this.probe = f; } }",
        "index.ts",
      ),
    ).toBe(false);
    expect(
      proven(
        "class C { x = ((C as any).prototype = this); y = (this.probe = f); }",
        "index.ts",
      ),
    ).toBe(false);
  });

  it("checks a file's `prototype` stores once, however many `this` positions ask (task BL-091's independent audit: once per `this` was quadratic)", () => {
    let source = "";
    for (let i = 0; i < 200; i += 1) {
      source += `function F${i}() {}\nF${i}.prototype = {};\nclass C${i} { constructor() { this.probe = f; } }\n`;
    }
    const sf = parse(source, "index.ts");
    const before = ownMemberBookkeepingCounts();
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "probe") {
        isProvenFreshObject(node.expression);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    const after = ownMemberBookkeepingCounts();
    expect(
      after.prototypeStabilityComputations -
        before.prototypeStabilityComputations,
    ).toBe(1);
  });

  it("JavaScript keeps the constructor's `this`: a class's `prototype` is non-writable", () => {
    expect(
      proven(
        "class C { constructor() { this.probe = f; } }\nC.prototype = globalThis;",
        "index.js",
      ),
    ).toBe(true);
  });
});

describe("an object whose [[Prototype]] may change, or that binds no value, is not proven its own (task BL-081's seventh audit round)", () => {
  it.each([
    [
      "an object literal with `__proto__`",
      "const o = { __proto__: g };\no.probe = f;",
    ],
    [
      "a name whose `__proto__` the file stores",
      "const o = {};\no.__proto__ = g;\no.probe = f;",
    ],
    [
      "a name with a computed-key store (the key may be `__proto__`)",
      "const o = {};\no[k] = g;\no.probe = f;",
    ],
    [
      "a name with a `Symbol.x` key that is no well-known symbol (the program may store `__proto__` there)",
      "const o = {};\no[Symbol.foo] = g;\no.probe = f;",
    ],
    [
      "a name with a well-known symbol key (another module may replace the global `Symbol`, task BL-081's ninth audit round)",
      "const o = {};\no[Symbol.iterator] = g;\no.probe = f;",
    ],
    [
      "a function whose `__proto__` the file stores",
      "function F() {}\nF.__proto__ = g;\nF.probe = f;",
    ],
    [
      "a class instance whose prototype's `__proto__` the file stores",
      "class C { constructor() { this.probe = f; } }\nC.prototype.__proto__ = g;",
    ],
    [
      "a function's `prototype` after a `__proto__` store through an alias",
      "function F() {}\nconst p = F.prototype;\np.__proto__ = g;\nF.prototype.probe = f;",
    ],
    [
      "an async function's `prototype` (inherited, not own)",
      "async function A() {}\nA.prototype.probe = f;",
    ],
  ])("%s", (_name, source) => {
    expect(proven(source)).toBe(false);
  });

  it.each([
    ["a numeric key keeps the proof", "const o = {};\no[0] = g;\no.probe = f;"],
    [
      "an async generator's `prototype` is its own",
      "async function* A() {}\nA.prototype.probe = f;",
    ],
  ])("%s", (_name, source) => {
    expect(proven(source)).toBe(true);
  });

  it("a TypeScript declaration that binds no run-time value", () => {
    expect(
      proven("declare class Object {}\nObject.probe = f;", "index.ts"),
    ).toBe(false);
    expect(
      proven("declare function Math(): void;\nMath.probe = f;", "index.ts"),
    ).toBe(false);
    // An overloaded function is refused too: the binding may resolve to a
    // bodiless signature (a precision cost, never a proof).
    expect(
      proven(
        "function F(): void;\nfunction F(a?: any) {}\nF.probe = f;",
        "index.ts",
      ),
    ).toBe(false);
  });
});
