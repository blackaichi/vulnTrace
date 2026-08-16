import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { buildModuleModel } from "./module-model.js";
import { createModuleResolver } from "./module-resolver.js";
import { indexSourceFile } from "./source-index.js";
import { bindCallee } from "./symbol-binder.js";
import { loadTsProject } from "./ts-project.js";

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-symbol-binder-"));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function findCallee(sourceFile: ts.SourceFile, occurrence = 0): ts.Expression {
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

describe("bindCallee end-to-end: real files, real resolver, real fixture-lib target", () => {
  it("resolves all four SDD § 17 import forms to the exact same real target file + export", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/fixture-lib/package.json",
      JSON.stringify({
        name: "fixture-lib",
        version: "1.0.0",
        main: "index.js",
      }),
    );
    const targetFile = write(
      root,
      "node_modules/fixture-lib/index.js",
      "exports.vulnerable = function () { return 'unsafe'; };\n",
    );

    const scenarios: { file: string; text: string; occurrence: number }[] = [
      {
        file: "esm-named-alias.ts",
        text: 'import { vulnerable as v } from "fixture-lib";\nv();\n',
        occurrence: 0,
      },
      {
        file: "cjs-destructured.js",
        text: 'const { vulnerable } = require("fixture-lib");\nvulnerable();\n',
        occurrence: 1, // occurrence 0 is the require() call itself
      },
      {
        file: "cjs-whole-module.js",
        text: 'const fixture = require("fixture-lib");\nfixture.vulnerable();\n',
        occurrence: 1,
      },
      {
        file: "esm-default.ts",
        text: 'import fixture from "fixture-lib";\nfixture.vulnerable();\n',
        occurrence: 0,
      },
    ];

    const project = loadTsProject(root);
    const resolver = createModuleResolver(project);
    const results = [];

    for (const scenario of scenarios) {
      const importerFilePath = write(
        root,
        `src/${scenario.file}`,
        scenario.text,
      );
      const index = indexSourceFile(importerFilePath, scenario.text);
      const model = buildModuleModel(index);
      const callee = findCallee(index.sourceFile, scenario.occurrence);

      const result = await bindCallee(
        callee,
        model,
        resolver,
        importerFilePath,
      );
      results.push({ file: scenario.file, result });
    }

    for (const { file, result } of results) {
      expect(result, `scenario: ${file}`).toEqual({
        kind: "resolved",
        target: {
          modulePath: targetFile,
          specifier: "fixture-lib",
          exportedName: "vulnerable",
        },
      });
    }
  });
});
