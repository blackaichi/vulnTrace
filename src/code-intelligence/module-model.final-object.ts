/**
 * The final-object account (task E-1): the uses of an export object's local
 * aliases, the reads it holds of itself, and the file's own functions a
 * final export object carries.
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
import { lexicalDeclarationOf } from "./named-bindings.js";
import {
  isNonReferenceName,
  isAmbientReference,
  isDeclarationName,
  identifiersSpelled,
  thisBindingFunction,
  isInertUse,
  accessNames,
  isPlainAssignmentTarget,
  skipOuterParentheses,
  isWriteTargetPosition,
} from "./module-model.syntax.js";
import { competingWriteSites } from "./module-model.competing-write-sites.js";
import { routeKeyNames } from "./module-model.route-keys.js";

/**
 * The names written through `binding` (a whole-module value spelled as a
 * binding, an alias of the final export object) and the values written,
 * or `"all"` when the binding is handed on: every reference to the same
 * declaration that is not a member read, a method call, an inert use or
 * another whole-module write. A member write of any form withdraws its
 * name. A binding that is not the file's own single declaration is
 * `"all"`; a `const`, `let` or `var` initialized to another binding (a
 * second alias) adds that one's uses, accounted the same way.
 */
function finalObjectAliasUses(
  sourceFile: ts.SourceFile,
  binding: ts.Identifier,
  seen: Set<unknown> = new Set(),
):
  | {
      readonly names: ReadonlySet<string>;
      readonly values: readonly ts.Expression[];
    }
  | "all" {
  // An undeclared name is a global: its uses in this file are every
  // undeclared reference of that spelling (another module reaches it only
  // through the global object, an accepted bound of every file census).
  const declaration: ts.Node =
    lexicalDeclarationOf(binding, binding.text) ?? sourceFile;
  if (seen.size > 8 || isAmbientReference(binding, "module")) {
    return "all";
  }
  const account = newFinalObjectAccount();
  const key =
    declaration === sourceFile ? `global:${binding.text}` : declaration;
  if (seen.has(key)) {
    return { names: account.names, values: account.values };
  }
  seen.add(key);
  const merge = (other: ts.Identifier): void =>
    mergeFinalObjectAlias(
      account,
      finalObjectAliasUses(sourceFile, other, seen),
    );
  // A binding initialized to another binding aliases that one's object too,
  // and so does one initialized to this binding (`const b = a`, RWF-012's
  // chains): their uses are accounted the same way. (One initialized to a
  // call or a `new` may share its object with whatever the callee kept: no
  // census of the file's text sees that holder, an accepted bound.)
  if (ts.isVariableDeclaration(declaration)) {
    const init =
      declaration.initializer === undefined
        ? undefined
        : unwrapParentheses(declaration.initializer);
    if (init !== undefined && ts.isIdentifier(init)) {
      merge(init);
      if (account.handedOn) {
        return "all";
      }
    }
  }
  // Only identifiers spelled like the binding are visited (E-1's audit, finding 5).
  for (const node of identifiersSpelled(sourceFile, binding.text)) {
    if (account.handedOn) {
      break;
    }
    if (
      !isNonReferenceName(node, node.parent) &&
      !isDeclarationName(node, node.parent) &&
      (lexicalDeclarationOf(node, node.text) ?? sourceFile) === declaration
    ) {
      accountFinalObjectUse(node, account, merge, declaration);
    }
  }
  accountSelfHeldReads(sourceFile, account, merge);
  return account.handedOn
    ? "all"
    : { names: account.names, values: account.values };
}

/** What the uses of the final export object's value write onto it ({@link finalObjectAliasUses}). */
interface FinalObjectAccount {
  readonly names: Set<string>;
  readonly values: ts.Expression[];
  handedOn: boolean;
  /**
   * Property names a store into itself or a write back into an export
   * object makes hold the object (`Api.self = Api`, `module.exports.self =
   * arguments.callee`): a later read of one is the object again
   * ({@link accountSelfHeldReads}; BL-084's audit, round 3).
   */
  readonly selfNames: Set<string>;
  /** Reads OF the object by a key no name decides: one may read a held name. */
  readonly computedReads: ts.Expression[];
}

/** A fresh {@link FinalObjectAccount}. */
function newFinalObjectAccount(): FinalObjectAccount {
  return {
    names: new Set(),
    values: [],
    handedOn: false,
    selfNames: new Set(),
    computedReads: [],
  };
}

