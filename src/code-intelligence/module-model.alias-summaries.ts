/**
 * The alias summaries: whether a binding may be the global object, a
 * `process` value is inert, or a value may hold a load's result; with the
 * value imports and the loads of a file itself.
 *
 * Split out of `module-model.ts` by concern, as a pure move (task BL-121):
 * the declarations below are those of that file, unchanged and in its order.
 * `module-model.ts` re-exports the public ones.
 */
import ts from "typescript";
import { skipOuterExpressions } from "./ambient-names.js";
import { unwrapParentheses } from "./commonjs-reexports.js";
import { lexicalDeclarationOf } from "./named-bindings.js";
import {
  isStaticClassElement,
  isNonReferenceName,
  isAmbientReference,
  identifiersSpelled,
  climbValue,
  isInertUse,
  isPlainAssignmentTarget,
  skipOuterParentheses,
  isRequireResult,
  isLoaderCallee,
  isAssignmentOperatorToken,
} from "./module-model.syntax.js";

/** Members of `process` that reach no module object and run no code of a module. */
const PROCESS_INERT_MEMBERS: ReadonlySet<string> = new Set([
  "env",
  "platform",
  "arch",
  "version",
  "versions",
  "release",
  "features",
  "config",
  "pid",
  "ppid",
  "argv",
  "argv0",
  "execArgv",
  "execPath",
  "title",
  "type",
  "browser",
  "cwd",
  "exit",
  "exitCode",
  "nextTick",
  "hrtime",
  "uptime",
  "memoryUsage",
  "cpuUsage",
  "resourceUsage",
  "emitWarning",
  "noDeprecation",
  "throwDeprecation",
  "traceDeprecation",
  "listeners",
  "listenerCount",
  "stdout",
  "stderr",
  "stdin",
  "umask",
  "kill",
  "getuid",
  "geteuid",
  "getgid",
  "getegid",
  "getgroups",
  "send",
  "connected",
  "disconnect",
  "channel",
]);

/** Members of `process` (its `EventEmitter` methods) that return `process` itself. */
const PROCESS_CHAINABLE_MEMBERS: ReadonlySet<string> = new Set([
  "on",
  "once",
  "off",
  "addListener",
  "removeListener",
  "removeAllListeners",
  "prependListener",
  "prependOnceListener",
  "setMaxListeners",
]);

/** Ambient names that denote the global object, or build code that returns it (`Function("return this")()`). */
const GLOBAL_OBJECT_NAMES: readonly string[] = [
  "globalThis",
  "global",
  "self",
  "window",
  "Function",
];

/**
 * Whether `base` may be the global object: an ambient `globalThis`,
 * `global`, `self` or `window`, or a binding whose initializer spells one
 * (lodash's `var freeGlobal = typeof global == "object" && global …`;
 * `root = freeGlobal || freeSelf || Function("return this")()`).
 */
