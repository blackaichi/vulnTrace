import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  loadDefectRegisters,
  rwfReferenceProblems,
} from "../testing/open-soundness-defect.js";
import {
  LEXICAL_FAMILIES,
  SYNTAX_KIND_CENSUS,
  censusEntryFor,
  invocationSiteOf,
  type InvocationSiteKind,
} from "./invocation-sites.js";

/**
 * ADR 0008 § 2's syntax-kind census (task A-1): every `ts.SyntaxKind` is
 * classified as an invocation site, a site pending a named lane-A task,
 * or not invocation-capable -- and a TypeScript upgrade that adds a node
 * kind fails here, naming it, until someone classifies it.
 */

function kindName(kind: number): string {
  return Object.entries(ts.SyntaxKind)
    .filter(([, value]) => value === kind)
    .map(([name]) => name)
    .join("/");
}

function inLexicalFamily(kind: number): boolean {
  return LEXICAL_FAMILIES.some(
    (family) => kind >= family.first && kind <= family.last,
  );
}

describe("the syntax-kind census", () => {
  it("classifies every ts.SyntaxKind the installed TypeScript defines", () => {
    const unclassified: string[] = [];
    for (let kind = 0; kind < ts.SyntaxKind.Count; kind++) {
      if (censusEntryFor(kind) === undefined) {
        unclassified.push(`${kind}:${kindName(kind)}`);
      }
    }
    expect(
      unclassified,
      "classify each in src/code-intelligence/invocation-sites.ts",
    ).toEqual([]);
  });

  it("names only real node kinds, each once, none inside a lexical family", () => {
    const seen = new Map<number, string>();
    const problems: string[] = [];
    for (const name of Object.keys(SYNTAX_KIND_CENSUS)) {
      const kind = ts.SyntaxKind[name as keyof typeof ts.SyntaxKind] as
        number | undefined;
      if (typeof kind !== "number") {
        problems.push(`${name}: not a ts.SyntaxKind member`);
        continue;
      }
      if (inLexicalFamily(kind)) {
        problems.push(`${name}: inside a lexical family, classified twice`);
      }
      const previous = seen.get(kind);
      if (previous !== undefined) {
        problems.push(`${name}: the same kind as ${previous}`);
      }
      seen.set(kind, name);
    }
    expect(problems).toEqual([]);
  });

  it("every pending entry names an OPEN finding", () => {
    const { findings } = loadDefectRegisters();
    const problems = Object.entries(SYNTAX_KIND_CENSUS).flatMap(
      ([name, entry]) =>
        entry.role === "pending"
          ? entry.findings.flatMap((id) =>
              rwfReferenceProblems(id, findings).map((p) => `${name}: ${p}`),
            )
          : [],
    );
    expect(problems).toEqual([]);
  });
});

/**
 * One program containing every kind the census marks a site, and the
 * site kind each must yield. A `site` entry nobody can produce from a
 * source file would be a census claim with no handler behind it.
 */
const SITE_EXAMPLES: Readonly<
  Record<string, { source: string; site: InvocationSiteKind }>
> = {
  CallExpression: { source: "f();", site: "call" },
  NewExpression: { source: "new C();", site: "construct" },
  TaggedTemplateExpression: { source: "tag`x`;", site: "tagged_template" },
  Decorator: { source: "@dec class X {}", site: "decorator" },
  ClassDeclaration: {
    source: "class Sub extends Base {}",
    site: "implicit_super",
  },
  ClassExpression: {
    source: "const Sub = class extends Base {};",
    site: "implicit_super",
  },
};

