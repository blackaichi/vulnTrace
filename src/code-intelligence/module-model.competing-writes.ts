/**
 * The competing-write window (task BL-064, RWF-094): whether competing
 * writes of one export can be observed apart, whether a file's export
 * objects may be observed, and whether its export writes may fail.
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
  isNonReferenceName,
  assignmentChainOf,
} from "./module-model.syntax.js";
import { topLevelCallableCandidates } from "./module-model.module-scope.js";
import {
  WHOLE_MODULE_EXPORT,
  competingWriteSites,
} from "./module-model.competing-write-sites.js";
import type { CompetingWriteKey } from "./module-model.competing-write-sites.js";
import {
  chainCompletesNormally,
  isCompletingWriteTarget,
  statementCompletesNormally,
  isAsyncCallable,
} from "./module-model.completion.js";

/** The index of the top-level statement holding `node`, or `undefined`. */
function topLevelStatementIndex(node: ts.Node): number | undefined {
  let current: ts.Node = node;
  while (current.parent !== undefined && !ts.isSourceFile(current.parent)) {
    current = current.parent;
  }
  if (current.parent === undefined) {
    return undefined;
  }
  const index = (current.parent as ts.SourceFile).statements.indexOf(
    current as ts.Statement,
  );
  return index < 0 ? undefined : index;
}

/**
 * Whether the export write whose right-hand side is `rhs` keeps its
 * authority against the file's OTHER writes of the same export (BL-064,
 * RWF-094; ADR 0009 § 1 clause 4 as amended by BL-064).
 *
 * An uncaught module-scope throw leaves the exports object holding
 * whatever was written last before it, and a module that already holds
 * the object observes that value: a module in a require cycle, any child
 * this module required (through `module.parent`), anything the object
 * escaped to. Measured against real Node: a child required BEFORE both
 * writes, with no cycle at all, reads the earlier value through
 * `module.parent.exports` after the load throws. So who can observe is
 * not a usable condition (almost every module requires something first),
 * and the condition is on the evaluation instead:
 *
 * the LAST write of `x` keeps its authority only when every evaluation
 * between the completion of the FIRST competing write of `x` and the
 * completion of this one is proven to complete normally
 * ({@link statementCompletesNormally},
 * {@link expressionCompletesNormally}). Anything else may throw -- a call
 * no proof reaches, a builtin, a property read -- and leave the earlier
 * value published, which is a second value the export can hold.
 *
 * The competing writes of a property `x` are every write of `x` and every
 * whole-module write; those of the whole-module value are every write.
 * A write of a provable primitive is not one (observing it reaches
 * nothing). A DEFERRED competing write (inside a function body) may run
 * at any point before this one, so the window opens at the start of the
 * file. A competing write in the same statement that is not a link of
 * this write's own assignment chain is refused outright.
 *
 * Fails closed: a right-hand side this relation cannot place answers
 * `false`, which withdraws authority toward `UNKNOWN`. A withdrawn
 * whole-module write also withdraws every property write it may replace
 * ({@link buildExportBindings}), so withdrawing one write never leaves a
 * stale one standing in its place. "Proven to complete" assumes the
 * engine does not run out of stack or memory at that statement: a
 * module loaded near the stack limit can throw a `RangeError` anywhere,
 * an accepted bound.
 */
