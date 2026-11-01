/**
 * The syntax predicates the module model's analyses share: whether an
 * identifier is a reference or a declaration name, an ambient name, a write
 * target or an inert use; the per-file identifier index; and the small key
 * and parenthesis helpers built on them.
 *
 * Split out of `module-model.ts` by concern, as a pure move (task BL-121):
 * the declarations below are those of that file, unchanged and in its order.
 * `module-model.ts` re-exports the public ones.
 */
import ts from "typescript";
import { unwrapParentheses } from "./commonjs-reexports.js";
import {
  isNameAssignedWithin,
  lexicalDeclarationOf,
} from "./named-bindings.js";
import { exactCommonJsExportPropertyName } from "./source-index.js";

function isStaticClassElement(node: ts.ClassElement): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ??
      false)
  );
}

/** A value that is provably a primitive, whatever its evaluation did first. */
function isPrimitiveValue(value: ts.Expression): boolean {
  const node = unwrapParentheses(value);
  return (
    ts.isVoidExpression(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

/** An identifier in a position that names a property or member, not a binding reference. */
function isNonReferenceName(node: ts.Identifier, parent: ts.Node): boolean {
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isQualifiedName(parent) && parent.right === node) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent)) &&
      parent.name === node) ||
    (ts.isLabeledStatement(parent) && parent.label === node) ||
    ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) &&
      parent.label === node)
  );
}

/**
 * The `=` links of a top-level statement that is nothing but an
 * assignment chain (`exports.a = exports.b = v;`, `export = v;`),
 * outermost first; empty for any other statement.
 */
function assignmentChainOf(statement: ts.Statement): ts.Node[] {
  if (ts.isExportAssignment(statement) && statement.isExportEquals) {
    return [statement];
  }
  if (!ts.isExpressionStatement(statement)) {
    return [];
  }
  const links: ts.Node[] = [];
  let current: ts.Expression = unwrapParentheses(statement.expression);
  while (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    links.push(current);
    current = unwrapParentheses(current.right);
  }
  return links;
}

const NO_NAMES: ReadonlySet<string> = new Set();

/** Whether `node` is an identifier reference to the AMBIENT CommonJS binding `name` (no declaration in scope). */
function isAmbientReference(node: ts.Node, name: string): boolean {
  if (!ts.isIdentifier(node) || node.text !== name) {
    return false;
  }
  const parent = node.parent as ts.Node | undefined;
  return (
    parent !== undefined &&
    !isNonReferenceName(node, parent) &&
    !isDeclarationName(node, parent) &&
    lexicalDeclarationOf(node, name) === undefined
  );
}

/**
 * Whether `node` is the name a declaration introduces, or a property name
 * a pattern or specifier reads (`{ module: m } = x`, `import { x as y }`,
 * `export { x as y }`'s outer name): not a reference.
 */
function isDeclarationName(node: ts.Identifier, parent: ts.Node): boolean {
  if (
    ((ts.isBindingElement(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isExportSpecifier(parent)) &&
      parent.propertyName === node) ||
    (ts.isExportSpecifier(parent) &&
      parent.propertyName !== undefined &&
      parent.name === node)
  ) {
    return true;
  }
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isBindingElement(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent)) &&
    (parent as { name?: ts.Node }).name === node
  );
}

const identifiersBySourceFile = new WeakMap<
  ts.SourceFile,
  ReadonlyMap<string, readonly ts.Identifier[]>
>();
let identifierIndexBuilds = 0;

/**
 * Every identifier of the file spelled `text`, from one index built per
 * file (task E-1's independent audit, finding 5: the alias censuses walked
 * the whole file once per alias, quadratic in aliases × file size).
 */
