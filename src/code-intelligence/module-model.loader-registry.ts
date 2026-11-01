/**
 * The loader registry and the global object: whether a file reaches the
 * module loader's registry, its global-object idioms, and the forms of
 * `this` and of a value that may be the global object.
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
import { type SourceIndex, toSourceLocation } from "./source-index.js";
import {
  isNonReferenceName,
  isAmbientReference,
  isDeclarationName,
  identifiersSpelled,
  climbValue,
  thisBindingFunction,
  isInertUse,
  isPlainAssignmentTarget,
  skipOuterParentheses,
} from "./module-model.syntax.js";
import {
  valueSink,
  INERT_MODULE_MEMBERS,
} from "./module-model.export-methods.js";
import { isPrototypeTampering } from "./module-model.prototype-tampering.js";
import {
  GLOBAL_OBJECT_NAMES,
  SUMMARY_DEPTH,
} from "./module-model.alias-summaries.js";
import {
  isLoadCall,
  isBoundLoader,
} from "./module-model.load-result-escape.js";

/** Builtins whose module object reaches the loader registry, or runs code that can (`vm`, `inspector`, `repl`). */
export const REGISTRY_BUILTINS: ReadonlySet<string> = new Set([
  "module",
  "process",
  "vm",
  "inspector",
  "repl",
  "worker_threads",
]);

/**
 * Whether this file can reach another module's exports object without a
 * static load of it (task BL-074): through the loader registry
 * (`module.parent`, `module.children`, `module.constructor`, `module`
 * handed on, `require.cache`, `require.main` other than tested or called
 * as a loader, `require` handed on, a load through `Function.prototype`),
 * through `process` (`process.mainModule`, `process` handed on, `process`
 * through the global object), a registry builtin
 * ({@link REGISTRY_BUILTINS}), `with`, or the wrapper's `arguments` (whose
 * third is `module`). The census's own predicates decide each:
 * {@link isPrototypeTampering} (which also counts writes to builtin
 * prototypes: over-approximate, in the safe direction),
 * {@link processValueIsInert}, {@link INERT_MODULE_MEMBERS}.
 *
 * Code the file evaluates (`eval`, `Function`, `vm`, a dynamic `import()`
 * or `require`) is the closure-widening scan's (`loader-constructs.ts`),
 * which `load-reach.ts` consults beside this.
 */
export function fileReachesLoaderRegistry(index: SourceIndex): boolean {
  const sourceFile = index.sourceFile;
  let reaches = false;
  const visit = (node: ts.Node, moduleScope: boolean): void => {
    if (reaches) {
      return;
    }
    if (ts.isWithStatement(node) || isPrototypeTampering(node)) {
      reaches = true;
      return;
    }
    // A member that reaches the loader registry or a caller's frame, by
    // NAME, whatever object it is read from -- `process.mainModule`
    // through a global object no relation here recognises (a sloppy
    // function's `this`), `fn.caller`, V8's call sites
    // (`Error.prepareStackTrace`, `getThis()`), `eval` and `Function`
    // reached as members -- spelled as a member, a literal key, a
    // destructuring key or any string (`Reflect.get(fn, "caller")`,
    // `Object.defineProperty(Error, "prepareStackTrace", …)`). BL-074's
    // audit, rounds 1 and 2. A key computed at run time spells no name:
    // RWF-109.
    if (
      (ts.isPropertyAccessExpression(node) &&
        REGISTRY_REACHING_MEMBER_NAMES.has(node.name.text)) ||
      (ts.isStringLiteralLike(node) &&
        REGISTRY_REACHING_MEMBER_NAMES.has(node.text)) ||
      // A key of an object literal, which is a destructuring assignment's
      // pattern (`({ mainModule: m } = p)`, `({ mainModule } = p)`).
      (ts.isIdentifier(node) &&
        REGISTRY_REACHING_MEMBER_NAMES.has(node.text) &&
        ((ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
          ts.isShorthandPropertyAssignment(node.parent))) ||
      (ts.isBindingElement(node) &&
        ts.isObjectBindingPattern(node.parent) &&
        (() => {
          const key = node.propertyName ?? node.name;
          return (
            (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) &&
            REGISTRY_REACHING_MEMBER_NAMES.has(key.text)
          );
        })())
    ) {
      reaches = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      // Only `require("x")` itself is an edge the graph follows
      // (`SourceIndex.imports`); any other load -- an alias, `module.require`,
      // a template specifier, `Function.prototype` -- is one it does not.
      if (isLoadCall(node)) {
        const callee = unwrapParentheses(node.expression);
        const [first] = node.arguments;
        const direct =
          isAmbientReference(callee, "require") &&
          node.arguments.length === 1 &&
          first !== undefined &&
          ts.isStringLiteral(first);
        if (
          !direct ||
          REGISTRY_BUILTINS.has(first.text.replace(/^node:/, ""))
        ) {
          reaches = true;
          return;
        }
      }
      if (isBoundLoader(node)) {
        reaches = true;
        return;
      }
    }
    if (
      ((ts.isIdentifier(node) && isReferenceIdentifier(node)) ||
        node.kind === ts.SyntaxKind.ThisKeyword) &&
      valueIsGlobalObject(node as ts.Expression) &&
      globalObjectUseReaches(node as ts.Expression)
    ) {
      reaches = true;
      return;
    }
    if (ts.isIdentifier(node)) {
      if (
        (node.text === "module" && isAmbientReference(node, "module")) ||
        (node.text === "require" && isAmbientReference(node, "require"))
      ) {
        if (registryReference(node)) {
          reaches = true;
          return;
        }
      } else if (
        node.text === "arguments" &&
        moduleScope &&
        isAmbientReference(node, "arguments")
      ) {
        reaches = true;
        return;
      }
    }
    const nested =
      moduleScope && !(ts.isFunctionLike(node) && !ts.isArrowFunction(node));
    ts.forEachChild(node, (child) => visit(child, nested));
  };
  visit(sourceFile, true);
  return reaches;
}

/**
 * Member names that reach another module's objects from any object they
 * are read from ({@link fileReachesLoaderRegistry}): the loader registry
 * through `process` (`mainModule`, `getBuiltinModule("module")`, `dlopen`
 * with a module object), code evaluation (`eval`, `Function` as members of
 * the global object), and a caller's frame, whose values include a module
 * wrapper's `exports` and `module` (`caller`, V8's `prepareStackTrace`,
 * `getThis`, `getFunction`).
 */
const REGISTRY_REACHING_MEMBER_NAMES: ReadonlySet<string> = new Set([
  "mainModule",
  "getBuiltinModule",
  "dlopen",
  "eval",
  "Function",
  "caller",
  "prepareStackTrace",
  "getThis",
  "getFunction",
]);

/** Whether `node` is a reference, not a name a declaration or a property introduces. */
function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node | undefined;
  return (
    parent !== undefined &&
    !isNonReferenceName(node, parent) &&
    !isDeclarationName(node, parent)
  );
}

