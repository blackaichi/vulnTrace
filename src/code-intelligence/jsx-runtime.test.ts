import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  isIntrinsicJsxTag,
  isJsxSite,
  jsxHandedExpressions,
  jsxRuntimeOf,
  jsxSiteMayLoad,
  type JsxRuntime,
  type JsxSettings,
  type JsxSite,
} from "./jsx-runtime.js";

/**
 * Task A-3b: `jsx-runtime.ts` decides what a JSX site compiles to. Each
 * decision is checked against what this repository's own TypeScript
 * actually EMITS for the same file and options, so the runtime the
 * analyzer assumes is the one the compiled program runs (RWF-066: a
 * pragma switches a classic project to the automatic runtime).
 */

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("index.tsx", source, ts.ScriptTarget.Latest, true);
}

function sites(sourceFile: ts.SourceFile): JsxSite[] {
  const found: JsxSite[] = [];
  const visit = (node: ts.Node): void => {
    if (isJsxSite(node)) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** What TypeScript emits for the file: the call a compiled element makes. */
function emitted(source: string, settings: JsxSettings): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      ...settings,
    },
    fileName: "index.tsx",
  }).outputText;
}

interface RuntimeCase {
  readonly name: string;
  readonly source: string;
  readonly settings: JsxSettings;
  readonly runtime: JsxRuntime;
  /** A fragment of the emitted JavaScript that proves the runtime. */
  readonly emits: string;
}