function reachesGlobalObject(
  base: ts.Expression,
  seen: Set<ts.Node> = new Set(),
): boolean {
  const value = unwrapParentheses(base);
  if (!ts.isIdentifier(value)) {
    return false;
  }
  if (GLOBAL_OBJECT_NAMES.some((name) => isAmbientReference(value, name))) {
    return true;
  }
  const declaration = lexicalDeclarationOf(value, value.text);
  if (
    declaration === undefined ||
    seen.has(declaration) ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined
  ) {
    return false;
  }
  const known = globalReachByDeclaration.get(declaration);
  if (known !== undefined) {
    return known;
  }
  if (seen.size >= SUMMARY_DEPTH) {
    // Fail closed past the bound: the binding may be the global object.
    return true;
  }
  const outermost = seen.size === 0;
  seen.add(declaration);
  aliasSummaryWalks += 1;
  let reaches = false;
  const visit = (node: ts.Node): void => {
    if (reaches) {
      return;
    }
    if (ts.isIdentifier(node) && reachesGlobalObject(node, seen)) {
      reaches = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.initializer);
  // A `false` below the outermost call may be a cycle's cut, not an answer.
  if (reaches || outermost) {
    globalReachByDeclaration.set(declaration, reaches);
  }
  return reaches;
}

/**
 * How deep the alias summaries ({@link reachesGlobalObject},
 * {@link bindingMayHoldLoad}, {@link processValueIsInert}) follow bindings
 * before failing closed (E-1's audit, round 3: a 3,000-alias chain
 * overflowed the stack).
 */
const SUMMARY_DEPTH = 64;

const globalReachByDeclaration = new WeakMap<ts.Node, boolean>();
let aliasSummaryWalks = 0;

/** How many alias summaries were computed (memo misses): an operation count for the structural performance test. */
export function exportAliasSummaryWalks(): number {
  return aliasSummaryWalks;
}
const loadHoldingByDeclaration = new WeakMap<ts.Node, boolean>();

/**
 * Whether a `process` value (`process`, `globalThis.process`) reaches no
 * module object (E-1's re-audit, F3): only tested, or used through a member
 * of {@link PROCESS_INERT_MEMBERS} (`process.env.X`), or `binding("util")`
 * (lodash), directly or through a binding every use of which is so
 * (`var freeProcess = … && freeGlobal.process`). `process.mainModule`,
 * `process.getBuiltinModule("module")`, a computed member and a hand-off
 * reach the loader.
 */
function processValueIsInert(
  node: ts.Node,
  seen: Set<ts.Node> = new Set(),
): boolean {
  const outer = skipOuterParentheses(node);
  const parent = outer.parent as ts.Node;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === outer) {
    const member = parent.name.text;
    const access = skipOuterParentheses(parent);
    if (PROCESS_CHAINABLE_MEMBERS.has(member)) {
      // `process.on(…)` returns `process` itself (E-1's audit, round 3):
      // only a call whose result is discarded or tested hands nothing on.
      const call = access.parent as ts.Node;
      return (
        isInertUse(access) ||
        (ts.isCallExpression(call) &&
          call.expression === access &&
          isInertUse(call))
      );
    }
    if (PROCESS_INERT_MEMBERS.has(member)) {
      return true;
    }
    if (isInertUse(access)) {
      return true;
    }
    const call = access.parent as ts.Node;
    const [first] = ts.isCallExpression(call) ? call.arguments : [];
    return (
      member === "binding" &&
      ts.isCallExpression(call) &&
      call.expression === access &&
      first !== undefined &&
      ts.isStringLiteralLike(first) &&
      first.text === "util"
    );
  }
  if (isInertUse(outer)) {
    return true;
  }
  const top = climbValue(outer);
  if (top !== outer && isInertUse(top)) {
    return true;
  }
  const holder = top.parent as ts.Node;
  if (
    ts.isVariableDeclaration(holder) &&
    holder.initializer === top &&
    ts.isObjectBindingPattern(holder.name)
  ) {
    // `const { env } = process`: allow-listed members only, no rest.
    return holder.name.elements.every((element) => {
      const key =
        element.propertyName ??
        (ts.isIdentifier(element.name) ? element.name : undefined);
      return (
        element.dotDotDotToken === undefined &&
        key !== undefined &&
        (ts.isIdentifier(key) || ts.isStringLiteral(key)) &&
        PROCESS_INERT_MEMBERS.has(key.text)
      );
    });
  }
  if (
    !ts.isVariableDeclaration(holder) ||
    holder.initializer !== top ||
    !ts.isIdentifier(holder.name)
  ) {
    return false;
  }
  if (seen.has(holder)) {
    return true;
  }
  if (seen.size >= SUMMARY_DEPTH) {
    // Fail closed past the bound.
    return false;
  }
  seen.add(holder);
  const name = holder.name;
  return identifiersSpelled(node.getSourceFile(), name.text).every(
    (reference) =>
      reference === name ||
      isNonReferenceName(reference, reference.parent) ||
      lexicalDeclarationOf(reference, reference.text) !== holder ||
      isPlainAssignmentTarget(skipOuterParentheses(reference)) ||
      processValueIsInert(reference, seen),
  );
}