function identifiersSpelled(
  sourceFile: ts.SourceFile,
  text: string,
): readonly ts.Identifier[] {
  let index = identifiersBySourceFile.get(sourceFile);
  if (index === undefined) {
    identifierIndexBuilds += 1;
    const built = new Map<string, ts.Identifier[]>();
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const known = built.get(node.text);
        if (known === undefined) {
          built.set(node.text, [node]);
        } else {
          known.push(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    identifiersBySourceFile.set(sourceFile, built);
    index = built;
  }
  return index.get(text) ?? [];
}

/** How many per-file identifier indexes were built (an operation count for the structural performance test). */
export function exportAliasIdentifierIndexBuilds(): number {
  return identifierIndexBuilds;
}

/**
 * The outermost expression `node`'s value can be the value of: through
 * parentheses, the operands of `&&`, `||` and `??`, a conditional's
 * branches and a comma's right.
 */
function climbValue(node: ts.Node): ts.Node {
  let current = skipOuterParentheses(node);
  for (;;) {
    const parent = current.parent as ts.Node | undefined;
    if (
      parent !== undefined &&
      ((ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          (parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
            parent.right === current))) ||
        (ts.isConditionalExpression(parent) && parent.condition !== current))
    ) {
      current = skipOuterParentheses(parent);
      continue;
    }
    return current;
  }
}

/**
 * The non-arrow function whose call binds `node`'s `this`, climbing past
 * arrows (whose `this` is lexical, whatever their own strictness), a
 * function's or member's computed name, a class's heritage clause and
 * decorators (each evaluated with the enclosing `this`); `undefined` at
 * module scope, or where a class member binds it (a method is found as the
 * function; a field initializer or static block binds the instance or the
 * class).
 */
function thisBindingFunction(node: ts.Node): ts.Node | undefined {
  let child: ts.Node = node;
  for (
    let current: ts.Node | undefined = node.parent;
    current !== undefined && !ts.isSourceFile(current);
    child = current, current = current.parent
  ) {
    const viaName =
      (current as { name?: ts.Node }).name === child || ts.isDecorator(child);
    if (ts.isFunctionLike(current) && !ts.isArrowFunction(current)) {
      if (!viaName) {
        return current;
      }
      continue;
    }
    if (
      (ts.isPropertyDeclaration(current) ||
        ts.isClassStaticBlockDeclaration(current)) &&
      ts.isClassLike(current.parent) &&
      !viaName
    ) {
      return undefined;
    }
  }
  return undefined;
}

/** Ambient builtin constructors (whose `Symbol.hasInstance`, unless some module defines one, is the builtin one). */
const BUILTIN_CONSTRUCTORS: readonly string[] = [
  "Object",
  "Function",
  "Array",
  "Error",
  "TypeError",
  "RangeError",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "String",
  "Number",
  "Boolean",
  "Symbol",
];

/** `null`, `undefined` (the ambient name) or `void …`: a loose comparison with it coerces nothing. */
function isNullish(expression: ts.Expression): boolean {
  const value = unwrapParentheses(expression);
  return (
    value.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(value) ||
    isAmbientReference(value, "undefined")
  );
}

/**
 * Whether the value of `node` (an object reference) is only tested, never
 * handed to code: `typeof x`, `!x`, `void x`, a strict comparison, a loose
 * one against `null` or `undefined`, `k in x`, a condition (`if`, a
 * loop's, a conditional's test), the discarded left of a comma, an expression statement, and the LEFT operand of `&&`
 * (ToBoolean: an object is truthy, so `x && y` yields `y`; a falsy `this`
 * is no export object). A logical expression's other operands are its
 * value, which is inert only when the whole expression is.
 *
 * NOT inert, because real Node runs code with the object (E-1's
 * independent audit, finding 3): a loose comparison against anything else
 * and a template literal (ToPrimitive: `valueOf`, `toString`,
 * `Symbol.toPrimitive`, inherited or patched), and `instanceof` on either
 * side (`C[Symbol.hasInstance](x)`): `C` one this file defines, an ambient
 * builtin (any module of the process may define a builtin's own
 * `Symbol.hasInstance`, RWF-104), or the object itself, whose
 * `Symbol.hasInstance` is inherited from a prototype any module may write
 * (RWF-112; BL-075).
 */
function isInertUse(node: ts.Node): boolean {
  const outer = skipOuterParentheses(node);
  const parent = outer.parent as ts.Node | undefined;
  if (parent === undefined) {
    return false;
  }
  if (
    ts.isTypeOfExpression(parent) ||
    ts.isVoidExpression(parent) ||
    ts.isExpressionStatement(parent) ||
    (ts.isPrefixUnaryExpression(parent) &&
      parent.operator === ts.SyntaxKind.ExclamationToken)
  ) {
    return true;
  }
  if (
    ((ts.isIfStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent)) &&
      parent.expression === outer) ||
    (ts.isForStatement(parent) && parent.condition === outer) ||
    (ts.isConditionalExpression(parent) && parent.condition === outer)
  ) {
    return true;
  }
  if (ts.isConditionalExpression(parent)) {
    // A branch is the conditional's value.
    return isInertUse(parent);
  }
  if (!ts.isBinaryExpression(parent)) {
    return false;
  }
  switch (parent.operatorToken.kind) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      return true;
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      return isNullish(parent.left === outer ? parent.right : parent.left);
    case ts.SyntaxKind.InstanceOfKeyword:
      // On the left the object is handed to the right's
      // `Symbol.hasInstance`, a builtin's included: any module may define
      // one on the builtin (`Object.defineProperty(Object,
      // Symbol.hasInstance, …)`, E-1's re-audit, F4; RWF-104, BL-075). On
      // the right its own `Symbol.hasInstance` runs with it as `this`, and
      // a plain object's is inherited from `Object.prototype`, which any
      // module may write (BL-075's audit, RWF-112) -- unless it is a
      // function or a class with no heritage this file declares, whose
      // inherited one is `Function.prototype`'s, non-writable and
      // non-configurable (measured) -- as long as its own properties and
      // its `[[Prototype]]` are unchanged. The census of its binding
      // accounts writes through the binding, and BL-084's route census
      // ({@link ownObjectRoutes}) those that reach the function without its
      // name (`arguments.callee`, `new.target`, `.prototype.constructor`):
      // a route handed on, `Object.setPrototypeOf(new.target, P)` included,
      // withdraws every named export (RWF-114, RWF-115), within that
      // census's accepted bounds (another module's code) and RWF-118's open
      // gap (a call that returns its receiver, `Api.valueOf()`).
      return parent.right === outer && isOwnBaseCallable(outer);
    case ts.SyntaxKind.InKeyword:
      return parent.right === outer;
    case ts.SyntaxKind.CommaToken:
      return parent.left === outer || isInertUse(parent);
    case ts.SyntaxKind.AmpersandAmpersandToken:
      return parent.left === outer || isInertUse(parent);
    case ts.SyntaxKind.BarBarToken:
    case ts.SyntaxKind.QuestionQuestionToken:
      return isInertUse(parent);
    default:
      return false;
  }
}

