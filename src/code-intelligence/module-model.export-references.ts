/**
 * The export write set's vocabulary and its reference classifier (task E-1;
 * ADR 0009 § 2): what one reference a file makes to its own export objects
 * does to them.
 *
 * Split out of `module-model.ts` by concern, as a pure move (task BL-121):
 * the declarations below are those of that file, unchanged and in its order.
 * `module-model.ts` re-exports the public ones.
 */
import ts from "typescript";
import {
  isModuleExportsAssignmentTarget,
  unwrapParentheses,
} from "./commonjs-reexports.js";
import { lexicalDeclarationOf } from "./named-bindings.js";
import { exactCommonJsExportPropertyName } from "./source-index.js";
import {
  NO_NAMES,
  isAmbientReference,
  climbValue,
  isInertUse,
  keyNames,
  accessNames,
  isPlainAssignmentTarget,
  skipOuterParentheses,
  isRequireResult,
  isLoaderCallee,
  isWriteTargetPosition,
  resolveComputedPropertyNameLiteral,
} from "./module-model.syntax.js";
import { callsForeignExportMethod } from "./module-model.competing-writes.js";
import {
  isOwnLiteralMethodCall,
  valueSink,
  isMethodWrittenElsewhere,
  withBodyReachesExportNames,
  INERT_MODULE_MEMBERS,
} from "./module-model.export-methods.js";
import {
  isPrototypeTampering,
  fileMayPatchBuiltins,
} from "./module-model.prototype-tampering.js";
import {
  baseMayBeLoaded,
  importedNameOf,
  mayLoadThisFile,
} from "./module-model.alias-summaries.js";
import { loaderAliasIsOnlyCalled } from "./module-model.loader-registry.js";

/* ------------------------------------------------------------------ *
 * E-1 (ADR 0009 § 1, § 2): the export write set                        *
 * ------------------------------------------------------------------ */

/**
 * What one reference this file makes to its own export objects does to
 * them (task E-1; ADR 0009 § 2's closed `ExportWriteKind` union). The
 * references censused are every ambient `exports`, `module` and
 * `require`, module-scope `this` and the wrapper's `arguments`, `this` in
 * any non-arrow function (called as `exports.m()`, it IS the exports
 * object), and every member write whose base is a `require(…)` result.
 *
 * - `read`: leaves the objects in this file's hands and writes nothing
 *   (`exports.x` read or called as one of this file's own functions,
 *   `typeof exports`, a comparison, `Object.keys(exports)`).
 * - `property-write`: `exports.x = v`, `exports["x"] = v`,
 *   `module.exports.x = v`, `module.exports["x"] = v`, module-scope
 *   `this.x = v` -- the writes {@link exportWriteSet} orders.
 * - `property-other-write`: the same targets in any other write position
 *   (`+=`, `&&=`, `++`, `delete`, a destructuring or `for-of` target).
 * - `whole-module-write`: `module.exports = v` (ordered by
 *   {@link collectModuleExportsAssignments}).
 * - `exports-rebinding`: `exports = v`.
 * - `method-this-write`: a member write on `this` inside a non-arrow
 *   function, a class method or a class's static member -- the exports
 *   object when the function is called as one of its methods (or the class
 *   is the whole-module value).
 * - `method-this-hand-off`: that `this` handed on (`var self = this`,
 *   `f.call(this)`, `return this`). It is un-enumerable only when its
 *   function can be a method of an export object
 *   ({@link exportMethodOwners}); anything handed a fresh instance is no
 *   export object unless the whole-module value may be one.
 * - `define-property`: `Object.defineProperty(exports, "x", …)`,
 *   `Object.defineProperties` / `Object.assign` with object-literal
 *   sources, `Reflect.set` / `Reflect.defineProperty` with a literal key.
 * - `require-result-member-write`: `require(…).x = v`, or `r.x = v` with
 *   `const r = require(…)`: a module that requires itself gets its own
 *   exports object back.
 * - `object-alias`: an export object's value bound to a local
 *   (`const e = exports`, lodash's `var freeExports = … && exports`): the
 *   local's own uses are censused ({@link finalObjectAliasUses}).
 * - `module-alias`: `module`'s value bound to a local
 *   (`var freeModule = … && module`): counted only when the local reads
 *   members other than `exports`, uses `exports` inertly, and writes
 *   nothing ({@link moduleAliasIsInert}).
 * - `unenumerable`: anything else -- an alias (`const e = exports`,
 *   `const m = module`), `module["exports"]`, the object handed to a call
 *   or returned, `Object.freeze(exports)`, the wrapper's `arguments`,
 *   `eval`, `require.cache`, a write through a key nothing names. The
 *   default: a form this union does not name is un-enumerable.
 */
