import ts from "typescript";
import { GLOBAL_OBJECT_NAMES, skipOuterExpressions } from "./ambient-names.js";
import { isMemberAssignedWithin } from "./named-bindings.js";

/**
 * Task A-5b (ADR 0008 invariant A2, the project owner's decision of
 * 2026-10-04): may a file WRITE an object's member named `m`?
 *
 * A method edge resolved from a receiver's class (`call-graph.ts`,
 * `resolveReceiverMethod`) says the call reaches the method the class
 * declares. That holds only while nothing replaces the member on the
 * instance, on a prototype of its chain, or on the class itself, and
 * nothing replaces the chain. The decision withdraws the edge when ANY
 * walked file may write the member: "an assignment, a dynamic key, or a
 * reflective mutator (`Object.defineProperty`, `Object.assign`, …)".
 *
 * THE RECEIVER IS DELIBERATELY NOT MATCHED, for the reason
 * `named-bindings.ts`'s `isMemberAssignedWithin` gives: a write reaches an
 * object through any alias, parameter or property of something else, and
 * this engine has no object identity. A member NAME written anywhere
 * counts. Over-approximate in the safe direction: an unrelated write of the
 * name costs a resolution, and no write is missed by its receiver.
 *
 * WHAT A FILE WRITES, in addition to the assignments `named-bindings.ts`
 * already sees (`x.m = v` in every assignment form, `++`, `delete`,
 * destructuring and `for…of` targets, and a key it cannot read):
 *
 * - `__proto__` written in any of those forms, and a string literal
 *   `"__proto__"` handed to a call (the `__proto__` setter reached through
 *   its descriptor): ANY member, since the whole chain changes;
 * - a `with` statement: ANY member (`with (o) { m = v }` writes `o.m`
 *   through a bare name);
 * - a reflective mutator, recognized by the NAME it is read under, whatever
 *   the receiver (`Object.defineProperty`, an alias `O.defineProperty`, a
 *   library's `_.assign`): {@link MUTATORS}. A direct call whose key is a
 *   literal writes that key; any key it cannot read, and any other use of
 *   the mutator (an alias, a destructuring, a `.call`, a value passed on),
 *   writes ANY member. `Reflect.set` and `Reflect.deleteProperty` are
 *   mutators only on `Reflect`, whose `set` would otherwise be every
 *   `Map#set`;
 * - `Object`, `Reflect` or a global-object name ({@link GLOBAL_OBJECT_NAMES},
 *   `window`, `self`) used as a VALUE -- anything but the receiver of a
 *   member read with a static name, a callee, a `typeof` operand, the
 *   right of `instanceof`, or an operand of an equality -- or read with a
 *   dynamic key: ANY member, since a mutator can then be reached without
 *   its name being spelled.
 *
 * NOT SEEN (recorded in the task's report): a mutator reached through a
 * value derived from a builtin with no spelling of `Object`, `Reflect` or
 * a mutator name (`({}).constructor[k]`, the global object as a sloppy
 * `this`), and code the graph never prepared. `Function(...)` and `eval`
 * are closure-widening edges of their own (`function_constructor`,
 * `eval`), which already block every negative proof over a region that
 * reaches them.
 */

/** A member name no source file can spell: "any member may be written". */
const ANY_MEMBER = "\u0000any-member";

/**
 * The reflective mutators read under these names, whatever their receiver,
 * and where each takes the key it writes: an argument position, the own
 * property names of an object-literal argument from a position on
 * (`defineProperties`' descriptor map, `assign`'s sources), or the whole
 * chain (`setPrototypeOf`, Node's `util.inherits`).
 */
type MutatorKey =
  | { readonly kind: "argument"; readonly position: number }
  | { readonly kind: "literal-keys"; readonly from: number }
  | { readonly kind: "any" };

const MUTATORS: ReadonlyMap<string, MutatorKey> = new Map<string, MutatorKey>([
  ["defineProperty", { kind: "argument", position: 1 }],
  ["defineProperties", { kind: "literal-keys", from: 1 }],
  ["assign", { kind: "literal-keys", from: 1 }],
  ["setPrototypeOf", { kind: "any" }],
  ["inherits", { kind: "any" }],
  ["__defineGetter__", { kind: "argument", position: 0 }],
  ["__defineSetter__", { kind: "argument", position: 0 }],
]);

/** Mutators only when read off `Reflect` (`Map#set` is not one). */
const REFLECT_MUTATORS: ReadonlyMap<string, MutatorKey> = new Map<
  string,
  MutatorKey
>([
  ["set", { kind: "argument", position: 1 }],
  ["deleteProperty", { kind: "argument", position: 1 }],
]);

/** Names whose value reaches every mutator without spelling one. */
const MUTATOR_HOLDERS: ReadonlySet<string> = new Set([
  "Object",
  "Reflect",
  ...GLOBAL_OBJECT_NAMES,
  "window",
  "self",
]);

