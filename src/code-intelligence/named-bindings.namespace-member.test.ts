import ts from "typescript";
import { describe, expect, it } from "vitest";
import { escapingAssignmentOf } from "./escape-row.js";
import { resolveNamedBinding, type NamedBinding } from "./named-bindings.js";
import { namespaceMemberCounters } from "./namespace-members.js";

/**
 * Task BL-099 (RWF-141, RWF-145): a use of a TypeScript namespace's
 * exported member is a read of the namespace's object, never a binding.
 *
 * TypeScript rewrites the use (measured with the repository's TypeScript at
 * ES5, ES2020 and ES2022; the real-Node cases are
 * `tests/oracle/bl099-namespace-export-member-read.cases.ts`):
 *
 * - in its own block, an exported variable (a destructured one included)
 *   and an `export import` alias: `h(1)` → `N.h(1)`; an exported function
 *   or class stays local;
 * - from another block of the merged namespace, or a namespace nested in
 *   it, every member of the namespace's merged symbol: another block's
 *   export, the function and class too, an ambient block's implicit one,
 *   one a module augmentation adds, one another file's block adds. No
 *   file's syntax shows them all (the task's independent audit, rounds 1
 *   to 3), so no name is looked up past a namespace.
 *
 * Each rule is pinned by name, so a mutation of any one fails here: the
 * own-block check (`isNamespaceMemberDeclaration`), the walk-out refusal
 * (`leavesNamespace`), the namespace's own `import X = A.b` declaration
 * and the exclusion of its `require` form, the escape row's reading of the
 * new cause as maybe the global (`mayBeUndeclaredGlobal`), and an ambient
 * block's implicit exports in the escape row's member index
 * (`exportedNamespaceMembers`). `lexicalDeclarationOf` is not changed: its
 * consumers read "no declaration" as a global (FINDINGS RWF-146).
 */

/** A module (it has `export {}`) unless `script` is set. */
function parse(source: string, script = false): ts.SourceFile {
  return ts.createSourceFile(
    "impl.ts",
    script ? source : `${source}\nexport {};\n`,
    ts.ScriptTarget.ES2022,
    true,
  );
}

/** The identifier at the `index`-th (0-based) occurrence of `marker`'s first character, where `marker` is the text around it. */
function referenceAt(
  sourceFile: ts.SourceFile,
  marker: string,
  index = 0,
): ts.Identifier {
  let at = -1;
  for (let i = 0; i <= index; i += 1) {
    at = sourceFile.text.indexOf(marker, at + 1);
    if (at < 0) {
      throw new Error(`marker not found: ${marker} #${index}`);
    }
  }
  let found: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.getStart(sourceFile) === at) {
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) {
    throw new Error(`no identifier starts at ${marker}`);
  }
  return found;
}

function resolve(source: string, marker: string, script = false): NamedBinding {
  return resolveNamedBinding(referenceAt(parse(source, script), marker));
}

function cause(binding: NamedBinding): string {
  return binding.kind === "unresolved" ? binding.cause : binding.kind;
}

const F = "function (x: any) { return x; }";

describe("BL-099: a namespace's exported member, used in its own block", () => {
  it("an exported `let` is a member read (RWF-141's reproduction)", () => {
    expect(
      cause(resolve(`namespace N { export let h: any = ${F}; h(1); }`, "h(1)")),
    ).toBe("namespace_member");
  });

  it("an exported `const` is a member read", () => {
    expect(
      cause(resolve(`namespace N { export const h = ${F}; h(1); }`, "h(1)")),
    ).toBe("namespace_member");
  });

  it("an exported `var` is a member read", () => {
    expect(
      cause(resolve(`namespace N { export var h = ${F}; h(1); }`, "h(1)")),
    ).toBe("namespace_member");
  });

  it("a name an exported destructuring binds is a member read, not a destructuring", () => {
    expect(
      cause(
        resolve(
          `namespace N { export const { h } = { h: ${F} }; h(1); }`,
          "h(1)",
        ),
      ),
    ).toBe("namespace_member");
    expect(
      cause(
        resolve(
          `namespace N { export const { a: [h] } = { a: [${F}] }; h(1); }`,
          "h(1)",
        ),
      ),
    ).toBe("namespace_member");
  });

  it("an `export import` alias is a member read", () => {
    expect(
      cause(
        resolve(
          `namespace I { export const f = ${F}; }\nnamespace N { export import h = I.f; h(1); }`,
          "h(1)",
        ),
      ),
    ).toBe("namespace_member");
  });

  it("an exported variable in a nested block of the body, an error TypeScript still emits as a member (audit round 5, finding 4)", () => {
    expect(
      cause(
        resolve(`namespace N { { export var h: any = ${F}; } h(1); }`, "h(1)"),
      ),
    ).toBe("namespace_member");
  });

  it("the read in a nested function is a member read too", () => {
    expect(
      cause(
        resolve(
          `namespace N { export let h: any = ${F}; function run() { h(1); } }`,
          "h(1)",
        ),
      ),
    ).toBe("namespace_member");
  });

  it("an alias of the exported variable refuses: its hop is a member read", () => {
    expect(
      cause(
        resolve(
          `namespace N { export let h: any = ${F}; const a = h; a(1); }`,
          "a(1)",
        ),
      ),
    ).toBe("namespace_member");
  });

  it("control: an exported function keeps its local binding in its own block", () => {
    expect(
      cause(resolve(`namespace N { export function f() {} f(); }`, "f();")),
    ).toBe("function");
  });

  it("control: an exported class keeps its local binding in its own block", () => {
    expect(
      cause(resolve(`namespace N { export class K {} new K(); }`, "K();")),
    ).toBe("class");
  });

  it("control: a member that is not exported is a local binding", () => {
    expect(
      cause(resolve(`namespace N { let h: any = ${F}; h(1); }`, "h(1)")),
    ).toBe("value");
  });

  it("control: an inner declaration that shadows the export is its own binding", () => {
    expect(
      cause(
        resolve(
          `namespace N { export let h: any = ${F}; function run() { const h = ${F}; h(1); } }`,
          "h(1)",
        ),
      ),
    ).toBe("value");
  });

  it("control: a module's own `export const` at file scope is a binding", () => {
    expect(cause(resolve(`export const h = ${F};\nh(1);`, "h(1)"))).toBe(
      "value",
    );
  });

  it("control: a `for` head inside an exported initializer is the loop's own binding", () => {
    expect(
      cause(
        resolve(
          `namespace N { export const C = class { static { for (const g of [${F}]) { g(1); } } }; }`,
          "g(1)",
        ),
      ),
    ).not.toBe("namespace_member");
  });
});