function competingWritesCannotBeObservedApart(rhs: ts.Expression): boolean {
  const write = rhs.parent as ts.Node | undefined;
  if (write === undefined) {
    return false;
  }
  let key: CompetingWriteKey | undefined;
  if (
    ts.isBinaryExpression(write) &&
    write.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    write.right === rhs
  ) {
    const left = unwrapParentheses(write.left);
    key =
      commonJsExportPropertyName(left) ??
      (isModuleExportsAssignmentTarget(left) ? WHOLE_MODULE_EXPORT : undefined);
  } else if (ts.isExportAssignment(write) && write.isExportEquals) {
    key = WHOLE_MODULE_EXPORT;
  }
  const last = topLevelStatementIndex(write);
  if (key === undefined || last === undefined) {
    return false;
  }
  const sourceFile = write.getSourceFile();
  if (!exportObjectsMayBeObserved(sourceFile)) {
    return true;
  }
  const statements = sourceFile.statements;
  const lastStatement = statements[last]!;
  const chain = assignmentChainOf(lastStatement);

  // Code that can make a write fail, or set a name no write spells
  // ({@link exportWritesMayFail}), matters only once it may have RUN
  // before this write: some earlier top-level statement is not proven to
  // complete, or is a `try` (whose block runs anything). Then every
  // whole-module write can carry any name, and any window withdraws.
  const tainted =
    exportWritesMayFail(sourceFile) &&
    firstUnguardedStatementFrom(sourceFile) < last;
  const sites = competingWriteSites(sourceFile);
  const competitors =
    key === WHOLE_MODULE_EXPORT
      ? sites.all
      : [
          ...(sites.byName.get(key) ?? []),
          ...sites.wholeModule.filter(
            (site) =>
              tainted || site.carries === "all" || site.carries.has(key),
          ),
        ];
  let first: number | undefined;
  for (const site of competitors) {
    if (site.primitive || site.node === write) {
      continue;
    }
    if (site.deferred) {
      first = -1;
      break;
    }
    if (site.statementIndex === last) {
      if (!chain.includes(site.node)) {
        return false;
      }
      continue;
    }
    if (site.statementIndex < last) {
      first = Math.min(first ?? site.statementIndex, site.statementIndex);
    }
  }
  if (first === undefined) {
    return true;
  }
  if (tainted) {
    return false;
  }
  // The first competing write's own statement: only further links of its
  // assignment chain may run after the write, or it must complete whole.
  if (first >= 0) {
    const opening = statements[first]!;
    const links = assignmentChainOf(opening);
    if (
      links.length === 0
        ? !statementCompletesNormally(opening, first)
        : !links.every(
            (link) =>
              ts.isExportAssignment(link) ||
              (ts.isBinaryExpression(link) &&
                isCompletingWriteTarget(link.left, first)),
          )
    ) {
      // BL-064 (its independent audit, finding 2): an outer link of the
      // opening chain runs after the competing write it holds
      // (`holder.y = exports.run = d;`), so its target is checked too.
      return false;
    }
  }
  if (firstNonCompletingStatementFrom(sourceFile, first + 1) < last) {
    return false;
  }
  // This write's own statement: its value, then the chain's writes.
  return chainCompletesNormally(lastStatement, last);
}

const nonCompletingStatementsBySourceFile = new WeakMap<
  ts.SourceFile,
  readonly number[]
>();

/**
 * The index of the first top-level statement at or after `from` that
 * {@link statementCompletesNormally} does not prove, or the statement
 * count when there is none. Every statement is classified once per file,
 * on the first window query, so a window check is one comparison however
 * many exports ask.
 */
function firstNonCompletingStatementFrom(
  sourceFile: ts.SourceFile,
  from: number,
): number {
  let next = nonCompletingStatementsBySourceFile.get(sourceFile);
  if (next === undefined) {
    const statements = sourceFile.statements;
    const computed: number[] = new Array<number>(statements.length + 1);
    computed[statements.length] = statements.length;
    for (let i = statements.length - 1; i >= 0; i -= 1) {
      computed[i] = statementCompletesNormally(statements[i]!, i)
        ? computed[i + 1]!
        : i;
    }
    nonCompletingStatementsBySourceFile.set(sourceFile, computed);
    next = computed;
  }
  return next[Math.max(0, from)]!;
}

const exportObjectsMayBeObservedBySourceFile = new WeakMap<
  ts.SourceFile,
  boolean
>();

/**
 * Whether anything outside this module's evaluation can hold its `module`
 * or exports object, and so observe an intermediate export value after an
 * abrupt completion (BL-064). Measured against real Node: a module whose
 * load throws is deleted from `require.cache` and spliced out of its
 * parent's `module.children`, so without such a holder nothing ever sees
 * the half-written object again, and a re-require evaluates afresh.
 *
 * A holder needs a reference, so this is a census of the references this
 * file gives out, over the WHOLE file (a function body may run at module
 * time). It is a census of this file's own text, and its bounds are
 * accepted, not modelled: code outside the file that patches the loader
 * (`Module.prototype._compile`, a preload), and the deprecated
 * `fn.caller.arguments` of a sloppy-mode caller (a foreign function the
 * module calls at module scope can read the wrapper's `arguments`). The
 * references counted: any `require` (every module it loads holds `module.parent`, and
 * `require.cache` holds the module), a dynamic `import()`, any `eval`,
 * the wrapper's `arguments` or module-scope `this`, and any `module` or
 * `exports` reference other than the base of an export write target
 * (`exports.x =`, `module.exports.x =`, `module.exports =`) or a
 * rebinding of `exports` itself. Over-approximate in the safe direction:
 * a reference that escapes nowhere still counts.
 */