/**
 * Whether `C.name = v` on a class this file defines creates or sets an own
 * data property: not for its own non-writable `name`, `length` and
 * `prototype`; not when it `extends` anything (an inherited static setter
 * may take the write); not when one of its static members is an accessor of
 * the name, or a computed key that may be.
 */
function classTakesWrite(node: ts.ClassLikeDeclaration, name: string): boolean {
  if (
    name === "name" ||
    name === "length" ||
    name === "prototype" ||
    (node.heritageClauses ?? []).some(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    )
  ) {
    return false;
  }
  return !node.members.some(
    (member) =>
      isStaticClassElement(member) &&
      member.name !== undefined &&
      (ts.isComputedPropertyName(member.name) ||
        (ts.isAccessor(member) &&
          (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
          member.name.text === name)),
  );
}

/**
 * Whether the object `base` denotes may be a load's result or reached from
 * one: `require(x)`, `require(x).a`, `require.call(null, x)`,
 * `require.bind(null)(x)`, `c ? require(x) : y`, or a binding any
 * declaration or assignment gives such a value (`const o = require(x)`,
 * `var s; s = require(x)`, `const { self } = require(x)`), through any chain
 * of members (`o.self`). A member write on it may write this file's own
 * exports object (E-1's re-audit, F1: a cycle through another module, an
 * `imports` alias or a self-name hands it back).
 */
function baseMayBeLoaded(base: ts.Expression): boolean {
  let root = unwrapParentheses(base);
  while (
    ts.isPropertyAccessExpression(root) ||
    ts.isElementAccessExpression(root)
  ) {
    root = unwrapParentheses(root.expression);
  }
  return ts.isIdentifier(root)
    ? bindingMayHoldLoad(root)
    : valueMayBeLoaded(root);
}

/** Whether `expression`'s value may be a load's result or a member of one. */
function valueMayBeLoaded(
  expression: ts.Expression,
  seen: Set<ts.Node> = new Set(),
): boolean {
  // Through TypeScript's wrappers too: `(o as any).run = v` writes `o.run`
  // (task BL-105, RWF-150).
  const value = skipOuterExpressions(expression);
  if (
    ts.isPropertyAccessExpression(value) ||
    ts.isElementAccessExpression(value)
  ) {
    return valueMayBeLoaded(value.expression, seen);
  }
  if (ts.isConditionalExpression(value)) {
    return (
      valueMayBeLoaded(value.whenTrue, seen) ||
      valueMayBeLoaded(value.whenFalse, seen)
    );
  }
  if (ts.isBinaryExpression(value)) {
    switch (value.operatorToken.kind) {
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.QuestionQuestionToken:
        return (
          valueMayBeLoaded(value.left, seen) ||
          valueMayBeLoaded(value.right, seen)
        );
      case ts.SyntaxKind.CommaToken:
      case ts.SyntaxKind.EqualsToken:
        return valueMayBeLoaded(value.right, seen);
      default:
        return false;
    }
  }
  if (ts.isCallExpression(value)) {
    if (isRequireResult(value)) {
      return true;
    }
    // `require.call(…)`, `require.apply(…)`, `require.bind(…)(…)`.
    let callee = unwrapParentheses(value.expression);
    while (
      ts.isPropertyAccessExpression(callee) ||
      ts.isElementAccessExpression(callee) ||
      ts.isCallExpression(callee)
    ) {
      callee = unwrapParentheses(callee.expression);
    }
    return isLoaderCallee(callee);
  }
  if (ts.isIdentifier(value)) {
    return bindingMayHoldLoad(value, seen);
  }
  return false;
}

/** Whether a declaration or an assignment of `binding` gives it a value {@link valueMayBeLoaded}. */
function bindingMayHoldLoad(
  binding: ts.Identifier,
  seen: Set<ts.Node> = new Set(),
): boolean {
  const declaration = lexicalDeclarationOf(binding, binding.text);
  if (declaration === undefined || seen.has(declaration)) {
    return false;
  }
  const known = loadHoldingByDeclaration.get(declaration);
  if (known !== undefined) {
    return known;
  }
  if (seen.size >= SUMMARY_DEPTH) {
    // Fail closed past the bound: the binding may hold a load's result.
    return true;
  }
  const outermost = seen.size === 0;
  seen.add(declaration);
  aliasSummaryWalks += 1;
  const holds = bindingSourcesMayBeLoaded(binding, declaration, seen);
  // A `false` below the outermost call may be a cycle's cut, not an answer.
  if (holds || outermost) {
    loadHoldingByDeclaration.set(declaration, holds);
  }
  return holds;
}

/** {@link bindingMayHoldLoad}'s question for one declaration: its initializer and every assignment. */
function bindingSourcesMayBeLoaded(
  binding: ts.Identifier,
  declaration: ts.Node,
  seen: Set<ts.Node>,
): boolean {
  if (isValueImport(declaration)) {
    return true;
  }
  let holder: ts.Node = declaration;
  // `const { self } = require(x)`, `const [s] = …`: the pattern's source.
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
    valueMayBeLoaded(holder.initializer, seen)
  ) {
    return true;
  }
  return identifiersSpelled(binding.getSourceFile(), binding.text).some(
    (reference) => {
      const outer = skipOuterParentheses(reference);
      const parent = outer.parent as ts.Node;
      return (
        ts.isBinaryExpression(parent) &&
        parent.left === outer &&
        isAssignmentOperatorToken(parent.operatorToken.kind) &&
        lexicalDeclarationOf(reference, reference.text) === declaration &&
        valueMayBeLoaded(parent.right, seen)
      );
    },
  );
}

