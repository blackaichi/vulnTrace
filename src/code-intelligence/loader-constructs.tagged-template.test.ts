import { describe, expect, it } from "vitest";
import {
  classifyClosureWideningTaggedTemplate,
  findClosureWideningConstructs,
} from "./loader-constructs.js";
import { buildModuleModel } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";
import ts from "typescript";

/**
 * Task A-1 (RWF-057): a tagged template's TAG is classified by the loader
 * classifier, in the module-load closure's scanner and -- through the same
 * function -- in the call graph. `` vm.runInThisContext`code` `` compiles
 * and runs `code` (the tag receives the strings array, which the vm
 * coerces to the source text; Node v22.11.0), and before A-1 only a
 * tagged template's substitutions were checked, so a `vm` tag that loads
 * a package the program never requires statically was a family-A false
 * NOT_AFFECTED (`tests/oracle/a1-invocation-sites.test.ts`,
 * `tagged-template.vm-tag`, and the FINDINGS.md entry).
 */

function context(source: string) {
  const index = indexSourceFile("/virtual/index.js", source);
  return { index, model: buildModuleModel(index) };
}

function reasons(source: string): string[] {
  return findClosureWideningConstructs(context(source)).map((c) => c.reason);
}

describe("the module-load closure classifies a tagged template's tag", () => {
  it("records a vm tag as vm_execution", () => {
    expect(
      reasons(`const vm = require("vm");\nvm.runInThisContext\`1 + 1\`;\n`),
    ).toEqual(["vm_execution"]);
  });

  it("records an eval or require tag by the same spelling a call is matched by", () => {
    expect(reasons("eval`1 + 1`;\n")).toEqual(["eval"]);
    expect(reasons("require`x`;\n")).toEqual(["dynamic_require"]);
  });

  it("still records a substitution that lets a capability escape, at the substitution", () => {
    const found = findClosureWideningConstructs(
      context("const tag = (s) => s;\ntag`${require}`;\n"),
    );
    expect(found.map((c) => c.reason)).toEqual(["loader_capability_escape"]);
    expect(found[0]?.location.line).toBe(2);
  });

  it("records nothing for an ordinary tag", () => {
    expect(reasons("String.raw`a${1}`;\nconst t = (s) => s;\nt`x`;\n")).toEqual(
      [],
    );
  });
});

describe("the call graph's classifier agrees with the closure scanner", () => {
  const SHAPES = [
    `const vm = require("vm");\nvm.runInThisContext\`1 + 1\`;\n`,
    "eval`1 + 1`;\n",
    "require`x`;\n",
    "const tag = (s) => s;\ntag`${require}`;\n",
    "String.raw`a${1}`;\n",
  ];

  it.each(SHAPES)("%s", (source) => {
    const ctx = context(source);
    const templates: ts.TaggedTemplateExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(node)) {
        templates.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(ctx.index.sourceFile);
    const fromCallGraph = templates.flatMap((node) => {
      const reason = classifyClosureWideningTaggedTemplate(node, ctx);
      return reason ? [reason] : [];
    });
    expect(fromCallGraph).toEqual(
      findClosureWideningConstructs(ctx).map((c) => c.reason),
    );
  });
});

describe("the module-load closure classifies a decorator as the call graph does", () => {
  function tsReasons(source: string): string[] {
    const index = indexSourceFile("/virtual/index.ts", source);
    return findClosureWideningConstructs({
      index,
      model: buildModuleModel(index),
    }).map((c) => c.reason);
  }

  it("records a loader used as a decorator", () => {
    expect(
      tsReasons(
        `import vm = require("vm");\n@vm.runInThisContext\nclass X {}\n`,
      ),
    ).toEqual(["vm_execution"]);
  });

  it("records nothing for a decorator TypeScript erases", () => {
    expect(
      tsReasons(
        `import vm = require("vm");\n@vm.runInThisContext\ndeclare class X {}\n`,
      ),
    ).toEqual([]);
  });
});