function exportObjectsMayBeObserved(sourceFile: ts.SourceFile): boolean {
  const cached = exportObjectsMayBeObservedBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  let observed = false;
  function visit(node: ts.Node, inOwnThisScope: boolean): void {
    if (observed) {
      return;
    }
    if (ts.isIdentifier(node)) {
      if (escapesExportObjects(node, inOwnThisScope)) {
        observed = true;
      }
      return;
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword && !inOwnThisScope) {
      observed = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      observed = true;
      return;
    }
    // TypeScript's `import x = require("...")` and an ES import compiled
    // to CommonJS load a module without spelling `require` (BL-064's
    // audit, finding 5c).
    if (
      (ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)) ||
      ts.isImportDeclaration(node) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined)
    ) {
      observed = true;
      return;
    }
    // A class's `extends` clause, its decorators and every computed key
    // (a class member's or an object-literal method's) are evaluated in
    // the ENCLOSING scope, so its `this` and `arguments` are the outer
    // ones (BL-064's audit, finding 5a); they are visited first, with the
    // outer flag, before the body is visited with its own.
    if (ts.isClassLike(node)) {
      node.heritageClauses?.forEach((clause) => visit(clause, inOwnThisScope));
      ts.getDecorators(node)?.forEach((d) => visit(d, inOwnThisScope));
      for (const member of node.members) {
        if (
          member.name !== undefined &&
          ts.isComputedPropertyName(member.name)
        ) {
          visit(member.name, inOwnThisScope);
        }
        if (ts.canHaveDecorators(member)) {
          ts.getDecorators(member)?.forEach((d) => visit(d, inOwnThisScope));
        }
      }
    } else if (
      ts.isFunctionLike(node) &&
      node.name !== undefined &&
      ts.isComputedPropertyName(node.name)
    ) {
      visit(node.name, inOwnThisScope);
    }
    // A non-arrow function, a class body and an object literal's method
    // bind their own `this` and `arguments`.
    const ownScope =
      inOwnThisScope ||
      (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) ||
      ts.isClassLike(node);
    ts.forEachChild(node, (child) => visit(child, ownScope));
  }
  visit(sourceFile, false);
  exportObjectsMayBeObservedBySourceFile.set(sourceFile, observed);
  return observed;
}

const exportWritesMayFailBySourceFile = new WeakMap<ts.SourceFile, boolean>();

/**
 * Whether code in this file may make a later export write -- or a member
 * write on a module function -- throw, or give a name a value no write
 * spells (BL-064's independent audit, finding 6): the `module` or exports
 * object handed to code (any `module`/`exports` reference other than the
 * base of an export write target or a rebinding of `exports`, which also
 * covers `Object.freeze(exports)` and `exports.m()` running `m` with
 * `this === exports`), module-scope `this`, or the builtins and keys that
 * reach the prototypes and property attributes (`Object`, `Reflect`,
 * `Function`, `globalThis`, `global`, `Proxy`, `__proto__`, `constructor`,
 * `setPrototypeOf`, `getPrototypeOf`). When it can, any window between
 * competing writes withdraws authority. Over-approximate in the safe
 * direction; tampering by code outside this file (a preload, a loader) is
 * outside every file census and is an accepted bound.
 */
