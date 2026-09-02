import ts from "typescript";
import type { SourceLocation } from "../domain/graph.js";
import {
  classifyLocalBinding,
  commonJsModuleReExportOrigin,
  commonJsPropertyExportRhs,
  commonJsPropertyReExportOrigin,
  declaresCommonJsAmbientShadow,
  refusesLocalIdentifierProvenance,
  resolveCommonJsReExportExpression,
  unwrapParentheses,
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
  /**
   * The exact source position of the function-like expression this binding's
   * exported value IS, when the export assignment structurally *references*
   * one (RWF-003; see docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 5's R-3,
   * tests/validation/FINDINGS.md RWF-003).
   *
   * This is the export's CONCRETE FUNCTION IDENTITY, deliberately kept
   * separate from {@link localName}, which is a *name* the export can be
   * looked up by. The two answer different questions and neither implies
   * the other:
   *
   * - `module.exports = function () {}` has an identity but NO name — the
   *   whole point of RWF-003. Before this field existed the export was
   *   simply unattributable, because the only mechanism available was a
   *   name lookup and there was no name to look up.
   * - `module.exports = function internalName() {}` has both, and they
   *   disagree about what they mean: `internalName` is the function's own
   *   INTERNAL name, not the public binding an importer sees (which is the
   *   canonical `"default"`). Matching on it happens to work, but only
   *   because no other function in the file shares that text.
   *
   * A position is not a guess and cannot collide: exactly one AST node
   * begins at a given offset in a file, and source-index.ts records every
   * function-like node under that same position (see `extractFunction`'s
   * `toSourceLocation`). So `mapExportsToFunctions` resolving through this
   * field is an identity, where resolving through {@link localName} is a
   * same-file name search that can land on a different function that
   * merely shares the text.
   *
   * `undefined` whenever the exported value is not a directly-referenced
   * function — including every shape this deliberately refuses to guess at:
   * a conditionally-assigned export, a file that shadows the CommonJS
   * ambient names, an alias chain longer than one hop, and any value that
   * is not statically a function at all. See
   * {@link directExportedFunctionLocation}.
   */
  readonly localFunctionLocation?: SourceLocation;
  /**
   * Whether this export's value is an identifier whose same-file binding
   * the local-provenance model EXAMINED AND REFUSED (RWF-013, widened by
   * RWF-013b; see `classifyLocalBinding` in commonjs-reexports.ts).
   *
   * Purely internal analysis state: never serialized, never surfaced in
   * evidence, and read by exactly one consumer —
   * {@link mapExportsToFunctions}, which must not fall back to a
   * name-only function search for such an export.
   *
   * This exists because {@link localFunctionLocation} being `undefined`
   * is NOT sufficient to decide that question, and treating it as if it
   * were is what made the defect look fixable without a new field.
   * `undefined` there is the answer for every export RWF-003's identity
   * relation does not model at all, most of which the older name-based
   * attribution handles perfectly well and soundly:
   *
   * ```text
   * function fn() {}          module.exports = fn   -- an un-reassigned function
   *                                                    DECLARATION, still bound by name
   * const C = class {};       module.exports = C    -- a class, attributed by
   *                                                    name via its constructor
   * exports.foo = function () {}                    -- a property export, which
   *                                                    this relation never covered
   * ```
   *
   * Suppressing the fallback on `undefined` alone would silently drop all
   * of those. So the two facts are carried separately: a *location* says
   * "the export IS this function node", and this flag says "the file's own
   * text contradicts any claim about what this name holds". Only the
   * second one is grounds for refusing to guess.
   *
   * The refused shapes, and what each one taught:
   *
   * ```js
   * let fn = function () {};   // RWF-013: indexed under the name "fn"
   * fn = other;                // ...and immediately stale
   * module.exports = fn;       // binds "fn" -> the STALE node, by name
   *
   * function fn() {}           // RWF-013b: the SAME defect, and the
   * fn = other;                // declaration form is irrelevant to it --
   * module.exports = fn;       // JavaScript reassigns this just as freely
   * ```
   *
   * The second shape is why the underlying question is "does this file
   * write to this name?", asked before and independently of "how was this
   * name declared?". Restricting the refusal to variable bindings left
   * reassigned `function`/`class` declarations attributing their stale
   * node, which reproduced a false NOT_AFFECTED carrying a complete
   * Family C proof.
   *
   * Deliberately independent of the module-scope and ambient-shadow
   * guards that gate {@link localFunctionLocation}: a conditional
   * assignment or a file that shadows `module`/`exports`/`require` has
   * strictly LESS provenance for the same identifier, never more.
   */
  readonly localIdentifierProvenanceRefused?: boolean;
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
  /**
   * Whether the assignment is an UNCONDITIONAL module-scope statement —
   * its own statement is a direct child of the source file, not nested
   * inside an `if`/`try`/loop/function body (RWF-003).
   *
   * `false` means this task cannot know whether the assignment runs at
   * all, so it cannot know the final value of `module.exports`. Only the
   * function-identity binding below consults this; the pre-existing
   * name-based attribution is deliberately left exactly as it was.
   */
  readonly isModuleScope: boolean;
}