function nodesOfKind(source: string, kind: ts.SyntaxKind): ts.Node[] {
  const sourceFile = ts.createSourceFile(
    "example.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === kind) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe("invocationSiteOf agrees with the census", () => {
  it("has an example for every kind the census marks a site", () => {
    const siteKinds = Object.entries(SYNTAX_KIND_CENSUS)
      .filter(([, entry]) => entry.role === "site")
      .map(([name]) => name)
      .sort();
    expect(Object.keys(SITE_EXAMPLES).sort()).toEqual(siteKinds);
  });

  it.each(Object.entries(SITE_EXAMPLES))(
    "%s yields its census site kind",
    (name, example) => {
      const kind = ts.SyntaxKind[name as keyof typeof ts.SyntaxKind];
      const entry = SYNTAX_KIND_CENSUS[name as keyof typeof SYNTAX_KIND_CENSUS];
      const nodes = nodesOfKind(example.source, kind);
      expect(nodes.length).toBeGreaterThan(0);
      for (const node of nodes) {
        expect(entry.role === "site" && entry.site).toBe(example.site);
        expect(invocationSiteOf(node)?.kind).toBe(example.site);
      }
    },
  );

  it("yields a site only for a kind the census marks a site", () => {
    const source = [
      `import x from "y";`,
      `const { a, ...rest } = obj; const [b] = arr;`,
      `class Base { constructor() {} static { init(); } get g() { return 1; } set s(v) {} m() {} f = 1; }`,
      `class Own extends Base { constructor() { super(); } }`,
      `declare class Ambient extends Base {}`,
      `const o = { toString() { return ""; }, then: () => 1, p, ...rest };`,
      `for (const v of it) {} for (const k in o) {}`,
      `async function g() { await p; } function* h() { yield* it; }`,
      "`${a}`; a + b; a instanceof B; delete o.p; ++i; o[k]; o.p;",
      `if (false) { f(); } else { g(); }`,
      `label: while (x) { break label; }`,
      `try { t(); } catch (e) {} finally {}`,
      `switch (x) { case 1: break; default: }`,
      `enum E { A = 1 } namespace N { export const v = 1; }`,
      `type T = { a: string }; interface I { m(): void }`,
      `const v = x as any; const w = x!; const s = x satisfies unknown;`,
      `export { x }; export default 1;`,
    ].join("\n");
    const sourceFile = ts.createSourceFile(
      "sample.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const mismatches: string[] = [];
    const visit = (node: ts.Node): void => {
      const site = invocationSiteOf(node);
      const entry = censusEntryFor(node.kind);
      if (site !== undefined) {
        if (entry?.role !== "site" || entry.site !== site.kind) {
          mismatches.push(`${kindName(node.kind)} yielded ${site.kind}`);
        }
      } else if (entry?.role === "site" && entry.when === undefined) {
        mismatches.push(`${kindName(node.kind)} yielded no site`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    expect(mismatches).toEqual([]);
  });

  it("a class is an implicit_super site only when derived, with no constructor, and not ambient", () => {
    const cases: readonly [string, boolean][] = [
      ["class Sub extends Base {}", true],
      ["class Base {}", false],
      ["class Own extends Base { constructor() { super(); } }", false],
      ["declare class Ambient extends Base {}", false],
      ["class Impl implements I {}", false],
    ];
    for (const [source, isSite] of cases) {
      const [cls] = nodesOfKind(source, ts.SyntaxKind.ClassDeclaration);
      expect(invocationSiteOf(cls!)?.kind === "implicit_super", source).toBe(
        isSite,
      );
    }
  });

  it("a decorator's class is the class whose definition invokes it", () => {
    const source = [
      "@a class X {",
      "  @b m() {}",
      "  @c static s() {}",
      "  @d f = 1;",
      "  @e get g() { return 1; }",
      "  constructor(@p x: any) {}",
      "  n(@q y: any) {}",
      "}",
    ].join("\n");
    const decorators = nodesOfKind(source, ts.SyntaxKind.Decorator);
    expect(decorators).toHaveLength(7);
    for (const decorator of decorators) {
      const site = invocationSiteOf(decorator);
      expect(site?.kind).toBe("decorator");
      if (site?.kind === "decorator") {
        expect(site.decoratedClass?.name?.text, decorator.getText()).toBe("X");
      }
    }
  });
});

/**
 * Task A-1 audit, finding 1: a decorator TypeScript erases in EVERY
 * decorator mode is not a site -- resolving it would fabricate an edge.
 * The positions only one mode erases are compile errors in that mode, and
 * stay sites. Measured with this repository's TypeScript (`transpileModule`,
 * both `experimentalDecorators` settings, target ES2022).
 */
describe("a decorator is a site only where the compiled program calls it", () => {
  const ERASED_IN_EVERY_MODE: readonly string[] = [
    "@d declare class X {}",
    "declare namespace N { @d class X {} }",
    "abstract class X { @d abstract m(): void; }",
    "class X { @d m(): void; m(a?: any) {} }",
    "class X { constructor(@d a: any); constructor(a?: any) {} }",
    "class X { set s(@d v: any) {} }",
    "function f(@d a: any) {}",
    "const o = { @d m() {} };",
    // A class expression: legacy erases all its decorators, standard
    // these two positions.
    "const C = class { m(@d a: any) {} };",
    "const C = class { constructor(@d a: any) {} };",
    "const C = class { @d declare f: any; };",
  ];
  const EMITTED_IN_SOME_MODE: readonly string[] = [
    "@d class X {}",
    "@d abstract class X {}",
    "class X { m(): void; @d m(a?: any) {} }",
    "class X { @d f = 1; }",
    "class X { @d accessor f = 1; }",
    "class X { @d get g() { return 1; } }",
    "class X { @d static s() {} }",
    // Emitted by one mode, a compile error in the other: kept as sites.
    "const C = @d class {};",
    "class X { constructor(@d a: any) {} }",
    "class X { m(@d a: any) {} }",
    "class X { @d declare f: any; }",
    "abstract class X { @d abstract p: any; }",
    "const C = class { @d m() {} };",
    "const C = class { @d f = 1; };",
  ];

  it.each(ERASED_IN_EVERY_MODE)("%s -- not a site", (source) => {
    const decorators = nodesOfKind(source, ts.SyntaxKind.Decorator);
    expect(decorators.length).toBeGreaterThan(0);
    for (const decorator of decorators) {
      expect(invocationSiteOf(decorator)).toBeUndefined();
    }
  });

  it.each(EMITTED_IN_SOME_MODE)("%s -- a site", (source) => {
    const decorators = nodesOfKind(source, ts.SyntaxKind.Decorator);
    expect(decorators.length).toBeGreaterThan(0);
    for (const decorator of decorators) {
      expect(invocationSiteOf(decorator)?.kind).toBe("decorator");
    }
  });

  it("an ambient derived class is not an implicit_super site either, even inside a declare namespace", () => {
    const [cls] = nodesOfKind(
      "declare namespace N { class Sub extends Base {} }",
      ts.SyntaxKind.ClassDeclaration,
    );
    expect(invocationSiteOf(cls!)).toBeUndefined();
  });
});
