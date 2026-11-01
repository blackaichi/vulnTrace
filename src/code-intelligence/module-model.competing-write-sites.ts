/**
 * The competing-write window's sites (task BL-064, RWF-094): every write of
 * an export a file spells, with the properties a written value carries, and
 * whether a module function escapes.
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
import { isNameAssignedWithin } from "./named-bindings.js";
import { exactCommonJsExportPropertyName } from "./source-index.js";
import {
  isStaticClassElement,
  isPrimitiveValue,
  isNonReferenceName,
  isAssignmentOperatorToken,
} from "./module-model.syntax.js";
import {
  moduleScopeBindings,
  topLevelCallableCandidates,
} from "./module-model.module-scope.js";

/* ------------------------------------------------------------------ *
 * BL-064 (RWF-094): the competing-write window                         *
 * ------------------------------------------------------------------ */

/**
 * The key a competing export write is filed under: an exported property
 * name, or {@link WHOLE_MODULE_EXPORT} for a write that replaces the
 * whole exported value (`module.exports = X`, `export = X`).
 */
const WHOLE_MODULE_EXPORT: unique symbol = Symbol("whole-module-export");
type CompetingWriteKey = string | typeof WHOLE_MODULE_EXPORT;

/** One write of an export this file spells, at the position it runs from. */
interface CompetingWriteSite {
  readonly key: CompetingWriteKey;
  /** The assignment (or `export =`) node itself. */
  readonly node: ts.Node;
  /** The index in `sourceFile.statements` of the top-level statement holding it. */
  readonly statementIndex: number;
  /**
   * Whether it runs later than its statement, or never: inside a function
   * body or an instance field initializer.
   */
  readonly deferred: boolean;
  /**
   * Whether the value written is provably a primitive (`void 0`, a
   * literal). An observer of a primitive reaches no code through it, so
   * such a write opens no window (TypeScript's `exports.x = void 0;`
   * preamble).
   */
  readonly primitive: boolean;
  /**
   * For a whole-module write, the property names the new export object
   * can hold: the keys an object literal spells, or `"all"` for any other
   * value (a function's statics, a prototype, a spread, a computed key).
   */
  readonly carries: ReadonlySet<string> | "all";
}

/** {@link competingWriteSites}' answer, indexed for the window query. */
interface CompetingWriteSites {
  /** Every site, in source order. */
  readonly all: readonly CompetingWriteSite[];
  /** The sites of each exported property name. */
  readonly byName: ReadonlyMap<string, readonly CompetingWriteSite[]>;
  /** The whole-module sites. */
  readonly wholeModule: readonly CompetingWriteSite[];
}

const competingWriteSitesBySourceFile = new WeakMap<
  ts.SourceFile,
  CompetingWriteSites
>();

/**
 * Every export write this file spells, wherever it is (BL-064): the
 * property forms {@link commonJsExportPropertyName} reads and the
 * whole-module forms. A form neither reads (an alias, `Object.assign`,
 * `Object.defineProperty`) is E-1's un-enumerable writer, not this
 * relation's.
 */
function competingWriteSites(sourceFile: ts.SourceFile): CompetingWriteSites {
  const cached = competingWriteSitesBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  const sites: CompetingWriteSite[] = [];
  sourceFile.statements.forEach((statement, statementIndex) => {
    function visit(node: ts.Node, deferred: boolean): void {
      let key: CompetingWriteKey | undefined;
      let value: ts.Expression | undefined;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const left = unwrapParentheses(node.left);
        key =
          commonJsExportPropertyName(left) ??
          (isModuleExportsAssignmentTarget(left)
            ? WHOLE_MODULE_EXPORT
            : undefined);
        value = node.right;
      } else if (ts.isExportAssignment(node) && node.isExportEquals) {
        key = WHOLE_MODULE_EXPORT;
        value = node.expression;
      }
      if (key !== undefined && value !== undefined) {
        sites.push({
          key,
          node,
          statementIndex,
          deferred,
          primitive: isPrimitiveValue(unwrapValue(value)),
          carries:
            key === WHOLE_MODULE_EXPORT
              ? propertiesCarriedBy(unwrapValue(value))
              : "all",
        });
      }
      const nested =
        deferred ||
        ts.isFunctionLike(node) ||
        (ts.isPropertyDeclaration(node) && !isStaticClassElement(node));
      ts.forEachChild(node, (child) => visit(child, nested));
    }
    visit(statement, false);
  });
  const byName = new Map<string, CompetingWriteSite[]>();
  const wholeModule: CompetingWriteSite[] = [];
  for (const site of sites) {
    if (site.key === WHOLE_MODULE_EXPORT) {
      wholeModule.push(site);
    } else {
      const known = byName.get(site.key);
      if (known === undefined) {
        byName.set(site.key, [site]);
      } else {
        known.push(site);
      }
    }
  }
  const indexed = { all: sites, byName, wholeModule };
  competingWriteSitesBySourceFile.set(sourceFile, indexed);
  return indexed;
}