const RUNTIME_CASES: readonly RuntimeCase[] = [
  {
    name: "jsx: react, default factory",
    source: `const e = <div />;\nexport {};\n`,
    settings: { jsx: ts.JsxEmit.React },
    runtime: {
      kind: "classic",
      factory: "React.createElement",
      fragmentFactory: "React.Fragment",
    },
    emits: `React.createElement("div", null)`,
  },
  {
    name: "jsx: react with jsxFactory and jsxFragmentFactory",
    source: `const e = <>{1}</>;\nexport {};\n`,
    settings: {
      jsx: ts.JsxEmit.React,
      jsxFactory: "h",
      jsxFragmentFactory: "Frag",
    },
    runtime: { kind: "classic", factory: "h", fragmentFactory: "Frag" },
    emits: `h(Frag, null, 1)`,
  },
  {
    name: "reactNamespace renames the default classic factories (the fourth audit)",
    source: `const e = <><a /></>;\nexport {};\n`,
    settings: { jsx: ts.JsxEmit.React, reactNamespace: "foo" },
    runtime: {
      kind: "classic",
      factory: "foo.createElement",
      fragmentFactory: "foo.Fragment",
    },
    emits: `foo.createElement(foo.Fragment, null`,
  },
  {
    name: "an @jsx pragma overrides jsxFactory",
    source: `/** @jsx p */\nconst e = <div />;\nexport {};\n`,
    settings: { jsx: ts.JsxEmit.React, jsxFactory: "h" },
    runtime: {
      kind: "classic",
      factory: "p",
      fragmentFactory: "React.Fragment",
    },
    emits: `p("div", null)`,
  },
  {
    name: "jsx: react-jsx, default import source",
    source: `const e = <div />;\nexport {};\n`,
    settings: { jsx: ts.JsxEmit.ReactJSX },
    runtime: { kind: "automatic", importSource: "react" },
    emits: `require("react/jsx-runtime")`,
  },
  {
    name: "jsx: react-jsxdev with jsxImportSource",
    source: `const e = <div />;\nexport {};\n`,
    settings: { jsx: ts.JsxEmit.ReactJSXDev, jsxImportSource: "preact" },
    runtime: { kind: "automatic", importSource: "preact" },
    emits: `require("preact/jsx-dev-runtime")`,
  },
  {
    name: "an @jsxImportSource pragma switches a classic project to automatic",
    source: `/** @jsxImportSource lib */\nconst e = <div />;\nexport {};\n`,
    settings: { jsx: ts.JsxEmit.React },
    runtime: { kind: "automatic", importSource: "lib" },
    emits: `require("lib/jsx-runtime")`,
  },
  {
    name: "an @jsxRuntime automatic pragma switches a classic project",
    source: `/** @jsxRuntime automatic */\nconst e = <div />;\nexport {};\n`,
    settings: { jsx: ts.JsxEmit.React },
    runtime: { kind: "automatic", importSource: "react" },
    emits: `require("react/jsx-runtime")`,
  },
  {
    name: "an @jsxRuntime classic pragma switches an automatic project",
    source: `/** @jsxRuntime classic */\nconst e = <div />;\nexport {};\n`,
    settings: { jsx: ts.JsxEmit.ReactJSX },
    runtime: {
      kind: "classic",
      factory: "React.createElement",
      fragmentFactory: "React.Fragment",
    },
    emits: `React.createElement("div", null)`,
  },
  {
    name: "an @jsx pragma does not switch an automatic project",
    source: `/** @jsx h */\nconst e = <div />;\nexport {};\n`,
    settings: { jsx: ts.JsxEmit.ReactJSX },
    runtime: { kind: "automatic", importSource: "react" },
    emits: `require("react/jsx-runtime")`,
  },
  {
    name: "a jsxImportSource option switches a classic project to automatic (the audit's finding 1)",
    source: `const e = <div />;\nexport {};\n`,
    settings: { jsx: ts.JsxEmit.React, jsxImportSource: "lib" },
    runtime: { kind: "automatic", importSource: "lib" },
    emits: `require("lib/jsx-runtime")`,
  },
  {
    name: "repeated @jsxRuntime pragmas: TypeScript reads the last (the audit's finding 2)",
    source: `/** @jsxRuntime classic */\n/** @jsxRuntime automatic */\n/** @jsxImportSource lib */\nconst e = <div />;\nexport {};\n`,
    settings: { jsx: ts.JsxEmit.React },
    runtime: { kind: "automatic", importSource: "lib" },
    emits: `require("lib/jsx-runtime")`,
  },
  {
    name: "repeated @jsxImportSource pragmas: TypeScript reads the last",
    source: `/** @jsxImportSource a */\n/** @jsxImportSource lib */\nconst e = <div />;\nexport {};\n`,
    settings: { jsx: ts.JsxEmit.ReactJSX },
    runtime: { kind: "automatic", importSource: "lib" },
    emits: `require("lib/jsx-runtime")`,
  },
  {
    name: "jsx: preserve leaves the JSX to another tool",
    source: `/** @jsxImportSource lib */\nconst e = <div />;\nexport {};\n`,
    settings: { jsx: ts.JsxEmit.Preserve },
    runtime: { kind: "undetermined" },
    emits: `<div />`,
  },
];

describe("jsxRuntimeOf agrees with TypeScript's emit", () => {
  it.each(RUNTIME_CASES.map((c) => [c.name, c] as const))("%s", (_, c) => {
    expect(emitted(c.source, c.settings)).toContain(c.emits);
    expect(jsxRuntimeOf(parse(c.source), c.settings)).toEqual(c.runtime);
  });

  it("is undetermined without the project's settings, or without a jsx option", () => {
    const sourceFile = parse(`/** @jsx h */\nconst e = <div />;\n`);
    expect(jsxRuntimeOf(sourceFile, undefined)).toEqual({
      kind: "undetermined",
    });
    expect(jsxRuntimeOf(sourceFile, {})).toEqual({ kind: "undetermined" });
    expect(jsxRuntimeOf(sourceFile, { jsx: ts.JsxEmit.ReactNative })).toEqual({
      kind: "undetermined",
    });
  });

  it("is undetermined for a JavaScript file TypeScript does not compile (no allowJs)", () => {
    const jsx = ts.createSourceFile(
      "index.jsx",
      `const e = <div />;\n`,
      ts.ScriptTarget.Latest,
      true,
    );
    expect(jsxRuntimeOf(jsx, { jsx: ts.JsxEmit.React })).toEqual({
      kind: "undetermined",
    });
    expect(jsxRuntimeOf(jsx, { jsx: ts.JsxEmit.React, allowJs: true })).toEqual(
      {
        kind: "classic",
        factory: "React.createElement",
        fragmentFactory: "React.Fragment",
      },
    );
  });

  it("is undetermined for a repeated @jsx or @jsxFrag pragma", () => {
    expect(
      jsxRuntimeOf(
        parse(`/** @jsx h */\n/** @jsx require */\nconst e = <div />;\n`),
        {
          jsx: ts.JsxEmit.React,
        },
      ),
    ).toEqual({ kind: "undetermined" });
    expect(
      jsxRuntimeOf(
        parse(`/** @jsxFrag F */\n/** @jsxFrag G */\nconst e = <></>;\n`),
        {
          jsx: ts.JsxEmit.React,
        },
      ),
    ).toEqual({ kind: "undetermined" });
  });

  it("is undetermined for an @jsxRuntime value TypeScript does not name", () => {
    expect(
      jsxRuntimeOf(parse(`/** @jsxRuntime other */\nconst e = <div />;\n`), {
        jsx: ts.JsxEmit.React,
      }),
    ).toEqual({ kind: "undetermined" });
  });
});

