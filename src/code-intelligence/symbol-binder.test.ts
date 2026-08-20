import ts from "typescript";
import { describe, expect, it } from "vitest";
import type {
  ModuleResolutionResult,
  ModuleResolver,
} from "./module-resolver.js";
import { buildModuleModel } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";
import { bindCallee } from "./symbol-binder.js";

function fakeResolver(
  mapping: Record<string, string>,
  declarationOnly: Record<string, string> = {},
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
    const model = buildModuleModel(
      indexSourceFile("a.ts", 'import { vulnerable as v } from "foo";\nv();\n'),
    );
    const result = await bindCallee(
      findCallee('import { vulnerable as v } from "foo";\nv();\n'),
      model,
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
    const model = buildModuleModel(indexSourceFile("a.js", text));
    // Occurrence 0 is the require("foo") call itself; occurrence 1 is the
    // actual vulnerable() invocation under test.
    const result = await bindCallee(
      findCallee(text, 1),
      model,
      resolver,
      "a.js",
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

  it("binds a whole-module require() with member access", async () => {
    const text = 'const foo = require("foo");\nfoo.vulnerable();\n';
    const model = buildModuleModel(indexSourceFile("a.js", text));
    const result = await bindCallee(
      findCallee(text, 1),
      model,
      resolver,
      "a.js",
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

  it("binds a default ESM import with member access", async () => {
    const text = 'import foo from "foo";\nfoo.vulnerable();\n';
    const model = buildModuleModel(indexSourceFile("a.ts", text));
    const result = await bindCallee(findCallee(text), model, resolver, "a.ts");

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
    const model = buildModuleModel(indexSourceFile("a.ts", text));
    const result = await bindCallee(findCallee(text), model, resolver, "a.ts");

    expect(result).toMatchObject({
      kind: "resolved",
      target: { exportedName: "vulnerable" },
    });
  });

  it("uses 'default' as the exported name when a default import is called directly", async () => {
    const text = 'import foo from "foo";\nfoo();\n';
    const model = buildModuleModel(indexSourceFile("a.ts", text));
    const result = await bindCallee(findCallee(text), model, resolver, "a.ts");

    expect(result).toMatchObject({
      kind: "resolved",
      target: { exportedName: "default" },
    });
  });

  it("resolves static bracket-notation member access", async () => {
    const text = 'const foo = require("foo");\nfoo["vulnerable"]();\n';
    const model = buildModuleModel(indexSourceFile("a.js", text));
    const result = await bindCallee(
      findCallee(text, 1),
      model,
      resolver,
      "a.js",
    );

    expect(result).toMatchObject({
      kind: "resolved",
      target: { exportedName: "vulnerable" },
    });
  });

  it("ignores a trailing method chain on an already-bound named import", async () => {
    const text =
      'import { vulnerable } from "foo";\nvulnerable.someMethod();\n';
    const model = buildModuleModel(indexSourceFile("a.ts", text));
    const result = await bindCallee(findCallee(text), model, resolver, "a.ts");

    expect(result).toMatchObject({
      kind: "resolved",
      target: { exportedName: "vulnerable" },
    });
  });
});

describe("bindCallee: ambiguous and unresolved outcomes are explicit", () => {
  it("returns ambiguous for dynamic member access on a known import", async () => {
    const text =
      'const foo = require("foo");\nconst method = "vulnerable";\nfoo[method]();\n';
    const model = buildModuleModel(indexSourceFile("a.js", text));
    const result = await bindCallee(
      findCallee(text, 1),
      model,
      resolver,
      "a.js",
    );

    expect(result).toEqual({
      kind: "ambiguous",
      reason: "dynamic_member_access",
    });
  });

  it("returns unresolved_module when the resolver cannot resolve the specifier", async () => {
    const text =
      'import { vulnerable } from "missing-package";\nvulnerable();\n';
    const model = buildModuleModel(indexSourceFile("a.ts", text));
    const result = await bindCallee(findCallee(text), model, resolver, "a.ts");

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
    const model = buildModuleModel(indexSourceFile("a.ts", text));
    const result = await bindCallee(
      findCallee(text),
      model,
      declOnlyResolver,
      "a.ts",
    );

    expect(result).toEqual({
      kind: "declaration_only",
      specifier: "types-only-package",
      resolvedFileName: "/resolved/types-only-package/index.d.ts",
    });
  });

  it("returns not_an_import for a call to a locally-defined function", async () => {
    const text = "function local() {}\nlocal();\n";
    const model = buildModuleModel(indexSourceFile("a.ts", text));
    const result = await bindCallee(findCallee(text), model, resolver, "a.ts");

    expect(result).toEqual({ kind: "not_an_import" });
  });

  it("returns not_an_import for indirection through an intermediate local variable", async () => {
    // import foo from "foo"; const { vulnerable } = foo; vulnerable();
    // — destructuring off an already-bound local, not the import site
    // itself; genuine data-flow tracking is out of MVP scope.
    const text =
      'import foo from "foo";\nconst { vulnerable } = foo;\nvulnerable();\n';
    const model = buildModuleModel(indexSourceFile("a.ts", text));
    const result = await bindCallee(findCallee(text), model, resolver, "a.ts");

    expect(result).toEqual({ kind: "not_an_import" });
  });
});
