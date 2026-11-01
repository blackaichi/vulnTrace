/**
 * Export-object methods: foreign roots, a file's own unreassigned callables,
 * method calls through its export objects, a `module` alias's inert uses,
 * and where a value flows.
 *
 * Split out of `module-model.ts` by concern, as a pure move (task BL-121):
 * the declarations below are those of that file, unchanged and in its order.
 * `module-model.ts` re-exports the public ones.
 */
import ts from "typescript";
import { unwrapParentheses, unwrapValue } from "./commonjs-reexports.js";
import {
  isNameAssignedWithin,
  lexicalDeclarationOf,
} from "./named-bindings.js";
import {
  isNonReferenceName,
  isAmbientReference,
  isDeclarationName,
  identifiersSpelled,
  isInertUse,
  isPlainAssignmentTarget,
  skipOuterParentheses,
  isRequireResult,
  isWriteTargetPosition,
} from "./module-model.syntax.js";
import { competingWriteSites } from "./module-model.competing-write-sites.js";
import { exportPropertyWriteValues } from "./module-model.competing-writes.js";
import { finalObjectAliasUses } from "./module-model.final-object.js";
import { mayLoadThisFile } from "./module-model.alias-summaries.js";

/**
 * Whether `expression`'s root names something outside this file's own
 * functions: a global (no declaration in scope; not the CommonJS ambient
 * names), an import, a `require(…)` result, or a binding initialized to
 * one (directly, through a member read, or through an interop helper's
 * call on it, TypeScript's `__importDefault(require("x"))`).
 */
function isForeignRoot(expression: ts.Expression): boolean {
  let root = unwrapParentheses(expression);
  while (
    ts.isPropertyAccessExpression(root) ||
    ts.isElementAccessExpression(root)
  ) {
    root = unwrapParentheses(root.expression);
  }
  if (isRequireResult(root)) {
    return true;
  }
  if (!ts.isIdentifier(root)) {
    return false;
  }
  if (
    ["exports", "module", "require", "arguments", "eval"].includes(root.text)
  ) {
    return false;
  }
  const declaration = lexicalDeclarationOf(root, root.text);
  if (declaration === undefined) {
    return true;
  }
  if (
    ts.isImportSpecifier(declaration) ||
    ts.isImportClause(declaration) ||
    ts.isNamespaceImport(declaration) ||
    ts.isImportEqualsDeclaration(declaration)
  ) {
    return true;
  }
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined ||
    isNameAssignedWithin(declaration.getSourceFile(), root.text)
  ) {
    return false;
  }
  const init = unwrapParentheses(declaration.initializer);
  return (
    isRequireResult(init) ||
    isRequireResultMember(init) ||
    (ts.isCallExpression(init) &&
      init.arguments.length === 1 &&
      isRequireResult(init.arguments[0]!))
  );
}

/** The function `callee` denotes when it is one of this file's own, unreassigned. */
function localCallable(
  sourceFile: ts.SourceFile,
  callee: ts.Expression,
): ts.FunctionLikeDeclaration | undefined {
  if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) {
    return callee;
  }
  if (
    !ts.isIdentifier(callee) ||
    isNameAssignedWithin(sourceFile, callee.text)
  ) {
    return undefined;
  }
  const declaration = lexicalDeclarationOf(callee, callee.text);
  if (declaration !== undefined && ts.isFunctionDeclaration(declaration)) {
    return declaration.body === undefined ? undefined : declaration;
  }
  if (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined
  ) {
    const init = unwrapParentheses(declaration.initializer);
    if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) {
      return init;
    }
  }
  return undefined;
}

/** Every value a function can return: its `return` expressions (not a nested function's), or a concise arrow's body. */
function returnedValues(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  if (fn.body === undefined) {
    return [];
  }
  if (!ts.isBlock(fn.body)) {
    return [fn.body];
  }
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      found.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return found;
}

/**
 * Whether `access` (`module.exports.m(…)`) calls a method every value of
 * which this file defines as its own function: no property write of `m`
 * ({@link exportPropertyWriteValues}) and, in every whole-module object
 * literal that defines `m`, a method or a function value. Such a method's
 * `this` writes and hand-offs are censused like any function's, so the call
 * hands the exports object to no code the census does not see.
 */
