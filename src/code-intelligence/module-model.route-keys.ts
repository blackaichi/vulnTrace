/**
 * Route keys: the property names a member access's key can denote, with the
 * numeric-key analysis of the bindings a key reads.
 *
 * Split out of `module-model.ts` by concern, as a pure move (task BL-121):
 * the declarations below are those of that file, unchanged and in its order.
 * `module-model.ts` re-exports the public ones.
 */
import ts from "typescript";
import { unwrapParentheses } from "./commonjs-reexports.js";
import { lexicalDeclarationOf } from "./named-bindings.js";
import {
  isNonReferenceName,
  NO_NAMES,
  isDeclarationName,
  identifiersSpelled,
  accessNames,
  skipOuterParentheses,
  isAssignmentOperatorToken,
  isWriteTargetPosition,
} from "./module-model.syntax.js";

/**
 * {@link accessNames} for a read {@link ownObjectRoutes} asks about: a key
 * that is provably a number or a boolean (`args[i]` with a loop counter)
 * converts to no name a route needs (`constructor`, `callee`, `caller`).
 */
function routeKeyNames(
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): ReadonlySet<string> | "all" {
  const names = accessNames(access);
  return names === "all" &&
    ts.isElementAccessExpression(access) &&
    isNumericValue(access.argumentExpression)
    ? NO_NAMES
    : names;
}

/**
 * Whether `expression` always evaluates to a number, a BigInt or a boolean
 * (task BL-084): a literal, a unary operator, an arithmetic, bitwise,
 * relational or equality operator (`+` only between two such values), a
 * conditional of two such values, or a `var` / `let` / `const` this file
 * declares (identified by lexical declaration, never by spelling) whose
 * initializer and every write are such values. A parameter, a `for…in` /
 * `for…of` binding, a destructuring and anything else is not.
 */
function isNumericValue(
  expression: ts.Expression,
  seen: Set<ts.Node> = new Set(),
): boolean {
  const node = unwrapParentheses(expression);
  if (
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isPrefixUnaryExpression(node) ||
    ts.isPostfixUnaryExpression(node)
  ) {
    return true;
  }
  if (ts.isConditionalExpression(node)) {
    return (
      isNumericValue(node.whenTrue, seen) &&
      isNumericValue(node.whenFalse, seen)
    );
  }
  if (ts.isBinaryExpression(node)) {
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        return (
          isNumericValue(node.left, seen) && isNumericValue(node.right, seen)
        );
      case ts.SyntaxKind.CommaToken:
        return isNumericValue(node.right, seen);
      case ts.SyntaxKind.MinusToken:
      case ts.SyntaxKind.AsteriskToken:
      case ts.SyntaxKind.SlashToken:
      case ts.SyntaxKind.PercentToken:
      case ts.SyntaxKind.AsteriskAsteriskToken:
      case ts.SyntaxKind.LessThanLessThanToken:
      case ts.SyntaxKind.GreaterThanGreaterThanToken:
      case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      case ts.SyntaxKind.AmpersandToken:
      case ts.SyntaxKind.BarToken:
      case ts.SyntaxKind.CaretToken:
      case ts.SyntaxKind.LessThanToken:
      case ts.SyntaxKind.LessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanToken:
      case ts.SyntaxKind.GreaterThanEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.InKeyword:
      case ts.SyntaxKind.InstanceOfKeyword:
        return true;
      default:
        return false;
    }
  }
  return ts.isIdentifier(node) && isNumericBinding(node, seen);
}

/** {@link isNumericValue} for a reference: its declaration's initializer and every write to it. */
function isNumericBinding(
  reference: ts.Identifier,
  seen: Set<ts.Node>,
): boolean {
  const declaration = lexicalDeclarationOf(reference, reference.text);
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name)
  ) {
    return false;
  }
  const known = numericBindingByDeclaration.get(declaration);
  if (known !== undefined) {
    return known;
  }
  if (seen.has(declaration)) {
    // Its other writes decide.
    return true;
  }
  if (seen.size >= NUMERIC_BINDING_DEPTH) {
    // Too deep a chain to follow without the stack: not proven, so a key
    // it reads may be a route (BL-084's audit, round 3).
    return false;
  }
  // A `false` holds whatever was assumed. Every combinator is a
  // conjunction, so a `false` anywhere reaches the outermost question: when
  // that one is `true`, so is every declaration it assumed (BL-084's audit,
  // F4 and round 2: each declaration is decided once).
  const outermost = seen.size === 0;
  seen.add(declaration);
  const decided = numericBindingWrites(
    declaration as ts.VariableDeclaration & { readonly name: ts.Identifier },
    seen,
  );
  if (!decided) {
    numericBindingByDeclaration.set(declaration, false);
  } else if (outermost) {
    for (const assumed of seen) {
      numericBindingByDeclaration.set(assumed, true);
    }
  }
  return decided;
}

