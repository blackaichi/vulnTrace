import ts from "typescript";
import {
  assignedNames,
  destructuringTargets,
  escapingValuesOf,
  isAmbientRoot,
  skipOuterExpressions,
  storesValue,
} from "./escape-row.js";
import { resolveNamedBinding } from "./named-bindings.js";

/**
 * ADR 0008 § 2's PROTOCOL-MEMBER ROW and Amendment A-0 part B (task A-4):
 * which definitions the runtime may invoke implicitly, with no call
 * expression anywhere in the program.
 *
 * A protocol member is invoked by syntax -- a coercion (`"" + o`, a
 * template, `==`, a computed key), `await` and an async `return` (`then`),
 * `for…of`, spread, destructuring and `yield*` (`Symbol.iterator`, then
 * the iterator's `next` / `return` / `throw`), `for await…of`
 * (`Symbol.asyncIterator`), `instanceof` (`Symbol.hasInstance`), `using`
 * (`Symbol.dispose`) -- or by a builtin (`JSON.stringify` and `toJSON`).
 * The use site cannot know what it invokes, so ADR 0008 accounts the
 * invocation where the member is DEFINED: a possible edge from the owner
 * that evaluates the definition. If that owner never runs, the member
 * never exists.
 *
 * WHAT IS A PROTOCOL KEY. A property key is a string or a symbol, so a
 * name is compared as the key it denotes -- that is the language's own
 * identity for a property, not a binding matched by spelling. A key is
 * treated as a protocol key unless it is PROVEN not to be one
 * ({@link mayBeProtocolKey}): a computed key the analyzer cannot read may
 * be `"toString"` at run time, and calling it "not a protocol key" would
 * collapse a multi-valued key to one value (defect class C).
 */

/**
 * ADR 0008 § 2's string-named protocol members, and the iterator
 * protocol's methods, which every consumer of an iterator invokes on the
 * object its `[Symbol.iterator]()` returns: `next`, `return` on early exit
 * (`break`, a throw), `throw` through `yield*` (RWF-068; the project
 * owner's decision of 2026-10-04, recorded in ADR 0008).
 */
export const PROTOCOL_NAMES: ReadonlySet<string> = new Set([
  "toString",
  "valueOf",
  "toJSON",
  "then",
  "next",
  "return",
  "throw",
]);

/** ADR 0008 § 2's well-known symbols, by their `Symbol` member name. */
export const PROTOCOL_SYMBOLS: ReadonlySet<string> = new Set([
  "iterator",
  "asyncIterator",
  "hasInstance",
  "toPrimitive",
  "dispose",
  "asyncDispose",
]);

/** How many `const k = …` hops {@link protocolKeyOf} follows. */
const MAX_KEY_ALIAS_HOPS = 4;

/**
 * What a property key is, as far as the protocol-member row cares:
 *
 * - `protocol`: it IS a protocol member's key (a literal name or string in
 *   {@link PROTOCOL_NAMES}, or `Symbol.<name>` through the ambient
 *   `Symbol` for a name in {@link PROTOCOL_SYMBOLS});
 * - `other`: it is proven to be some other key -- a literal name or string
 *   not in the list, a number, a private name (`#x`, which no property
 *   lookup reaches), another well-known symbol, or a fresh symbol made by
 *   `Symbol(…)` through the ambient `Symbol`; through a stable `const`,
 *   too;
 * - `unread`: anything else. It may be a protocol key at run time.
 *   `Symbol.for(…)` is one: a REGISTERED symbol is never a well-known one,
 *   but Node registers its own hooks there --
 *   `Symbol.for("nodejs.util.inspect.custom")` IS `util.inspect.custom`
 *   (task A-4's independent audit).
 *
 * "Some other key" means: not a member of ADR 0008 § 2's list as amended.
 * The other well-known symbols are read as values (`toStringTag`,
 * `isConcatSpreadable`, `unscopables`; an accessor under one is still its
 * own owner), or invoked by a builtin method called on a receiver
 * (`match`, `matchAll`, `replace`, `search`, `split`) -- a call that always
 * carries an unknown edge, since no receiver-bound builtin earns a no-edge
 * proof (`builtin-callables.ts`). `Symbol.species` is NOT only that:
 * `await` reaches a promise's `constructor[Symbol.species]` with no call
 * in the program. That gap, and the `constructor` key itself, are outside
 * the list and recorded as RWF-070, for the project owner to decide.
 */
export type ProtocolKey = "protocol" | "other" | "unread";