describe("jsxSiteMayLoad", () => {
  const classic = (factory: string, fragmentFactory = "React.Fragment") =>
    ({ kind: "classic", factory, fragmentFactory }) as const;
  /** The first element and fragment of `prelude` followed by two JSX sites. */
  function sitesAfter(prelude: string): [JsxSite, JsxSite] {
    const found = sites(
      parse(`${prelude}\nconst e = <div />;\nconst f = <></>;\n`),
    );
    return [found[0]!, found[1]!];
  }

  it("is true under the automatic and an undetermined runtime", () => {
    const [element] = sitesAfter(`import React from "react";`);
    expect(
      jsxSiteMayLoad(element, { kind: "automatic", importSource: "react" }),
    ).toBe(true);
    expect(jsxSiteMayLoad(element, { kind: "undetermined" })).toBe(true);
  });

  it("is false for a classic factory the file binds by a function, a class or a non-builtin import", () => {
    expect(
      jsxSiteMayLoad(
        sitesAfter(`import React from "react";`)[0],
        classic("React.createElement"),
      ),
    ).toBe(false);
    expect(
      jsxSiteMayLoad(
        sitesAfter(`import * as React from "react";`)[0],
        classic("React.createElement"),
      ),
    ).toBe(false);
    expect(
      jsxSiteMayLoad(
        sitesAfter(`import { h, Fragment as Frag } from "preact";`)[1],
        classic("h", "Frag"),
      ),
    ).toBe(false);
    expect(
      jsxSiteMayLoad(
        sitesAfter(`function h() {}\nclass Frag {}`)[1],
        classic("h", "Frag"),
      ),
    ).toBe(false);
    expect(
      jsxSiteMayLoad(
        sitesAfter(`function h(a: string): void;\nfunction h(a: any) {}`)[0],
        classic("h"),
      ),
      "an overload signature beside its implementation",
    ).toBe(false);
    expect(
      jsxSiteMayLoad(
        sitesAfter(`import h = require("preact");`)[0],
        classic("h.h"),
      ),
    ).toBe(false);
  });

  it.each([
    ["the module's own require", ``, "require"],
    ["an undeclared global (a UMD React)", ``, "React.createElement"],
    [
      "a const alias of require (the audit's reproduction)",
      `const r = require;`,
      "r",
    ],
    [
      "a destructured Module._load",
      `const { _load: h } = require("module");`,
      "h",
    ],
    ["an import from a builtin", `import { _load as h } from "module";`, "h"],
    [
      "a type-only import",
      `import type React from "react";`,
      "React.createElement",
    ],
    [
      "a function declaration later reassigned",
      `function h() {}\nh = require;`,
      "h",
    ],
    [
      "a name a nested scope rebinds",
      `import React from "react";\nfunction f() { const React = require; }`,
      "React.createElement",
    ],
    ["a parameter", `function f(h) {}`, "h"],
    ["a file with a with statement", `function h() {}\nwith (o) {}`, "h"],
    ["an executing global", ``, "eval"],
    [
      "a function declaration rewritten by an object destructuring assignment (the second audit)",
      `function h() {}\n({ _load: h } = M);`,
      "h",
    ],
    [
      "a function declaration rewritten by a parenthesized destructuring target",
      `function h() {}\n({ _load: (h) } = M);`,
      "h",
    ],
    [
      "a function declaration rewritten in a for-of destructuring",
      `function h() {}\nfor ({ _load: h } of [M]) {}`,
      "h",
    ],
    [
      "a function declaration rewritten by an object rest",
      `function h() {}\n({ ...h } = M);`,
      "h",
    ],
    [
      "a non-null target in a destructuring write (the third audit)",
      `function h() {}\nfor ({ _load: h! } of [M]) {}`,
      "h",
    ],
    [
      "an `as` target in a destructuring write",
      `function h() {}\nfor ({ _load: (h as any) } of [M]) {}`,
      "h",
    ],
    [
      "a `satisfies` target in a destructuring write",
      `function h() {}\nfor ({ _load: h satisfies any } of [M]) {}`,
      "h",
    ],
    [
      "an `as` target of a for-of head",
      `function h() {}\nfor ((h as any) of [M._load]) {}`,
      "h",
    ],
    [
      "an `as` target of an assignment",
      `function h() {}\n(h as any) = M._load;`,
      "h",
    ],
    ["an ambient declare function", `declare function h(): void;`, "h"],
    [
      "a nested function declaration (the site reads a global)",
      `function f() { function h() {} }`,
      "h",
    ],
  ])("is true for a classic factory rooted in %s", (_, prelude, factory) => {
    expect(jsxSiteMayLoad(sitesAfter(prelude)[0], classic(factory))).toBe(true);
  });

  it("reads the fragment factory for a fragment only", () => {
    const [element, fragment] = sitesAfter(`function h() {}`);
    expect(jsxSiteMayLoad(fragment, classic("h", "require"))).toBe(true);
    expect(jsxSiteMayLoad(element, classic("h", "require"))).toBe(false);
  });
});