type ExportWriteKind =
  | "read"
  | "property-write"
  | "property-other-write"
  | "whole-module-write"
  | "exports-rebinding"
  | "method-this-write"
  | "method-this-hand-off"
  | "define-property"
  | "require-result-member-write"
  | "object-alias"
  | "module-alias"
  | "unenumerable";

/**
 * Where a `this` is: module scope (the original exports object); a
 * non-arrow function or class method (`function`, the exports object when
 * called as one of its methods); a class's static field or static block
 * (`static`, the class); a constructor or instance field (`fresh`, the
 * instance being constructed).
 */
type ThisContext = "module" | "function" | "static" | "fresh";

/** How a value written into an export object can make a function one of its methods. */
type MethodSourceContext =
  /** The value of one property: a function value is a method. */
  | "property"
  /** The whole-module value: its properties' values, and a class's statics. */
  | "whole"
  /** An object whose properties are copied in (`Object.assign`, `defineProperties`). */
  | "container"
  /** A property descriptor (`defineProperty`): its `get`, `set` and `value`. */
  | "descriptor"
  /** A map of descriptors (`defineProperties`): each value is a `descriptor`. */
  | "descriptors";

/** A value written into an export object, with how it can become a method. */
type MethodSource = readonly [ts.Expression, MethodSourceContext];

/** Builds one {@link ExportReference} of a classification site. */
type MakeReference = (
  kind: ExportWriteKind,
  names?: ReadonlySet<string> | "all",
  values?: readonly MethodSource[],
  assignment?: ts.BinaryExpression,
) => ExportReference;

/** One censused reference, classified. */
interface ExportReference {
  readonly kind: ExportWriteKind;
  /** The names a write of this reference can set; `"all"` for a key nothing names. */
  readonly names: ReadonlySet<string> | "all";
  /** For a `property-write`: the assignment, and which spelling it writes through. */
  readonly assignment?: ts.BinaryExpression;
  readonly base?: ExportPropertyWrite["base"];
  /** Values this reference writes into an export object, for {@link exportMethodOwners}. */
  readonly values?: readonly MethodSource[];
  /** For a `method-this-hand-off`: the function (or, for a static or fresh `this`, the class) whose `this` is handed on. */
  readonly owner?: ts.Node;
  /** For an `object-alias` or a `module-alias`: the local bound to the value. */
  readonly alias?: ts.Identifier;
  readonly thisContext?: ThisContext;
  /** Whether it runs later than its statement, or never: inside a function body or an instance field initializer. */
  readonly deferred: boolean;
  readonly statementIndex: number;
}

/** A plain `=` property write, at the position the object-identity walk orders it. */
interface ExportPropertyWrite {
  readonly name: string;
  readonly assignment: ts.BinaryExpression;
  readonly statementIndex: number;
  /** `this` is module-scope `this`: the ORIGINAL exports object, whatever `exports` is rebound to. */
  readonly base: "exports" | "module.exports" | "this";
}

/**
 * The outermost form of `node` through parentheses and TypeScript's
 * wrappers that change no value (`as`, `<T>`, `!`, `satisfies`; the
 * emitted JavaScript drops them): `(exports as any).dec = v` is
 * `exports.dec = v` (task BL-105, RWF-150).
 */
function skipOuterValueWrappers(node: ts.Node): ts.Node {
  let current = node;
  while (
    current.parent !== undefined &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent))
  ) {
    current = current.parent;
  }
  return current;
}