/**
 * Whether `node` is an identifier bound, in this file, to a function
 * declaration (neither async nor a generator) or to a class declaration
 * with no heritage clause and no computed member, and never assigned: a
 * value whose `[[Prototype]]` is `Function.prototype` (task BL-075).
 */
function isOwnBaseCallable(node: ts.Node): boolean {
  const reference = unwrapParentheses(node as ts.Expression);
  if (!ts.isIdentifier(reference)) {
    return false;
  }
  const declaration = lexicalDeclarationOf(reference, reference.text);
  if (
    declaration === undefined ||
    isNameAssignedWithin(reference.getSourceFile(), reference.text)
  ) {
    return false;
  }
  if (ts.isFunctionDeclaration(declaration)) {
    return (
      declaration.asteriskToken === undefined &&
      !ts
        .getModifiers(declaration)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    );
  }
  return (
    ts.isClassDeclaration(declaration) &&
    declaration.heritageClauses === undefined &&
    declaration.members.every(
      (member) =>
        member.name === undefined || !ts.isComputedPropertyName(member.name),
    )
  );
}

/**
 * The names a property key can denote: the one exact name, none for a
 * symbol (`Symbol.toStringTag`, `Symbol("x")`, `Symbol.for("x")` with the
 * ambient `Symbol`: no export is named by a symbol), or `"all"`.
 */