const reflectiveWritesByFile = new WeakMap<
  ts.SourceFile,
  ReadonlySet<string>
>();
let reflectiveWriteIndexBuilds = 0;

/** How many files {@link fileMayWriteMember} has scanned for reflective writes. Instrumentation for tests; never an input to analysis. */
export function memberWriteIndexBuilds(): number {
  return reflectiveWriteIndexBuilds;
}

/**
 * Whether anything in `sourceFile` may write a member named `member` on
 * any object (see the module comment). One walk per file for the forms
 * below, cached on the AST; the assignment forms are
 * `named-bindings.ts`'s own per-scope index.
 */
export function fileMayWriteMember(
  sourceFile: ts.SourceFile,
  member: string,
): boolean {
  let reflective = reflectiveWritesByFile.get(sourceFile);
  if (!reflective) {
    reflective = buildReflectiveWrites(sourceFile);
    reflectiveWritesByFile.set(sourceFile, reflective);
  }
  return (
    reflective.has(ANY_MEMBER) ||
    reflective.has(member) ||
    isMemberAssignedWithin(sourceFile, "__proto__") ||
    isMemberAssignedWithin(sourceFile, member)
  );
}

/** The text of a key the analyzer can read: a string, numeric or plain template literal. */
function literalKey(expression: ts.Expression): string | undefined {
  const key = skipOuterExpressions(expression);
  if (ts.isStringLiteralLike(key)) {
    return key.text;
  }
  if (ts.isNumericLiteral(key)) {
    return String(Number(key.text));
  }
  return undefined;
}

/** The name of an object-literal or binding-pattern property, when the analyzer can read it. */
function propertyNameText(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isNumericLiteral(name)) {
    return String(Number(name.text));
  }
  if (ts.isComputedPropertyName(name)) {
    return literalKey(name.expression);
  }
  return undefined;
}

/** Whether `expression` denotes `Reflect` -- `Reflect`, or `globalThis.Reflect`. */
function denotesReflect(expression: ts.Expression): boolean {
  const target = skipOuterExpressions(expression);
  if (ts.isIdentifier(target)) {
    return target.text === "Reflect";
  }
  return (
    ts.isPropertyAccessExpression(target) && target.name.text === "Reflect"
  );
}

/** The static name a member read uses, or `undefined` for a dynamic key. */
function readName(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined {
  return ts.isPropertyAccessExpression(node)
    ? node.name.text
    : literalKey(node.argumentExpression);
}

/**
 * Whether `node` -- an expression denoting a mutator holder -- is used only
 * in a position that cannot hand it on: the receiver of a member read with
 * a static name (the name rule then applies to the member), a callee
 * (`Object(x)`), a `typeof` operand, the right of `instanceof`, or an
 * operand of an equality.
 */
function isInertHolderUse(node: ts.Expression): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  while (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isTypeAssertionExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isSatisfiesExpression(parent)
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === child) {
    return true;
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === child) {
    return literalKey(parent.argumentExpression) !== undefined;
  }
  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.expression === child
  ) {
    return true;
  }
  if (ts.isTypeOfExpression(parent)) {
    return true;
  }
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    if (operator === ts.SyntaxKind.InstanceOfKeyword) {
      return parent.right === child;
    }
    return (
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      operator === ts.SyntaxKind.EqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsToken
    );
  }
  return false;
}

/** Whether an identifier is a value REFERENCE -- not a declaration or property name, a label, or a type. */
function isValueReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (
    ts.isShorthandPropertyAssignment(parent) ||
    ts.isExportSpecifier(parent)
  ) {
    return true;
  }
  if (ts.isPropertyAccessExpression(parent)) {
    return parent.expression === id;
  }
  if (
    ts.isLabeledStatement(parent) ||
    ts.isBreakOrContinueStatement(parent) ||
    ts.isTypeReferenceNode(parent) ||
    ts.isTypeQueryNode(parent) ||
    ts.isQualifiedName(parent)
  ) {
    return false;
  }
  if (
    ts.isExpressionWithTypeArguments(parent) &&
    ts.isHeritageClause(parent.parent) &&
    parent.parent.token === ts.SyntaxKind.ImplementsKeyword
  ) {
    return false;
  }
  const named = parent as {
    readonly name?: ts.Node;
    readonly propertyName?: ts.Node;
  };
  return named.name !== id && named.propertyName !== id;
}

