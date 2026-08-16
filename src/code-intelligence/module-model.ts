import ts from "typescript";
import type { SourceLocation } from "../domain/graph.js";
import {
  type IndexedExport,
  type SourceIndex,
  toSourceLocation,
} from "./source-index.js";

export type ModuleSyntax = "esm" | "commonjs";

/**
 * A binding's semantic shape, unified across ESM and CommonJS so downstream
 * consumers (TASK-016 Module Resolution, TASK-017 Symbol Binding) can treat
 * `import foo from "x"` and `const foo = require("x")` identically — both
 * bind the whole module to one local name — while still knowing which
 * syntax produced it via {@link ModuleSyntax} (see docs/SDD.md § 17's
 * convergence examples).
 */
export type BindingKind = "default" | "named" | "namespace" | "side-effect";

export interface ImportBinding {
  readonly specifier: string;
  readonly kind: BindingKind;
  readonly syntax: ModuleSyntax;
  readonly localName?: string;
  /** The original exported name, when it differs from `localName` (aliasing). */
  readonly importedName?: string;
  readonly location: SourceLocation;
}

export type ExportKind = "named" | "default" | "namespace" | "re-export";

export interface ExportBinding {
  readonly kind: ExportKind;
  readonly syntax: ModuleSyntax;
  readonly exportedName?: string;
  readonly localName?: string;
  /** The source module, for re-exports (`export { a } from "./x"`). */
  readonly specifier?: string;
  readonly location: SourceLocation;
}

/**
 * The unified import/export model for one module (see docs/SDD.md § 15-17).
 * Built from a {@link SourceIndex} (TASK-014) rather than re-parsing:
 * TASK-014 extracts per-syntax-construct facts; this normalizes them into
 * one shape regardless of which syntax was used.
 */
export interface ModuleModel {
  readonly filePath: string;
  readonly imports: readonly ImportBinding[];
  readonly exports: readonly ExportBinding[];
}

function toImportBinding(imp: SourceIndex["imports"][number]): ImportBinding {
  if (imp.bindingKind === "commonjs") {
    const kind: BindingKind = imp.importedName
      ? "named"
      : imp.localName
        ? "default"
        : "side-effect";
    return {
      specifier: imp.specifier,
      kind,
      syntax: "commonjs",
      localName: imp.localName,
      importedName: imp.importedName,
      location: imp.location,
    };
  }

  return {
    specifier: imp.specifier,
    kind: imp.bindingKind,
    syntax: "esm",
    localName: imp.localName,
    importedName: imp.importedName,
    location: imp.location,
  };
}

interface ModuleExportsAssignment {
  readonly rhs: ts.Expression;
  readonly location: SourceLocation;
}

/**
 * Finds the last `module.exports = X` (or TypeScript's `export = X`)
 * assignment in the file — real Node.js semantics are last-write-wins for
 * `module.exports` reassignment, so this task represents the module's
 * final exported value, not every intermediate assignment. Interleaved
 * `exports.foo = ...` mutations before a later `module.exports = ...`
 * reassignment are not specially reconciled — see TASK-015 completion
 * report for this scope boundary.
 */