function keyNames(key: ts.Expression): ReadonlySet<string> | "all" {
  const expression = unwrapParentheses(key);
  const exact = exactCommonJsExportPropertyName(expression);
  if (exact !== undefined) {
    return new Set([exact]);
  }
  const symbolBase = ts.isPropertyAccessExpression(expression)
    ? expression.expression
    : ts.isCallExpression(expression)
      ? ts.isPropertyAccessExpression(expression.expression) &&
        expression.expression.name.text === "for"
        ? expression.expression.expression
        : expression.expression
      : undefined;
  return symbolBase !== undefined &&
    isAmbientReference(unwrapParentheses(symbolBase), "Symbol")
    ? NO_NAMES
    : "all";
}

/** {@link keyNames} for a member access. */
function accessNames(
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): ReadonlySet<string> | "all" {
  return ts.isPropertyAccessExpression(access)
    ? new Set([access.name.text])
    : keyNames(access.argumentExpression);
}

/** Whether `node` is a plain `=` assignment's left-hand side. */
function isPlainAssignmentTarget(node: ts.Node): boolean {
  const parent = node.parent as ts.Node | undefined;
  return (
    parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === node
  );
}

/** The outermost parenthesized form of `node` (what its parent sees). */
function skipOuterParentheses(node: ts.Node): ts.Node {
  let current = node;
  while (
    current.parent !== undefined &&
    ts.isParenthesizedExpression(current.parent)
  ) {
    current = current.parent;
  }
  return current;
}

/** Whether `expression` is `require(…)` or `module.require(…)`, the ambient loader. */
function isRequireResult(expression: ts.Expression): boolean {
  const call = unwrapParentheses(expression);
  return (
    ts.isCallExpression(call) &&
    isLoaderCallee(unwrapParentheses(call.expression))
  );
}

/**
 * Whether `callee` is a CommonJS loader, whose call may return this very
 * module's exports object (a self-load): the ambient `require`,
 * `module.require`, `require.main.require`, `module.constructor._load`, or
 * a local bound once to the ambient `require` and never written
 * (`const r = require`, ADV2-051).
 */
function isLoaderCallee(callee: ts.Expression): boolean {
  if (isAmbientReference(callee, "require")) {
    return true;
  }
  if (ts.isIdentifier(callee)) {
    const declaration = lexicalDeclarationOf(callee, callee.text);
    return (
      declaration !== undefined &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      isAmbientReference(
        unwrapParentheses(declaration.initializer),
        "require",
      ) &&
      !isNameAssignedWithin(callee.getSourceFile(), callee.text)
    );
  }
  if (!ts.isPropertyAccessExpression(callee)) {
    return false;
  }
  const base = unwrapParentheses(callee.expression);
  return (
    (callee.name.text === "require" &&
      (isAmbientReference(base, "module") ||
        (ts.isPropertyAccessExpression(base) &&
          base.name.text === "main" &&
          isAmbientReference(
            unwrapParentheses(base.expression),
            "require",
          )))) ||
    (callee.name.text === "_load" &&
      ts.isPropertyAccessExpression(base) &&
      base.name.text === "constructor" &&
      isAmbientReference(unwrapParentheses(base.expression), "module"))
  );
}