function exportWritesMayFail(sourceFile: ts.SourceFile): boolean {
  const cached = exportWritesMayFailBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  let hazard = false;
  function visit(node: ts.Node, inOwnThisScope: boolean): void {
    if (hazard) {
      return;
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      // Module-scope `this` is the exports object; any other `this` may be
      // it too (a method called as `exports.m()`), so it must only ever be
      // a member access's base, never handed on.
      if (!inOwnThisScope || !isMemberAccessBase(node)) {
        hazard = true;
      }
      return;
    }
    if (ts.isIdentifier(node)) {
      if (TAMPERING_KEYS.has(node.text)) {
        hazard = true;
        return;
      }
      const parent = node.parent as ts.Node | undefined;
      if (parent === undefined || isNonReferenceName(node, parent)) {
        return;
      }
      if (
        TAMPERING_GLOBALS.has(node.text) ||
        // The wrapper's `arguments` holds `exports` and `module`.
        (node.text === "arguments" && !inOwnThisScope) ||
        (node.text === "exports" && !isExportsObjectContained(node)) ||
        (node.text === "module" && !isModuleObjectContained(node))
      ) {
        hazard = true;
      }
      return;
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      TAMPERING_KEYS.has(node.text)
    ) {
      hazard = true;
      return;
    }
    const ownScope =
      inOwnThisScope ||
      (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) ||
      ts.isClassLike(node);
    ts.forEachChild(node, (child) => visit(child, ownScope));
  }
  visit(sourceFile, false);
  exportWritesMayFailBySourceFile.set(sourceFile, hazard);
  return hazard;
}

/** Whether `node` is the object of a member access (`node.p`, `node[k]`), read, written or called. */
function isMemberAccessBase(node: ts.Node): boolean {
  const parent = node.parent as ts.Node | undefined;
  return (
    parent !== undefined &&
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  );
}

/**
 * Whether this `exports` reference keeps the object in this file's hands
 * (for {@link exportWritesMayFail}): a member access's base, or the target
 * of a rebinding of `exports` itself. A method called on it gets it as
 * `this`, which the `this` rule covers.
 */
function isExportsObjectContained(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node;
  return (
    (isMemberAccessBase(node) && !callsForeignExportMethod(parent)) ||
    (ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === node)
  );
}

/**
 * Whether `access` (`exports.m`, `module.exports.m`) is called as a
 * method whose value this file does not prove is its own function: the
 * method runs with the exports object as `this`, so a foreign one holds
 * it. Proven when every write of `m` the file spells is a function or
 * arrow value, or a module function binding; their own `this` uses are
 * the `this` rule's.
 */
function callsForeignExportMethod(access: ts.Node): boolean {
  const call = access.parent as ts.Node | undefined;
  if (
    call === undefined ||
    !(
      (ts.isCallExpression(call) && call.expression === access) ||
      (ts.isTaggedTemplateExpression(call) && call.tag === access)
    )
  ) {
    return false;
  }
  if (!ts.isPropertyAccessExpression(access)) {
    return true;
  }
  const sourceFile = access.getSourceFile();
  const values = exportPropertyWriteValues(sourceFile).get(access.name.text);
  if (values === undefined || values.length === 0) {
    return true;
  }
  const callables = topLevelCallableCandidates(sourceFile);
  return !values.every((written) => {
    const value = unwrapParentheses(unwrapValue(written));
    return (
      ts.isFunctionExpression(value) ||
      ts.isArrowFunction(value) ||
      (ts.isIdentifier(value) && callables.has(value.text))
    );
  });
}

const exportPropertyWriteValuesBySourceFile = new WeakMap<
  ts.SourceFile,
  ReadonlyMap<string, readonly ts.Expression[]>
>();

/**
 * The values every `exports.x = v` / `module.exports.x = v` in the file
 * writes, by name, wherever it is. Its own walk, so that
 * {@link exportWritesMayFail} never depends on {@link competingWriteSites}
 * (which depends on it).
 */