/**
 * {@link ExportWriteKind} for one node, or `undefined` when the node is no
 * censused reference. `object` is the reference denoting an export object
 * (`exports`, `module.exports`, module-scope `this`); its use decides.
 */
function classifyObjectUse(
  object: ts.Node,
  base: ExportPropertyWrite["base"],
  deferred: boolean,
  statementIndex: number,
): ExportReference {
  const outer = skipOuterValueWrappers(object);
  const parent = outer.parent as ts.Node;
  const make: MakeReference = (kind, names = NO_NAMES, values, assignment) => ({
    kind,
    names,
    values,
    assignment,
    base,
    deferred,
    statementIndex,
  });
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === outer
  ) {
    const access = skipOuterValueWrappers(parent);
    const names = accessNames(parent);
    if (isPlainAssignmentTarget(access)) {
      const assignment = access.parent as ts.BinaryExpression;
      return make(
        "property-write",
        names,
        [[assignment.right, "property"]],
        assignment,
      );
    }
    if (isWriteTargetPosition(access)) {
      const writer = access.parent as ts.Node;
      // The value a compound write stores is its right-hand side's (or a
      // number); a destructuring or `for-of` target's is unreadable here,
      // so it stands in as a member read (any function).
      const values: readonly MethodSource[] =
        ts.isBinaryExpression(writer) && writer.left === access
          ? [[writer.right, "property"]]
          : ts.isPrefixUnaryExpression(writer) ||
              ts.isPostfixUnaryExpression(writer) ||
              ts.isDeleteExpression(writer)
            ? []
            : [[access as ts.Expression, "property"]];
      return make("property-other-write", names, values);
    }
    // A method called on the object runs with it as `this`: one of this
    // file's own functions is censused here; any other holds it.
    // A method this file never writes was put there by another module,
    // which already holds the object: whatever it writes is a write by
    // another module (E-4's), and calling it hands over nothing new.
    return callsForeignExportMethod(access) &&
      !isOwnLiteralMethodCall(access) &&
      !isMethodWrittenElsewhere(access)
      ? make("unenumerable")
      : make("read");
  }
  if (isInertUse(outer)) {
    return make("read");
  }
  if (ts.isCallExpression(parent) && parent.arguments[0] === outer) {
    return classifyHelperCall(parent, make);
  }
  const sink = valueSink(outer);
  return sink === undefined
    ? make("unenumerable")
    : { ...make("object-alias"), alias: sink };
}

/** `Object.x(E, …)`, `Reflect.x(E, …)` and `….hasOwnProperty.call(E, …)` with an export object `E` first. */
function classifyHelperCall(
  call: ts.CallExpression,
  make: MakeReference,
): ExportReference {
  const callee = unwrapParentheses(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) {
    return make("unenumerable");
  }
  const method = callee.name.text;
  const receiver = unwrapParentheses(callee.expression);
  // No builtin is trusted to only read the object (`Object.keys(E)`,
  // `Object.prototype.hasOwnProperty.call(E, k)`): builtins are shared by
  // every module of the process, and any of them -- this file through a
  // spelling no census sees (`({}).constructor.keys = f`), a sibling, the
  // entry -- may have replaced one with a function that writes onto what
  // it is handed (RWF-104, BL-075). Such a call is `unenumerable` below.
  const isObject = isAmbientReference(receiver, "Object");
  const isReflect = isAmbientReference(receiver, "Reflect");
  if (!isObject && !isReflect) {
    return make("unenumerable");
  }
  if (fileMayPatchBuiltins(call.getSourceFile())) {
    return make("unenumerable");
  }
  const [, second, third, ...rest] = call.arguments;
  if (
    method === "defineProperty" ||
    (isReflect && (method === "set" || method === "deleteProperty"))
  ) {
    const values: MethodSource[] =
      third === undefined
        ? []
        : [[third, method === "set" ? "property" : "descriptor"]];
    return make(
      "define-property",
      second === undefined ? "all" : keyNames(second),
      values,
    );
  }
  if (isObject && (method === "defineProperties" || method === "assign")) {
    const sources = (
      method === "assign" ? [second, third, ...rest] : [second]
    ).filter((source): source is ts.Expression => source !== undefined);
    const values = sources.map((source): MethodSource => [
      source,
      method === "assign" ? "container" : "descriptors",
    ]);
    const names = new Set<string>();
    for (const source of sources) {
      const literal = unwrapParentheses(source);
      const keys = ts.isObjectLiteralExpression(literal)
        ? objectLiteralKeyNames(literal)
        : "all";
      if (keys === "all") {
        return make("define-property", "all", values);
      }
      for (const key of keys) names.add(key);
    }
    return make("define-property", names, values);
  }
  // `Object.freeze`, `seal`, `preventExtensions`, `setPrototypeOf`, … :
  // a later write may fail, or the object's names change.
  return make("unenumerable");
}