describe("BL-099: no name is looked up past a namespace", () => {
  it("another block's exported variable shadows an outer `const` spelled the same", () => {
    expect(
      cause(
        resolve(
          `const h = ${F};\nnamespace N { export let h: any = ${F}; }\nnamespace N { h(1); }`,
          "h(1)",
        ),
      ),
    ).toBe("namespace_member");
  });

  it("another block's exported function is a member read (`N.f()`)", () => {
    expect(
      cause(
        resolve(
          `function f() {}\nnamespace N { export function f() {} }\nnamespace N { f(); }`,
          "f();",
        ),
      ),
    ).toBe("namespace_member");
  });

  it("a dotted nested namespace reads its parent's export", () => {
    expect(
      cause(
        resolve(
          `const h = ${F};\nnamespace N { export let h: any = ${F}; }\nnamespace N.P { h(1); }`,
          "h(1)",
        ),
      ),
    ).toBe("namespace_member");
  });

  it("a namespace nested in another block reads the outer namespace's export", () => {
    expect(
      cause(
        resolve(
          `const h = ${F};\nnamespace N { export let h: any = ${F}; }\nnamespace N { namespace P { h(1); } }`,
          "h(1)",
        ),
      ),
    ).toBe("namespace_member");
  });

  it("an ambient block's implicit export (audit round 1, finding 1)", () => {
    expect(
      cause(
        resolve(
          `const call = ${F};\nfunction N(x: any) {}\ndeclare namespace N { let call: any; }\nnamespace N { call(1); }`,
          "call(1)",
        ),
      ),
    ).toBe("namespace_member");
  });

  it("a member a module augmentation may add, the namespace exported through an alias (audit rounds 2 and 3)", () => {
    expect(
      cause(
        resolve(
          `const call = ${F};\nnamespace N { export function P(x: any) {} export namespace P { call(1); } }\nexport = N.P;`,
          "call(1)",
        ),
      ),
    ).toBe("namespace_member");
  });

  it("an `export { h }` in another block, which TypeScript reports and still emits (audit round 3, finding 2)", () => {
    expect(
      cause(
        resolve(
          `const h = ${F};\nnamespace Q { const h: any = 2; export { h }; }\nnamespace Q { h(1); }`,
          "h(1)",
        ),
      ),
    ).toBe("namespace_member");
  });

  it("any other name leaving a namespace, a global's included", () => {
    expect(
      cause(resolve(`function f() {}\nnamespace N { f(); }`, "f();")),
    ).toBe("namespace_member");
    expect(
      cause(resolve(`namespace N { setTimeout(() => {}, 0); }`, "setTimeout")),
    ).toBe("namespace_member");
  });

  it("control: outside the namespace, the outer binding stands", () => {
    expect(
      cause(
        resolve(
          `const h = ${F};\nnamespace N { export let h: any = ${F}; }\nh(1);`,
          "h(1)",
        ),
      ),
    ).toBe("value");
  });
});

