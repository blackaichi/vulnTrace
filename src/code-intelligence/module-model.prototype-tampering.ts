/**
 * Prototype tampering: whether a write reaches a builtin prototype or the
 * module loader's own objects, and whether a file may patch the builtins its
 * readers rely on.
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
import {
  isNonReferenceName,
  isAmbientReference,
  identifiersSpelled,
  climbValue,
  BUILTIN_CONSTRUCTORS,
  isInertUse,
  skipOuterParentheses,
  isRequireResult,
  isWriteTargetPosition,
} from "./module-model.syntax.js";
import {
  reachesGlobalObject,
  processValueIsInert,
} from "./module-model.alias-summaries.js";

/** `Object` methods that only read an object they are handed. */
const OBJECT_READERS: ReadonlySet<string> = new Set([
  "keys",
  "values",
  "entries",
  "getOwnPropertyNames",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getOwnPropertySymbols",
  "getPrototypeOf",
  "isFrozen",
  "isSealed",
  "isExtensible",
  "hasOwn",
]);

/** `Reflect` methods that only read an object they are handed. */
const REFLECT_READERS: ReadonlySet<string> = new Set([
  "get",
  "has",
  "ownKeys",
  "getOwnPropertyDescriptor",
  "getPrototypeOf",
  "isExtensible",
]);

/**
 * Whether `node` changes what EVERY object inherits, or reaches the loader
 * (E-1's independent audit, finding 4): then an export object may have an
 * inherited setter, getter or method no write of the file spells, and
 * `exports.x = v` may not even create a property.
 *
 * - `X.prototype` of an ambient global (`Object.prototype`,
 *   `Function.prototype`, …) written, written through
 *   (`Object.prototype.m = f`), or handed to a call
 *   (`Object.defineProperty(Object.prototype, "run", …)`); a read of it
 *   (`Object.prototype.hasOwnProperty.call(…)`) is not;
 * - a `__defineGetter__` or `__defineSetter__` call on anything;
 * - `process.mainModule` (the entry `Module`, whose `children` can hold this
 *   module) and a load of the `module` builtin (`require("module")._cache`,
 *   `._load`).
 */
function isPrototypeTampering(node: ts.Node): boolean {
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    const name = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : exactCommonJsExportPropertyName(
          unwrapParentheses(node.argumentExpression),
        );
    const base = unwrapParentheses(node.expression);
    if (
      name === "prototype" &&
      ts.isIdentifier(base) &&
      isAmbientReference(base, base.text) &&
      !["exports", "module", "require"].includes(base.text)
    ) {
      const outer = skipOuterParentheses(node);
      const parent = outer.parent as ts.Node;
      if (isWriteTargetPosition(outer)) {
        return true;
      }
      if (
        (ts.isPropertyAccessExpression(parent) ||
          ts.isElementAccessExpression(parent)) &&
        parent.expression === outer
      ) {
        return isWriteTargetPosition(skipOuterParentheses(parent));
      }
      return (
        ts.isCallExpression(parent) &&
        parent.arguments.some(
          (argument) => unwrapParentheses(argument) === node,
        ) &&
        !isBuiltinReaderCall(parent)
      );
    }
    if (
      name === "mainModule" &&
      ts.isIdentifier(base) &&
      isAmbientReference(base, "process")
    ) {
      return true;
    }
    if (
      (name === "__defineGetter__" || name === "__defineSetter__") &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression === node
    ) {
      return true;
    }
    // `globalThis.process`, `root.process` where `root` is bound to the
    // global object (lodash's `freeGlobal.process`), or a global's member
    // nothing names (E-1's re-audit, F3).
    if (
      (name === undefined || name === "process") &&
      reachesGlobalObject(base)
    ) {
      return name === undefined || !processValueIsInert(node);
    }
    return false;
  }
  if (isAmbientReference(node, "process")) {
    return !processValueIsInert(node);
  }
  if (ts.isCallExpression(node) && isRequireResult(node)) {
    const [first] = node.arguments;
    const argument = first === undefined ? undefined : unwrapParentheses(first);
    if (
      argument !== undefined &&
      ts.isStringLiteralLike(argument) &&
      (argument.text === "process" || argument.text === "node:process")
    ) {
      // The `process` builtin is the `process` object itself.
      return !processValueIsInert(node);
    }
    return (
      argument !== undefined &&
      ts.isStringLiteralLike(argument) &&
      (argument.text === "module" || argument.text === "node:module")
    );
  }
  return false;
}