export function protocolKeyOf(
  key: ts.PropertyName | ts.Expression,
  hops = 0,
): ProtocolKey {
  if (ts.isPrivateIdentifier(key)) {
    return "other";
  }
  if (ts.isComputedPropertyName(key)) {
    return protocolKeyOf(key.expression, hops);
  }
  if (ts.isIdentifier(key) && isPropertyNamePosition(key)) {
    return PROTOCOL_NAMES.has(key.text) ? "protocol" : "other";
  }
  const expr = skipOuterExpressions(key as ts.Expression);
  if (ts.isStringLiteralLike(expr)) {
    return PROTOCOL_NAMES.has(expr.text) ? "protocol" : "other";
  }
  if (ts.isNumericLiteral(expr) || ts.isBigIntLiteral(expr)) {
    return "other";
  }
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Symbol" &&
    isAmbientRoot(expr.expression)
  ) {
    return PROTOCOL_SYMBOLS.has(expr.name.text) ? "protocol" : "other";
  }
  if (ts.isCallExpression(expr) && isAmbientSymbolCall(expr.expression)) {
    return "other";
  }
  if (ts.isIdentifier(expr) && hops < MAX_KEY_ALIAS_HOPS) {
    const binding = resolveNamedBinding(expr);
    return binding.kind === "value"
      ? protocolKeyOf(binding.value, hops + 1)
      : "unread";
  }
  return "unread";
}

/** Whether a key may denote a protocol member at run time ({@link protocolKeyOf} is not `other`). */
export function mayBeProtocolKey(
  key: ts.PropertyName | ts.Expression,
): boolean {
  return protocolKeyOf(key) !== "other";
}

/** `Symbol` itself, through the ambient `Symbol`: a fresh symbol, never a well-known or registered one. */
function isAmbientSymbolCall(raw: ts.Expression): boolean {
  const callee = skipOuterExpressions(raw);
  return (
    ts.isIdentifier(callee) && callee.text === "Symbol" && isAmbientRoot(callee)
  );
}

/**
 * Whether an identifier is a property NAME (`toString` in
 * `{ toString() {} }`, `o.toString`), not a reference to a binding.
 */
function isPropertyNamePosition(id: ts.Identifier): boolean {
  const parent = id.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === id) ||
    ((ts.isMethodDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
      parent.name === id)
  );
}

/**
 * A definition the protocol-member row accounts for (task A-4):
 *
 * - `method`: a method (class or object literal) under a key that may be
 *   a protocol key: the method itself may be invoked implicitly;
 * - `value`: a property (object literal, shorthand, class field) whose
 *   value may carry the program's code, under such a key;
 * - `store`: an assignment storing such a value into a member under such
 *   a key (`o.toString = f`, `C.prototype.then = f`, `o[k] = f`);
 * - `pattern_store`: a destructuring assignment or `for…of` whose targets
 *   include such a member, a re-export (`export { x as then } from "m"`),
 *   a destructuring export declaration, or an exported protocol-named
 *   binding the file writes again: the value is read from elsewhere, or
 *   may be any of several, and is not attributed.
 *
 * An ES module's EXPORTS are the properties of its namespace object, which
 * `import * as ns` and `import()` hand over: `${ns}` calls an exported
 * `toString`, `await ns` an exported `then` (task A-4's independent
 * audit). An exported function, variable or export specifier under a
 * protocol name is therefore a `method` or `value` definition too.
 *
 * `key` is `protocol` when the definition's key is a protocol key (for a
 * pattern, when one of its member targets' is), `unread` when it only may
 * be.
 */
export type ProtocolDefinition =
  | {
      readonly form: "method";
      readonly node: ts.MethodDeclaration | ts.FunctionDeclaration;
      readonly key: ProtocolKey;
    }
  | {
      readonly form: "value";
      readonly node:
        | ts.PropertyAssignment
        | ts.ShorthandPropertyAssignment
        | ts.PropertyDeclaration
        | ts.VariableDeclaration
        | ts.ExportSpecifier;
      readonly value: ts.Expression;
      readonly key: ProtocolKey;
    }
  | {
      readonly form: "store";
      readonly node: ts.BinaryExpression;
      readonly value: ts.Expression;
      readonly key: ProtocolKey;
    }
  | {
      readonly form: "pattern_store";
      readonly node:
        | ts.BinaryExpression
        | ts.ForOfStatement
        | ts.ExportSpecifier
        | ts.FunctionDeclaration
        | ts.VariableDeclaration;
      readonly key: ProtocolKey;
    };

/**
 * The protocol definition `node` is, if any. Syntax and lexical scopes
 * only; which graph node a value denotes is the call graph's.
 */