function isOwnLiteralMethodCall(access: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(access)) {
    return false;
  }
  const name = access.name.text;
  const sourceFile = access.getSourceFile();
  if ((exportPropertyWriteValues(sourceFile).get(name) ?? []).length > 0) {
    return false;
  }
  let defined = false;
  for (const site of competingWriteSites(sourceFile).wholeModule) {
    const value = unwrapParentheses(
      unwrapValue(
        ts.isExportAssignment(site.node)
          ? site.node.expression
          : (site.node as ts.BinaryExpression).right,
      ),
    );
    if (!ts.isObjectLiteralExpression(value)) {
      return false;
    }
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) {
        return false;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        if (property.name.text !== name) continue;
        defined = true;
        const declaration = lexicalDeclarationOf(property.name, name);
        if (
          declaration === undefined ||
          !ts.isFunctionDeclaration(declaration) ||
          isNameAssignedWithin(sourceFile, name)
        ) {
          return false;
        }
        continue;
      }
      if (
        property.name === undefined ||
        !(
          ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ) ||
        property.name.text !== name
      ) {
        continue;
      }
      defined = true;
      const own =
        ts.isMethodDeclaration(property) ||
        (ts.isPropertyAssignment(property) &&
          (ts.isFunctionExpression(unwrapParentheses(property.initializer)) ||
            ts.isArrowFunction(unwrapParentheses(property.initializer))));
      if (!own) {
        return false;
      }
    }
  }
  return defined;
}

/**
 * The local a value flows into, when `node`'s value can only end up there:
 * through parentheses, the value operands of `&&`, `||` and `??`, a
 * conditional's branches and a comma's right, into a variable's initializer
 * (`var a = … && exports`) or a plain assignment to an identifier
 * (`a = exports`). `undefined` for any other destination.
 */
function valueSink(node: ts.Node): ts.Identifier | undefined {
  let current = skipOuterParentheses(node);
  for (;;) {
    const parent = current.parent as ts.Node | undefined;
    if (parent === undefined) {
      return undefined;
    }
    if (
      (ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          (parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
            parent.right === current))) ||
      (ts.isConditionalExpression(parent) && parent.condition !== current)
    ) {
      current = skipOuterParentheses(parent);
      continue;
    }
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === current &&
      ts.isIdentifier(parent.name)
    ) {
      return parent.name;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === current &&
      ts.isIdentifier(unwrapParentheses(parent.left))
    ) {
      const target = unwrapParentheses(parent.left) as ts.Identifier;
      return isAmbientReference(target, "exports") ||
        isAmbientReference(target, "module")
        ? undefined
        : target;
    }
    return undefined;
  }
}

/**
 * Whether a local holding `module` (lodash's `var freeModule = … && module`)
 * reaches the export objects through nothing the census does not see: every
 * use of it is inert, a read or a call of a member other than `exports`
 * (`freeModule.require(…)`), or an inert use of its `exports` member
 * (`freeModule.exports === freeExports`). A write through it, its `exports`
 * read for any other use, and the local handed on are not.
 */
function moduleAliasIsInert(
  sourceFile: ts.SourceFile,
  binding: ts.Identifier,
): boolean {
  const declaration = lexicalDeclarationOf(binding, binding.text);
  if (declaration === undefined) {
    return false;
  }
  let inert = true;
  const visit = (node: ts.Node): void => {
    if (!inert) {
      return;
    }
    if (
      ts.isIdentifier(node) &&
      node.text === binding.text &&
      !isNonReferenceName(node, node.parent) &&
      !isDeclarationName(node, node.parent) &&
      lexicalDeclarationOf(node, node.text) === declaration
    ) {
      const outer = skipOuterParentheses(node);
      const parent = outer.parent as ts.Node;
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === outer
      ) {
        const access = skipOuterParentheses(parent);
        if (isWriteTargetPosition(access)) {
          inert = false;
        } else if (isInertUse(access)) {
          // A member only tested (`freeModule.require && …`).
        } else if (parent.name.text === "exports") {
          inert = false;
        } else if (parent.name.text === "require") {
          // `freeModule.require("util")`: a load of something that cannot be
          // this file.
          const call = access.parent as ts.Node;
          inert =
            ts.isCallExpression(call) &&
            call.expression === access &&
            !mayLoadThisFile(call);
        } else {
          inert = INERT_MODULE_MEMBERS.has(parent.name.text);
        }
        return;
      }
      if (isInertUse(outer) || isPlainAssignmentTarget(outer)) {
        return;
      }
      inert = false;
      return;
    }
  };
  // Only identifiers spelled like the binding are visited (E-1's audit, finding 5).
  for (const reference of identifiersSpelled(sourceFile, binding.text)) {
    visit(reference);
  }
  return inert;
}