function findLastModuleExportsAssignment(
  sourceFile: ts.SourceFile,
): ModuleExportsAssignment | undefined {
  let found: ModuleExportsAssignment | undefined;

  function visit(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === "module" &&
      node.left.name.text === "exports"
    ) {
      found = { rhs: node.right, location: toSourceLocation(sourceFile, node) };
    } else if (ts.isExportAssignment(node) && node.isExportEquals) {
      found = {
        rhs: node.expression,
        location: toSourceLocation(sourceFile, node),
      };
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

/**
 * Unpacks `module.exports = { a, b: c, method() {} }` into individual
 * named exports — this is one of the most common CommonJS export patterns
 * and, without unpacking, its named members would be invisible to symbol
 * resolution (TASK-017). Spread elements and computed property names are
 * skipped: their exported name cannot be determined statically (see
 * docs/SDD.md § 21: dynamic constructs must not fabricate exact bindings).
 * Returns `undefined` (not unpacked) when the RHS isn't an object literal,
 * or when none of its properties are statically nameable.
 */
function unpackObjectLiteralExports(
  sourceFile: ts.SourceFile,
  assignment: ModuleExportsAssignment,
): ExportBinding[] | undefined {
  if (!ts.isObjectLiteralExpression(assignment.rhs)) {
    return undefined;
  }

  const results: ExportBinding[] = [];

  for (const property of assignment.rhs.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      results.push({
        kind: "named",
        syntax: "commonjs",
        exportedName: property.name.text,
        localName: ts.isIdentifier(property.initializer)
          ? property.initializer.text
          : undefined,
        location: toSourceLocation(sourceFile, property),
      });
    } else if (ts.isShorthandPropertyAssignment(property)) {
      results.push({
        kind: "named",
        syntax: "commonjs",
        exportedName: property.name.text,
        localName: property.name.text,
        location: toSourceLocation(sourceFile, property),
      });
    } else if (
      ts.isMethodDeclaration(property) &&
      ts.isIdentifier(property.name)
    ) {
      results.push({
        kind: "named",
        syntax: "commonjs",
        exportedName: property.name.text,
        localName: property.name.text,
        location: toSourceLocation(sourceFile, property),
      });
    }
    // Spread elements, computed property names, and accessor properties
    // are intentionally not unpacked.
  }

  return results.length > 0 ? results : undefined;
}

function buildExportBindings(
  sourceFile: ts.SourceFile,
  exportsList: readonly IndexedExport[],
): ExportBinding[] {
  const results: ExportBinding[] = [];
  let sawCommonJsModuleExports = false;

  for (const exp of exportsList) {
    switch (exp.bindingKind) {
      case "commonjs-module-exports":
        sawCommonJsModuleExports = true;
        break;
      case "commonjs-exports-property":
        results.push({
          kind: "named",
          syntax: "commonjs",
          exportedName: exp.exportedName,
          location: exp.location,
        });
        break;
      case "named":
      case "default":
      case "re-export":
        results.push({
          kind: exp.bindingKind,
          syntax: "esm",
          exportedName: exp.exportedName,
          localName: exp.localName,
          specifier: exp.specifier,
          location: exp.location,
        });
        break;
    }
  }

  if (sawCommonJsModuleExports) {
    const assignment = findLastModuleExportsAssignment(sourceFile);
    if (assignment) {
      const unpacked = unpackObjectLiteralExports(sourceFile, assignment);
      results.push(...(unpacked ?? [wholeModuleDefaultExport(assignment)]));
    }
  }

  return results;
}

/**
 * The non-object-literal `module.exports = X` fallback. When `X` is an
 * identifier (`module.exports = main;`) or a named function/class
 * expression (`module.exports = function main() {};`), captures that name
 * as `localName` — needed to correlate this export back to the function
 * that implements it (see TASK-018 Call Graph, which relies on this to
 * find the node for `fixtures/commonjs/src/index.cjs`'s real
 * `module.exports = function main() {...}` pattern). Left `undefined` for
 * anything else (e.g. an inline anonymous arrow function): still a valid
 * "the module's default export exists" fact, just not attributable to a
 * named local declaration.
 */
function wholeModuleDefaultExport(
  assignment: ModuleExportsAssignment,
): ExportBinding {
  let localName: string | undefined;

  if (ts.isIdentifier(assignment.rhs)) {
    localName = assignment.rhs.text;
  } else if (
    (ts.isFunctionExpression(assignment.rhs) ||
      ts.isClassExpression(assignment.rhs)) &&
    assignment.rhs.name
  ) {
    localName = assignment.rhs.name.text;
  }

  return {
    kind: "default",
    syntax: "commonjs",
    localName,
    location: assignment.location,
  };
}

/**
 * Builds the unified import/export model for a file already indexed by
 * TASK-014 (see docs/SDD.md § 15-17).
 */
export function buildModuleModel(index: SourceIndex): ModuleModel {
  return {
    filePath: index.filePath,
    imports: index.imports.map(toImportBinding),
    exports: buildExportBindings(index.sourceFile, index.exports),
  };
}
