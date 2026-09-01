import ts from "typescript";
import type { SourceLocation } from "../domain/graph.js";
import {
  commonJsModuleReExportOrigin,
  commonJsPropertyReExportOrigin,
  resolveCommonJsReExportExpression,
  type CommonJsReExportOrigin,
} from "./commonjs-reexports.js";
import {
  type IndexedExport,
  type IndexedFunction,
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
  /**
   * For a CommonJS export whose value came from a `require()` of another
   * module (RWF-004a): where that value originates. `undefined` for every
   * export defined locally, and for every CommonJS export whose right-hand
   * side has no single statically-known origin (a dynamic specifier, a
   * conditional, a chained alias) — see
   * {@link CommonJsReExportOrigin} and commonjs-reexports.ts.
   *
   * Deliberately separate from {@link specifier}, which carries the ESM
   * `export { a } from "./x"` form: the two are different syntaxes with
   * different resolution rules (the CommonJS one is restricted to the
   * SAME canonical PackageInstance — see call-graph.ts's
   * `resolveReExportChain`), and collapsing them would silently give the
   * CommonJS form the ESM form's cross-package reach.
   */
  readonly commonJsReExport?: CommonJsReExportOrigin;
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
 * The literal string value of a computed property name's key expression
 * (`[expr]:` / `[expr]() {}`), when it's directly a string/numeric
 * literal or a same-file `const` binding initialized to one (VT-217,
 * SDD-v0.2.md § 7.1's computed-key follow-on) -- e.g.
 * `const NAME = "vulnerable"; module.exports = { [NAME]: impl };`.
 * `undefined` for anything else (a parameter, a function call, a runtime
 * value) -- a genuinely dynamic key stays unresolved exactly as before.
 */
function resolveComputedPropertyNameLiteral(
  sourceFile: ts.SourceFile,
  name: ts.ComputedPropertyName,
): string | undefined {
  const expr = name.expression;
  if (ts.isStringLiteralLike(expr) || ts.isNumericLiteral(expr)) {
    return expr.text;
  }
  if (!ts.isIdentifier(expr)) {
    return undefined;
  }
  const keyName = expr.text;

  let found: string | undefined;
  function visit(node: ts.Node): void {
    if (found !== undefined) {
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === keyName &&
      node.initializer &&
      ts.isStringLiteralLike(node.initializer) &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      found = node.initializer.text;
      return;
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
 * resolution (TASK-017). Spread elements are skipped: their exported name
 * cannot be determined statically (see docs/SDD.md § 21: dynamic
 * constructs must not fabricate exact bindings). A computed property name
 * (VT-217) is unpacked only when its key resolves to a literal via
 * {@link resolveComputedPropertyNameLiteral}; any other computed key stays
 * unresolved. Returns `undefined` (not unpacked) when the RHS isn't an
 * object literal, or when none of its properties are statically nameable.
 */
function unpackObjectLiteralExports(
  index: SourceIndex,
  assignment: ModuleExportsAssignment,
): ExportBinding[] | undefined {
  const sourceFile = index.sourceFile;
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
        commonJsReExport: resolveCommonJsReExportExpression(
          index,
          property.initializer,
        ),
        location: toSourceLocation(sourceFile, property),
      });
    } else if (
      ts.isPropertyAssignment(property) &&
      ts.isComputedPropertyName(property.name)
    ) {
      const exportedName = resolveComputedPropertyNameLiteral(
        sourceFile,
        property.name,
      );
      if (exportedName !== undefined) {
        results.push({
          kind: "named",
          syntax: "commonjs",
          exportedName,
          localName: ts.isIdentifier(property.initializer)
            ? property.initializer.text
            : undefined,
          commonJsReExport: resolveCommonJsReExportExpression(
            index,
            property.initializer,
          ),
          location: toSourceLocation(sourceFile, property),
        });
      }
    } else if (ts.isShorthandPropertyAssignment(property)) {
      results.push({
        kind: "named",
        syntax: "commonjs",
        exportedName: property.name.text,
        localName: property.name.text,
        // `module.exports = { Range }` over a local
        // `const Range = require("./classes/range")` -- the dominant
        // real-world shape (semver, qs; see the audit's § 5.2). The
        // shorthand's own identifier IS the value expression.
        commonJsReExport: resolveCommonJsReExportExpression(
          index,
          property.name,
        ),
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
    } else if (
      ts.isMethodDeclaration(property) &&
      ts.isComputedPropertyName(property.name)
    ) {
      const exportedName = resolveComputedPropertyNameLiteral(
        sourceFile,
        property.name,
      );
      if (exportedName !== undefined) {
        results.push({
          kind: "named",
          syntax: "commonjs",
          exportedName,
          localName: exportedName,
          location: toSourceLocation(sourceFile, property),
        });
      }
    }
    // Spread elements and any other computed property name (one that
    // doesn't resolve to a literal) are intentionally not unpacked.
  }

  return results.length > 0 ? results : undefined;
}

function buildExportBindings(
  index: SourceIndex,
  exportsList: readonly IndexedExport[],
): ExportBinding[] {
  const sourceFile = index.sourceFile;
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
          commonJsReExport:
            exp.exportedName === undefined
              ? undefined
              : commonJsPropertyReExportOrigin(index, exp.exportedName),
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
      const unpacked = unpackObjectLiteralExports(index, assignment);
      results.push(
        ...(unpacked ?? [wholeModuleDefaultExport(index, assignment)]),
      );
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
  index: SourceIndex,
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
    // `module.exports = require("./lib")` / `= require("./lib").foo`
    // (RWF-004a): the module's whole exported value comes from another
    // module. Unlike `localName`, this survives the value being anonymous.
    commonJsReExport: commonJsModuleReExportOrigin(index),
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
    exports: buildExportBindings(index, index.exports),
  };
}

/**
 * Maps each of a module's *canonical* export names (the name an importer
 * would bind to — "default" for a default/whole-module export, or the
 * named-export identifier otherwise) to the {@link IndexedFunction} that
 * implements it, when that can be attributed to a local function
 * declaration.
 *
 * This is the one place that reconciles a canonical export name with the
 * underlying function's own declared name, which can differ — most
 * commonly for CommonJS's `module.exports = someNamedFunction;` idiom
 * (used throughout the real npm ecosystem, e.g. lodash's per-method
 * files): the canonical export name is `"default"`, but the function
 * itself is still named `someNamedFunction`. Any consumer that needs to
 * go from "the export a rule/import specifier names" to "the real
 * function" — not just "a function that happens to share the export's
 * literal name" — must go through this mapping rather than comparing
 * against a function's own name directly (see call-graph.ts's
 * `prepareFile`, which builds call edges this way, and
 * src/analysis/verdict.ts's `findOrPhantomTarget`, which locates a rule's
 * declared target the same way — see TASK-023 completion report for the
 * regression this fixes).
 */
export function mapExportsToFunctions(
  index: SourceIndex,
  model: ModuleModel,
): ReadonlyMap<string, IndexedFunction> {
  const result = new Map<string, IndexedFunction>();

  for (const exp of model.exports) {
    if (exp.kind === "re-export") {
      // Chasing a re-export to its ultimate source file is not attempted
      // here — see TASK-018 completion report.
      continue;
    }
    const canonicalName = exp.kind === "default" ? "default" : exp.exportedName;
    // Prefer the actual local identifier; for CommonJS `exports.foo = ...`
    // there is no separate localName, but TASK-014 already infers the
    // assigned function's own name as "foo" from the assignment target,
    // so exportedName doubles as the correct lookup key there too.
    const localKey = exp.localName ?? exp.exportedName;
    if (!canonicalName || !localKey) {
      continue;
    }
    const matchingFn = index.functions.find((fn) => fn.name === localKey);
    if (matchingFn) {
      result.set(canonicalName, matchingFn);
    }
  }

  return result;
}

/**
 * Structurally attributes a rule target's `export` name to every
 * class-member declaration (method or constructor) reachable through a
 * REAL, module-level export binding that names a class (VT-301A; see
 * docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 7.3/§ 10's RWF-011/R-6
 * provenance requirement).
 *
 * The chain is exact, never a same-file name search:
 *
 * ```text
 * export binding (canonical name -> local class name)
 *   -> that class's own IndexedFunction (mapExportsToFunctions,
 *      kind === "constructor" -- constructors are always named after
 *      their enclosing class, see source-index.ts)
 *   -> every OTHER IndexedFunction in the same file whose
 *      memberOf.className equals that class's own name AND whose own
 *      name equals memberName
 * ```
 *
 * A method/constructor belonging to a class the module does not itself
 * export is never a candidate here, no matter how uniquely its bare name
 * matches `memberName` elsewhere in the file — this is exactly the
 * coincidence RWF-011 identified as unsafe for a same-file bare-name
 * search to rely on.
 *
 * When more than one exported class legitimately declares a member named
 * `memberName` (e.g. two exported classes both happen to have a `parse()`
 * method), every one of them is a structurally valid candidate: this
 * returns ALL of them rather than arbitrarily picking one. It is the
 * caller's (`findExportNodeInFile`'s) job to turn each into a graph node,
 * and `resolveTargetNodes`/`checkReachability`'s existing
 * OR-across-candidate-nodes aggregation that already backs
 * multiple-`VulnerableSymbolTarget`/multiple-entrypoint reachability
 * decides AFFECTED/NOT_AFFECTED/UNKNOWN from there — this function never
 * narrows ambiguity down to one answer itself.
 *
 * Returns an empty array (not a guess) when the module exports no class
 * at all, or when no exported class's own members include `memberName` —
 * e.g. a webpack-bundled module whose export table
 * (`mapExportsToFunctions`) has no attributable class entry at all (see
 * RWF-006/RWB-03: this deliberately does not fall back to treating every
 * class in the file as if it were exported).
 */
export function findExportedClassMembers(
  index: SourceIndex,
  model: ModuleModel,
  memberName: string,
): readonly IndexedFunction[] {
  const exportedClassNames = new Set<string>();
  for (const fn of mapExportsToFunctions(index, model).values()) {
    if (fn.kind === "constructor" && fn.name !== undefined) {
      exportedClassNames.add(fn.name);
    }
  }

  if (exportedClassNames.size === 0) {
    return [];
  }

  return index.functions.filter(
    (fn) =>
      fn.name === memberName &&
      fn.memberOf !== undefined &&
      exportedClassNames.has(fn.memberOf.className),
  );
}