/**
 * Whether `expression`'s value may BE the global object (task BL-074): an
 * ambient `globalThis`, `global`, `self`, `window` or `Function` (whose
 * calls build code), the idiom `Function("return this")()`, or a binding
 * initialized to one, through the value operands of `||`, `&&`, `??`, a
 * conditional's branches and a comma's right. Narrower than
 * {@link reachesGlobalObject}, which also counts a binding of a member of
 * the global object (`var Symbol = root.Symbol`): here such a member is
 * censused where it is read ({@link globalObjectUseReaches}).
 */
/**
 * Whether a `this` may be the global object (BL-074's audit, round 3): in
 * a non-arrow function (an arrow's is its enclosing one's) that is not a
 * class member, in sloppy code -- a plain call `g()` of such a function
 * gives `this` the global object. Module-scope `this` is the exports
 * object; class bodies, ES modules and code under a `"use strict"`
 * prologue (of the file or of an enclosing function) are strict, where a
 * plain call gives `undefined`. A file with `import`/`export` syntax runs as
 * an ES module (strict) or does not load at all (`export` in a `.cjs`).
 * A TypeScript SOURCE is judged by its own syntax, though its CommonJS
 * output may be sloppy (`noImplicitUseStrict`, Babel's `strictMode:
 * false`): the analyzer reads the file Node runs only where that is the
 * emitted JavaScript.
 */
function thisMayBeGlobalObject(node: ts.Node): boolean {
  const binder = thisBindingFunction(node);
  if (binder === undefined) {
    // Module scope (the exports object), or a class member's own `this`
    // (an instance or the class: class code is strict).
    return false;
  }
  // The binding function's strictness alone decides `this` (the spec's
  // OrdinaryCallBindThis; BL-074's round-4 review).
  return !isInStrictCode(binder);
}

/**
 * Whether `node` is strict code: under its own prologue (a function's) or
 * that of anything enclosing it -- a function or arrow under a prologue, a
 * class (all of whose code is strict), the file's prologue, an ES module.
 */