/**
 * Whether `declaration` is an import that binds a value (task BL-105,
 * RWF-150): a namespace import or `import x = require(…)`, a load's
 * result, or a default or named import, a member of one. TypeScript
 * compiles each to `require(…)` under `module: commonjs`, so a module that
 * imports itself (`import * as self from "./self"`) holds its own exports
 * object. An `import x = N.y` alias and a type-only import load nothing.
 */
function isValueImport(declaration: ts.Node): boolean {
  if (ts.isImportEqualsDeclaration(declaration)) {
    return (
      !declaration.isTypeOnly &&
      ts.isExternalModuleReference(declaration.moduleReference)
    );
  }
  if (ts.isImportSpecifier(declaration)) {
    return !declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly;
  }
  if (ts.isNamespaceImport(declaration)) {
    return !declaration.parent.isTypeOnly;
  }
  return ts.isImportClause(declaration) && !declaration.isTypeOnly;
}

/**
 * The property of the load's result a value import binding reads: a named
 * import's imported name, a default import's `default`; `undefined` for any
 * other declaration (a namespace import or `import x = require(…)` binds the
 * result itself, a `const` TypeScript keeps).
 */
function importedNameOf(declaration: ts.Node): string | undefined {
  if (ts.isImportSpecifier(declaration) && isValueImport(declaration)) {
    return (declaration.propertyName ?? declaration.name).text;
  }
  if (ts.isImportClause(declaration) && isValueImport(declaration)) {
    return "default";
  }
  return undefined;
}

/** An import declaration's literal specifier, or `undefined`. */
function importSpecifierOf(
  node: ts.ImportDeclaration | ts.ImportEqualsDeclaration,
): string | undefined {
  const literal = ts.isImportDeclaration(node)
    ? node.moduleSpecifier
    : ts.isExternalModuleReference(node.moduleReference)
      ? node.moduleReference.expression
      : undefined;
  return literal !== undefined && ts.isStringLiteralLike(literal)
    ? literal.text
    : undefined;
}

