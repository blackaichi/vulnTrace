/**
 * A load's result that may be an export object of this file (task BL-074;
 * RWF-103, RWF-106): the load reach a scan supplies, and whether a load's
 * value escapes the routes the census follows.
 *
 * Split out of `module-model.ts` by concern, as a pure move (task BL-121):
 * the declarations below are those of that file, unchanged and in its order.
 * `module-model.ts` re-exports the public ones.
 */
import ts from "typescript";
import {
  commonJsExportPropertyName,
  isModuleExportsAssignmentTarget,
  unwrapParentheses,
  unwrapValue,
} from "./commonjs-reexports.js";
import {
  isNameAssignedWithin,
  lexicalDeclarationOf,
} from "./named-bindings.js";
import type { SourceIndex } from "./source-index.js";
import {
  isPrimitiveValue,
  isNonReferenceName,
  isAmbientReference,
  isDeclarationName,
  identifiersSpelled,
  climbValue,
  isInertUse,
  isPlainAssignmentTarget,
  skipOuterParentheses,
  isRequireResult,
  isLoaderCallee,
  isWriteTargetPosition,
} from "./module-model.syntax.js";
import { competingWriteSites } from "./module-model.competing-write-sites.js";
import {
  importSpecifierOf,
  valueImportNames,
  mayLoadThisFile,
} from "./module-model.alias-summaries.js";

/* ------------------------------------------------------------------ *
 * BL-074 (RWF-103, RWF-106): a load's result that may be an export     *
 * object of this file, through any dataflow                            *
 * ------------------------------------------------------------------ */

/**
 * The module-graph context of one file's census (task BL-074; ADR 0009
 * § 4, "a cyclic `require` that cannot reach back"): which of its loads
 * may return one of its export objects -- its own exports object, handed
 * back through a cycle or the loader registry, or the object a
 * whole-module write installed (`module.exports = require("./safe")`
 * forwards `./safe`'s exports object, which every load of `./safe`
 * returns). Built per scan by `load-reach.ts`, from the resolver.
 *
 * Absent, every load may: the census is then the per-file rule, which
 * withdraws a file wherever a load's value leaves the routes the census
 * follows. That keeps every consumer without a resolver fail-closed.
 */
export interface LoadReach {
  /**
   * Whether a load of `specifier`, a literal resolved from this file, may
   * return an export object of this file or reach one through its members.
   * `true` for any specifier the context was not asked about.
   */
  mayReachBack(specifier: string): boolean;
}

/** What {@link loadResultEscapes} needs asked of the module graph, for one file. */
export interface LoadReachQuery {
  /** Every literal specifier a load of this file resolves from this file. */
  readonly specifiers: readonly string[];
  /** The literal specifiers whose module a whole-module write installs (`module.exports = require("./safe")`). */
  readonly forwardSpecifiers: readonly string[];
  /**
   * A whole-module write installs a value that may be any object (a call's
   * result, a binding the file reassigns, a load this relation cannot
   * resolve): then any load may return it, and the graph cannot answer.
   */
  readonly opaqueFinalObject: boolean;
}

/**
 * The literal specifier of a load resolved from this file -- the ambient
 * `require`, an only-called alias of it, `module.require` -- or
 * `undefined` for a load the graph cannot answer for: a computed
 * specifier, a spread, a load resolved from another module
 * (`require.main.require`, `module.constructor._load`).
 */