/**
 * The property names every object carries from `Object.prototype`, and
 * every function from its own intrinsics and `Function.prototype`. None
 * holds package code; they are listed so that a write of one of these
 * names is never treated as uncontested.
 */
const OBJECT_INTRINSIC_NAMES: readonly string[] = [
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
];
const FUNCTION_INTRINSIC_NAMES: readonly string[] = [
  ...OBJECT_INTRINSIC_NAMES,
  "apply",
  "arguments",
  "bind",
  "call",
  "caller",
  "length",
  "name",
  "prototype",
];

/**
 * The property names a whole-module export value can carry when it is
 * written (BL-064), so that it competes only with the later writes of
 * those names:
 *
 * - an object literal: its keys, unless it has a spread, a computed key
 *   or a `__proto__` (each can supply any name);
 * - a function or arrow expression: a fresh object, so only its
 *   intrinsics;
 * - an identifier naming exactly one module-scope function declaration,
 *   or `const` function or arrow, that nothing in the file reassigns and
 *   that never escapes ({@link moduleFunctionEscapes}): its intrinsics,
 *   every `P` the file writes as `name.P = ...` anywhere, and every `P` it
 *   writes as `this.P = ...` anywhere (a method called on it runs with
 *   `this` bound to it); a computed write, or any other use of `this`,
 *   carries every name;
 * - anything else: `"all"`.
 *
 * A name a writer this file does not spell can set (an alias, a
 * parameter, `Object.assign`, another module) is the un-enumerable writer
 * of ADR 0009 § 1 clause 1, E-1's, exactly as it is for every attribution
 * today.
 */
function propertiesCarriedBy(
  value: ts.Expression,
): ReadonlySet<string> | "all" {
  const node = unwrapParentheses(value);
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return new Set(FUNCTION_INTRINSIC_NAMES);
  }
  if (ts.isIdentifier(node)) {
    return propertiesCarriedByModuleFunction(node);
  }
  if (!ts.isObjectLiteralExpression(node)) {
    return "all";
  }
  const names = new Set<string>(OBJECT_INTRINSIC_NAMES);
  for (const property of node.properties) {
    const name = property.name;
    if (
      name === undefined ||
      ts.isComputedPropertyName(name) ||
      ts.isPrivateIdentifier(name)
    ) {
      return "all";
    }
    const text = ts.isIdentifier(name)
      ? name.text
      : exactCommonJsExportPropertyName(name);
    if (
      text === undefined ||
      text === "__proto__" ||
      ts.isGetAccessorDeclaration(property) ||
      ts.isSetAccessorDeclaration(property)
    ) {
      // An accessor makes a later write of its name run code, or throw.
      return "all";
    }
    names.add(text);
  }
  return names;
}

/**
 * Whether `name` is exactly one module-scope function declaration, or
 * `const` bound to a function or arrow expression, that nothing in the
 * file reassigns: a binding that always holds that one function object.
 */
function isUnreassignedModuleFunction(
  sourceFile: ts.SourceFile,
  name: string,
): boolean {
  const binding = moduleScopeBindings(sourceFile).get(name);
  return (
    binding !== undefined &&
    binding.count === 1 &&
    (binding.kind === "function" || binding.kind === "const") &&
    topLevelCallableCandidates(sourceFile).has(name) &&
    !isNameAssignedWithin(sourceFile, name) &&
    !moduleFunctionEscapes(sourceFile, name)
  );
}

const escapingModuleFunctionsBySourceFile = new WeakMap<
  ts.SourceFile,
  Map<string, boolean>
>();

/**
 * Whether any reference spelled `name` in the file can hand the function
 * object to code that may change it (`Object.freeze(fn)`,
 * `Object.defineProperty(fn, ...)`, an alias, an argument, a return):
 * every reference must be a callee, a member access's base, a `typeof`
 * operand, a declaration's own name, or the value of an assignment chain
 * whose every link writes an export target, `exports`, or a member of
 * `name` itself. Counted by spelling over the whole file, so a shadowing
 * binding only makes it more likely to answer `true`.
 */
