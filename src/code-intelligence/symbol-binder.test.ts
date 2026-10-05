import ts from "typescript";
import { describe, expect, it } from "vitest";
import type {
  ModuleResolutionResult,
  ModuleResolver,
} from "./module-resolver.js";
import { bindCallee } from "./symbol-binder.js";

function fakeResolver(
  mapping: Record<string, string>,
  declarationOnly: Record<string, string> = {},
  builtins: ReadonlySet<string> = new Set(),
): ModuleResolver {
  return {
    resolve(specifier, importer): Promise<ModuleResolutionResult> {
      const resolvedFileName = mapping[specifier];
      if (resolvedFileName) {
        return Promise.resolve({
          kind: "resolved",
          resolvedFileName,
          isExternalLibraryImport: true,
        });
      }
      const declarationFileName = declarationOnly[specifier];
      if (declarationFileName) {
        return Promise.resolve({
          kind: "declaration",
          resolvedFileName: declarationFileName,
          isExternalLibraryImport: true,
        });
      }
      if (builtins.has(specifier)) {
        return Promise.resolve({ kind: "builtin", specifier });
      }
      return Promise.resolve({
        kind: "unresolved",
        specifier,
        importer,
        reason: `no mapping for "${specifier}"`,
      });
    },
  };
}

/** Finds the Nth call expression's callee in source text. */
function findCallee(text: string, occurrence = 0): ts.Expression {
  const sourceFile = ts.createSourceFile(
    "a.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const callees: ts.Expression[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      callees.push(node.expression);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  const callee = callees[occurrence];
  if (!callee) {
    throw new Error(`No call expression at occurrence ${occurrence}`);
  }
  return callee;
}

const resolver = fakeResolver({ foo: "/resolved/foo/index.js" });

describe("bindCallee: converges the four SDD § 17 forms onto the same target", () => {
  it("binds an aliased named ESM import (bare call)", async () => {
    const result = await bindCallee(
      findCallee('import { vulnerable as v } from "foo";\nv();\n'),
      resolver,
      "a.ts",
    );

    expect(result).toEqual({
      kind: "resolved",
      target: {
        modulePath: "/resolved/foo/index.js",
        specifier: "foo",
        exportedName: "vulnerable",
      },
    });
  });

  it("binds a destructured require() (bare call)", async () => {
    const text = 'const { vulnerable } = require("foo");\nvulnerable();\n';
    // Occurrence 0 is the require("foo") call itself; occurrence 1 is the
    // actual vulnerable() invocation under test.
    const result = await bindCallee(findCallee(text, 1), resolver, "a.js");

    expect(result).toEqual({
      kind: "resolved",
      target: {
        modulePath: "/resolved/foo/index.js",
        specifier: "foo",
        exportedName: "vulnerable",
      },
    });
  });

  it("binds a whole-module require() with member access", async () => {
    const text = 'const foo = require("foo");\nfoo.vulnerable();\n';
    const result = await bindCallee(findCallee(text, 1), resolver, "a.js");

    expect(result).toEqual({
      kind: "resolved",
      target: {
        modulePath: "/resolved/foo/index.js",
        specifier: "foo",
        exportedName: "vulnerable",
      },
    });
  });

  it("binds a default ESM import with member access", async () => {
    const text = 'import foo from "foo";\nfoo.vulnerable();\n';
    const result = await bindCallee(findCallee(text), resolver, "a.ts");

    expect(result).toEqual({
      kind: "resolved",
      target: {
        modulePath: "/resolved/foo/index.js",
        specifier: "foo",
        exportedName: "vulnerable",
      },
    });
  });
});

describe("bindCallee: additional binding shapes", () => {
  it("binds a namespace import with member access", async () => {
    const text = 'import * as ns from "foo";\nns.vulnerable();\n';
    const result = await bindCallee(findCallee(text), resolver, "a.ts");

    expect(result).toMatchObject({
      kind: "resolved",
      target: { exportedName: "vulnerable" },
    });
  });

  it("uses 'default' as the exported name when a default import is called directly", async () => {
    const text = 'import foo from "foo";\nfoo();\n';
    const result = await bindCallee(findCallee(text), resolver, "a.ts");

    expect(result).toMatchObject({
      kind: "resolved",
      target: { exportedName: "default" },
    });
  });

  it("resolves static bracket-notation member access", async () => {
    const text = 'const foo = require("foo");\nfoo["vulnerable"]();\n';
    const result = await bindCallee(findCallee(text, 1), resolver, "a.js");

    expect(result).toMatchObject({
      kind: "resolved",
      target: { exportedName: "vulnerable" },
    });
  });

  /**
   * Task A-6 (PRM-20, ADR 0008 invariant A2: "an exact export with the
   * whole member chain consumed"). This test used to be "ignores a trailing
   * method chain on an already-bound named import" and expected
   * `vulnerable.someMethod()` to resolve to `vulnerable` itself -- the false
   * premise PRM-20 records: the call reaches a member of the export, and
   * an edge to the export certified the member's real target unreachable.
   */
  it("binds nothing for a trailing method chain on an already-bound named import (PRM-20)", async () => {
    const text =
      'import { vulnerable } from "foo";\nvulnerable.someMethod();\n';
    const result = await bindCallee(findCallee(text), resolver, "a.ts");

    expect(result).toEqual({ kind: "not_an_import" });
  });

  it("binds nothing for any chain past the export, in every binding form and spelling (PRM-20)", async () => {
    const programs: readonly (readonly [string, string, number])[] = [
      ['import { api } from "foo";\napi.parse();\n', "a.ts", 0],
      ['import { api } from "foo";\napi["parse"]();\n', "a.ts", 0],
      ['import { api } from "foo";\napi.a.b();\n', "a.ts", 0],
      ['const { api } = require("foo");\napi.parse();\n', "a.js", 1],
      ['const lib = require("foo");\nlib.api.parse();\n', "a.js", 1],
      ['import lib from "foo";\nlib.api.parse();\n', "a.ts", 0],
      ['import * as ns from "foo";\nns.api.parse();\n', "a.ts", 0],
      // `.call` / `.apply` is kept only as the LAST and ONLY member.
      [
        'const lib = require("foo");\nlib.safe.call.call(lib.parse);\n',
        "a.js",
        1,
      ],
      ['const lib = require("foo");\nlib.parse.call.apply();\n', "a.js", 1],
      ['const lib = require("foo");\nlib.api.parse.call();\n', "a.js", 1],
      ['import { parse } from "foo";\nparse.bind(null);\n', "a.ts", 0],
    ];
    for (const [text, file, occurrence] of programs) {
      const result = await bindCallee(
        findCallee(text, occurrence),
        resolver,
        file,
      );
      expect(result, text).toEqual({ kind: "not_an_import" });
    }
  });

  it("resolves a single trailing .call / .apply as the export invoked through Function.prototype (task A-6)", async () => {
    const whole = await bindCallee(
      findCallee('const foo = require("foo");\nfoo.vulnerable.call();\n', 1),
      resolver,
      "a.js",
    );
    expect(whole).toEqual({
      kind: "resolved_function_method",
      target: {
        modulePath: "/resolved/foo/index.js",
        specifier: "foo",
        exportedName: "vulnerable",
      },
      method: "call",
    });
    const named = await bindCallee(
      findCallee('import { vulnerable } from "foo";\nvulnerable.apply();\n'),
      resolver,
      "a.ts",
    );
    expect(named).toMatchObject({
      kind: "resolved_function_method",
      target: { exportedName: "vulnerable" },
      method: "apply",
    });
  });

  it("still keys a builtin by its whole member chain (task A-3a)", async () => {
    const result = await bindCallee(
      findCallee('import { promises } from "fs";\npromises.readFile();\n'),
      fakeResolver({}, {}, new Set(["fs"])),
      "a.ts",
    );
    expect(result).toEqual({
      kind: "builtin",
      specifier: "fs",
      exportPath: ["promises", "readFile"],
    });
  });
});

describe("bindCallee: ambiguous and unresolved outcomes are explicit", () => {
  it("returns ambiguous for dynamic member access on a known import", async () => {
    const text =
      'const foo = require("foo");\nconst method = "vulnerable";\nfoo[method]();\n';
    const result = await bindCallee(findCallee(text, 1), resolver, "a.js");

    expect(result).toEqual({
      kind: "ambiguous",
      reason: "dynamic_member_access",
    });
  });

  it("returns unresolved_module when the resolver cannot resolve the specifier", async () => {
    const text =
      'import { vulnerable } from "missing-package";\nvulnerable();\n';
    const result = await bindCallee(findCallee(text), resolver, "a.ts");

    expect(result).toEqual({
      kind: "unresolved_module",
      specifier: "missing-package",
      reason: 'no mapping for "missing-package"',
    });
  });

  it("returns declaration_only when the resolver finds only a .d.ts (VT-304)", async () => {
    const declOnlyResolver = fakeResolver(
      {},
      { "types-only-package": "/resolved/types-only-package/index.d.ts" },
    );
    const text =
      'import { vulnerable } from "types-only-package";\nvulnerable();\n';
    const result = await bindCallee(findCallee(text), declOnlyResolver, "a.ts");

    expect(result).toEqual({
      kind: "declaration_only",
      specifier: "types-only-package",
      resolvedFileName: "/resolved/types-only-package/index.d.ts",
    });
  });

  it("returns builtin when the resolver classifies the specifier as a Node builtin (VT-305)", async () => {
    const builtinResolver = fakeResolver({}, {}, new Set(["fs"]));
    const text = 'const fs = require("fs");\nfs.readFileSync("x");\n';
    const result = await bindCallee(
      findCallee(text, 1),
      builtinResolver,
      "a.js",
    );

    expect(result).toEqual({
      kind: "builtin",
      specifier: "fs",
      exportPath: ["readFileSync"],
    });
  });

  it("reports a builtin module's member path through a destructured binding and a nested chain (task A-3a)", async () => {
    const builtinResolver = fakeResolver({}, {}, new Set(["fs"]));
    const destructured = await bindCallee(
      findCallee('const { readFile } = require("fs");\nreadFile("x");\n', 1),
      builtinResolver,
      "a.js",
    );
    expect(destructured).toMatchObject({ exportPath: ["readFile"] });
    const nested = await bindCallee(
      findCallee('const fs = require("fs");\nfs.promises.readFile("x");\n', 1),
      builtinResolver,
      "a.js",
    );
    expect(nested).toMatchObject({ exportPath: ["promises", "readFile"] });
  });

  it("returns not_an_import for a call to a locally-defined function", async () => {
    const text = "function local() {}\nlocal();\n";
    const result = await bindCallee(findCallee(text), resolver, "a.ts");

    expect(result).toEqual({ kind: "not_an_import" });
  });

  it("returns not_an_import for indirection through an intermediate local variable", async () => {
    // import foo from "foo"; const { vulnerable } = foo; vulnerable();
    // — destructuring off an already-bound local, not the import site
    // itself; genuine data-flow tracking is out of MVP scope.
    const text =
      'import foo from "foo";\nconst { vulnerable } = foo;\nvulnerable();\n';
    const result = await bindCallee(findCallee(text), resolver, "a.ts");

    expect(result).toEqual({ kind: "not_an_import" });
  });
});