/** Whether a node is a function-like *expression* — the only value shape a `module.exports = X` assignment can directly make callable. */
function isDirectFunctionValue(
  node: ts.Expression,
): node is ts.FunctionExpression | ts.ArrowFunction {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

/**
 * The exact source position of the function-like node a *property*
 * export's right-hand side IS, when the right-hand side is one
 * structurally (RWF-011). The property-export counterpart of
 * {@link directExportedFunctionLocation}, and the same kind of fact: a
 * position identifies exactly one AST node, so this is an identity, never
 * a same-file text match.
 *
 * ```text
 * exports.foo = function () {}      -> that FunctionExpression
 * exports.foo = function bar() {}   -> that FunctionExpression
 * exports.foo = async function () {}-> that FunctionExpression
 * exports.foo = () => {}            -> that ArrowFunction
 * exports.Foo = class { m() {} }    -> that class's constructor
 * module.exports = { foo() {} }     -> that MethodDeclaration
 * ```
 *
 * A class expression IS matched here, unlike in
 * {@link directExportedFunctionLocation}: the callable node a class
 * exports is its constructor, and source-index.ts indexes one for every
 * class — the explicit `constructor() {}` member when the class declares
 * it, and otherwise a synthesized entry positioned at the class's own name
 * (or, for an anonymous class, at the class node itself; see
 * `extractImplicitConstructor`). {@link classConstructorNode} reproduces
 * that choice exactly, so the position resolves to the very entry source
 * indexing recorded. This is what keeps `exports.Foo = class { ... }`
 * attributable — and therefore keeps
 * {@link findExportedClassMembers}'s exported-class set populated — once
 * the coincidental name fallback is gone.
 *
 * `undefined` for every other right-hand side, which is the whole point:
 * `exports.foo = registry.impl`, `exports.foo = makeFoo()`,
 * `exports.foo = obj.foo` and `exports.foo = cond ? a : b` name no
 * function node at all, and this relation says so rather than letting the
 * export's public NAME go looking for one.
 */
function directValueFunctionLocation(
  sourceFile: ts.SourceFile,
  value: ts.Expression,
): SourceLocation | undefined {
  const node = unwrapParentheses(value);
  if (isDirectFunctionValue(node)) {
    return toSourceLocation(sourceFile, node);
  }
  if (ts.isClassExpression(node)) {
    return toSourceLocation(sourceFile, classConstructorNode(node));
  }
  return undefined;
}

/**
 * The node source-index.ts positions a class's constructor entry at — the
 * explicit `constructor() {}` member when there is one, and otherwise the
 * class's own name identifier, or the class node itself when it is
 * anonymous. Mirrors `extractConstructor`/`extractImplicitConstructor`
 * there; the two must agree, because {@link mapExportsToFunctions}
 * resolves this position against the index's own entries.
 */
function classConstructorNode(
  node: ts.ClassExpression | ts.ClassDeclaration,
): ts.Node {
  const explicit = node.members.find((member) =>
    ts.isConstructorDeclaration(member),
  );
  return explicit ?? node.name ?? node;
}

/**
 * The positive provenance a CommonJS *property* export
 * (`exports.X = RHS` / `module.exports.X = RHS`) establishes for its own
 * value (RWF-011).
 *
 * Before this, a property export carried NEITHER of these facts, and
 * {@link mapExportsToFunctions} fell back to searching the file for a
 * function whose own name equalled the EXPORTED name. That fallback is
 * unsound in exactly the way this whole relation exists to prevent: the
 * public property name an export is published under is not provenance for
 * any local symbol, so
 *
 * ```js
 * function parse(input) { return "safe:" + input; }   // unrelated decoy
 * const registry = { impl: require("./lib/parse") };
 * exports.parse = registry.impl;                      // the REAL value
 * ```
 *
 * bound `exports.parse` to the decoy, and proving the decoy unreachable
 * produced a complete, correct — and completely wrong-target — Family C
 * NOT_AFFECTED for a vulnerability that is reachable at runtime.
 *
 * Two shapes, both of which the right-hand side itself establishes:
 *
 * - **A bare identifier** (`exports.foo = foo`,
 *   `exports.publicName = internal`, `exports.Klass = Klass`) names a
 *   local symbol explicitly, so it becomes {@link ExportBinding.localName}
 *   — the RHS's OWN text, never the exported name. `exports.publicName =
 *   internal` therefore looks up `internal`, which is both correct and
 *   something the exported-name fallback could never do. RWF-013's
 *   refusal is unaffected and still consulted first, so a reassigned
 *   identifier stays refused rather than becoming newly attributable.
 * - **A directly-referenced function/class value** becomes
 *   {@link ExportBinding.localFunctionLocation} via
 *   {@link directValueFunctionLocation}, an exact identity. This also
 *   repairs a wrong-target case the name search got silently wrong:
 *   `function foo() {}` alongside `exports.foo = function () {}` indexes
 *   TWO functions named `foo` (source-index.ts names the anonymous one
 *   after the property it is assigned to), and the name search returned
 *   whichever came first in the file — the decoy.
 *
 * Gated on the assignment being an unconditional module-scope statement,
 * for the same reason {@link directExportedFunctionLocation} is: this
 * module has no control-flow semantics, and
 * `commonJsPropertyExportRhs`'s last-write-wins map picks the last
 * assignment in SOURCE order. Binding a right-hand side that sits inside
 * an `if`/`try`/loop/function body would be choosing a branch
 * arbitrarily, which is the same manufactured certainty in a different
 * shape.
 */
function propertyExportProvenance(
  index: SourceIndex,
  rhs: ts.Expression | undefined,
): Pick<ExportBinding, "localName" | "localFunctionLocation"> {
  if (rhs === undefined || !isUnconditionalPropertyAssignment(rhs)) {
    return {};
  }
  const value = unwrapParentheses(rhs);
  return {
    localName: ts.isIdentifier(value) ? value.text : undefined,
    localFunctionLocation: directValueFunctionLocation(index.sourceFile, value),
  };
}

/**
 * {@link isUnconditionalModuleScopeStatement} for the `exports.X = rhs`
 * form, climbing out through CHAINED assignments first.
 *
 * `exports.parse = exports.decode = decode` (real ini, and a staple
 * CommonJS idiom for publishing one function under two names) parses as
 * `exports.parse = (exports.decode = decode)`, so the inner assignment's
 * enclosing node is the outer ASSIGNMENT, not the statement. Asking about
 * it directly reports "not module scope" and refuses a binding whose
 * provenance is in fact perfect: the whole chain is one unconditional
 * top-level statement, and `decode` is a bare identifier naming a local
 * function.
 *
 * Only assignment links are climbed, and only from the right-hand side —
 * exactly the positions whose value IS the value being assigned. Anything
 * else between the assignment and the source file (an `if`, a `try`, a
 * function body, a comma expression) still means the assignment may not
 * run, and still refuses.
 *
 * Note this deliberately does NOT make `exports.parse` itself
 * attributable: its own right-hand side is the inner assignment
 * expression, not an identifier or a function node, so
 * {@link propertyExportProvenance} finds nothing to bind and the export
 * stays unresolved. Resolving THROUGH an assignment expression's value is
 * a separate relation and is not attempted here.
 */
function isUnconditionalPropertyAssignment(rhs: ts.Expression): boolean {
  let node: ts.Node | undefined = rhs.parent;
  if (node === undefined) {
    return false;
  }
  let parent = node.parent as ts.Node | undefined;
  while (
    parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node
  ) {
    node = parent;
    parent = node.parent as ts.Node | undefined;
  }
  return isUnconditionalModuleScopeStatement(node);
}

/** Whether `node`'s own statement is a direct child of the source file (module scope, unconditional). */
function isUnconditionalModuleScopeStatement(node: ts.Node): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) {
    return false;
  }
  if (ts.isSourceFile(parent)) {
    // `export = X;` — an ExportAssignment is itself a statement.
    return true;
  }
  return (
    ts.isExpressionStatement(parent) &&
    parent.parent !== undefined &&
    ts.isSourceFile(parent.parent)
  );
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
      found = {
        rhs: node.right,
        location: toSourceLocation(sourceFile, node),
        isModuleScope: isUnconditionalModuleScopeStatement(node),
      };
    } else if (ts.isExportAssignment(node) && node.isExportEquals) {
      found = {
        rhs: node.expression,
        location: toSourceLocation(sourceFile, node),
        isModuleScope: isUnconditionalModuleScopeStatement(node),
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
        // RWF-011: `{ foo: function () {} }` / `{ foo: () => {} }` /
        // `{ Foo: class {} }` — the property's VALUE is the function node,
        // an identity. Without it the only remaining key would be the
        // property name, which is the exported name and therefore no
        // provenance at all (see {@link propertyExportProvenance}).
        localFunctionLocation: objectLiteralValueLocation(
          sourceFile,
          assignment,
          property.initializer,
        ),
        commonJsReExport: resolveCommonJsReExportExpression(
          index,
          property.initializer,
        ),
        localIdentifierProvenanceRefused: refusedProvenanceFlag(
          refusesLocalIdentifierProvenance(index, property.initializer),
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
          localFunctionLocation: objectLiteralValueLocation(
            sourceFile,
            assignment,
            property.initializer,
          ),
          commonJsReExport: resolveCommonJsReExportExpression(
            index,
            property.initializer,
          ),
          // RWF-013, extended to the computed-key form (VT-217) that
          // shipped without it: `module.exports = { [NAME]: fn }` binds an
          // export to an identifier exactly as the literal-key form does,
          // and a reassigned `fn` must be refused in both.
          localIdentifierProvenanceRefused: refusedProvenanceFlag(
            refusesLocalIdentifierProvenance(index, property.initializer),
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
        localIdentifierProvenanceRefused: refusedProvenanceFlag(
          refusesLocalIdentifierProvenance(index, property.name),
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
        // RWF-011: a method IS its own function node, so bind it by
        // position. Its `localName` above is the method's own name, which
        // for this shape is necessarily also the exported name — so a
        // name search could not tell the method apart from an unrelated
        // same-file `function foo() {}` and returned whichever came
        // first, silently attributing the wrong node.
        localFunctionLocation: methodValueLocation(
          sourceFile,
          assignment,
          property,
        ),
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
          // The computed form additionally has no usable name at all:
          // source indexing records the method under its literal source
          // text (`[NAME]`), so position is the only thing that can
          // resolve it.
          localFunctionLocation: methodValueLocation(
            sourceFile,
            assignment,
            property,
          ),
          location: toSourceLocation(sourceFile, property),
        });
      }
    }
    // Spread elements and any other computed property name (one that
    // doesn't resolve to a literal) are intentionally not unpacked.
  }

  return results.length > 0 ? results : undefined;
}