/**
 * Every member read of the file by exact name, and every read by a key no
 * name decides whose base is `exports` or `module.exports`, which may hold
 * the final object. A computed read of any other base reads a held name
 * only when that base is the object: the census that found the name
 * records its own such reads ({@link FinalObjectAccount.computedReads}).
 * An alias's census keeps its own (BL-084's audit, round 4: not merged
 * across accounts; masked, since an alias of the final object handed to
 * any computed read is already a route of {@link ownObjectRoutes}).
 */
interface MemberReadIndex {
  readonly byName: ReadonlyMap<string, readonly ts.Expression[]>;
  readonly computed: readonly ts.Expression[];
}

const memberReadIndexBySourceFile = new WeakMap<
  ts.SourceFile,
  MemberReadIndex
>();

function memberReadIndex(sourceFile: ts.SourceFile): MemberReadIndex {
  const cached = memberReadIndexBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  const byName = new Map<string, ts.Expression[]>();
  const computed: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      !isWriteTargetPosition(skipOuterParentheses(node))
    ) {
      // A key that is provably a number reads no name a store held.
      const names = routeKeyNames(node);
      if (names === "all") {
        const base = unwrapParentheses(node.expression);
        if (
          isAmbientReference(base, "exports") ||
          isModuleExportsAssignmentTarget(base)
        ) {
          computed.push(node);
        }
      } else {
        for (const name of names) {
          const known = byName.get(name);
          if (known === undefined) {
            byName.set(name, [node]);
          } else {
            known.push(node);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const index = { byName, computed };
  memberReadIndexBySourceFile.set(sourceFile, index);
  return index;
}

/**
 * Accounts every read of a name `account` found holding the object (and
 * every read by a key no name decides), each like a reference to it, until
 * no further name is found (BL-084's audit, round 3: `Api.self = Api;
 * Api.self.run = v`).
 */
function accountSelfHeldReads(
  sourceFile: ts.SourceFile,
  account: FinalObjectAccount,
  merge: (other: ts.Identifier) => void,
): void {
  if (account.selfNames.size === 0) {
    return;
  }
  const index = memberReadIndex(sourceFile);
  const done = new Set<string>();
  let computedDone = false;
  let ownComputedDone = 0;
  for (;;) {
    const pending = [...account.selfNames].filter((name) => !done.has(name));
    const ownComputed = account.computedReads.slice(ownComputedDone);
    ownComputedDone = account.computedReads.length;
    if (
      (pending.length === 0 && ownComputed.length === 0) ||
      account.handedOn
    ) {
      return;
    }
    const reads: ts.Expression[] = [...ownComputed];
    for (const name of pending) {
      done.add(name);
      reads.push(...(index.byName.get(name) ?? []));
    }
    if (!computedDone) {
      computedDone = true;
      reads.push(...index.computed);
    }
    for (const read of reads) {
      if (account.handedOn) {
        return;
      }
      accountFinalObjectUse(read, account, merge, undefined);
    }
  }
}

/** Adds a further alias's uses (or its hand-off) to `account`. */
function mergeFinalObjectAlias(
  account: FinalObjectAccount,
  uses:
    | {
        readonly names: ReadonlySet<string>;
        readonly values: readonly ts.Expression[];
      }
    | "all",
): void {
  if (uses === "all") {
    account.handedOn = true;
    return;
  }
  for (const name of uses.names) account.names.add(name);
  account.values.push(...uses.values);
}

/**
 * Accounts one expression that evaluates to the final export object's
 * value -- a reference to its binding, or a route to a function's own
 * object ({@link ownObjectRoutes}) -- by what its use does to the object:
 * a member write adds its name and value, a member read, a call, an inert
 * use or a write back into an export object adds nothing, a further
 * binding is merged as an alias, and anything else hands it on. A call's
 * RESULT is not censused, though it may be the object (`Api.valueOf()`):
 * RWF-118's open gap, masked today by the call graph's unresolved-callee
 * backstop.
 * `declaration` is the binding's own declaration, for a store into itself
 * (`factory.default = factory`); a route has none.
 */
function accountFinalObjectUse(
  node: ts.Node,
  account: FinalObjectAccount,
  merge: (other: ts.Identifier) => void,
  declaration: ts.Node | undefined,
): void {
  const outer = skipOuterParentheses(node);
  const parent = outer.parent as ts.Node;
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === outer
  ) {
    const access = skipOuterParentheses(parent);
    if (isWriteTargetPosition(access)) {
      const written = accessNames(parent);
      // A `__proto__` write sets the prototype: any name may follow.
      if (written === "all" || written.has("__proto__")) {
        account.handedOn = true;
      } else {
        for (const name of written) account.names.add(name);
      }
      const writer = access.parent as ts.Node;
      if (ts.isBinaryExpression(writer) && writer.left === access) {
        account.values.push(writer.right);
      } else if (
        !ts.isPrefixUnaryExpression(writer) &&
        !ts.isPostfixUnaryExpression(writer) &&
        !ts.isDeleteExpression(writer)
      ) {
        // A destructuring or `for-of` target's value is unreadable
        // here: it stands in as a member read (any function).
        account.values.push(access as ts.Expression);
      }
    } else if (routeKeyNames(parent) === "all") {
      // A read by a key no name decides may read a name a store makes hold
      // the object ({@link accountSelfHeldReads}).
      account.computedReads.push(parent as ts.Expression);
    }
    return;
  }
  if (isInertUse(outer)) {
    return;
  }
  // Another binding's initializer (`const b = a`), or assigned to one
  // (`b = a`, `module.exports = alias = impl`): a further alias.
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === outer &&
    ts.isIdentifier(parent.name)
  ) {
    merge(parent.name);
    return;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === outer &&
    ts.isIdentifier(unwrapParentheses(parent.left)) &&
    !isAmbientReference(unwrapParentheses(parent.left), "exports")
  ) {
    merge(unwrapParentheses(parent.left) as ts.Identifier);
    // The assignment's own value is the object too (`(b = a).run = v`,
    // `set(b = a)`, `x = b = a`; BL-084's audit, F2).
    accountFinalObjectUse(parent, account, merge, declaration);
    return;
  }
  // Stored into itself (`factory.default = factory`): it stays within
  // the final object.
  const target =
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === outer
      ? unwrapParentheses(parent.left)
      : undefined;
  if (
    declaration !== undefined &&
    target !== undefined &&
    (ts.isPropertyAccessExpression(target) ||
      ts.isElementAccessExpression(target)) &&
    ts.isIdentifier(unwrapParentheses(target.expression)) &&
    lexicalDeclarationOf(
      unwrapParentheses(target.expression),
      (unwrapParentheses(target.expression) as ts.Identifier).text,
    ) === declaration
  ) {
    // A later read of that property is the object again.
    const held = accessNames(target);
    if (held === "all") {
      account.handedOn = true;
      return;
    }
    for (const name of held) account.selfNames.add(name);
    accountFinalObjectUse(parent, account, merge, declaration);
    return;
  }
  // Handed to a builtin (`Object.keys(api)`), it is handed to code: any
  // module may have replaced the builtin (RWF-104, BL-075).
  // Called or constructed, the object hands itself to nothing.
  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.expression === outer
  ) {
    return;
  }
  // Written back into an export object (`module.exports = fn;
  // module.exports.default = fn;`): it stays in this module's exports.
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === outer &&
    (isModuleExportsAssignmentTarget(unwrapParentheses(parent.left)) ||
      isAmbientReference(unwrapParentheses(parent.left), "exports") ||
      commonJsExportPropertyName(unwrapParentheses(parent.left)) !== undefined)
  ) {
    // A later read of that property is the object again (`module.exports.self
    // = fn; module.exports.self.run = v`; BL-084's audit, round 3), and the
    // assignment's own value is the object too (round 2).
    const held = commonJsExportPropertyName(unwrapParentheses(parent.left));
    if (held !== undefined) {
      account.selfNames.add(held);
    }
    accountFinalObjectUse(parent, account, merge, declaration);
    return;
  }
  if (
    ts.isExportAssignment(parent) &&
    parent.isExportEquals &&
    parent.expression === outer
  ) {
    return;
  }
  if (isPlainAssignmentTarget(outer)) {
    // Rebound: the binding no longer holds the final object afterwards,
    // but may before; its later member writes are counted all the same.
    return;
  }
  account.handedOn = true;
}

