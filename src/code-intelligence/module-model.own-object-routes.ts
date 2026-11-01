/**
 * Own-object routes: the routes by which a file's own export objects reach
 * its own functions, and the owners of the methods its export objects carry.
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
  isStaticClassElement,
  isPrimitiveValue,
  isAmbientReference,
  thisBindingFunction,
  isInertUse,
  keyNames,
  accessNames,
  skipOuterParentheses,
  isRequireResult,
  isWriteTargetPosition,
} from "./module-model.syntax.js";
import type {
  MethodSourceContext,
  MethodSource,
} from "./module-model.export-references.js";
import {
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
} from "./module-model.final-object.js";
import { routeKeyNames } from "./module-model.route-keys.js";
import {
  isForeignRoot,
  localCallable,
  returnedValues,
  isRequireResultMember,
} from "./module-model.export-methods.js";
import {
  isInStrictCode,
  valueIsGlobalObject,
} from "./module-model.loader-registry.js";

/** {@link ownObjectRoutes}'s answer. */
interface OwnObjectRoutes {
  /** Expressions that may evaluate to an own function, censused like its binding. */
  readonly expressions: readonly ts.Expression[];
  /** Bindings a destructuring may bind to one, censused as aliases. */
  readonly aliases: readonly ts.Identifier[];
}

const ownObjectRoutesBySourceFile = new WeakMap<
  ts.SourceFile,
  OwnObjectRoutes | "all"
>();
let ownObjectRouteWalks = 0;

/** How many files {@link ownObjectRoutes} walked (an operation count for the structural performance test). */
export function exportOwnObjectRouteWalks(): number {
  return ownObjectRouteWalks;
}

/**
 * Every expression of the file that may evaluate to one of `owners` (the
 * final export object's functions and classes,
 * {@link finalObjectOwnFunctions}) WITHOUT spelling its binding (task
 * BL-084; RWF-114 to RWF-117), or `"all"` when one is handed where no census
 * follows it. A named function or class expression's own name, the other
 * binding to the same object, is censused as an alias by
 * {@link finalObjectRouteUses} (round 4). Measured against real Node
 * (`tests/oracle/bl084-function-own-object.test.ts`):
 *
 * - `arguments` in the frame of a sloppy owner (an arrow's is its
 *   enclosing function's), identified by binding: undeclared or a `var`
 *   ({@link isArgumentsObjectReference}): `arguments.callee`, and a read by
 *   a key that may be `"callee"`, are routes; `arguments` handed on (an
 *   argument, `.apply`, a spread, a destructuring) is `"all"`. In strict
 *   code `callee` throws (RWF-114). A sloppy function's own `arguments`
 *   property is that object too (`Api.arguments.callee`), so when an owner
 *   is sloppy a read of `callee` from any base is a route.
 * - `new.target` in an owner's frame (a function, or a class's
 *   constructor), and in any constructor or function of the file when an
 *   owner class has a heritage clause (`super()` passes it on) (RWF-115).
 * - A read of `constructor` -- of the `prototype` and of every instance,
 *   by any base, since no census follows where an instance flows -- and a
 *   read by a key computed at run time, which may be `"constructor"`,
 *   `"callee"` or `"caller"` (RWF-115), unless the key is provably a
 *   number or a boolean ({@link isNumericValue}).
 * - A read of `caller`, when an owner is sloppy: a sloppy function is the
 *   `caller` of the function it calls (RWF-116).
 * - A stack callsite's `getFunction()` and `getThis()`
 *   (`Error.prepareStackTrace`), which give a sloppy frame's function and
 *   receiver, called directly; either taken as a value or spelled as a
 *   string, and `prepareStackTrace` spelled as a name or a string key, is
 *   `"all"`. Built at run time (`"prepare" + "StackTrace"`, then `s[0][m]()`),
 *   the callsite reader is a call whose result is not censused: RWF-118.
 * - `Reflect.get(…)`, whose result is a property's value; the holders
 *   `Object.getOwnPropertyDescriptor(s)`, `Object.values` / `entries` and
 *   `Reflect.getOwnPropertyDescriptor`, any of those members but called
 *   directly, an ambient `Reflect` or `Object` but as the base of a member
 *   of an exact key (or `Object(…)`), and `Reflect` or `Object` read from
 *   the global object, are `"all"` unless used inertly
 *   ({@link isConfinedReaderNamespace}; BL-084's audit, F5).
 * - A destructuring that reads `constructor`, `caller` or a computed key
 *   binds an alias; into anything but a plain binding it is `"all"`.
 * - A `with` statement may resolve any name to a holder's member: `"all"`.
 *
 * Accepted bounds, as for every census of one file: code of another module
 * (a function of another module this file's functions call may read its
 * `caller`; another module may read an instance's `constructor`, hand this
 * file the function or an instance, or install `Error.prepareStackTrace`
 * so that this file's frames are callsites), and accessors other modules
 * install on the builtin prototypes (RWF-113).
 */