function moduleFunctionEscapes(
  sourceFile: ts.SourceFile,
  name: string,
): boolean {
  let byName = escapingModuleFunctionsBySourceFile.get(sourceFile);
  if (byName === undefined) {
    byName = new Map();
    escapingModuleFunctionsBySourceFile.set(sourceFile, byName);
  }
  const cached = byName.get(name);
  if (cached !== undefined) {
    return cached;
  }
  let escapes = false;
  function visit(node: ts.Node): void {
    if (escapes) {
      return;
    }
    if (ts.isIdentifier(node) && node.text === name) {
      if (!isContainedModuleFunctionReference(node, name)) {
        escapes = true;
      }
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  byName.set(name, escapes);
  return escapes;
}

function isContainedModuleFunctionReference(
  node: ts.Identifier,
  name: string,
): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined || isNonReferenceName(node, parent)) {
    return true;
  }
  if (
    ((ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isVariableDeclaration(parent)) &&
      parent.name === node) ||
    (ts.isCallExpression(parent) && parent.expression === node) ||
    ((ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
      parent.expression === node) ||
    ts.isTypeOfExpression(parent)
  ) {
    return true;
  }
  // The value of an assignment chain: `exports = module.exports = fn;`,
  // `fn.self = fn;`.
  let value: ts.Node = node;
  let link = parent;
  let sawLink = false;
  while (
    ts.isBinaryExpression(link) &&
    link.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    link.right === value
  ) {
    const target = unwrapParentheses(link.left);
    const ownMember =
      (ts.isPropertyAccessExpression(target) ||
        ts.isElementAccessExpression(target)) &&
      ts.isIdentifier(target.expression) &&
      target.expression.text === name;
    // A property export (`exports.helper = fn`) is an alias of the
    // function under another name, through which it can be written
    // (`exports.helper.run = d`), so it is not one (BL-064's audit,
    // finding 7).
    if (!(
      isModuleExportsAssignmentTarget(target) ||
      (ts.isIdentifier(target) && target.text === "exports") ||
      ownMember
    )) {
      return false;
    }
    sawLink = true;
    value = link;
    link = link.parent;
  }
  return sawLink && ts.isExpressionStatement(link);
}

/**
 * What one `this` does to the object it is bound to: `undefined` for a
 * property read (`this.p`, `this[k]`, a method call `this.m()`), the name
 * for a write of an exact key (`this.p = v`, `this["p"] += v`), and
 * `"other"` for anything else (a computed write, an argument, an alias).
 */
function thisMemberWrite(node: ts.Node): string | "other" | undefined {
  const access = node.parent as ts.Node | undefined;
  if (
    access === undefined ||
    !(
      (ts.isPropertyAccessExpression(access) ||
        ts.isElementAccessExpression(access)) &&
      access.expression === node
    )
  ) {
    return "other";
  }
  const assignment = access.parent as ts.Node | undefined;
  const isWrite =
    assignment !== undefined &&
    ((ts.isBinaryExpression(assignment) &&
      isAssignmentOperatorToken(assignment.operatorToken.kind) &&
      assignment.left === access) ||
      ((ts.isPrefixUnaryExpression(assignment) ||
        ts.isPostfixUnaryExpression(assignment)) &&
        assignment.operand === access) ||
      ts.isDeleteExpression(assignment));
  if (!isWrite) {
    return undefined;
  }
  const name = ts.isPropertyAccessExpression(access)
    ? access.name.text
    : exactCommonJsExportPropertyName(access.argumentExpression);
  return name ?? "other";
}

/** {@link propertiesCarriedBy} for an identifier value. */
function propertiesCarriedByModuleFunction(
  identifier: ts.Identifier,
): ReadonlySet<string> | "all" {
  const sourceFile = identifier.getSourceFile();
  const name = identifier.text;
  if (!isUnreassignedModuleFunction(sourceFile, name)) {
    return "all";
  }
  const names = new Set<string>(FUNCTION_INTRINSIC_NAMES);
  let every = false;
  function visit(node: ts.Node): void {
    if (every) {
      return;
    }
    // A method called on the function -- through its name or through any
    // alias of the export -- runs with `this` bound to it, so every
    // `this.P = ...` in the file may set `P` on it, and any other use of
    // `this` (an argument, an alias, a computed write) may set anything.
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      const written = thisMemberWrite(node);
      if (written === "other") {
        every = true;
      } else if (written !== undefined) {
        names.add(written);
      }
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperatorToken(node.operatorToken.kind)
    ) {
      const target = unwrapParentheses(node.left);
      if (
        (ts.isPropertyAccessExpression(target) ||
          ts.isElementAccessExpression(target)) &&
        ts.isIdentifier(unwrapParentheses(target.expression)) &&
        (unwrapParentheses(target.expression) as ts.Identifier).text === name
      ) {
        const written = ts.isPropertyAccessExpression(target)
          ? target.name.text
          : exactCommonJsExportPropertyName(target.argumentExpression);
        if (written === undefined) {
          every = true;
          return;
        }
        names.add(written);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return every ? "all" : names;
}

export {
  WHOLE_MODULE_EXPORT,
  competingWriteSites,
  FUNCTION_INTRINSIC_NAMES,
  isUnreassignedModuleFunction,
};
export type { CompetingWriteKey };