function plainLoadSpecifier(call: ts.CallExpression): string | undefined {
  if (!isRequireResult(call)) {
    return undefined;
  }
  const callee = unwrapParentheses(call.expression);
  if (
    ts.isPropertyAccessExpression(callee) &&
    !isAmbientReference(unwrapParentheses(callee.expression), "module")
  ) {
    return undefined;
  }
  const [first] = call.arguments;
  if (first === undefined || ts.isSpreadElement(first)) {
    return undefined;
  }
  const argument = unwrapParentheses(first);
  return ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

/**
 * Whether `call` loads a module: a loader call ({@link isRequireResult}),
 * or one made through `Function.prototype` (`require.call(null, x)`,
 * `require.apply(null, [x])`, `require.bind(null)(x)`).
 */
function isLoadCall(call: ts.CallExpression): boolean {
  if (isRequireResult(call)) {
    return true;
  }
  const callee = unwrapParentheses(call.expression);
  if (
    ts.isPropertyAccessExpression(callee) &&
    (callee.name.text === "call" || callee.name.text === "apply")
  ) {
    return isLoaderCallee(unwrapParentheses(callee.expression));
  }
  return ts.isCallExpression(callee) && isBoundLoader(callee);
}

/** Whether `call` is `require.bind(…)` (of any loader {@link isLoaderCallee} names). */
function isBoundLoader(call: ts.CallExpression): boolean {
  const callee = unwrapParentheses(call.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "bind" &&
    isLoaderCallee(unwrapParentheses(callee.expression))
  );
}

/** {@link loadValueIsConfined}'s bound on the bindings it follows; past it, a value escapes. */
const CONFINEMENT_DEPTH = 64;

/**
 * Whether every use of a value a load returns -- or reads from such a
 * value through members -- is one the census accounts for (task BL-074):
 *
 * - the base of a member chain: a write through it is a write of its name,
 *   withdrawn ({@link baseMayBeLoaded}); a member read is followed, since
 *   the member may be an export object too (`require("./holder").self`);
 * - the receiver of a member call, or a callee: the code run is a
 *   module's own, with its own census;
 * - an inert use ({@link isInertUse}): a test, `typeof`, a discarded value;
 * - held by a binding -- a declaration, a destructuring declaration, or a
 *   plain assignment to a name -- whose every reference is confined.
 *
 * Anything else hands the value on where the census cannot follow it: an
 * argument, a return, an array or object element, a spread, `for-of`,
 * `await`, a destructuring assignment, a coercion.
 */
function loadValueIsConfined(
  value: ts.Node,
  seen: Set<ts.Node> = new Set(),
): boolean {
  const top = climbValue(value);
  const parent = top.parent as ts.Node | undefined;
  if (parent === undefined) {
    return false;
  }
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === top
  ) {
    const access = skipOuterParentheses(parent);
    if (isWriteTargetPosition(access)) {
      return true;
    }
    const accessParent = access.parent as ts.Node | undefined;
    if (
      accessParent !== undefined &&
      (ts.isCallExpression(accessParent) || ts.isNewExpression(accessParent)) &&
      accessParent.expression === access
    ) {
      // A member call: its code is a module's own, censused there. What it
      // returns is NOT followed, though it may be the object itself
      // (`require("./other").valueOf()`): RWF-107, open, a measured
      // precision trade-off for the project owner (BL-078).
      return true;
    }
    return loadValueIsConfined(access, seen);
  }
  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.expression === top
  ) {
    // Called or constructed: the result may be an export object too
    // (`module.exports = () => require("./index")`) and is NOT followed:
    // RWF-107, as above.
    return true;
  }
  if (isInertUse(top)) {
    return true;
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === top) {
    return bindingNameIsConfined(parent.name, seen);
  }
  if (ts.isExportAssignment(parent) && parent.isExportEquals) {
    // `export = require("./lib")`: a whole-module write, below.
    return true;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === top
  ) {
    // In every branch below the assignment's own value is the load's
    // (`set(a = require("./other"))`, `a = b = require("./other")`), and
    // is followed too (BL-074's audit, finding 1).
    const target = unwrapParentheses(parent.left);
    if (isModuleExportsAssignmentTarget(target)) {
      // `module.exports = require("./lib")`: the whole-module write the
      // identity walk orders, and every later use of `module.exports` is
      // censused as the final object's.
      return loadValueIsConfined(parent, seen);
    }
    if (isAmbientReference(target, "exports")) {
      // `exports = module.exports = require("./lib")`: the rebinding the
      // identity walk orders with it, and `exports`'s uses are censused.
      return (
        isChainedWholeModuleWrite(parent.right) &&
        loadValueIsConfined(parent, seen)
      );
    }
    if (
      commonJsExportPropertyName(target) !== undefined &&
      exportObjectsAreWriteOnly(target.getSourceFile())
    ) {
      // `exports.b = require("./b")` in a file that never reads its export
      // objects back: the value is published, and no code of this file can
      // reach it again to write through it (another module's writes are
      // E-4's, as for every other export).
      return loadValueIsConfined(parent, seen);
    }
    if (ts.isIdentifier(target) && !isAmbientReference(target, "module")) {
      const declaration = lexicalDeclarationOf(target, target.text);
      return (
        declaration !== undefined &&
        bindingReferencesAreConfined(target, declaration, seen) &&
        loadValueIsConfined(parent, seen)
      );
    }
  }
  return false;
}