/** `Object.prototype` methods that read their `this` and write nothing. */
const PROTOTYPE_READER_METHODS: ReadonlySet<string> = new Set([
  "hasOwnProperty",
  "propertyIsEnumerable",
  "isPrototypeOf",
]);

/**
 * Whether `call` only reads the objects it is handed: an ambient `Object`
 * or `Reflect` reader (`Object.getOwnPropertyDescriptor(Map.prototype, …)`),
 * or `.call` / `.apply` of a builtin prototype's reader method, spelled
 * directly or through a binding initialized to it and never written
 * (qs's `var has = Object.prototype.hasOwnProperty; has.call(o, k)`).
 * Used only for an ambient prototype handed to it
 * ({@link isPrototypeTampering}): any code holds those anyway. An export
 * object handed to one is handed to code (RWF-104, BL-075).
 */
function isBuiltinReaderCall(call: ts.CallExpression): boolean {
  return (
    isSyntacticReaderCall(call) && !fileMayPatchBuiltins(call.getSourceFile())
  );
}

/** {@link isBuiltinReaderCall}'s spelling alone, trusting that the builtins it names are the builtins. */
function isSyntacticReaderCall(call: ts.CallExpression): boolean {
  const callee = unwrapParentheses(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) {
    return false;
  }
  const receiver = unwrapParentheses(callee.expression);
  if (isAmbientReference(receiver, "Object")) {
    return OBJECT_READERS.has(callee.name.text);
  }
  if (isAmbientReference(receiver, "Reflect")) {
    return REFLECT_READERS.has(callee.name.text);
  }
  if (callee.name.text !== "call" && callee.name.text !== "apply") {
    return false;
  }
  let method: ts.Expression = receiver;
  if (ts.isIdentifier(method)) {
    const declaration = lexicalDeclarationOf(method, method.text);
    if (
      declaration === undefined ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer === undefined ||
      isNameAssignedWithin(call.getSourceFile(), method.text)
    ) {
      return false;
    }
    method = unwrapParentheses(declaration.initializer);
  }
  if (
    !ts.isPropertyAccessExpression(method) ||
    !PROTOTYPE_READER_METHODS.has(method.name.text)
  ) {
    return false;
  }
  const owner = unwrapParentheses(method.expression);
  return (
    ts.isPropertyAccessExpression(owner) &&
    owner.name.text === "prototype" &&
    BUILTIN_CONSTRUCTORS.some((name) =>
      isAmbientReference(unwrapParentheses(owner.expression), name),
    )
  );
}

/** Ambient names whose members a file can patch for every module: the global object and the builtins the census's define arm trusts. */
const PATCHABLE_GLOBALS: readonly string[] = [
  "globalThis",
  "global",
  "self",
  "window",
  "Reflect",
];

const builtinPatchingBySourceFile = new WeakMap<ts.SourceFile, boolean>();

/**
 * Whether this file may replace a builtin, spelled by its ambient name
 * (E-1's re-audit, F2): a write through an ambient builtin or global
 * object (`Object.keys = f`, `globalThis.Object = o`,
 * `Object.prototype.m = f`), or one of them handed
 * to code or aliased (`Object.defineProperty(Object, …)`, `const O =
 * Object`). Calling one (`Object.keys(o)`, `Object(x)`), testing one,
 * `instanceof` one, and aliasing a builtin's member that is not an object
 * of builtins (`var has = Object.prototype.hasOwnProperty`) do not. Then
 * `Object.defineProperty(E, …)`, `Object.assign(E, …)` and `Reflect.set(E,
 * …)` are not taken for the definitions they spell, and an ambient
 * prototype handed to a reader is tampering ({@link isPrototypeTampering}).
 *
 * It is NOT what makes a builtin reader a reader of an export object: no
 * census of one file sees a builtin reached without its name
 * (`({}).constructor.keys = f`) or replaced by another module, so no
 * builtin is trusted with an export object at all (RWF-104, BL-075). The
 * define arm keeps the trust this census gives; another module's
 * replacement of it is RWF-111 (masked by the call graph's escape row).
 */