/**
 * Whether the method `access` calls (`exports.m(…)`) is one this file
 * spells no value of at all: no property write of `m` and no whole-module
 * write whose value can carry `m`. Another module put it on the object.
 */
function isMethodWrittenElsewhere(access: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(access)) {
    return false;
  }
  const name = access.name.text;
  const sourceFile = access.getSourceFile();
  // An `Object.prototype` method is a builtin, not another module's
  // (`exports.__defineGetter__(…)` writes the object; E-1's independent
  // audit, finding 4).
  if (
    name in Object.prototype ||
    (exportPropertyWriteValues(sourceFile).get(name) ?? []).length > 0
  ) {
    return false;
  }
  return competingWriteSites(sourceFile).wholeModule.every((site) => {
    if (site.carries !== "all") {
      return !site.carries.has(name);
    }
    // A function or class value carries what is written onto it (the alias
    // census reads every such write of this file) and a class's own static
    // members; anything else (a call's result, another module's object) may
    // carry any name.
    const value = unwrapParentheses(
      unwrapValue(
        ts.isExportAssignment(site.node)
          ? site.node.expression
          : (site.node as ts.BinaryExpression).right,
      ),
    );
    // Another module's object (`module.exports = require("./debug")`)
    // carries that module's methods.
    if (isRequireResult(value) || isRequireResultMember(value)) {
      return true;
    }
    const binding = ts.isIdentifier(value)
      ? value
      : (ts.isFunctionExpression(value) || ts.isClassExpression(value)) &&
          value.name !== undefined
        ? value.name
        : undefined;
    const declared =
      binding === undefined
        ? ts.isFunctionExpression(value) || ts.isClassExpression(value)
          ? value
          : undefined
        : lexicalDeclarationOf(binding, binding.text);
    if (
      declared === undefined ||
      !(
        ts.isFunctionDeclaration(declared) ||
        ts.isFunctionExpression(declared) ||
        ts.isClassDeclaration(declared) ||
        ts.isClassExpression(declared)
      ) ||
      (ts.isClassLike(declared) &&
        declared.members.some(
          (member) =>
            member.name !== undefined &&
            ts.isIdentifier(member.name) &&
            member.name.text === name,
        ))
    ) {
      return false;
    }
    if (binding === undefined) {
      return true;
    }
    const uses = finalObjectAliasUses(sourceFile, binding);
    return uses !== "all" && !uses.names.has(name);
  });
}

/** Whether a `with` body spells any name or `this` through which an export object is reached. */
function withBodyReachesExportNames(body: ts.Node): boolean {
  let reaches = false;
  const visit = (node: ts.Node): void => {
    if (reaches) {
      return;
    }
    if (
      node.kind === ts.SyntaxKind.ThisKeyword ||
      (ts.isIdentifier(node) &&
        (node.text === "exports" ||
          node.text === "module" ||
          node.text === "require" ||
          node.text === "arguments" ||
          node.text === "eval"))
    ) {
      reaches = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return reaches;
}

/** `require(…).x`, `require(…)["x"]`: another module's export. */
function isRequireResultMember(expression: ts.Expression): boolean {
  const value = unwrapParentheses(expression);
  return (
    (ts.isPropertyAccessExpression(value) ||
      ts.isElementAccessExpression(value)) &&
    isRequireResult(value.expression)
  );
}

/**
 * The members of a `module` object that reach no module object: its own
 * strings and flags, and `require` (each call of it is a loader call the
 * census follows).
 */
const INERT_MODULE_MEMBERS: ReadonlySet<string> = new Set([
  "id",
  "filename",
  "path",
  "loaded",
  "paths",
  "isPreloading",
  "require",
]);

export {
  isForeignRoot,
  localCallable,
  returnedValues,
  isOwnLiteralMethodCall,
  valueSink,
  moduleAliasIsInert,
  isMethodWrittenElsewhere,
  withBodyReachesExportNames,
  isRequireResultMember,
  INERT_MODULE_MEMBERS,
};