function ownObjectRoutes(
  sourceFile: ts.SourceFile,
  owners: ReadonlySet<ts.Node>,
): OwnObjectRoutes | "all" {
  const cached = ownObjectRoutesBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  ownObjectRouteWalks += 1;
  const expressions = new Set<ts.Expression>();
  const aliases: ts.Identifier[] = [];
  let all = false;
  const sloppyOwners = new Set(
    [...owners].filter(
      (owner) => ts.isFunctionLike(owner) && !isInStrictCode(owner),
    ),
  );
  const superChain = [...owners].some(
    (owner) =>
      ts.isClassLike(owner) &&
      (owner.heritageClauses ?? []).some(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
      ),
  );
  const isRoutingKey = (names: ReadonlySet<string> | "all"): boolean =>
    names === "all" ||
    names.has("constructor") ||
    // A sloppy function's `arguments` property is its frame's arguments
    // object (`Api.arguments.callee`), held by any value: `callee` routes
    // from every base, as `caller` does (BL-084's audit, round 2).
    (sloppyOwners.size > 0 && (names.has("caller") || names.has("callee")));
  const isAmbientReader = (
    node: ts.Node,
    members: ReadonlySet<string>,
  ): boolean =>
    ts.isPropertyAccessExpression(node) &&
    members.has(node.name.text) &&
    (isAmbientReference(node.expression, "Reflect") ||
      isAmbientReference(node.expression, "Object"));

  const visit = (node: ts.Node): void => {
    if (all) {
      return;
    }
    if (ts.isWithStatement(node)) {
      all = true;
      return;
    }
    if (
      ts.isMetaProperty(node) &&
      node.keywordToken === ts.SyntaxKind.NewKeyword
    ) {
      const frame = thisBindingFunction(node);
      if (
        frame !== undefined &&
        (owners.has(frame) ||
          (ts.isConstructorDeclaration(frame) && owners.has(frame.parent)) ||
          (superChain &&
            (ts.isConstructorDeclaration(frame) ||
              ts.isFunctionDeclaration(frame) ||
              ts.isFunctionExpression(frame))))
      ) {
        expressions.add(node);
      }
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      (STACK_FRAME_KEYS.has(node.text) || node.text === "prepareStackTrace")
    ) {
      // A stack callsite's reader, or the hook, spelled as a key
      // (`s[0]["getFunction"]()`, `Error["prepareStackTrace"] = …`).
      all = true;
      return;
    }
    if (ts.isIdentifier(node)) {
      if (node.text === "prepareStackTrace") {
        // This file shapes stack frames into callsites, whose readers it may
        // reach by keys no census follows (`c[m]()`).
        all = true;
        return;
      }
      if (isArgumentsObjectReference(node)) {
        const frame = thisBindingFunction(node);
        if (frame !== undefined && sloppyOwners.has(frame)) {
          const outer = skipOuterParentheses(node);
          const parent = outer.parent as ts.Node;
          if (
            (ts.isPropertyAccessExpression(parent) ||
              ts.isElementAccessExpression(parent)) &&
            parent.expression === outer
          ) {
            const names = routeKeyNames(parent);
            if (
              !isWriteTargetPosition(skipOuterParentheses(parent)) &&
              (names === "all" || names.has("callee"))
            ) {
              expressions.add(parent);
            }
          } else if (!isInertUse(outer)) {
            all = true;
            return;
          }
        }
      } else if (
        (isAmbientReference(node, "Reflect") ||
          isAmbientReference(node, "Object")) &&
        !isConfinedReaderNamespace(node)
      ) {
        // `Reflect` or `Object` handed on, aliased or keyed at run time:
        // its readers are no longer seen where they are called (BL-084's
        // audit, F5).
        all = true;
        return;
      }
      return;
    }
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      !isWriteTargetPosition(skipOuterParentheses(node))
    ) {
      if (isRoutingKey(routeKeyNames(node))) {
        expressions.add(node);
      }
      const call = skipOuterParentheses(node).parent as ts.Node;
      const called =
        ts.isCallExpression(call) &&
        call.expression === skipOuterParentheses(node);
      if (isAmbientReader(node, VALUE_OR_HOLDER_READERS) && !called) {
        // A reader taken as a value (`var gOPD = Object.getOwnPropertyDescriptor`).
        all = true;
        return;
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        STACK_FRAME_KEYS.has(node.name.text) &&
        !called
      ) {
        // A callsite's reader taken as a value (`const gf = s[0].getFunction`).
        all = true;
        return;
      }
      const reached = accessNames(node);
      if (
        (reached === "all" ||
          reached.has("Reflect") ||
          reached.has("Object")) &&
        valueIsGlobalObject(node.expression)
      ) {
        // `globalThis.Reflect`, `global["Object"]`: the readers by a name
        // the ambient census does not see (BL-084's audit, F5).
        all = true;
        return;
      }
      if (called && ts.isPropertyAccessExpression(node)) {
        const member = node.name.text;
        if (member === "getFunction" || member === "getThis") {
          expressions.add(call as ts.CallExpression);
        } else if (isAmbientReader(node, VALUE_READERS)) {
          expressions.add(call as ts.CallExpression);
        } else if (isAmbientReader(node, HOLDER_READERS) && !isInertUse(call)) {
          all = true;
          return;
        }
      }
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      const names = ts.isComputedPropertyName(key)
        ? keyNames(key.expression)
        : ts.isIdentifier(key) || ts.isStringLiteral(key)
          ? new Set([key.text])
          : "all";
      if (node.dotDotDotToken === undefined && isRoutingKey(names)) {
        if (ts.isIdentifier(node.name)) {
          aliases.push(node.name);
        } else {
          all = true;
          return;
        }
      }
    }
    if (
      ts.isObjectLiteralExpression(node) &&
      isWriteTargetPosition(skipOuterParentheses(node)) &&
      node.properties.some(
        (property) =>
          property.name !== undefined &&
          isRoutingKey(
            ts.isComputedPropertyName(property.name)
              ? keyNames(property.name.expression)
              : ts.isIdentifier(property.name) ||
                  ts.isStringLiteral(property.name)
                ? new Set([property.name.text])
                : "all",
          ),
      )
    ) {
      // A destructuring assignment reading a routing key.
      all = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const routes: OwnObjectRoutes | "all" = all
    ? "all"
    : { expressions: [...expressions], aliases };
  ownObjectRoutesBySourceFile.set(sourceFile, routes);
  return routes;
}

/**
 * What the routes to the final export object's own functions and classes
 * write onto them (task BL-084): each route accounted like a reference to
 * the binding ({@link accountFinalObjectUse}), each destructured alias
 * like the binding's alias ({@link finalObjectAliasUses}). `undefined`
 * when the final object may be no function or class of this file.
 */
function finalObjectRouteUses(sourceFile: ts.SourceFile):
  | {
      readonly names: ReadonlySet<string>;
      readonly values: readonly ts.Expression[];
    }
  | "all"
  | undefined {
  const owners = finalObjectOwnFunctions(sourceFile);
  if (owners.size === 0) {
    return undefined;
  }
  const routes = ownObjectRoutes(sourceFile, owners);
  if (routes === "all") {
    return "all";
  }
  const account = newFinalObjectAccount();
  const merge = (other: ts.Identifier): void =>
    mergeFinalObjectAlias(account, finalObjectAliasUses(sourceFile, other));
  // A named function or class expression's own name is a second binding to
  // the same object (`const Api = function Inner() { Inner.run = v; }`;
  // BL-084's audit, round 4).
  for (const owner of owners) {
    if (
      (ts.isFunctionExpression(owner) || ts.isClassExpression(owner)) &&
      owner.name !== undefined
    ) {
      merge(owner.name);
    }
  }
  for (const alias of routes.aliases) {
    merge(alias);
  }
  for (const route of routes.expressions) {
    if (account.handedOn) {
      break;
    }
    accountFinalObjectUse(route, account, merge, undefined);
  }
  accountSelfHeldReads(sourceFile, account, merge);
  return account.handedOn
    ? "all"
    : { names: account.names, values: account.values };
}

/**
 * The functions whose `this` can be an export object, because they can be
 * one of its methods (task E-1): every function value written into an
 * export object -- a property write's value, the whole-module value's
 * properties and, for a class, its static members, an `Object.assign` or
 * `defineProperties` source's values, a `defineProperty` descriptor's `get`,
 * `set` and `value`. A class is listed for its static fields and blocks.
 *
 * `"all"` when any of those values is something this cannot read -- a
 * call, a `new`, a member read, a parameter, a binding the file reassigns:
 * it may be any function of the file, and a whole-module value that is a
 * call's or a `new`'s result may be an instance of any class of the file.
 * A value from another module (`require(…)`, an import) brings that
 * module's functions, whose `this` is no census's (an accepted bound); a
 * nested object literal's methods have that object as `this`.
 */
function exportMethodOwners(
  sourceFile: ts.SourceFile,
  sources: readonly MethodSource[],
): ReadonlySet<ts.Node> | "all" {
  const owners = new Set<ts.Node>();
  let all = false;
  const visiting = new Set<ts.Node>();
  const addClass = (node: ts.ClassLikeDeclaration): void => {
    owners.add(node);
    for (const member of node.members) {
      if (
        isStaticClassElement(member) &&
        (ts.isMethodDeclaration(member) || ts.isAccessor(member))
      ) {
        owners.add(member);
      }
    }
  };
  const addObject = (
    literal: ts.ObjectLiteralExpression,
    accessors: boolean,
  ): void => {
    for (const property of literal.properties) {
      if (ts.isSpreadAssignment(property)) {
        all = true;
      } else if (
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === "__proto__"
      ) {
        // The prototype's methods are inherited, run with this object as
        // `this`.
        add(property.initializer, "container");
      } else if (ts.isPropertyAssignment(property)) {
        add(property.initializer, "property");
      } else if (ts.isShorthandPropertyAssignment(property)) {
        add(property.name, "property");
      } else if (ts.isMethodDeclaration(property)) {
        owners.add(property);
      } else if (accessors) {
        owners.add(property);
      }
    }
  };
  const add = (
    expression: ts.Expression,
    context: MethodSourceContext,
    depth = 0,
  ): void => {
    const value = unwrapParentheses(unwrapValue(expression));
    if (all || depth > 3) {
      all = true;
      return;
    }
    // A primitive and an arrow have no `this` of their own; an array is
    // its elements' `this`, never the export object's.
    if (
      isPrimitiveValue(value) ||
      ts.isArrowFunction(value) ||
      ts.isArrayLiteralExpression(value) ||
      ts.isRegularExpressionLiteral(value) ||
      ts.isTemplateExpression(value)
    ) {
      return;
    }
    if (ts.isFunctionExpression(value)) {
      if (context !== "whole") owners.add(value);
      return;
    }
    if (ts.isClassExpression(value)) {
      if (context === "whole") addClass(value);
      return;
    }
    if (ts.isObjectLiteralExpression(value)) {
      if (context === "whole" || context === "container") {
        addObject(value, context === "whole");
      } else if (context === "descriptors") {
        for (const property of value.properties) {
          if (ts.isPropertyAssignment(property)) {
            add(property.initializer, "descriptor", depth + 1);
          } else if (ts.isShorthandPropertyAssignment(property)) {
            add(property.name, "descriptor", depth + 1);
          } else {
            all = true;
          }
        }
      } else if (context === "descriptor") {
        for (const property of value.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === "value"
          ) {
            add(property.initializer, "property", depth + 1);
          } else if (
            ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property)
          ) {
            add(
              ts.isPropertyAssignment(property)
                ? property.initializer
                : property.name,
              "property",
              depth + 1,
            );
          } else if (!ts.isSpreadAssignment(property)) {
            owners.add(property);
          } else {
            all = true;
          }
        }
      }
      return;
    }
    if (isRequireResult(value) || isRequireResultMember(value)) {
      return;
    }
    // The value is one of the operands.
    if (ts.isConditionalExpression(value)) {
      add(value.whenTrue, context, depth + 1);
      add(value.whenFalse, context, depth + 1);
      return;
    }
    if (
      ts.isBinaryExpression(value) &&
      (value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      add(value.left, context, depth + 1);
      add(value.right, context, depth + 1);
      return;
    }
    if (
      ts.isBinaryExpression(value) &&
      value.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      add(value.right, context, depth + 1);
      return;
    }
    // Read off a global or another module (`Error.captureStackTrace`,
    // `lib.util.x`): no function of this file.
    if (
      (ts.isPropertyAccessExpression(value) ||
        ts.isElementAccessExpression(value)) &&
      isForeignRoot(value)
    ) {
      return;
    }
    // A call's (or a construction's) result outside the whole-module
    // position is one of this file's functions only through what the callee
    // returns -- for one of this file's own callees -- or through what it was
    // handed -- for a global's or another module's. A whole-module value
    // that is a call's or a construction's result may be an instance of any
    // class of the file.
    if (
      (ts.isCallExpression(value) || ts.isNewExpression(value)) &&
      context !== "whole"
    ) {
      const callee = unwrapParentheses(value.expression);
      if (
        ts.isCallExpression(value) &&
        isAmbientReference(
          ts.isPropertyAccessExpression(callee) ? callee.expression : callee,
          "Symbol",
        )
      ) {
        return;
      }
      // An instance of one of this file's classes has itself as its
      // methods' `this`; only a constructor's explicit return is another value.
      const constructed =
        ts.isNewExpression(value) && ts.isIdentifier(callee)
          ? lexicalDeclarationOf(callee, callee.text)
          : ts.isNewExpression(value) && ts.isClassExpression(callee)
            ? callee
            : undefined;
      if (
        constructed !== undefined &&
        (ts.isClassDeclaration(constructed) ||
          ts.isClassExpression(constructed)) &&
        !(
          ts.isIdentifier(callee) &&
          isNameAssignedWithin(sourceFile, callee.text)
        )
      ) {
        const ctor = constructed.members.find(ts.isConstructorDeclaration);
        for (const returned of ctor === undefined ? [] : returnedValues(ctor)) {
          add(returned, "property", depth + 1);
        }
        return;
      }
      const local = localCallable(sourceFile, callee);
      if (local !== undefined) {
        for (const returned of returnedValues(local)) {
          // A returned parameter (an enum IIFE's `return E2`) is what this
          // call passed at its position -- unless the parameter is written,
          // rest, or the call spreads its arguments.
          const unwrapped = unwrapParentheses(returned);
          const declared = ts.isIdentifier(unwrapped)
            ? lexicalDeclarationOf(unwrapped, unwrapped.text)
            : undefined;
          const parameter =
            declared !== undefined && ts.isParameter(declared)
              ? declared
              : undefined;
          const at =
            parameter === undefined ? -1 : local.parameters.indexOf(parameter);
          if (parameter !== undefined && at >= 0) {
            const args = value.arguments ?? [];
            if (
              parameter.dotDotDotToken !== undefined ||
              !ts.isIdentifier(parameter.name) ||
              isNameAssignedWithin(local, parameter.name.text) ||
              args.some(ts.isSpreadElement)
            ) {
              all = true;
              return;
            }
            const argument = args[at] ?? parameter.initializer;
            if (argument !== undefined) {
              add(argument, "property", depth + 1);
            }
            continue;
          }
          add(returned, "property", depth + 1);
        }
        return;
      }
      if (isForeignRoot(callee)) {
        for (const argument of value.arguments ?? []) {
          add(
            argument,
            ts.isObjectLiteralExpression(unwrapParentheses(argument))
              ? "container"
              : "property",
            depth + 1,
          );
        }
        return;
      }
      all = true;
      return;
    }
    if (ts.isIdentifier(value)) {
      if (isAmbientReference(value, "exports")) {
        return;
      }
      const declaration = lexicalDeclarationOf(value, value.text);
      if (declaration === undefined) {
        // A global (`Object`, `Symbol.iterator`'s owner): no function of
        // this file.
        return;
      }
      if (
        ts.isImportSpecifier(declaration) ||
        ts.isImportClause(declaration) ||
        ts.isNamespaceImport(declaration) ||
        ts.isImportEqualsDeclaration(declaration)
      ) {
        return;
      }
      if (ts.isFunctionDeclaration(declaration)) {
        if (context !== "whole") owners.add(declaration);
        return;
      }
      if (ts.isClassDeclaration(declaration)) {
        if (context === "whole") addClass(declaration);
        return;
      }
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined &&
        !isNameAssignedWithin(sourceFile, value.text)
      ) {
        // A binding read inside its own initializer (`var E = f(E || {})`)
        // is still `undefined` there: the cycle adds no value.
        if (visiting.has(declaration)) {
          return;
        }
        visiting.add(declaration);
        add(declaration.initializer, context, depth + 1);
        visiting.delete(declaration);
        return;
      }
      // Destructured from another module (`const { bold } = require("x")`).
      if (ts.isBindingElement(declaration)) {
        let holder: ts.Node = declaration;
        while (
          ts.isBindingElement(holder) ||
          ts.isObjectBindingPattern(holder) ||
          ts.isArrayBindingPattern(holder)
        ) {
          holder = holder.parent;
        }
        if (
          ts.isVariableDeclaration(holder) &&
          holder.initializer !== undefined &&
          isForeignRoot(holder.initializer) &&
          !isNameAssignedWithin(sourceFile, value.text)
        ) {
          return;
        }
      }
      all = true;
      return;
    }
    all = true;
  };
  for (const [expression, context] of sources) {
    add(expression, context);
    if (all) {
      return "all";
    }
  }
  return owners;
}

export { finalObjectRouteUses, exportMethodOwners };