/**
 * The functions and classes the final export object may be (task BL-084):
 * every whole-module value that is a function, arrow or class expression,
 * a binding to a function or class declaration, or a variable initialized
 * (through further bindings, a conditional's branches, `&&`, `||`, `??`)
 * to one. A value that is none of these (a call's result, a load) is no
 * object of this file's functions, and a property write after it is never
 * attributed ({@link applyExportWriteSet}'s `writesTakeOnFinalObject`).
 */
function finalObjectOwnFunctions(sourceFile: ts.SourceFile): Set<ts.Node> {
  const owners = new Set<ts.Node>();
  const seen = new Set<ts.Node>();
  const add = (expression: ts.Expression): void => {
    const value = unwrapParentheses(unwrapValue(expression));
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    if (
      ts.isFunctionExpression(value) ||
      ts.isArrowFunction(value) ||
      ts.isClassExpression(value)
    ) {
      owners.add(value);
    } else if (ts.isConditionalExpression(value)) {
      add(value.whenTrue);
      add(value.whenFalse);
    } else if (
      ts.isBinaryExpression(value) &&
      (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        value.operatorToken.kind === ts.SyntaxKind.CommaToken ||
        value.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    ) {
      if (value.operatorToken.kind !== ts.SyntaxKind.CommaToken) {
        add(value.left);
      }
      add(value.right);
    } else if (
      ts.isIdentifier(value) &&
      !isAmbientReference(value, "exports")
    ) {
      const declaration = lexicalDeclarationOf(value, value.text);
      if (
        declaration !== undefined &&
        (ts.isFunctionDeclaration(declaration) ||
          ts.isClassDeclaration(declaration))
      ) {
        owners.add(declaration);
      } else if (
        declaration !== undefined &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined
      ) {
        add(declaration.initializer);
      }
    }
  };
  for (const site of competingWriteSites(sourceFile).wholeModule) {
    add(
      ts.isExportAssignment(site.node)
        ? site.node.expression
        : (site.node as ts.BinaryExpression).right,
    );
  }
  return owners;
}

/** `Reflect` and `Object` members whose result is a property's value: a route ({@link ownObjectRoutes}). */
const VALUE_READERS: ReadonlySet<string> = new Set(["get"]);

/**
 * `Reflect` and `Object` members whose result HOLDS property values (a
 * descriptor, a map of them, an array of values or entries): a route to
 * anything it holds, so any use but an inert one hands it on
 * ({@link ownObjectRoutes}).
 */
const HOLDER_READERS: ReadonlySet<string> = new Set([
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "values",
  "entries",
]);

const VALUE_OR_HOLDER_READERS: ReadonlySet<string> = new Set([
  ...VALUE_READERS,
  ...HOLDER_READERS,
]);

/** A stack callsite's readers of its frame's function and receiver. */
const STACK_FRAME_KEYS: ReadonlySet<string> = new Set([
  "getFunction",
  "getThis",
]);

/**
 * Whether `node` (an identifier) denotes its frame's `arguments` object
 * (BL-084's audit, F1): no declaration, or a `var` (which re-declares the
 * same binding, and whose initializer only writes it -- taken for the
 * object, failing closed), or a declaration outside the frame (shadowed by
 * the frame's own `arguments`). A parameter, `let`, `const`, function or
 * class of that name inside the frame is another binding.
 */
function isArgumentsObjectReference(node: ts.Identifier): boolean {
  if (node.text !== "arguments") {
    return false;
  }
  const parent = node.parent as ts.Node | undefined;
  if (
    parent === undefined ||
    isNonReferenceName(node, parent) ||
    isDeclarationName(node, parent) ||
    (ts.isVariableDeclaration(parent) && parent.name === node)
  ) {
    return false;
  }
  const declaration = lexicalDeclarationOf(node, "arguments");
  if (declaration === undefined) {
    return true;
  }
  if (
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.BlockScoped) === 0
  ) {
    return true;
  }
  const frame = thisBindingFunction(node);
  if (frame === undefined) {
    return false;
  }
  for (
    let current: ts.Node | undefined = declaration;
    current !== undefined;
    current = current.parent
  ) {
    if (current === frame) {
      return false;
    }
  }
  return true;
}

/**
 * Whether an ambient `Reflect` or `Object` is used only where
 * {@link ownObjectRoutes} sees its readers: the base of a member named by
 * an exact key (a reader's call is censused there), `Object(…)` or
 * `new Object(…)`, or an inert use.
 */
function isConfinedReaderNamespace(node: ts.Identifier): boolean {
  const outer = skipOuterParentheses(node);
  const parent = outer.parent as ts.Node;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === outer) {
    return true;
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === outer) {
    const names = accessNames(parent);
    return (
      names !== "all" &&
      ![...names].some((name) => VALUE_OR_HOLDER_READERS.has(name))
    );
  }
  if (
    node.text === "Object" &&
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.expression === outer
  ) {
    return true;
  }
  return isInertUse(outer);
}

export {
  finalObjectAliasUses,
  newFinalObjectAccount,
  accountSelfHeldReads,
  mergeFinalObjectAlias,
  accountFinalObjectUse,
  finalObjectOwnFunctions,
  VALUE_READERS,
  HOLDER_READERS,
  VALUE_OR_HOLDER_READERS,
  STACK_FRAME_KEYS,
  isArgumentsObjectReference,
  isConfinedReaderNamespace,
};