/** Every name an object literal defines, or `"all"` when a spread or a key nothing names may define any. */
function objectLiteralKeyNames(
  literal: ts.ObjectLiteralExpression,
): ReadonlySet<string> | "all" {
  const names = new Set<string>();
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      return "all";
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      names.add(property.name.text);
      continue;
    }
    const key = property.name;
    const name = ts.isComputedPropertyName(key)
      ? resolveComputedPropertyNameLiteral(literal.getSourceFile(), key)
      : ts.isIdentifier(key) || ts.isPrivateIdentifier(key)
        ? key.text
        : exactCommonJsExportPropertyName(key as ts.Expression);
    if (name === undefined) {
      return "all";
    }
    names.add(name);
  }
  return names;
}

/** Whether `access` (`require.main`, `module.constructor`) is the base of a loader call (`require.main.require(…)`). */
function isLoaderCallBase(access: ts.Node): boolean {
  const member = access.parent as ts.Node | undefined;
  const call = member?.parent as ts.Node | undefined;
  return (
    member !== undefined &&
    ts.isPropertyAccessExpression(member) &&
    member.expression === access &&
    call !== undefined &&
    ts.isCallExpression(call) &&
    call.expression === member &&
    isLoaderCallee(member)
  );
}

function classifyExportReference(
  node: ts.Node,
  deferred: boolean,
  thisContext: ThisContext,
  owner: ts.Node | undefined,
  statementIndex: number,
): ExportReference | undefined {
  const make: MakeReference = (kind, names = NO_NAMES, values, assignment) => ({
    kind,
    names,
    values,
    assignment,
    deferred,
    statementIndex,
  });

  if (ts.isWithStatement(node)) {
    // Inside `with (o) { … }` an ambient name may be a property of `o`, so
    // `exports.x = v` there may write `o.exports` and `module.exports = v`
    // may not write the module at all. Its object expression is censused
    // like any other reference.
    return withBodyReachesExportNames(node.statement)
      ? make("unenumerable")
      : undefined;
  }
  if (ts.isExportAssignment(node) && node.isExportEquals) {
    // TypeScript's `export = X`: a whole-module write.
    return make("whole-module-write", NO_NAMES, [[node.expression, "whole"]]);
  }
  if (node.kind === ts.SyntaxKind.ThisKeyword) {
    if (thisContext === "module") {
      // Module-scope `this` is the ORIGINAL exports object.
      return classifyObjectUse(node, "this", deferred, statementIndex);
    }
    // In a function, `this` is the exports object when the function is
    // called as one of its methods (a static member's, when its class is
    // the whole-module value): any write through it may set a name. A
    // fresh instance's writes run while it is constructed, before any write
    // the walk orders after it; handing it on matters only when the
    // whole-module value may be such an instance ({@link exportMethodOwners}).
    const outer = skipOuterParentheses(node);
    const parent = outer.parent as ts.Node;
    if (
      (ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent)) &&
      parent.expression === outer
    ) {
      if (!isWriteTargetPosition(skipOuterParentheses(parent))) {
        return make("read");
      }
      return thisContext === "fresh"
        ? undefined
        : {
            ...make("method-this-write", accessNames(parent)),
            owner,
            thisContext,
          };
    }
    if (isInertUse(outer)) {
      return make("read");
    }
    return { ...make("method-this-hand-off"), owner, thisContext };
  }
  if (node.kind === ts.SyntaxKind.SuperKeyword) {
    // A `super` property write sets the property on `this`, the receiver
    // (RWF-117, BL-084): a method's `this` write by another spelling. A read
    // or a call through `super` reads the home object's prototype.
    const parent = node.parent as ts.Node;
    if (
      (ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent)) &&
      parent.expression === node &&
      isWriteTargetPosition(skipOuterParentheses(parent)) &&
      thisContext !== "fresh"
    ) {
      return {
        ...make("method-this-write", accessNames(parent)),
        owner,
        thisContext,
      };
    }
    return undefined;
  }

  if (isPrototypeTampering(node)) {
    return make("unenumerable");
  }
  // A load that may load this very file returns its exports object (a
  // self-load): the result is an alias of it, wherever it flows (E-1's
  // independent audit, finding 1). A member write on it withdraws the
  // name; a binding it flows into is censused like any alias; anything
  // else hands it on.
  if (
    ts.isCallExpression(node) &&
    isRequireResult(node) &&
    mayLoadThisFile(node)
  ) {
    const top = climbValue(node);
    const parent = top.parent as ts.Node;
    if (
      (ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent)) &&
      parent.expression === top
    ) {
      const access = skipOuterParentheses(parent);
      if (!isWriteTargetPosition(access)) {
        return make("read");
      }
      const writer = access.parent as ts.Node;
      return make(
        "require-result-member-write",
        accessNames(parent),
        ts.isBinaryExpression(writer) && writer.left === access
          ? [[writer.right, "property"]]
          : [[access as ts.Expression, "property"]],
      );
    }
    if (isInertUse(top)) {
      return make("read");
    }
    const sink = valueSink(top);
    return sink === undefined
      ? make("unenumerable")
      : { ...make("object-alias"), alias: sink };
  }
  // A member write on any load's result, directly, through a binding or
  // through a chain of members (`require("./other").run = v`, `o.run = v`,
  // `o.self.run = v`): the loaded module may hand this file's exports object
  // back, so it withdraws the name (E-1's re-audit, F1).
  if (
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)) &&
    isWriteTargetPosition(skipOuterParentheses(node)) &&
    baseMayBeLoaded(node.expression)
  ) {
    return make("require-result-member-write", accessNames(node));
  }

  if (!ts.isIdentifier(node)) {
    return undefined;
  }
  // Task BL-105 (its independent audit, finding 1): TypeScript compiles a
  // write to a named or default import binding (`d2 = v`, `d2 ||= v`,
  // `[d2] = [v]`) into a member write on the load's result
  // (`decs_1.dec = v`), which a self-import makes this file's own exports.
  if (isWriteTargetPosition(skipOuterValueWrappers(node))) {
    const declaration = lexicalDeclarationOf(node, node.text);
    const imported =
      declaration === undefined ? undefined : importedNameOf(declaration);
    if (imported !== undefined) {
      return make("require-result-member-write", new Set([imported]));
    }
  }
  switch (node.text) {
    case "exports": {
      if (!isAmbientReference(node, "exports")) {
        return undefined;
      }
      const outer = skipOuterValueWrappers(node);
      if (isPlainAssignmentTarget(outer)) {
        return make(
          "exports-rebinding",
          NO_NAMES,
          undefined,
          outer.parent as ts.BinaryExpression,
        );
      }
      if (isWriteTargetPosition(outer)) {
        return make("unenumerable");
      }
      // `module.exports = exports`: the value is tracked by the identity walk.
      const parent = outer.parent as ts.Node;
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.right === outer &&
        isModuleExportsAssignmentTarget(unwrapParentheses(parent.left))
      ) {
        return make("read");
      }
      return classifyObjectUse(node, "exports", deferred, statementIndex);
    }
    case "module": {
      if (!isAmbientReference(node, "module")) {
        return undefined;
      }
      const outer = skipOuterValueWrappers(node);
      const parent = outer.parent as ts.Node;
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === outer
      ) {
        const member = parent.name.text;
        if (member !== "exports") {
          // Only the members that reach no module object are reads
          // (`module.id`, `module.filename`, a `module.require(…)` load,
          // censused as a loader call); `module.parent.children` and
          // `module.children` can hold this module itself, and
          // `module.constructor` reaches the loader's cache (E-1's
          // independent audit, finding 2).
          // A member only tested (`!module.nodeType`) hands nothing on.
          return INERT_MODULE_MEMBERS.has(member) ||
            isInertUse(skipOuterParentheses(parent)) ||
            (member === "constructor" && isLoaderCallBase(parent))
            ? make("read")
            : make("unenumerable");
        }
        const access = skipOuterValueWrappers(parent);
        if (isPlainAssignmentTarget(access)) {
          // Only a spelling the whole-module relations order
          // ({@link competingWriteSites}) is theirs; a cast one
          // (`(module as any).exports = v`) is no write they see.
          const assignment = access.parent as ts.BinaryExpression;
          return isModuleExportsAssignmentTarget(
            unwrapParentheses(assignment.left),
          )
            ? make("whole-module-write", NO_NAMES, [
                [assignment.right, "whole"],
              ])
            : make("unenumerable");
        }
        if (isWriteTargetPosition(access)) {
          return make("unenumerable");
        }
        // `exports = module.exports`: tracked by the identity walk.
        const accessParent = access.parent as ts.Node;
        if (
          ts.isBinaryExpression(accessParent) &&
          accessParent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          accessParent.right === access &&
          isAmbientReference(unwrapParentheses(accessParent.left), "exports")
        ) {
          return make("read");
        }
        return classifyObjectUse(
          parent,
          "module.exports",
          deferred,
          statementIndex,
        );
      }
      if (isInertUse(outer)) {
        return make("read");
      }
      const moduleSink = valueSink(outer);
      return moduleSink === undefined
        ? make("unenumerable")
        : { ...make("module-alias"), alias: moduleSink };
    }
    case "require": {
      if (!isAmbientReference(node, "require")) {
        return undefined;
      }
      const outer = skipOuterParentheses(node);
      const parent = outer.parent as ts.Node;
      if (ts.isCallExpression(parent) && parent.expression === outer) {
        return make("read");
      }
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === outer
      ) {
        // `require.cache` holds this module; `require.main` is this module
        // when it is the entry, except in a comparison.
        if (parent.name.text === "cache") {
          return make("unenumerable");
        }
        if (parent.name.text === "main") {
          // `require.main.require(…)` is a loader call (its result is
          // censused like `require(…)`'s).
          return isInertUse(skipOuterParentheses(parent)) ||
            isLoaderCallBase(parent)
            ? make("read")
            : make("unenumerable");
        }
        return make("read");
      }
      if (isInertUse(outer)) {
        return make("read");
      }
      // `const r = require`: a loader alias, whose calls are censused like
      // `require(…)`'s, as long as it is only ever called.
      const loaderSink = valueSink(outer);
      return loaderSink !== undefined &&
        ts.isVariableDeclaration(loaderSink.parent) &&
        loaderAliasIsOnlyCalled(loaderSink)
        ? make("read")
        : make("unenumerable");
    }
    case "arguments":
      return thisContext === "module" && isAmbientReference(node, "arguments")
        ? make("unenumerable")
        : undefined;
    case "eval":
      // Only a DIRECT `eval(…)` sees the module's scope; an indirect one runs
      // in the global scope, where `module` and `exports` are not bound.
      return isAmbientReference(node, "eval") &&
        ts.isCallExpression(skipOuterParentheses(node).parent) &&
        (skipOuterParentheses(node).parent as ts.CallExpression).expression ===
          skipOuterParentheses(node)
        ? make("unenumerable")
        : undefined;
    default:
      return undefined;
  }
}

export { classifyExportReference };
export type {
  ThisContext,
  MethodSourceContext,
  MethodSource,
  ExportReference,
  ExportPropertyWrite,
};