/**
 * Whether `node` is one of the constructs that can hold STATEMENTS — the
 * only places a `return`/`throw` can be, once function bodies are excluded
 * (RWF-015).
 *
 * This is what keeps {@link firstModuleEvaluationCutoff} off the hot path
 * of large files. `return` and `throw` are statements, and a statement can
 * only appear in a statement position: a block, an `if` arm, a loop or
 * `with` body, a `switch` clause, a `try`/`catch`/`finally` block, or a
 * labeled statement. It can never appear inside an EXPRESSION — with two
 * exceptions, and both are handled elsewhere: a function body (skipped
 * deliberately, see {@link mayEndModuleEvaluation}) and a class `static`
 * block (the reason for the `scanExpressions` escape hatch, since a class
 * EXPRESSION can sit anywhere an expression can).
 *
 * So descending only through these is not an approximation — it reaches
 * every node that could hold the thing being looked for, and skips the
 * expression trees that make up the bulk of a real file. On the
 * scan-performance suite's single-file fixture (9,001 top-level
 * statements, nearly all of them object literals and call expressions)
 * walking expressions too cost ~190ms per module model, multiplied by
 * every model a scan builds; this walk is a per-statement kind check.
 */
function mayContainNestedStatements(node: ts.Node): boolean {
  return (
    ts.isBlock(node) ||
    ts.isIfStatement(node) ||
    ts.isIterationStatement(node, false) ||
    ts.isSwitchStatement(node) ||
    ts.isCaseBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node) ||
    ts.isTryStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isLabeledStatement(node) ||
    ts.isWithStatement(node)
  );
}

/**
 * Whether this file could contain a class element that EXECUTES at
 * class-definition time — a `static { ... }` block (RWF-015) or a
 * `static x = ...` field initializer (RWF-018) — and therefore needs
 * {@link mayEndModuleEvaluation}'s full expression walk to be classified
 * correctly.
 *
 * Those two are the only constructs that run code inside an EXPRESSION
 * without a function body around them: a static block is the only place a
 * statement can sit there, and a static field initializer the only place
 * an expression is evaluated there. Neither can exist unless the token
 * `static` appears in the file, so the same one-line text test gates both.
 * It is a sound over-approximation: a `static` in a comment, a string, or
 * an ordinary static METHOD modifier costs that one file the fast walk and
 * changes no answer, while a file containing no `static` at all provably
 * has neither — which makes the cheap statement-position walk exactly
 * complete rather than merely close.
 */
function mayContainClassStaticEvaluation(sourceFile: ts.SourceFile): boolean {
  return /\bstatic\b/.test(sourceFile.text);
}

/**
 * Whether an operator token assigns to its left-hand side (`=`, `+=`,
 * `??=`, ...). Local copy of the same test commonjs-reexports.ts's
 * `collectFacts` uses, kept independent rather than exported/shared: this
 * relation and that one answer different questions and coupling their
 * implementations would make either one harder to change without risking
 * the other.
 */