function exportPropertyWriteValues(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, readonly ts.Expression[]> {
  const cached = exportPropertyWriteValuesBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  const values = new Map<string, ts.Expression[]>();
  function visit(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const name = commonJsExportPropertyName(unwrapParentheses(node.left));
      if (name !== undefined) {
        const known = values.get(name);
        if (known === undefined) {
          values.set(name, [node.right]);
        } else {
          known.push(node.right);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  exportPropertyWriteValuesBySourceFile.set(sourceFile, values);
  return values;
}

/**
 * {@link isExportsObjectContained} for `module`: any member access but
 * `module.exports` is not the exports object at all; `module.exports`
 * must itself be a member access's base or a write target.
 */
function isModuleObjectContained(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node;
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node) {
    return false;
  }
  if (parent.name.text !== "exports") {
    // `module.parent`, `module.children`, `module.require`: not this
    // module's exports object, but the module object itself is not handed
    // on either.
    return true;
  }
  const outer = parent.parent as ts.Node;
  return (
    (isMemberAccessBase(parent) && !callsForeignExportMethod(outer)) ||
    (ts.isBinaryExpression(outer) &&
      outer.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      outer.left === parent)
  );
}

/** The globals through which code reaches property attributes and the prototypes. */
const TAMPERING_GLOBALS: ReadonlySet<string> = new Set([
  "eval",
  "Object",
  "Reflect",
  "Function",
  "globalThis",
  "global",
  "Proxy",
]);

/** The property keys that reach a prototype, wherever they are spelled. */
const TAMPERING_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "setPrototypeOf",
  "getPrototypeOf",
]);

/** {@link exportObjectsMayBeObserved}'s test for one identifier. */
function escapesExportObjects(
  node: ts.Identifier,
  inOwnThisScope: boolean,
): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined || isNonReferenceName(node, parent)) {
    return false;
  }
  switch (node.text) {
    case "require":
    case "eval":
      return true;
    case "arguments":
      return !inOwnThisScope;
    case "exports":
      return !(
        isExportWriteTargetBase(node) ||
        (ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          parent.left === node)
      );
    case "module":
      return !(
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.name.text === "exports" &&
        (isExportWriteTargetBase(parent) ||
          (ts.isBinaryExpression(parent.parent) &&
            parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            parent.parent.left === parent))
      );
    default:
      return false;
  }
}

/** Whether `object` is the base of an export property write target (`object.x = v`, `object["x"] = v`). */
function isExportWriteTargetBase(object: ts.Expression): boolean {
  const access = object.parent as ts.Node | undefined;
  if (
    access === undefined ||
    !(
      (ts.isPropertyAccessExpression(access) ||
        ts.isElementAccessExpression(access)) &&
      access.expression === object
    )
  ) {
    return false;
  }
  const assignment = access.parent as ts.Node | undefined;
  return (
    assignment !== undefined &&
    ts.isBinaryExpression(assignment) &&
    assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    assignment.left === access &&
    commonJsExportPropertyName(access) !== undefined
  );
}

const firstUnguardedStatementBySourceFile = new WeakMap<
  ts.SourceFile,
  number
>();

/**
 * The index of the first top-level statement that may run code this file
 * does not prove: one {@link statementCompletesNormally} does not prove,
 * or one holding a `try` (its block runs anything, the `catch` only stops
 * the throw). The statement count when there is none.
 */
function firstUnguardedStatementFrom(sourceFile: ts.SourceFile): number {
  const cached = firstUnguardedStatementBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  const statements = sourceFile.statements;
  // An `async` callee's call is proven to COMPLETE, but its body runs
  // synchronously up to its first `await`, so it may run anything
  // (BL-064's second audit round, finding 1): while the file has one, a
  // statement that invokes anything is not guarded.
  const hasAsyncCallable = [
    ...topLevelCallableCandidates(sourceFile).values(),
  ].some((fn) => isAsyncCallable(fn));
  let index = statements.length;
  for (let i = 0; i < statements.length; i += 1) {
    const statement = statements[i]!;
    if (
      !statementCompletesNormally(statement, i) ||
      containsTryStatement(statement) ||
      (hasAsyncCallable && containsInvocation(statement))
    ) {
      index = i;
      break;
    }
  }
  firstUnguardedStatementBySourceFile.set(sourceFile, index);
  return index;
}

/** Whether a statement holds a call or a tagged template outside any function. */
function containsInvocation(statement: ts.Statement): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found || ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(statement);
  return found;
}

/** Whether a statement holds a `try` outside any function. */
function containsTryStatement(statement: ts.Statement): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found || ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isTryStatement(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(statement);
  return found;
}

export {
  topLevelStatementIndex,
  competingWritesCannotBeObservedApart,
  exportWritesMayFail,
  callsForeignExportMethod,
  exportPropertyWriteValues,
};