function isInStrictCode(node: ts.Node): boolean {
  const sourceFile = node.getSourceFile();
  if (
    ts.isExternalModule(sourceFile) ||
    hasUseStrictPrologue(sourceFile.statements)
  ) {
    return true;
  }
  for (
    let current: ts.Node | undefined = node;
    current !== undefined && !ts.isSourceFile(current);
    current = current.parent
  ) {
    if (ts.isClassLike(current)) {
      return true;
    }
    if (ts.isFunctionLike(current)) {
      const body = (current as ts.FunctionLikeDeclaration).body;
      if (
        body !== undefined &&
        ts.isBlock(body) &&
        hasUseStrictPrologue(body.statements)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Whether `statements` open with a `"use strict"` directive prologue. */
function hasUseStrictPrologue(statements: ts.NodeArray<ts.Statement>): boolean {
  for (const statement of statements) {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isStringLiteral(statement.expression)
    ) {
      return false;
    }
    // The RAW text decides: a directive spelled with an escape
    // (`"use\x20strict"`) is no strict directive (BL-074's audit, round 4).
    const raw = statement.expression.getText();
    if (raw === '"use strict"' || raw === "'use strict'") {
      return true;
    }
  }
  return false;
}

function valueIsGlobalObject(
  expression: ts.Expression,
  seen: Set<ts.Node> = new Set(),
): boolean {
  const value = unwrapParentheses(expression);
  if (value.kind === ts.SyntaxKind.ThisKeyword) {
    return thisMayBeGlobalObject(value);
  }
  if (ts.isIdentifier(value)) {
    if (GLOBAL_OBJECT_NAMES.some((name) => isAmbientReference(value, name))) {
      return true;
    }
    const declaration = lexicalDeclarationOf(value, value.text);
    if (
      declaration === undefined ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer === undefined ||
      seen.has(declaration)
    ) {
      return false;
    }
    if (seen.size >= SUMMARY_DEPTH) {
      return true;
    }
    seen.add(declaration);
    return valueIsGlobalObject(declaration.initializer, seen);
  }
  if (ts.isConditionalExpression(value)) {
    return (
      valueIsGlobalObject(value.whenTrue, seen) ||
      valueIsGlobalObject(value.whenFalse, seen)
    );
  }
  if (ts.isBinaryExpression(value)) {
    switch (value.operatorToken.kind) {
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.QuestionQuestionToken:
        return (
          valueIsGlobalObject(value.left, seen) ||
          valueIsGlobalObject(value.right, seen)
        );
      case ts.SyntaxKind.CommaToken:
      case ts.SyntaxKind.EqualsToken:
        return valueIsGlobalObject(value.right, seen);
      default:
        return false;
    }
  }
  return (
    ts.isCallExpression(value) &&
    ts.isCallExpression(unwrapParentheses(value.expression)) &&
    isAmbientReference(
      unwrapParentheses(
        (unwrapParentheses(value.expression) as ts.CallExpression).expression,
      ),
      "Function",
    )
  );
}

/**
 * Members of the global object that evaluate code, reach the loader
 * registry, or are the global object again: read through a binding of the
 * global object, any of them taints the module ({@link fileReachesLoaderRegistry}).
 */
const GLOBAL_OBJECT_REACHING_MEMBERS: ReadonlySet<string> = new Set([
  "process",
  "eval",
  "Function",
  "constructor",
  "__proto__",
  "globalThis",
  "global",
  "self",
  "window",
  "require",
  "module",
]);

/**
 * Whether a use of a value that may be the global object
 * ({@link reachesGlobalObject}: `globalThis`, `global`, a binding of
 * either, lodash's `root = freeGlobal || freeSelf || Function("return
 * this")()`) may reach another module or evaluate code: a member of
 * {@link GLOBAL_OBJECT_REACHING_MEMBERS}, a computed member, or the value
 * handed anywhere but a test or another binding's initializer (which is
 * itself a binding of the global object, checked where it is used).
 */
function globalObjectUseReaches(node: ts.Expression): boolean {
  const outer = skipOuterParentheses(node);
  const parent = outer.parent as ts.Node | undefined;
  if (parent === undefined) {
    return true;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === outer) {
    return GLOBAL_OBJECT_REACHING_MEMBERS.has(parent.name.text);
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === outer) {
    const key = unwrapParentheses(parent.argumentExpression);
    return (
      !ts.isStringLiteralLike(key) ||
      GLOBAL_OBJECT_REACHING_MEMBERS.has(key.text)
    );
  }
  if (isInertUse(outer)) {
    return false;
  }
  if (
    ts.isCallExpression(parent) &&
    parent.expression === outer &&
    isGlobalObjectIdiomBody(parent)
  ) {
    // `Function("return this")`: the idiom's own constructor call, whose
    // result is censused as the global object where it flows.
    return false;
  }
  const top = climbValue(outer);
  const holder = top.parent as ts.Node | undefined;
  return !(
    holder !== undefined &&
    ts.isVariableDeclaration(holder) &&
    holder.initializer === top &&
    ts.isIdentifier(holder.name)
  );
}

/**
 * The `line:column` of every `Function("return this")()` in the file whose
 * value only initializes a binding (task BL-074): the global-object idiom
 * of lodash and many UMD builds (`var root = freeGlobal || freeSelf ||
 * Function("return this")()`). Its literal body evaluates nothing but the
 * global object, and every use of the binding is checked by
 * {@link fileReachesLoaderRegistry} ({@link globalObjectUseReaches}), so
 * `load-reach.ts` does not count the closure-widening scan's
 * `function_constructor` at these sites as taint.
 */
export function globalObjectIdiomSites(
  index: SourceIndex,
): ReadonlySet<string> {
  const sourceFile = index.sourceFile;
  const sites = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 0 &&
      ts.isCallExpression(unwrapParentheses(node.expression))
    ) {
      const inner = unwrapParentheses(node.expression) as ts.CallExpression;
      if (isGlobalObjectIdiomBody(inner)) {
        const top = climbValue(node);
        const holder = top.parent as ts.Node | undefined;
        if (
          holder !== undefined &&
          ts.isVariableDeclaration(holder) &&
          holder.initializer === top &&
          ts.isIdentifier(holder.name)
        ) {
          const location = toSourceLocation(sourceFile, inner);
          sites.add(`${location.line}:${location.column}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

/** Whether `call` is `Function("return this")`: the ambient `Function` with exactly that literal body. */
function isGlobalObjectIdiomBody(call: ts.CallExpression): boolean {
  const [body] = call.arguments;
  return (
    isAmbientReference(unwrapParentheses(call.expression), "Function") &&
    call.arguments.length === 1 &&
    body !== undefined &&
    ts.isStringLiteralLike(body) &&
    /^\s*return this;?\s*$/.test(body.text)
  );
}

/** Whether a reference to the ambient `module` or `require` reaches the loader registry ({@link fileReachesLoaderRegistry}). */
function registryReference(node: ts.Identifier): boolean {
  const outer = skipOuterParentheses(node);
  const parent = outer.parent as ts.Node;
  if (node.text === "require") {
    if (ts.isCallExpression(parent) && parent.expression === outer) {
      return false;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === outer) {
      const member = parent.name.text;
      if (member === "cache" || member === "call" || member === "apply") {
        return true;
      }
      if (member === "main") {
        return !isInertUse(skipOuterParentheses(parent));
      }
      return false;
    }
    if (isInertUse(outer)) {
      return false;
    }
    const sink = valueSink(outer);
    return !(
      sink !== undefined &&
      ts.isVariableDeclaration(sink.parent) &&
      loaderAliasIsOnlyCalled(sink)
    );
  }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === outer) {
    const member = parent.name.text;
    return !(
      member === "exports" ||
      (INERT_MODULE_MEMBERS.has(member) && member !== "require") ||
      isInertUse(skipOuterParentheses(parent))
    );
  }
  if (isInertUse(outer)) {
    return false;
  }
  const sink = valueSink(outer);
  return sink === undefined || moduleAliasReachesRegistry(sink);
}

/** Whether a local bound to `module` reads a member that reaches the registry, or is handed on. */
function moduleAliasReachesRegistry(alias: ts.Identifier): boolean {
  const declaration = lexicalDeclarationOf(alias, alias.text);
  return identifiersSpelled(alias.getSourceFile(), alias.text).some(
    (reference) => {
      const parent = reference.parent as ts.Node | undefined;
      if (
        parent === undefined ||
        isNonReferenceName(reference, parent) ||
        isDeclarationName(reference, parent) ||
        lexicalDeclarationOf(reference, reference.text) !== declaration
      ) {
        return false;
      }
      const outer = skipOuterParentheses(reference);
      const outerParent = outer.parent as ts.Node;
      if (
        ts.isPropertyAccessExpression(outerParent) &&
        outerParent.expression === outer
      ) {
        const member = outerParent.name.text;
        return !(
          member === "exports" ||
          (INERT_MODULE_MEMBERS.has(member) && member !== "require") ||
          isInertUse(skipOuterParentheses(outerParent))
        );
      }
      return !(isInertUse(outer) || isPlainAssignmentTarget(outer));
    },
  );
}

/**
 * Whether every use of a local bound to `require` is a call of it (or
 * inert), so that {@link isLoaderCallee} accounts for all of them.
 */
function loaderAliasIsOnlyCalled(binding: ts.Identifier): boolean {
  const sourceFile = binding.getSourceFile();
  const declaration = lexicalDeclarationOf(binding, binding.text);
  if (
    declaration === undefined ||
    isNameAssignedWithin(sourceFile, binding.text)
  ) {
    return false;
  }
  let only = true;
  const visit = (node: ts.Node): void => {
    if (!only) {
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
      only =
        (ts.isCallExpression(parent) && parent.expression === outer) ||
        isInertUse(outer);
      return;
    }
  };
  // Only identifiers spelled like the binding are visited (E-1's audit, finding 5).
  for (const reference of identifiersSpelled(sourceFile, binding.text)) {
    visit(reference);
  }
  return only;
}

export { isInStrictCode, valueIsGlobalObject, loaderAliasIsOnlyCalled };