function isAssignmentOperatorToken(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

/**
 * Whether `node` sits in a position that WRITES to whatever it denotes
 * (RWF-028).
 *
 * The direct forms are the obvious ones — `h.x = v`, `h.x ??= v`,
 * `h.x++`, `delete h.x`. The ones worth building a walk for are the
 * destructuring forms, because a write target can be nested arbitrarily
 * deep inside a pattern that is syntactically an object or array
 * LITERAL:
 *
 * ```js
 * ({ a: h.x } = source);       // writes h.x
 * [h.x] = values;              // writes h.x
 * ({ a: { b: h.x } } = source) // writes h.x
 * for (h.x of list) {}         // writes h.x, once per iteration
 * ```
 *
 * An earlier version of this test looked only at `node`'s immediate
 * parent and missed every one of those — `const h = { bail }; ({ a:
 * h.bail } = { a: safeFn }); h.bail();` was proven non-completing when it
 * completes perfectly well, which is a false AFFECTED invented by this
 * rule. Found by RWF-028's own self-review attack pass.
 *
 * So the walk climbs the pattern's own structure — parentheses and TS
 * type-only wrappers, array and object literals, property assignments and
 * spreads — and answers `true` only if it lands on something that is
 * actually an assignment. Climbing a literal proves nothing on its own:
 * `foo({ a: h.x })` and `const y = [h.x]` climb exactly the same nodes and
 * correctly answer `false`, because the walk ends at a call and a
 * declaration rather than at an assignment's left-hand side.
 */
function isWriteTargetPosition(node: ts.Node): boolean {
  let current: ts.Node = node;
  for (;;) {
    const parent = current.parent as ts.Node | undefined;
    if (parent === undefined) {
      return false;
    }

    if (
      ts.isBinaryExpression(parent) &&
      isAssignmentOperatorToken(parent.operatorToken.kind) &&
      parent.left === current
    ) {
      return true;
    }
    if (
      (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) &&
      parent.initializer === current
    ) {
      return true;
    }
    if (
      (ts.isPrefixUnaryExpression(parent) ||
        ts.isPostfixUnaryExpression(parent)) &&
      parent.operand === current
    ) {
      return true;
    }
    if (ts.isDeleteExpression(parent) && parent.expression === current) {
      return true;
    }

    // Structure a write target can legitimately be nested inside. Nothing
    // here is a decision — only the tests above decide — so climbing one
    // of these in a non-assignment context is harmless.
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === current)
    ) {
      current = parent;
      continue;
    }

    return false;
  }
}

/**
 * The property name a computed key (`[expr]:` / `[expr]() {}`) denotes,
 * when it is directly a string or numeric literal or an identifier bound to
 * a `const` initialized to one (VT-217) -- e.g.
 * `const NAME = "vulnerable"; module.exports = { [NAME]: impl };`.
 * `undefined` for anything else (a parameter, a call, a runtime value): a
 * genuinely dynamic key, which {@link unpackObjectLiteralExports} treats as
 * able to define any name.
 *
 * E-1 (PRM-28): the identifier resolves LEXICALLY, from the key itself, to
 * the one declaration it binds to ({@link lexicalDeclarationOf}), which
 * must be written before the key (a `const` read earlier is in its temporal
 * dead zone). This used to take the first `const` of that spelling anywhere
 * in the file, so a function's or block's own `const K = "other"` decided
 * what a module-scope `[K]` published. A numeric key yields its property
 * name only when it round-trips ({@link exactCommonJsExportPropertyName}):
 * `1e3` denotes `"1000"`.
 */
function resolveComputedPropertyNameLiteral(
  sourceFile: ts.SourceFile,
  name: ts.ComputedPropertyName,
): string | undefined {
  const expr = unwrapParentheses(name.expression);
  const literal = exactCommonJsExportPropertyName(expr);
  if (literal !== undefined || !ts.isIdentifier(expr)) {
    return literal;
  }
  const declaration = lexicalDeclarationOf(expr, expr.text);
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    declaration.getEnd() > expr.getStart(sourceFile)
  ) {
    return undefined;
  }
  return exactCommonJsExportPropertyName(
    unwrapParentheses(declaration.initializer),
  );
}

export {
  isStaticClassElement,
  isPrimitiveValue,
  isNonReferenceName,
  assignmentChainOf,
  NO_NAMES,
  isAmbientReference,
  isDeclarationName,
  identifiersSpelled,
  climbValue,
  thisBindingFunction,
  BUILTIN_CONSTRUCTORS,
  isInertUse,
  keyNames,
  accessNames,
  isPlainAssignmentTarget,
  skipOuterParentheses,
  isRequireResult,
  isLoaderCallee,
  mayContainNestedStatements,
  mayContainClassStaticEvaluation,
  isAssignmentOperatorToken,
  isWriteTargetPosition,
  resolveComputedPropertyNameLiteral,
};