export function protocolDefinitionOf(
  node: ts.Node,
): ProtocolDefinition | undefined {
  if (ts.isMethodDeclaration(node)) {
    if (
      node.body === undefined ||
      !(
        ts.isClassLike(node.parent) || ts.isObjectLiteralExpression(node.parent)
      )
    ) {
      return undefined;
    }
    const key = protocolKeyOf(node.name);
    return key === "other" ? undefined : { form: "method", node, key };
  }
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
    if (
      !ts.isObjectLiteralExpression(node.parent) ||
      isAssignmentPattern(node.parent)
    ) {
      return undefined;
    }
    const value = ts.isPropertyAssignment(node) ? node.initializer : node.name;
    return valueDefinition(node, node.name, value);
  }
  const exported = moduleExportDefinitionOf(node);
  if (exported !== "none") {
    return exported;
  }
  if (ts.isPropertyDeclaration(node)) {
    return node.initializer !== undefined && ts.isClassLike(node.parent)
      ? valueDefinition(node, node.name, node.initializer)
      : undefined;
  }
  if (ts.isBinaryExpression(node)) {
    if (!storesValue(node.operatorToken.kind)) {
      return undefined;
    }
    const left = skipOuterExpressions(node.left);
    if (
      ts.isObjectLiteralExpression(left) ||
      ts.isArrayLiteralExpression(left)
    ) {
      const key = patternTargetKey(destructuringTargets(left));
      return key !== undefined
        ? { form: "pattern_store", node, key }
        : undefined;
    }
    const written = writtenKeyOf(left);
    if (written === undefined) {
      return undefined;
    }
    const key = protocolKeyOf(written);
    return key !== "other" && escapingValuesOf(node.right).length > 0
      ? { form: "store", node, value: node.right, key }
      : undefined;
  }
  if (
    ts.isForOfStatement(node) &&
    !ts.isVariableDeclarationList(node.initializer)
  ) {
    const key = patternTargetKey(destructuringTargets(node.initializer));
    return key !== undefined ? { form: "pattern_store", node, key } : undefined;
  }
  return undefined;
}

/**
 * The definition an ES module export makes on the module's namespace
 * object (see {@link ProtocolDefinition}), `undefined` when the export is
 * not one, or `"none"` when `node` is not an export form at all. A
 * type-only or `declare` export makes nothing at run time; a default
 * export's key is `default`.
 */
function moduleExportDefinitionOf(
  node: ts.Node,
): ProtocolDefinition | undefined | "none" {
  if (ts.isFunctionDeclaration(node)) {
    if (!isRuntimeNamedExport(node) || node.name === undefined) {
      return "none";
    }
    if (node.body === undefined || !PROTOCOL_NAMES.has(node.name.text)) {
      return undefined;
    }
    return isWrittenInFile(node, node.name.text)
      ? { form: "pattern_store", node, key: "protocol" }
      : { form: "method", node, key: "protocol" };
  }
  if (ts.isVariableDeclaration(node)) {
    const statement = node.parent.parent;
    if (
      !ts.isVariableStatement(statement) ||
      !isRuntimeNamedExport(statement)
    ) {
      return "none";
    }
    if (!ts.isIdentifier(node.name)) {
      // `export const { a: toString } = …`, `export const [then] = …`:
      // the value bound is read out of another value.
      return declaredNames(node.name).some((name) => PROTOCOL_NAMES.has(name))
        ? { form: "pattern_store", node, key: "protocol" }
        : undefined;
    }
    if (!PROTOCOL_NAMES.has(node.name.text)) {
      return undefined;
    }
    if (isWrittenInFile(node, node.name.text)) {
      return { form: "pattern_store", node, key: "protocol" };
    }
    return node.initializer !== undefined &&
      escapingValuesOf(node.initializer).length > 0
      ? { form: "value", node, value: node.initializer, key: "protocol" }
      : undefined;
  }
  if (ts.isExportSpecifier(node)) {
    const declaration = node.parent.parent;
    if (node.isTypeOnly || declaration.isTypeOnly) {
      return undefined;
    }
    if (!PROTOCOL_NAMES.has(moduleExportNameText(node.name))) {
      return undefined;
    }
    if (declaration.moduleSpecifier !== undefined) {
      return { form: "pattern_store", node, key: "protocol" };
    }
    const local = node.propertyName ?? node.name;
    return ts.isIdentifier(local)
      ? { form: "value", node, value: local, key: "protocol" }
      : { form: "pattern_store", node, key: "protocol" };
  }
  return "none";
}