/** The local names an import declaration binds to values ({@link isValueImport}). */
function valueImportNames(
  node: ts.ImportDeclaration | ts.ImportEqualsDeclaration,
): ts.Identifier[] {
  if (ts.isImportEqualsDeclaration(node)) {
    return isValueImport(node) ? [node.name] : [];
  }
  const clause = node.importClause;
  if (clause === undefined || clause.isTypeOnly) {
    return [];
  }
  const names: ts.Identifier[] = [];
  if (clause.name !== undefined) {
    names.push(clause.name);
  }
  const bindings = clause.namedBindings;
  if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
    names.push(bindings.name);
  } else if (bindings !== undefined) {
    for (const element of bindings.elements) {
      if (!element.isTypeOnly) {
        names.push(element.name);
      }
    }
  }
  return names;
}

/**
 * Whether a loader call ({@link isRequireResult}) may load the file it is
 * written in, and so return this module's own exports object: a specifier
 * that is not a literal; a relative or absolute one that resolves to this
 * file (with or without an extension) or to one of its ancestor
 * directories (an `index`, or a `package.json` `main`); the package's own
 * name or a subpath of it, for a file under `node_modules/<name>/`. A
 * `require.main.require(…)` or `module.constructor._load(…)` resolves from
 * another module, so any relative or absolute specifier may be this file.
 *
 * It decides only where a self-load's result is CENSUSED as an alias of the
 * exports object. It is no proof that a load returns another object: a
 * cycle through another module (`module.exports = require("./index")`), a
 * `package.json` `imports` entry (`#self`), an installed name that differs
 * from the directory, or `module.paths` can all hand this file's exports
 * object back. A member write through ANY load's result is therefore a
 * write of its name ({@link baseMayBeLoaded}; E-1's re-audit, F1); only the
 * other flows of a load this does not accept are not censused (an accepted
 * bound: its object is another module's, task E-4).
 */
function mayLoadThisFile(call: ts.CallExpression): boolean {
  const [first] = call.arguments;
  if (first === undefined || ts.isSpreadElement(first)) {
    return true;
  }
  const argument = unwrapParentheses(first);
  if (!ts.isStringLiteralLike(argument)) {
    return true;
  }
  const specifier = argument.text;
  const file = call.getSourceFile().fileName.replace(/\\/g, "/");
  if (!file.startsWith("/")) {
    // Not a POSIX absolute path: no resolution here can rule it out.
    return true;
  }
  const callee = unwrapParentheses(call.expression);
  const elsewhere =
    ts.isPropertyAccessExpression(callee) &&
    (callee.name.text === "_load" ||
      (ts.isPropertyAccessExpression(unwrapParentheses(callee.expression)) &&
        (unwrapParentheses(callee.expression) as ts.PropertyAccessExpression)
          .name.text === "main"));
  const isPath =
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/");
  if (isPath) {
    if (elsewhere) {
      return true;
    }
    const directory = file.slice(0, file.lastIndexOf("/") + 1);
    const resolved = posixResolve(directory, specifier);
    return (
      resolved === file ||
      file.startsWith(`${resolved}/`) ||
      [
        ".js",
        ".cjs",
        ".mjs",
        ".ts",
        ".cts",
        ".mts",
        ".jsx",
        ".tsx",
        ".node",
      ].some((extension) => `${resolved}${extension}` === file)
    );
  }
  const owner = file.match(/.*\/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  return (
    owner !== null &&
    (specifier === owner[1] || specifier.startsWith(`${owner[1]}/`))
  );
}

/** `path.posix.resolve(directory, specifier)` with no filesystem access, `directory` ending in `/`. */
function posixResolve(directory: string, specifier: string): string {
  const parts = (
    specifier.startsWith("/") ? specifier : `${directory}${specifier}`
  ).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
    } else {
      out.push(part);
    }
  }
  return `/${out.join("/")}`;
}

export {
  GLOBAL_OBJECT_NAMES,
  reachesGlobalObject,
  SUMMARY_DEPTH,
  processValueIsInert,
  classTakesWrite,
  baseMayBeLoaded,
  importedNameOf,
  importSpecifierOf,
  valueImportNames,
  mayLoadThisFile,
};