describe("BL-099: a function declared in a nested block (RWF-147, audit round 4)", () => {
  it("seen from outside its block, it is refused: in strict code the name there is an outer binding", () => {
    expect(
      cause(
        resolve(
          `const h = ${F};\nfunction g() { { function h(x: any) { return x; } } h(1); }`,
          "h(1)",
        ),
      ),
    ).toBe("block_function");
    expect(
      cause(
        resolve(
          `namespace N { export var h: any = ${F}; }\nnamespace N { if (true) { function h(x: any) { return x; } } h(1); }`,
          "h(1)",
        ),
      ),
    ).toBe("block_function");
  });

  it("control: used inside its block, it is the function", () => {
    expect(
      cause(
        resolve(
          `const h = ${F};\nfunction g() { { function h(x: any) { return x; } h(1); } }`,
          "h(1)",
        ),
      ),
    ).toBe("function");
  });

  it("used inside its block, it is found before a declaration between the block and the hoisting scope (audit round 5, finding 3)", () => {
    expect(
      cause(
        resolve(
          `namespace N { const h: any = ${F}; { function h(x: any) { return x; } h(1); } }`,
          "h(1)",
        ),
      ),
    ).toBe("function");
    expect(
      cause(
        resolve(
          `function g() { const h = ${F}; { function h(x: any) { return x; } h(1); } }`,
          "h(1)",
        ),
      ),
    ).toBe("function");
  });

  it("a braceless `if` body is its own container: its condition does not see it (audit round 5, N1)", () => {
    expect(cause(resolve(`if (h(1)) function h() {}`, "h(1)", true))).toBe(
      "block_function",
    );
  });

  it("a class static block is a var scope: its function and `var` do not hoist into the namespace (audit round 5, findings 1 and 2)", () => {
    expect(
      cause(
        resolve(
          `namespace N { class C { static { function h(x: any) { return x; } } } h(1); }`,
          "h(1)",
        ),
      ),
    ).toBe("namespace_member");
    expect(
      cause(
        resolve(
          `namespace N { class C { static { var h: any = ${F}; } } h(1); }`,
          "h(1)",
        ),
      ),
    ).toBe("namespace_member");
  });

  it("control: a function declared in a function's body is not a block function", () => {
    expect(
      cause(
        resolve(`function g() { function h() {} if (true) { h(); } }`, "h();"),
      ),
    ).toBe("function");
  });
});

describe("BL-099: a namespace's own `import X =` (RWF-145)", () => {
  it("is a declaration of its block: it shadows an outer `const`", () => {
    expect(
      cause(
        resolve(
          `const g = ${F};\nnamespace I { export const h = ${F}; }\nnamespace N { import g = I.h; g(1); }`,
          "g(1)",
        ),
      ),
    ).toBe("import_binding");
  });

  it('`import x = require("m")` in a namespace emits nothing, and is no binding (audit round 2, finding 1)', () => {
    // `x` is the outer binding at run time; the walk then leaves the
    // namespace and refuses it, never taking the `require` for a load.
    expect(
      cause(
        resolve(
          `const x = ${F};\nnamespace N { import x = require("m"); x(1); }`,
          "x(1)",
        ),
      ),
    ).toBe("namespace_member");
  });
});

describe("BL-099: the escape row (audit rounds 1 and 2)", () => {
  /** The first assignment of `source`. */
  function firstAssignment(sourceFile: ts.SourceFile): ts.BinaryExpression {
    let assignment: ts.BinaryExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (assignment === undefined && ts.isBinaryExpression(node)) {
        assignment = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (!assignment) {
      throw new Error("no assignment");
    }
    return assignment;
  }

  it("in a script, `JSON = f` in a namespace is an ambient escape: a refused name may be the global", () => {
    const sourceFile = parse(
      `namespace N { JSON = function () {} as any; }`,
      true,
    );
    expect(
      escapingAssignmentOf(firstAssignment(sourceFile), () => false),
    ).toEqual({ kind: "ambient" });
  });

  it("an ambient block's declaration is a member: a write to it from another block is a store onto the namespace's object", () => {
    const sourceFile = parse(
      `declare namespace N { let k: any; }\nnamespace N { k = function () {}; }`,
    );
    expect(
      escapingAssignmentOf(firstAssignment(sourceFile), () => false),
    ).toEqual({ kind: "unproven_object" });
  });
});

describe("BL-099: structural cost", () => {
  it("walking out of a namespace builds no namespace index", () => {
    const blocks = Array.from(
      { length: 40 },
      (_, i) => `namespace N { export let h${i}: any = ${F}; h${i}(1); g(1); }`,
    ).join("\n");
    const sourceFile = parse(`const g = ${F};\n${blocks}`);
    const references: ts.Identifier[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        references.push(node.expression);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    const before = namespaceMemberCounters();
    for (const reference of references) {
      expect(cause(resolveNamedBinding(reference))).toBe("namespace_member");
    }
    expect(
      namespaceMemberCounters().namespaceBlockIndexBuilds -
        before.namespaceBlockIndexBuilds,
    ).toBe(0);
  });
});