const numericBindingByDeclaration = new WeakMap<ts.Node, boolean>();

/** How many bindings one numeric-key question may follow before it fails closed. */
const NUMERIC_BINDING_DEPTH = 64;

/** {@link isNumericBinding}'s question for one declaration: its initializer and every write. */
function numericBindingWrites(
  declaration: ts.VariableDeclaration & { readonly name: ts.Identifier },
  seen: Set<ts.Node>,
): boolean {
  const list = declaration.parent;
  if (
    ts.isVariableDeclarationList(list) &&
    (ts.isForInStatement(list.parent) || ts.isForOfStatement(list.parent))
  ) {
    return false;
  }
  const isNumericWrite = (initializer: ts.Expression | undefined): boolean =>
    initializer === undefined || isNumericValue(initializer, seen);
  if (!isNumericWrite(declaration.initializer)) {
    return false;
  }
  for (const node of referencesByDeclaration(
    declaration.getSourceFile(),
    declaration.name.text,
  ).get(declaration) ?? []) {
    numericKeyReferenceVisits += 1;
    const parent = node.parent as ts.Node;
    if (ts.isVariableDeclaration(parent) && parent.name === node) {
      // A redeclaration (`var i = …` again) is a write.
      if (!isNumericWrite(parent.initializer)) {
        return false;
      }
      continue;
    }
    if (
      isDeclarationName(node, parent) ||
      (ts.isShorthandPropertyAssignment(parent) && parent.name === node)
    ) {
      // A shorthand in an object pattern (`({ k } = o)`, `({ k = "x" } = o)`)
      // writes it (BL-084's audit, F3); in an object literal it is a read,
      // taken for a write all the same.
      return false;
    }
    const outer = skipOuterParentheses(node);
    if (!isWriteTargetPosition(outer)) {
      continue;
    }
    const writer = outer.parent as ts.Node;
    if (
      ts.isPrefixUnaryExpression(writer) ||
      ts.isPostfixUnaryExpression(writer)
    ) {
      continue;
    }
    if (
      ts.isBinaryExpression(writer) &&
      writer.left === outer &&
      isAssignmentOperatorToken(writer.operatorToken.kind) &&
      isNumericValue(writer.right, seen)
    ) {
      continue;
    }
    // A destructuring, a `for…in` / `for…of` target, a write of anything else.
    return false;
  }
  return true;
}

const referencesByDeclarationBySourceFile = new WeakMap<
  ts.SourceFile,
  Map<string, ReadonlyMap<ts.Node, readonly ts.Identifier[]>>
>();
let numericKeyReferenceVisits = 0;

/** How many references {@link isNumericBinding} visited, the index builds included (an operation count for the structural performance test). */
export function exportNumericKeyReferenceVisits(): number {
  return numericKeyReferenceVisits;
}

/**
 * Every reference of the file spelled `text`, grouped by the declaration
 * it denotes (lexically): one pass per spelling per file.
 */
function referencesByDeclaration(
  sourceFile: ts.SourceFile,
  text: string,
): ReadonlyMap<ts.Node, readonly ts.Identifier[]> {
  let byText = referencesByDeclarationBySourceFile.get(sourceFile);
  if (byText === undefined) {
    byText = new Map();
    referencesByDeclarationBySourceFile.set(sourceFile, byText);
  }
  const cached = byText.get(text);
  if (cached !== undefined) {
    return cached;
  }
  const grouped = new Map<ts.Node, ts.Identifier[]>();
  for (const node of identifiersSpelled(sourceFile, text)) {
    numericKeyReferenceVisits += 1;
    if (isNonReferenceName(node, node.parent)) {
      continue;
    }
    const declaration = lexicalDeclarationOf(node, text);
    if (declaration === undefined) {
      continue;
    }
    const known = grouped.get(declaration);
    if (known === undefined) {
      grouped.set(declaration, [node]);
    } else {
      known.push(node);
    }
  }
  byText.set(text, grouped);
  return grouped;
}

export { routeKeyNames };