function fileMayPatchBuiltins(sourceFile: ts.SourceFile): boolean {
  const known = builtinPatchingBySourceFile.get(sourceFile);
  if (known !== undefined) {
    return known;
  }
  const names = [...BUILTIN_CONSTRUCTORS, ...PATCHABLE_GLOBALS];
  const patches = names.some((name) =>
    identifiersSpelled(sourceFile, name).some((reference) => {
      if (!isAmbientReference(reference, name)) {
        return false;
      }
      // The member chain the name heads (`Object.prototype.m`), and whether
      // its value is still an object of builtins (the global object, a
      // builtin, a builtin's `prototype`) rather than one of their methods.
      let top: ts.Node = skipOuterParentheses(reference);
      let objectValued = true;
      for (;;) {
        const parent = top.parent as ts.Node;
        if (
          !(
            ts.isPropertyAccessExpression(parent) ||
            ts.isElementAccessExpression(parent)
          ) ||
          parent.expression !== top
        ) {
          break;
        }
        const member = ts.isPropertyAccessExpression(parent)
          ? parent.name.text
          : exactCommonJsExportPropertyName(
              unwrapParentheses(parent.argumentExpression),
            );
        objectValued =
          objectValued &&
          (member === undefined ||
            member === "prototype" ||
            names.includes(member));
        top = skipOuterParentheses(parent);
      }
      const parent = top.parent as ts.Node;
      // `-Number.MAX_VALUE`, `!globalThis.window`: an operator that only
      // reads (the shared write test counts every prefix operand).
      const readOnlyUnary =
        ts.isPrefixUnaryExpression(parent) &&
        parent.operator !== ts.SyntaxKind.PlusPlusToken &&
        parent.operator !== ts.SyntaxKind.MinusMinusToken;
      if (!readOnlyUnary && isWriteTargetPosition(top)) {
        return true;
      }
      if (
        !objectValued ||
        isInertUse(top) ||
        ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
          parent.expression === top) ||
        (ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
          parent.right === top)
      ) {
        return false;
      }
      // `class E extends Error {}`: the class inherits, the builtin is not
      // changed.
      if (
        ts.isExpressionWithTypeArguments(parent) &&
        ts.isHeritageClause(parent.parent)
      ) {
        return false;
      }
      if (readOnlyUnary) {
        return false;
      }
      // `const F = Function; new F("")`, `var hasMap = typeof Map ===
      // "function" && Map.prototype` (only tested), `U = max ? f(max) :
      // Array`: an alias only tested, called or constructed.
      const value = climbValue(top);
      const holder = value.parent as ts.Node;
      if (
        ts.isVariableDeclaration(holder) &&
        holder.initializer === value &&
        ts.isIdentifier(holder.name)
      ) {
        const alias = holder.name;
        return !identifiersSpelled(sourceFile, alias.text).every(
          (use) =>
            use === alias ||
            isNonReferenceName(use, use.parent) ||
            lexicalDeclarationOf(use, use.text) !== holder ||
            isInertUse(use) ||
            ((ts.isCallExpression(use.parent) ||
              ts.isNewExpression(use.parent)) &&
              use.parent.expression === use),
        );
      }
      // `const { defineProperty, keys } = Object`: its methods, not an
      // object of builtins (no rest, no `prototype`, no builtin's name).
      if (
        ts.isVariableDeclaration(holder) &&
        holder.initializer === value &&
        ts.isObjectBindingPattern(holder.name) &&
        holder.name.elements.every((element) => {
          const key =
            element.propertyName ??
            (ts.isIdentifier(element.name) ? element.name : undefined);
          return (
            element.dotDotDotToken === undefined &&
            key !== undefined &&
            (ts.isIdentifier(key) || ts.isStringLiteral(key)) &&
            key.text !== "prototype" &&
            !names.includes(key.text)
          );
        })
      ) {
        return false;
      }
      // Handed to an `Object` or `Reflect` reader, which only reads it.
      return !(
        ts.isCallExpression(parent) &&
        parent.arguments.some((argument) => argument === top) &&
        isSyntacticReaderCall(parent)
      );
    }),
  );
  builtinPatchingBySourceFile.set(sourceFile, patches);
  return patches;
}

export { isPrototypeTampering, fileMayPatchBuiltins };