/**
 * Whether the binding `name` may hold more than its declaration's value.
 * An export is a LIVE binding: the namespace property always holds the
 * binding's current value, so every write to an exported protocol-named
 * binding defines the member again (task A-4's re-audit). A write is any
 * assignment form, in any function (`escape-row.ts`'s `assignedNames`),
 * and any SECOND declaration of the name -- a `var` redeclared, in a
 * block, a `for (var … of …)` head or a destructuring `var` writes the
 * same binding with no assignment expression (the second re-audit).
 * Matched by name over the whole file, which over-approximates a
 * shadowing local: that costs only precision.
 */
function isWrittenInFile(node: ts.Node, name: string): boolean {
  const sourceFile = node.getSourceFile();
  return (
    assignedNames(sourceFile).has(name) ||
    (declarationCounts(sourceFile).get(name) ?? 0) > 1
  );
}

const declarationCountsCache = new WeakMap<
  ts.SourceFile,
  ReadonlyMap<string, number>
>();

/** How many declarations in the file declare each name (variables, binding-pattern elements, functions, classes, parameters). */
function declarationCounts(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, number> {
  const cached = declarationCountsCache.get(sourceFile);
  if (cached) {
    return cached;
  }
  const counts = new Map<string, number>();
  const count = (name: string): void => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isBindingElement(node)
    ) {
      if (ts.isIdentifier(node.name)) {
        count(node.name.text);
      }
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) {
      count(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  declarationCountsCache.set(sourceFile, counts);
  return counts;
}

/** The names a binding pattern declares. */
function declaredNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : declaredNames(element.name),
  );
}

/** Whether a declaration is a named, run-time `export` (not `default`, not `declare`). */
function isRuntimeNamedExport(
  node: ts.FunctionDeclaration | ts.VariableStatement,
): boolean {
  const modifiers = ts.getModifiers(node) ?? [];
  return (
    modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
    !modifiers.some(
      (m) =>
        m.kind === ts.SyntaxKind.DefaultKeyword ||
        m.kind === ts.SyntaxKind.DeclareKeyword,
    )
  );
}

function moduleExportNameText(name: ts.ModuleExportName): string {
  return name.text;
}

function valueDefinition(
  node:
    | ts.PropertyAssignment
    | ts.ShorthandPropertyAssignment
    | ts.PropertyDeclaration,
  name: ts.PropertyName,
  value: ts.Expression,
): ProtocolDefinition | undefined {
  const key = protocolKeyOf(name);
  return key !== "other" && escapingValuesOf(value).length > 0
    ? { form: "value", node, value, key }
    : undefined;
}

/**
 * The key that decides whether a pattern's member targets are accounted:
 * `protocol` when one of them is a protocol key, otherwise `unread` when
 * one may be, otherwise `undefined`.
 */
function patternTargetKey(
  targets: readonly ts.Expression[],
): ProtocolKey | undefined {
  let found: ProtocolKey | undefined;
  for (const target of targets) {
    const written = writtenKeyOf(target);
    if (written === undefined) {
      continue;
    }
    const key = protocolKeyOf(written);
    if (key === "protocol") {
      return "protocol";
    }
    if (key === "unread") {
      found = "unread";
    }
  }
  return found;
}

/**
 * The key a member-access assignment target writes: `o.toString` →
 * `toString`; `o[k]` → `k`. `undefined` for any other target.
 */
export function writtenKeyOf(
  target: ts.Expression,
): ts.PropertyName | ts.Expression | undefined {
  const expr = skipOuterExpressions(target);
  if (ts.isPropertyAccessExpression(expr)) {
    return expr.name;
  }
  if (ts.isElementAccessExpression(expr)) {
    return expr.argumentExpression;
  }
  return undefined;
}

/**
 * Whether an object literal is a destructuring assignment PATTERN (the
 * left side of `=`, a `for…of` / `for…in` target, or nested in one), whose
 * properties read values out rather than define members.
 */
export function isAssignmentPattern(
  literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
): boolean {
  let child: ts.Node = literal;
  let parent: ts.Node = literal.parent;
  for (;;) {
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === child)
    ) {
      child = parent;
      parent = parent.parent;
      continue;
    }
    // Any literal on the left of `=` is a pattern: the whole destructuring
    // target, or a nested target with a default (`[{ a } = d] = xs`). A
    // literal on the RIGHT of a default is an ordinary value.
    return (
      (ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.left === child) ||
      ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) &&
        parent.initializer === child)
    );
  }
}