const writeOnlyExportsBySourceFile = new WeakMap<ts.SourceFile, boolean>();

/** Whether `value` is `module.exports = v` (the inner write of `exports = module.exports = v`). */
function isChainedWholeModuleWrite(value: ts.Expression): boolean {
  const inner = unwrapParentheses(value);
  return (
    ts.isBinaryExpression(inner) &&
    inner.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    isModuleExportsAssignmentTarget(unwrapParentheses(inner.left))
  );
}

/**
 * Whether this file's every reference to its export objects is a plain
 * `=` write: of a property (`exports.x = v`, `module.exports.x = v`) or of
 * the whole module (`module.exports = v`, `exports = module.exports = v`),
 * with no `this` anywhere (a method's `this` may be an export object) --
 * so nothing the file stores on them can be read back by its own code
 * (task BL-074).
 */
function exportObjectsAreWriteOnly(sourceFile: ts.SourceFile): boolean {
  const cached = writeOnlyExportsBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  let writeOnly = true;
  const visit = (node: ts.Node): void => {
    if (!writeOnly) {
      return;
    }
    if (
      node.kind === ts.SyntaxKind.ThisKeyword ||
      // A self-load returns the exports object: another way to read back.
      (ts.isCallExpression(node) &&
        isLoadCall(node) &&
        (!isRequireResult(node) || mayLoadThisFile(node)))
    ) {
      writeOnly = false;
      return;
    }
    if (ts.isIdentifier(node)) {
      const outer = skipOuterParentheses(node);
      const parent = outer.parent as ts.Node | undefined;
      if (isAmbientReference(node, "exports")) {
        writeOnly =
          parent !== undefined &&
          (((ts.isPropertyAccessExpression(parent) ||
            ts.isElementAccessExpression(parent)) &&
            parent.expression === outer &&
            commonJsExportPropertyName(parent) !== undefined &&
            isPlainAssignmentTarget(skipOuterParentheses(parent))) ||
            // `exports = module.exports = v`
            (isPlainAssignmentTarget(outer) &&
              ts.isBinaryExpression(parent) &&
              isChainedWholeModuleWrite(parent.right)));
        return;
      }
      if (isAmbientReference(node, "module")) {
        if (
          parent === undefined ||
          !ts.isPropertyAccessExpression(parent) ||
          parent.expression !== outer
        ) {
          writeOnly = false;
          return;
        }
        if (parent.name.text !== "exports") {
          return;
        }
        const access = skipOuterParentheses(parent);
        const accessParent = access.parent as ts.Node | undefined;
        writeOnly =
          isPlainAssignmentTarget(access) ||
          (accessParent !== undefined &&
            (ts.isPropertyAccessExpression(accessParent) ||
              ts.isElementAccessExpression(accessParent)) &&
            accessParent.expression === access &&
            commonJsExportPropertyName(accessParent) !== undefined &&
            isPlainAssignmentTarget(skipOuterParentheses(accessParent)));
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  writeOnlyExportsBySourceFile.set(sourceFile, writeOnly);
  return writeOnly;
}

/** {@link loadValueIsConfined} for every name a declaration's name (or pattern) binds. */
function bindingNameIsConfined(
  name: ts.BindingName,
  seen: Set<ts.Node>,
): boolean {
  if (ts.isIdentifier(name)) {
    const declaration = lexicalDeclarationOf(name, name.text);
    return (
      declaration !== undefined &&
      bindingReferencesAreConfined(name, declaration, seen)
    );
  }
  return name.elements.every(
    (element) =>
      ts.isOmittedExpression(element) ||
      bindingNameIsConfined(element.name, seen),
  );
}

/** Whether every reference to `declaration` (bound to `binding`'s name) is confined. */
function bindingReferencesAreConfined(
  binding: ts.Identifier,
  declaration: ts.Node,
  seen: Set<ts.Node>,
): boolean {
  if (seen.has(declaration)) {
    // A cycle: its other uses are being checked already.
    return true;
  }
  if (seen.size >= CONFINEMENT_DEPTH) {
    return false;
  }
  seen.add(declaration);
  loadConfinementWalks += 1;
  return identifiersSpelled(binding.getSourceFile(), binding.text).every(
    (reference) => {
      const parent = reference.parent as ts.Node | undefined;
      if (
        parent === undefined ||
        isNonReferenceName(reference, parent) ||
        isDeclarationName(reference, parent) ||
        lexicalDeclarationOf(reference, reference.text) !== declaration
      ) {
        return true;
      }
      const outer = skipOuterParentheses(reference);
      if (isPlainAssignmentTarget(outer)) {
        // A new value is written; this one is not read here.
        return true;
      }
      if (isWriteTargetPosition(outer)) {
        return false;
      }
      return loadValueIsConfined(reference, seen);
    },
  );
}

let loadConfinementWalks = 0;

/** Bindings {@link loadValueIsConfined} has followed in this process (BL-074's structural performance test). */
export function loadConfinementWalkCount(): number {
  return loadConfinementWalks;
}

const loadEscapesBySourceFile = new WeakMap<
  ts.SourceFile,
  Map<LoadReach | undefined, boolean>
>();

/**
 * Whether a load's result that may be an export object of this file
 * leaves the routes the census follows (task BL-074; RWF-103, RWF-106):
 * then a write anywhere it flows may set any name of that object, and the
 * whole file is un-enumerable.
 *
 * A load may be an export object when the graph context says its
 * specifier may reach back ({@link LoadReach}), when it has no literal
 * specifier resolved from this file, or when there is no context at all
 * (the per-file rule). A load that may load this very file is
 * E-1's alias of the exports object ({@link mayLoadThisFile}), censused
 * where it flows by {@link classifyExportReference}, and is skipped here.
 * A bound loader (`require.bind(…)`) that is not called at once escapes
 * with whatever it may load.
 */
function loadResultEscapes(
  sourceFile: ts.SourceFile,
  reach: LoadReach | undefined,
): boolean {
  let byReach = loadEscapesBySourceFile.get(sourceFile);
  const cached = byReach?.get(reach);
  if (cached !== undefined) {
    return cached;
  }
  let escapes = false;
  const visit = (node: ts.Node): void => {
    if (escapes) {
      return;
    }
    if (ts.isCallExpression(node)) {
      if (isBoundLoader(node)) {
        const outer = skipOuterParentheses(node);
        const parent = outer.parent as ts.Node | undefined;
        if (
          parent === undefined ||
          !ts.isCallExpression(parent) ||
          parent.expression !== outer
        ) {
          escapes = true;
          return;
        }
      } else if (
        isLoadCall(node) &&
        !(isRequireResult(node) && mayLoadThisFile(node))
      ) {
        const specifier = plainLoadSpecifier(node);
        const mayYield =
          specifier === undefined ||
          reach === undefined ||
          reach.mayReachBack(specifier);
        if (mayYield && !loadValueIsConfined(node)) {
          escapes = true;
          return;
        }
      }
    }
    // Task BL-105: an import is a load too under TypeScript's `module:
    // commonjs` ({@link isValueImport}), a self-import included -- no census
    // follows an import's own flows, so it is confined or it escapes.
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      const names = valueImportNames(node);
      if (names.length > 0) {
        const specifier = importSpecifierOf(node);
        const mayYield =
          specifier === undefined ||
          reach === undefined ||
          reach.mayReachBack(specifier);
        if (
          mayYield &&
          !names.every((name) => bindingNameIsConfined(name, new Set()))
        ) {
          escapes = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (byReach === undefined) {
    byReach = new Map();
    loadEscapesBySourceFile.set(sourceFile, byReach);
  }
  byReach.set(reach, escapes);
  return escapes;
}

/**
 * Whether a whole-module value is a fresh object no load can return: a
 * literal, a function or class expression, a primitive, or a name bound
 * once to a function or class declaration or to such a value.
 */
function isFreshWholeModuleValue(value: ts.Expression): boolean {
  const unwrapped = unwrapValue(value);
  if (
    ts.isObjectLiteralExpression(unwrapped) ||
    ts.isArrayLiteralExpression(unwrapped) ||
    ts.isFunctionExpression(unwrapped) ||
    ts.isArrowFunction(unwrapped) ||
    ts.isClassExpression(unwrapped) ||
    isPrimitiveValue(unwrapped)
  ) {
    return true;
  }
  if (!ts.isIdentifier(unwrapped)) {
    return false;
  }
  const declaration = lexicalDeclarationOf(unwrapped, unwrapped.text);
  if (
    declaration === undefined ||
    isNameAssignedWithin(unwrapped.getSourceFile(), unwrapped.text)
  ) {
    return false;
  }
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isClassDeclaration(declaration)
  ) {
    return true;
  }
  return (
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    declaration.initializer !== undefined &&
    !ts.isIdentifier(unwrapValue(declaration.initializer)) &&
    isFreshWholeModuleValue(declaration.initializer)
  );
}

/**
 * The questions {@link loadResultEscapes} asks of the module graph for
 * this file (task BL-074): every literal specifier it loads, and which
 * module objects its whole-module writes install.
 */
export function loadReachQuery(index: SourceIndex): LoadReachQuery {
  const sourceFile = index.sourceFile;
  const specifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const specifier = plainLoadSpecifier(node);
      if (specifier !== undefined) {
        specifiers.add(specifier);
      }
    }
    // Task BL-105: an import is a load {@link loadResultEscapes} asks about.
    if (
      (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) &&
      valueImportNames(node).length > 0
    ) {
      const specifier = importSpecifierOf(node);
      if (specifier !== undefined) {
        specifiers.add(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const forwardSpecifiers = new Set<string>();
  let opaqueFinalObject = false;
  for (const site of competingWriteSites(sourceFile).wholeModule) {
    const value = ts.isExportAssignment(site.node)
      ? site.node.expression
      : (site.node as ts.BinaryExpression).right;
    if (isFreshWholeModuleValue(value)) {
      continue;
    }
    // `module.exports = require("./safe")`, or a member of a load
    // (`require("./lib").sub`): the object is that module's, or one it
    // reaches -- a load of it, or of anything that reaches it, returns it.
    let root = unwrapValue(value);
    while (
      ts.isPropertyAccessExpression(root) ||
      ts.isElementAccessExpression(root)
    ) {
      root = unwrapParentheses(root.expression);
    }
    const specifier = ts.isCallExpression(root)
      ? plainLoadSpecifier(root)
      : undefined;
    if (specifier === undefined) {
      opaqueFinalObject = true;
    } else {
      forwardSpecifiers.add(specifier);
    }
  }
  return {
    specifiers: [...specifiers],
    forwardSpecifiers: [...forwardSpecifiers],
    opaqueFinalObject,
  };
}

export { isLoadCall, isBoundLoader, loadResultEscapes };