describe("jsxHandedExpressions", () => {
  function handed(source: string): string[] {
    const sourceFile = parse(source);
    const [first] = sites(sourceFile);
    return jsxHandedExpressions(first!).map((e) => e.getText(sourceFile));
  }

  it("lists a component tag, attributes, spreads and child expressions, in order", () => {
    expect(
      handed(`<App a={f} b="s" {...rest} c={<x />}>{g}text<y />{h}</App>;`),
    ).toEqual(["App", "f", "rest", "g", "h"]);
  });

  it("never lists an intrinsic tag", () => {
    expect(handed(`<div onClick={f} />;`)).toEqual(["f"]);
    expect(handed(`<my-element />;`)).toEqual([]);
    expect(handed(`<svg:rect />;`)).toEqual([]);
  });

  it("lists a member and a `this` tag", () => {
    expect(handed(`<lib.Comp />;`)).toEqual(["lib.Comp"]);
    expect(handed(`<this.Comp />;`)).toEqual(["this.Comp"]);
  });

  it("lists a fragment's child expressions", () => {
    expect(handed(`<>{f}{g}</>;`)).toEqual(["f", "g"]);
  });
});

describe("isIntrinsicJsxTag", () => {
  it("follows TypeScript's rule", () => {
    const tags = sites(
      parse(`<div />; <App />; <my-el />; <_x />; <$y />; <a.B />;`),
    ).map((site) => [
      (site as ts.JsxSelfClosingElement).tagName.getText(),
      isIntrinsicJsxTag((site as ts.JsxSelfClosingElement).tagName),
    ]);
    expect(tags).toEqual([
      ["div", true],
      ["App", false],
      ["my-el", true],
      ["_x", false],
      ["$y", false],
      ["a.B", false],
    ]);
  });
});