function buildReflectiveWrites(sourceFile: ts.SourceFile): ReadonlySet<string> {
  reflectiveWriteIndexBuilds += 1;
  const written = new Set<string>();

  /** The keys a direct call of a mutator writes, read from its arguments. */
  function addMutatorCall(call: ts.CallExpression, key: MutatorKey): void {
    const args = call.arguments;
    if (args.some(ts.isSpreadElement)) {
      written.add(ANY_MEMBER);
      return;
    }
    if (key.kind === "any") {
      written.add(ANY_MEMBER);
      return;
    }
    if (key.kind === "argument") {
      const arg = args[key.position];
      const text = arg ? literalKey(arg) : undefined;
      written.add(text ?? ANY_MEMBER);
      return;
    }
    // `literal-keys`: a fresh literal target (`Object.assign({}, …)`)
    // writes nothing that existed before the call. Otherwise every
    // property of every object-literal argument from `from` on.
    const target = args[0] ? skipOuterExpressions(args[0]) : undefined;
    if (
      target &&
      (ts.isObjectLiteralExpression(target) ||
        ts.isArrayLiteralExpression(target))
    ) {
      return;
    }
    for (const arg of args.slice(key.from)) {
      const source = skipOuterExpressions(arg);
      if (!ts.isObjectLiteralExpression(source)) {
        written.add(ANY_MEMBER);
        return;
      }
      for (const property of source.properties) {
        // A plain `__proto__: v` sets the literal's own prototype and is
        // no property, so nothing is copied. Any other `__proto__` key --
        // computed (`["__proto__"]: v`) or shorthand (`{ __proto__ }`) -- is
        // an own property, and `Object.assign`'s [[Set]] runs the
        // `__proto__` setter on the target with it (task A-5b's
        // independent audit): the chain changes, any member.
        if (
          ts.isPropertyAssignment(property) &&
          !ts.isComputedPropertyName(property.name) &&
          propertyNameText(property.name) === "__proto__"
        ) {
          continue;
        }
        const text =
          ts.isSpreadAssignment(property) || property.name === undefined
            ? undefined
            : propertyNameText(property.name);
        written.add(text === "__proto__" ? ANY_MEMBER : (text ?? ANY_MEMBER));
      }
    }
  }

  /** A member read under a mutator's name: a direct call is read, anything else writes any member. */
  function addMutatorRead(
    read: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    key: MutatorKey,
  ): void {
    let child: ts.Node = read;
    let parent = read.parent;
    while (
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent)
    ) {
      child = parent;
      parent = parent.parent;
    }
    if (ts.isCallExpression(parent) && parent.expression === child) {
      addMutatorCall(parent, key);
      return;
    }
    written.add(ANY_MEMBER);
  }

  function visit(node: ts.Node): void {
    if (ts.isWithStatement(node)) {
      written.add(ANY_MEMBER);
    } else if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const name = readName(node);
      // A dynamic read off a mutator holder needs no rule of its own: the
      // holder is then not inert (`isInertHolderUse`), so it writes any
      // member as a value.
      if (name !== undefined) {
        const mutator =
          MUTATORS.get(name) ??
          (denotesReflect(node.expression)
            ? REFLECT_MUTATORS.get(name)
            : undefined);
        if (mutator) {
          addMutatorRead(node, mutator);
        }
        if (
          ts.isPropertyAccessExpression(node) &&
          isMutatorHolder(node) &&
          !isInertHolderUse(node)
        ) {
          written.add(ANY_MEMBER);
        }
      }
    } else if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent)
    ) {
      // `const { defineProperty } = O`, `({ assign: a }) => …`: a mutator
      // taken out under a local name.
      const key = node.propertyName ?? node.name;
      const text = ts.isIdentifier(key)
        ? key.text
        : ts.isObjectBindingPattern(key) || ts.isArrayBindingPattern(key)
          ? undefined
          : propertyNameText(key);
      if (text !== undefined && MUTATORS.has(text)) {
        written.add(ANY_MEMBER);
      }
    } else if (ts.isImportSpecifier(node)) {
      // `import { inherits } from "node:util"`.
      if (MUTATORS.has((node.propertyName ?? node.name).text)) {
        written.add(ANY_MEMBER);
      }
    } else if (ts.isIdentifier(node)) {
      if (
        MUTATOR_HOLDERS.has(node.text) &&
        isValueReference(node) &&
        !isInertHolderUse(node)
      ) {
        written.add(ANY_MEMBER);
      }
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      // The `__proto__` setter reached through its descriptor:
      // `Object.getOwnPropertyDescriptor(Object.prototype, "__proto__")`.
      if (node.arguments?.some((arg) => literalKey(arg) === "__proto__")) {
        written.add(ANY_MEMBER);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return written;
}

/**
 * Whether `expression` may denote `Object`, `Reflect` or the global object:
 * one of those names, `x.Object` / `x.Reflect` off anything, or a global
 * name off a global name (`globalThis.global`).
 */
function isMutatorHolder(expression: ts.Expression): boolean {
  const target = skipOuterExpressions(expression);
  if (ts.isIdentifier(target)) {
    return MUTATOR_HOLDERS.has(target.text);
  }
  if (ts.isPropertyAccessExpression(target)) {
    const name = target.name.text;
    return (
      name === "Object" ||
      name === "Reflect" ||
      (MUTATOR_HOLDERS.has(name) && isMutatorHolder(target.expression))
    );
  }
  return false;
}