/**
 * {@link directValueFunctionLocation} for one property of a
 * `module.exports = { ... }` object literal, gated on the enclosing
 * assignment being unconditional module scope — the same guard the other
 * two identity relations apply, for the same reason: an object literal
 * assigned inside an `if`/`try`/loop may never be the module's exported
 * value at all, and `findLastModuleExportsAssignment` picks by source
 * order, not by control flow.
 */
function objectLiteralValueLocation(
  sourceFile: ts.SourceFile,
  assignment: ModuleExportsAssignment,
  value: ts.Expression,
): SourceLocation | undefined {
  return assignment.isModuleScope
    ? directValueFunctionLocation(sourceFile, value)
    : undefined;
}

/** The identity of a `module.exports = { foo() {} }` method — the method node itself, under the same module-scope guard. */
function methodValueLocation(
  sourceFile: ts.SourceFile,
  assignment: ModuleExportsAssignment,
  method: ts.MethodDeclaration,
): SourceLocation | undefined {
  return assignment.isModuleScope
    ? toSourceLocation(sourceFile, method)
    : undefined;
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
      case "commonjs-exports-property": {
        // `exports.parse = parse` binds an export to an identifier
        // exactly as `module.exports = parse` does, and is the shape the
        // RWF-013 reproducer actually hits (see
        // fixtures/commonjs-stale-alias-export/).
        //
        // RWF-011: the export's own right-hand side is the ONLY thing
        // allowed to establish what it holds — as `localName` when it
        // names a local symbol, or as `localFunctionLocation` when it IS
        // a function/class node. Before this, a property export carried
        // neither, and `mapExportsToFunctions` searched the file for a
        // function named after the EXPORTED name, which bound
        // `exports.parse = registry.impl` to any unrelated same-file
        // `function parse()`. See {@link propertyExportProvenance}.
        const propertyRhs =
          exp.exportedName === undefined
            ? undefined
            : commonJsPropertyExportRhs(index, exp.exportedName);
        results.push({
          kind: "named",
          syntax: "commonjs",
          exportedName: exp.exportedName,
          ...propertyExportProvenance(index, propertyRhs),
          commonJsReExport:
            exp.exportedName === undefined
              ? undefined
              : commonJsPropertyReExportOrigin(index, exp.exportedName),
          localIdentifierProvenanceRefused: refusedProvenanceFlag(
            propertyRhs !== undefined &&
              refusesLocalIdentifierProvenance(index, propertyRhs),
          ),
          location: exp.location,
        });
        break;
      }
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
/**
 * The concrete function identity a `module.exports = X` / `export = X`
 * assignment binds the module's whole exported value to — the RWF-003
 * relation (see {@link ExportBinding.localFunctionLocation}).
 *
 * Two shapes produce an identity, both of which name a function node
 * *structurally*, never by its text:
 *
 * ```text
 * module.exports = function () {}            -> that FunctionExpression
 * module.exports = function named() {}       -> that FunctionExpression
 * module.exports = async function () {}      -> that FunctionExpression
 * module.exports = () => {}                  -> that ArrowFunction
 * module.exports = async () => {}            -> that ArrowFunction
 * module.exports = fn   (const fn = function () {} / () => {})
 *                                            -> that same function node
 * export = function () {}                    -> that FunctionExpression
 * ```
 *
 * An arrow function is included because source-index.ts indexes arrows as
 * first-class function nodes exactly like function expressions
 * (`isFunctionLike`), and call-graph.ts registers and walks them the same
 * way — so this is integrating an already-authoritative representation,
 * not adding a partial one.
 *
 * Three guards make the result a fact rather than a guess, and each one
 * returning `undefined` leaves the export exactly as unattributed as it
 * was before RWF-003 (an unresolved target, hence UNKNOWN — never a
 * verdict):
 *
 * 1. **Unconditional module scope.** Node's `module.exports` is
 *    last-write-wins at RUNTIME, and this task has no control-flow
 *    semantics. An assignment nested in an `if`/`try`/loop/function may or
 *    may not run, and `findLastModuleExportsAssignment` picks the last one
 *    in SOURCE order — so binding to it would be choosing a branch
 *    arbitrarily. Requiring the winning assignment to be a direct
 *    statement of the file makes "this is the module's final exported
 *    value" true by the language's own rules.
 * 2. **CommonJS ambient provenance.** A file that declares its own
 *    `module`/`exports`/`require` binding is refused outright, so
 *    `const module = { exports: null }; module.exports = function () {}`
 *    creates no export identity at all — the RWF-004a protection, applied
 *    to this relation too (see `declaresCommonJsAmbientShadow`).
 * 3. **Exactly one alias hop.** The identifier form goes through
 *    commonjs-reexports.ts's existing module-scope single-assignment
 *    proof and never recurses, so `const a = fn; const b = a;
 *    module.exports = b` resolves to nothing here. Broadening that is
 *    RWF-012, deliberately not done.
 *
 * A class expression (`module.exports = class {}`) is deliberately NOT
 * matched: its callable target is an implicit or explicit constructor and
 * its members are attributed by a different relation
 * ({@link findExportedClassMembers}), which is keyed on the class's own
 * name. Extending identity-based attribution to anonymous classes is a
 * separate question, and refusing here costs only the precision it
 * already lacked.
 */
function directExportedFunctionLocation(
  index: SourceIndex,
  assignment: ModuleExportsAssignment,
): SourceLocation | undefined {
  if (!assignment.isModuleScope) {
    return undefined;
  }

  const value = unwrapParentheses(assignment.rhs);

  if (isDirectFunctionValue(value)) {
    return declaresCommonJsAmbientShadow(index)
      ? undefined
      : toSourceLocation(index.sourceFile, value);
  }

  if (!ts.isIdentifier(value) || declaresCommonJsAmbientShadow(index)) {
    return undefined;
  }

  const bound = classifyLocalBinding(index, value.text);
  if (bound.kind !== "single-assignment") {
    return undefined;
  }
  const boundValue = unwrapParentheses(bound.value);
  return isDirectFunctionValue(boundValue)
    ? toSourceLocation(index.sourceFile, boundValue)
    : undefined;
}

/**
 * `true` or absent, never `false` — {@link ExportBinding} is a bag of
 * facts about an export, and "we did not refuse anything" is the absence
 * of a fact rather than one. Keeps every export binding this relation has
 * nothing to say about shaped exactly as it was before RWF-013.
 */
function refusedProvenanceFlag(refused: boolean): true | undefined {
  return refused ? true : undefined;
}

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
    // The export's concrete function identity, when the assignment names
    // one structurally (RWF-003). Independent of `localName`: an anonymous
    // value has an identity and no name, and a named function expression
    // has both.
    localFunctionLocation: directExportedFunctionLocation(index, assignment),
    // RWF-013: `module.exports = fn` where `fn` is a variable this file
    // reassigns (or otherwise cannot prove single-assignment for). The
    // name "fn" is still a perfectly good same-file match for the STALE
    // initializer, so the fallback must be told not to take it.
    localIdentifierProvenanceRefused: refusedProvenanceFlag(
      refusesLocalIdentifierProvenance(index, assignment.rhs),
    ),
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
  /** Built at most once per call, and only when some export actually carries an identity. */
  let functionsByPosition: ReadonlyMap<string, IndexedFunction> | undefined;

  for (const exp of model.exports) {
    if (exp.kind === "re-export") {
      // Chasing a re-export to its ultimate source file is not attempted
      // here — see TASK-018 completion report.
      continue;
    }
    const canonicalName = exp.kind === "default" ? "default" : exp.exportedName;
    if (!canonicalName) {
      continue;
    }

    // RWF-003: a structurally-referenced function node is the export's real
    // identity and always wins over the name search below — it is exact
    // where the name search is a same-file text match, and it is the ONLY
    // mechanism available at all when the exported function is anonymous.
    // See ExportBinding.localFunctionLocation.
    if (exp.localFunctionLocation) {
      functionsByPosition ??= indexFunctionsByPosition(index);
      const byIdentity = functionsByPosition.get(
        positionKey(exp.localFunctionLocation),
      );
      if (byIdentity) {
        result.set(canonicalName, byIdentity);
        continue;
      }
    }

    // RWF-013: the export's value is an identifier whose binding this
    // file's own text contradicts (reassigned, multiply declared, not
    // module scope, ...). The name search below would still find a
    // same-named function -- typically the STALE initializer, which
    // source indexing names after the very variable that was reassigned
    // away from it -- and binding that manufactures a confident target
    // out of a value the analyzer just proved it cannot determine. An
    // export nothing can attribute is an unresolved target (UNKNOWN),
    // which is the correct answer here; a stale one is a false verdict in
    // whichever direction the stale node's reachability happens to fall.
    // See ExportBinding.localIdentifierProvenanceRefused.
    if (exp.localIdentifierProvenanceRefused) {
      continue;
    }

    // RWF-011: ONLY a local name the export's own right-hand side
    // established may drive a same-file function search. This used to
    // read `exp.localName ?? exp.exportedName`, and that fallback is the
    // defect: a public export name is not provenance for any local
    // symbol, so `exports.parse = registry.impl` — whose value this
    // analyzer models nothing about — bound itself to an unrelated
    // same-file `function parse()` purely because the two strings match.
    // Family C would then prove that decoy unreachable and report a
    // complete, internally consistent, and false NOT_AFFECTED.
    //
    // Dropping the fallback costs nothing that had provenance: every
    // shape that legitimately resolved through it now arrives here with a
    // real `localName` (an identifier right-hand side, an object-literal
    // shorthand, an ESM local) or was already resolved above by exact
    // position (a directly-referenced function, arrow, class or method).
    // An export with neither is one nothing in this file attributes, and
    // an unattributed export is an unresolved target — UNKNOWN, never a
    // verdict. See {@link propertyExportProvenance}.
    const localKey = exp.localName;
    if (!localKey) {
      continue;
    }
    const matchingFn = index.functions.find((fn) => fn.name === localKey);
    if (matchingFn) {
      result.set(canonicalName, matchingFn);
    }
  }

  return result;
}

/** A function node's own start position, the identity key {@link ExportBinding.localFunctionLocation} resolves against. */
function positionKey(location: SourceLocation): string {
  return `${location.line}:${location.column}`;
}

/**
 * Every indexed function keyed by its own start position, built once per
 * {@link mapExportsToFunctions} call rather than re-scanned per export —
 * exactly one AST node begins at a given position, so first-wins here can
 * only ever be an exact match (the guard exists solely so a synthesized
 * implicit-constructor entry, whose position is its class's name rather
 * than its own node, can never displace a real function node).
 */
function indexFunctionsByPosition(
  index: SourceIndex,
): ReadonlyMap<string, IndexedFunction> {
  const byPosition = new Map<string, IndexedFunction>();
  for (const fn of index.functions) {
    const key = positionKey(fn.location);
    if (!byPosition.has(key)) {
      byPosition.set(key, fn);
    }
  }
  return byPosition;
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
