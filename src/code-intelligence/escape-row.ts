import ts from "typescript";
import {
  RETURNS_PRIMITIVE,
  isKnownBuiltinCallable,
} from "./builtin-callables.js";
import { resolveNamedBinding } from "./named-bindings.js";
import { importSpecifierOf } from "./symbol-binder.js";
import {
  GLOBAL_OBJECT_NAMES,
  assignedNames,
  declaredOrAssignedNames,
  insideWith,
  isProvenCommonJsModuleScope,
  skipOuterExpressions,
} from "./ambient-names.js";

export { assignedNames, skipOuterExpressions } from "./ambient-names.js";

/**
 * ADR 0008 § 2's ESCAPE ROW, the syntax half (task A-3a).
 *
 * "A function value *escaping* into code the graph does not model: an
 * argument (or spread, or object/array member of an argument) of a call or
 * `new` whose callee is ambient, builtin, unresolved or unknown; the
 * right-hand side of an assignment to a member rooted in an ambient or
 * builtin value; a property descriptor" -- "resolved for a documented
 * invoking builtin, otherwise *possible* when the value is attributable
 * and unknown when it is not".
 *
 * This module answers the questions that need only the file's syntax and
 * its lexical scopes: which values an expression may hand over
 * ({@link escapingValuesOf}), whether it is provably primitive, whether a
 * name is the ambient global it is spelled like ({@link isAmbientRoot}),
 * and whether an assignment stores into an ambient or builtin value
 * ({@link escapingAssignmentOf}). Which graph node an attributable value
 * denotes -- which needs the module resolver -- is `call-graph.ts`'s.
 */

/**
 * The CommonJS module-scope bindings. Undeclared in the file, like an
 * ambient global, but not one: each is the module's own (`exports.x = f`
 * writes an export, which the export model owns; `exports.x()` calls one,
 * AUD-02, task A-3b). None is ever treated as an ambient root here.
 */
export const MODULE_SCOPE_ROOTS: ReadonlySet<string> = new Set([
  "module",
  "exports",
  "require",
  "__dirname",
  "__filename",
]);

/**
 * The ambient global VALUES: the objects and functions Node supplies under
 * these names (task A-3a; before it, VT-201's `KNOWN_GLOBAL_IDENTIFIERS`).
 *
 * WHAT CHANGED, AND WHY. VT-201 matched a callee's root identifier against
 * this list by SPELLING and gave every match no edge at all, on the premise
 * that an ambient global "can never be a vulnerable-rule target". ADR 0008
 * § 6 reopened that premise: what a builtin is HANDED can be the program's
 * own code (AUD-01, PRM-12, PRM-117), and a parameter named like a builtin
 * is not one. Since A-3a a root is one of these only when no scope in the
 * file declares it (`escape-row.ts`'s `isAmbientRoot`), and a call through
 * it is accounted by the builtin table (`builtin-callables.ts`): a member
 * Node supplies gets the escape row and, when nothing escapes, a no-edge
 * proof; a member Node does not supply (`globalThis.myHook()`,
 * `Intl.someUnlistedThing()`) is the program's own, and an unknown callee.
 *
 * The CommonJS module-scope bindings (`module`, `exports`, `require`,
 * `__dirname`, `__filename`) are not here: they are the module's own, not
 * ambient globals ({@link MODULE_SCOPE_ROOTS}).
 *
 * ONE LIST, TWO JOBS. Every `global:` key of the builtin table is rooted
 * in one of these names (`scripts/generate-builtin-callables.mjs`
 * enumerates nothing else; `tests/oracle/builtin-admission.test.ts`
 * checks it), and a write to any of them is an escaping assignment
 * ({@link escapingAssignmentOf}). The two must agree: task A-3a's
 * independent audit found a first table rooted in ten names this list
 * lacked (`URL`, `atob`, `TextEncoder`, …), so a polyfill assigning one in
 * another file was invisible while its calls earned no-edge proofs.
 */
export const AMBIENT_GLOBAL_NAMES: ReadonlySet<string> = new Set([
  "console",
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Symbol",
  "Proxy",
  "Reflect",
  "Function",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Intl",
  "globalThis",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "queueMicrotask",
  "structuredClone",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "fetch",
  "process",
  "Buffer",
  "global",
]);

/**
 * Whether `id` denotes the ambient global it is spelled like: no enclosing
 * scope declares it (`resolveNamedBinding`'s lexical model), no
 * declaration anywhere in the file carries its name (the lexical model
 * does not see a TypeScript `enum` or `namespace`; over-approximating here
 * costs only precision), nothing in the file assigns to the bare name in
 * any assignment form ({@link assignedNames}), it is not inside a `with`
 * body, and it is not one of the CommonJS {@link MODULE_SCOPE_ROOTS}.
 *
 * What this cannot see is a write in ANOTHER file. That is why only the
 * names in {@link AMBIENT_GLOBAL_NAMES} root the builtin table, and why a
 * write to one of them anywhere -- a bare-name write too -- is an
 * escaping assignment, which gives the stored value its own edge.
 *
 * Before task A-3a the call graph decided this by SPELLING: a parameter
 * named `JSON` whose `parse` member the program supplied was treated as
 * the ambient `JSON` and given no edge (defect class A).
 */
export function isAmbientRoot(id: ts.Identifier): boolean {
  if (MODULE_SCOPE_ROOTS.has(id.text) || insideWith(id)) {
    return false;
  }
  if (declaredOrAssignedNames(id.getSourceFile()).has(id.text)) {
    return false;
  }
  const binding = resolveNamedBinding(id);
  return binding.kind === "unresolved" && binding.cause === "no_declaration";
}

/** Whether `id` is an undeclared CommonJS module-scope binding (`exports.x()`). */
export function isModuleScopeRoot(id: ts.Identifier): boolean {
  if (!MODULE_SCOPE_ROOTS.has(id.text) || insideWith(id)) {
    return false;
  }
  if (declaredOrAssignedNames(id.getSourceFile()).has(id.text)) {
    return false;
  }
  const binding = resolveNamedBinding(id);
  return binding.kind === "unresolved" && binding.cause === "no_declaration";
}

/**
 * A member chain rooted in an identifier: `Array.isArray` → root `Array`,
 * path `["isArray"]`; `fs["readFile"]` → root `fs`, path `["readFile"]`.
 * `undefined` for anything else (a computed member, a call in the chain).
 */
export function memberChainOf(expr: ts.Expression): {
  readonly root: ts.Expression;
  readonly path: readonly string[];
} {
  const path: string[] = [];
  let current = skipOuterExpressions(expr);
  for (;;) {
    if (ts.isPropertyAccessExpression(current)) {
      path.unshift(current.name.text);
      current = skipOuterExpressions(current.expression);
    } else if (
      ts.isElementAccessExpression(current) &&
      ts.isStringLiteralLike(current.argumentExpression)
    ) {
      path.unshift(current.argumentExpression.text);
      current = skipOuterExpressions(current.expression);
    } else {
      return { root: current, path };
    }
  }
}

/**
 * The ambient global member path an expression denotes, as a builtin-table
 * key (`global:Array.isArray`, `global:setTimeout`), when its root is an
 * ambient global ({@link isAmbientRoot}). A leading `globalThis` /
 * `global` is the global object itself, so `globalThis.setTimeout` is
 * `global:setTimeout`. `undefined` when the root is not ambient or the
 * chain has a computed member.
 */
export function ambientGlobalKeyOf(expr: ts.Expression): string | undefined {
  const { root, path } = memberChainOf(expr);
  if (!ts.isIdentifier(root) || !isAmbientRoot(root)) {
    return undefined;
  }
  const full = [root.text, ...path];
  while (full.length > 1 && GLOBAL_OBJECT_NAMES.has(full[0]!)) {
    full.shift();
  }
  return `global:${full.join(".")}`;
}

// ---------------------------------------------------------------------------
// What an expression hands over
// ---------------------------------------------------------------------------

/**
 * One value an escaping expression may carry, as far as syntax and the
 * lexical scopes can tell:
 *
 * - `function`: a function-like node the file defines -- an inline
 *   function or arrow, an object-literal method, or the declaration a
 *   stable local binding denotes. `direct` when the expression IS that
 *   function (only then can a documented invoking builtin be proved to
 *   call it), not a member of an object or array literal it contains.
 * - `class`: a class the file defines (it may be constructed).
 * - `import`: an expression that may name an imported function (`lib.parse`,
 *   `parse` from a destructured require); the call graph binds it.
 * - `opaque`: a non-primitive value the graph cannot see into -- a
 *   parameter, a call result, an object passed by name. The builtin may
 *   run anything reachable from it.
 */
export type EscapingValue =
  | {
      readonly kind: "function";
      readonly node: ts.SignatureDeclaration;
      readonly direct: boolean;
    }
  | {
      readonly kind: "class";
      readonly node: ts.ClassLikeDeclaration;
      readonly direct: boolean;
    }
  | {
      readonly kind: "import";
      readonly expr: ts.Expression;
      readonly direct: boolean;
    }
  | { readonly kind: "opaque"; readonly expr: ts.Expression };

/** How many `const a = b` hops {@link escapingValuesOf} follows. */
const MAX_ALIAS_HOPS = 4;

/**
 * Every value `expr` may hand over, recursively through object and array
 * literals (ADR 0008 § 2: "or spread, or object/array member of an
 * argument"; a property descriptor is an object-literal argument). An
 * empty result means the expression is provably primitive, or a literal
 * holding only primitives: nothing in it can carry the program's code.
 *
 * An accessor (`get x() {}`) inside an object literal is `opaque`: a
 * getter can return a function the receiving builtin then invokes, and
 * what it returns is not attributed here (the accessor itself is its own
 * owner since task A-4, reached by a possible edge from its definer).
 */
export function escapingValuesOf(
  expr: ts.Expression,
): readonly EscapingValue[] {
  const out: EscapingValue[] = [];
  collect(expr, true, 0, out);
  return out;
}

function collect(
  raw: ts.Expression,
  direct: boolean,
  hops: number,
  out: EscapingValue[],
): void {
  const expr = skipOuterExpressions(raw);

  if (isPrimitiveSyntax(expr) || isPrimitiveReturningCall(expr)) {
    return;
  }
  if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)) {
    out.push({ kind: "function", node: expr, direct });
    pushOwnMembers(expr, out);
    return;
  }
  if (ts.isClassExpression(expr)) {
    out.push({ kind: "class", node: expr, direct });
    pushOwnMembers(expr, out);
    return;
  }
  if (ts.isObjectLiteralExpression(expr)) {
    for (const property of expr.properties) {
      if (ts.isMethodDeclaration(property)) {
        out.push({ kind: "function", node: property, direct: false });
      } else if (ts.isPropertyAssignment(property)) {
        collect(property.initializer, false, hops, out);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        collect(property.name, false, hops, out);
      } else if (ts.isSpreadAssignment(property)) {
        collect(property.expression, false, hops, out);
      } else if (
        ts.isGetAccessorDeclaration(property) ||
        ts.isSetAccessorDeclaration(property)
      ) {
        // A getter can RETURN a function the builtin then invokes
        // (`new Readable({ get read() { return f; } })`): opaque. The
        // accessor's own body is reached by its possible edge (task A-4).
        out.push({ kind: "opaque", expr: property.name as ts.Expression });
      }
      // A computed key's
      // ToPropertyKey coercion is a use site, accounted at the key
      // object's definition (ADR 0008 § 2's protocol row, since task A-4).
    }
    return;
  }
  if (ts.isArrayLiteralExpression(expr)) {
    for (const element of expr.elements) {
      if (ts.isOmittedExpression(element)) {
        continue;
      }
      collect(
        ts.isSpreadElement(element) ? element.expression : element,
        false,
        hops,
        out,
      );
    }
    return;
  }
  // A conditional or logical operator may evaluate to EITHER operand: each
  // is a value the builtin may be handed, never the one value it is
  // (defect class C), so neither is `direct` -- a documented invoking
  // builtin gets a possible edge to each, not a resolved one (task A-3a's
  // independent audit: `setTimeout(a || b, 0)`).
  if (ts.isConditionalExpression(expr)) {
    collect(expr.whenTrue, false, hops, out);
    collect(expr.whenFalse, false, hops, out);
    return;
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      collect(expr.left, false, hops, out);
      collect(expr.right, false, hops, out);
      return;
    }
    if (op === ts.SyntaxKind.CommaToken || op === ts.SyntaxKind.EqualsToken) {
      collect(expr.right, direct, hops, out);
      return;
    }
    // Every other binary operator yields a primitive (see isPrimitiveSyntax).
  }
  // A builtin function Node itself supplies (`Boolean`, `Math.max`), passed
  // as a value: see the comment below for why it is still opaque.
  const ambientKey =
    ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)
      ? ambientGlobalKeyOf(expr)
      : undefined;
  if (ambientKey !== undefined && isKnownBuiltinCallable(ambientKey)) {
    // A builtin function handed to another builtin carries none of the
    // program's code -- but the receiving builtin may store it over a
    // builtin (`Object.assign(Array, { isArray: setTimeout })`) and change
    // what a later trusted call does. Opaque, so the receiving call is
    // fail-closed unless the position is admitted (task A-3a's third audit
    // round); never "nothing", which claimed primitive-only arguments.
    out.push({ kind: "opaque", expr });
    return;
  }
  if (ts.isIdentifier(expr)) {
    collectIdentifier(expr, direct, hops, out);
    return;
  }
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(skipOuterExpressions(expr.expression))
  ) {
    // `lib.parse`: possibly an imported function; the call graph binds it
    // and requires the whole chain to be consumed.
    out.push({ kind: "import", expr, direct });
    return;
  }
  out.push({ kind: "opaque", expr });
}

function collectIdentifier(
  id: ts.Identifier,
  direct: boolean,
  hops: number,
  out: EscapingValue[],
): void {
  if (
    (id.text === "undefined" || id.text === "NaN" || id.text === "Infinity") &&
    isAmbientRoot(id)
  ) {
    return;
  }
  const binding = resolveNamedBinding(id);
  switch (binding.kind) {
    case "function":
    case "function-expression":
      // A `function` declaration needs no ORDER check (it is hoisted), but
      // it is a mutable binding: `cb = other` anywhere in the file means
      // the name may hold something else when it escapes (PRM-104's shape,
      // found in this producer by task A-3a's audit). Over-approximated by
      // name, which costs only precision. The DECLARATION's own name is
      // checked, not the reference's: `const a = cb` resolves through the
      // alias to `cb`'s declaration, whose name is the one reassigned
      // (task A-3a's re-audit).
      {
        const declared = binding.declaration.name;
        const assigned = assignedNames(id.getSourceFile());
        if (
          assigned.has(id.text) ||
          (declared !== undefined && assigned.has(declared.text))
        ) {
          out.push({ kind: "opaque", expr: id });
          return;
        }
      }
      out.push({ kind: "function", node: binding.declaration, direct });
      pushOwnMembers(binding.declaration, out);
      return;
    case "class":
      out.push({ kind: "class", node: binding.declaration, direct });
      pushOwnMembers(binding.declaration, out);
      return;
    case "value": {
      const value = skipOuterExpressions(binding.value);
      if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) {
        out.push({ kind: "function", node: value, direct });
        pushOwnMembers(value, out);
        return;
      }
      if (ts.isClassExpression(value)) {
        out.push({ kind: "class", node: value, direct });
        pushOwnMembers(value, out);
        return;
      }
      // A stable `const` holding a primitive -- or a further alias -- is
      // followed; an object held by a name is NOT expanded (ADR 0008
      // Amendment A-0, "Not proposed": that would give the methods of
      // every object passed by name an edge, and break the S4 precision
      // controls). The builtin may still run what it reaches, which is
      // what `opaque` says.
      if (isPrimitiveSyntax(value) || isPrimitiveReturningCall(value)) {
        return;
      }
      if (ts.isIdentifier(value) && hops < MAX_ALIAS_HOPS) {
        collectIdentifier(value, direct, hops + 1, out);
        return;
      }
      out.push({ kind: "opaque", expr: id });
      return;
    }
    case "unresolved":
      if (
        binding.cause === "import_binding" ||
        binding.cause === "destructuring"
      ) {
        // An import, or a destructured require: the call graph binds it.
        out.push({ kind: "import", expr: id, direct });
        return;
      }
      out.push({ kind: "opaque", expr: id });
      return;
  }
}

/**
 * Task BL-081 (its second and third audit rounds): a function or class
 * handed over carries its OWN members, which whoever receives it may call:
 * stored as a builtin (`G.Math = K`), `Math.max(1)` runs `K.max`. They are
 * not attributed here, so a function or class that may have any -- a
 * static member, a base class to inherit them from, a class decorator, a
 * merged TypeScript `namespace`, or a store onto one of its members in its
 * own file through any route a freshness proof accepts (`fn.max = f`,
 * `(a = fn).max = f`, `P.prototype = fn; P.prototype.max = f`) -- also
 * hands over an opaque value. A store onto its members in ANOTHER file is
 * a store onto an unproven object (a load), an escape of its own; a
 * function or class handed over from another file is checked in ITS file
 * (`call-graph.ts`, through {@link mayCarryOwnMembers}).
 */
function pushOwnMembers(node: ts.Node, out: EscapingValue[]): void {
  if (mayCarryOwnMembers(node)) {
    out.push({ kind: "opaque", expr: node as ts.Expression });
  }
}

export function mayCarryOwnMembers(node: ts.Node): boolean {
  const name = (node as ts.NamedDeclaration).name;
  if (
    name !== undefined &&
    ts.isIdentifier(name) &&
    mergedNamespaceNames(node.getSourceFile()).has(name.text)
  ) {
    return true;
  }
  if (
    ts.isClassLike(node) &&
    (isDerived(node) ||
      isDecorated(node) ||
      node.members.some(
        (member) =>
          ts.isClassStaticBlockDeclaration(member) ||
          (ts.canHaveModifiers(member) &&
            (ts.getModifiers(member) ?? []).some(
              (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
            )),
      ))
  ) {
    return true;
  }
  const stored = membersStoredOnto(node.getSourceFile());
  return stored.has(node) || stored.has(node.getSourceFile());
}

const membersStoredCache = new WeakMap<ts.SourceFile, ReadonlySet<ts.Node>>();

/** Every function or class definition some store in the file writes a member of, through a name that denotes it. */
function membersStoredOnto(sourceFile: ts.SourceFile): ReadonlySet<ts.Node> {
  const cached = membersStoredCache.get(sourceFile);
  if (cached) {
    return cached;
  }
  const found = new Set<ts.Node>();
  for (const store of fileStores(sourceFile)) {
    const target = skipOuterExpressions(store.target);
    if (
      (!ts.isPropertyAccessExpression(target) &&
        !ts.isElementAccessExpression(target)) ||
      (store.value !== undefined && isPrimitiveSyntax(store.value))
    ) {
      continue;
    }
    try {
      for (const denoted of definitionsDenotedBy(target.expression, 0)) {
        found.add(denoted);
      }
    } catch (error) {
      if (!(error instanceof DenotationUnknown)) {
        throw error;
      }
      // A member store whose object cannot be followed may be onto any
      // function or class of the file.
      found.add(sourceFile);
    }
  }
  membersStoredCache.set(sourceFile, found);
  return found;
}

/**
 * The function and class definitions `raw` may evaluate to, through every
 * route a freshness proof ({@link isProvenFreshObject}) accepts as the
 * program's own object: a definition, a stable name, an assignment's value,
 * the CommonJS `exports` / `module.exports` and a function's `prototype`
 * through the values stored to them. A base no proof accepts is unproven,
 * so a store onto it is an escape of its own and needs no entry here.
 */
function definitionsDenotedBy(raw: ts.Expression, hops: number): ts.Node[] {
  const expr = skipOuterExpressions(raw);
  // A cycle through the stores, or a chain too long to follow, cannot be
  // answered: unknown, which every caller reads as "may be the object"
  // (never as "is none").
  if (hops > MAX_ALIAS_HOPS || denoting.has(expr)) {
    throw new DenotationUnknown();
  }
  denoting.add(expr);
  try {
    return denotedThroughRoutes(expr, hops);
  } finally {
    denoting.delete(expr);
  }
}

class DenotationUnknown extends Error {}

/** The expressions {@link definitionsDenotedBy} is currently following. */
const denoting = new Set<ts.Expression>();

function denotedThroughRoutes(expr: ts.Expression, hops: number): ts.Node[] {
  if (
    ts.isFunctionExpression(expr) ||
    ts.isArrowFunction(expr) ||
    ts.isClassExpression(expr)
  ) {
    return [expr];
  }
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return definitionsDenotedBy(expr.right, hops + 1);
  }
  const sourceFile = expr.getSourceFile();
  const throughStores = (values: readonly (ts.Expression | undefined)[]) =>
    values.flatMap((value) =>
      value === undefined ? [] : definitionsDenotedBy(value, hops + 1),
    );
  if (ts.isIdentifier(expr)) {
    if (insideWith(expr)) {
      return [];
    }
    const denoted = denotedDefinitionOf(expr);
    if (denoted !== undefined) {
      return [denoted];
    }
    if (expr.text === "exports" && isUndeclaredInProvenCommonJs(expr)) {
      return throughStores(storesToName(sourceFile, "exports"));
    }
    // A stable name bound to any route `isFreshBinding` accepts (`const p =
    // F.prototype`, `const a = (b = K)`, `const m = module.exports`): the
    // same routes, followed the same way (task BL-081's fourth audit
    // round).
    // One hop at a time, so an alias of the undeclared `exports` reaches
    // the branch above instead of resolving to no declaration.
    const binding = resolveNamedBinding(expr, { followAliases: false });
    return binding.kind === "value"
      ? definitionsDenotedBy(binding.value, hops + 1)
      : [];
  }
  const member = staticMemberOf(expr);
  if (
    member === undefined ||
    !ts.isIdentifier(member.object) ||
    (member.key !== "exports" && member.key !== "prototype")
  ) {
    return [];
  }
  const object = member.object;
  // A definition stored there by a route this file does not spell -- a
  // parameter's store (`setP(F)`: `X.prototype = K`), a builtin
  // (`Object.defineProperty(F, "prototype", { value: K })`), another file
  // -- gets an unknown edge at that store or call (`storesUnderPrototypeKey`,
  // `builtinMayStoreUnderModelKey`), so the stores spelled here are all
  // this relation needs (task BL-081's fifth to ninth audit rounds).
  return storeValueDefinitions(storesOnto(object, member.key), hops);
}

const namespaceNamesCache = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

/** Every name a TypeScript `namespace` declaration in the file binds: merged into a function or class of the name, it adds own members. */
function mergedNamespaceNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const cached = namespaceNamesCache.get(sourceFile);
  if (cached) {
    return cached;
  }
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  namespaceNamesCache.set(sourceFile, names);
  return names;
}

/**
 * The defaults of a destructuring ASSIGNMENT's shorthand targets (`({ keys
 * = h } = src)`), at any depth: a default written `a: t = d` is an
 * assignment expression and a site of its own, but a shorthand one is not.
 */
export function shorthandDefaultsOf(raw: ts.Expression): ts.Expression[] {
  const node = skipOuterExpressions(raw);
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.flatMap((property) =>
      ts.isShorthandPropertyAssignment(property)
        ? property.objectAssignmentInitializer
          ? [property.objectAssignmentInitializer]
          : []
        : ts.isPropertyAssignment(property)
          ? shorthandDefaultsOf(property.initializer)
          : ts.isSpreadAssignment(property)
            ? shorthandDefaultsOf(property.expression)
            : [],
    );
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element) =>
      ts.isOmittedExpression(element)
        ? []
        : shorthandDefaultsOf(
            ts.isSpreadElement(element) ? element.expression : element,
          ),
    );
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return shorthandDefaultsOf(node.left);
  }
  return [];
}

/**
 * A call of an ambient builtin that always returns a primitive
 * (`builtin-callables.ts`'s `RETURNS_PRIMITIVE`, checked against real
 * Node). Its own arguments are accounted at its own call site.
 */
function isPrimitiveReturningCall(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr)) {
    return false;
  }
  const key = ambientGlobalKeyOf(expr.expression);
  return key !== undefined && RETURNS_PRIMITIVE.has(key);
}

/**
 * Whether `expr` provably evaluates to a primitive, from its syntax alone:
 * a literal (not a regular expression literal, which is an object), a
 * template, or an operator whose result is always primitive (`typeof`,
 * `!`, `void`, `-`, arithmetic, comparison, equality, `in`,
 * `instanceof`). Such an operator may itself run a coercion hook on its
 * operand, but that is a use site, accounted at the hook's definition
 * (ADR 0008 § 2's protocol row, since task A-4) -- the builtin is handed only
 * the primitive.
 */
export function isPrimitiveSyntax(raw: ts.Expression): boolean {
  const expr = skipOuterExpressions(raw);
  switch (expr.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateExpression:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.TypeOfExpression:
    case ts.SyntaxKind.VoidExpression:
    case ts.SyntaxKind.DeleteExpression:
    case ts.SyntaxKind.PrefixUnaryExpression:
    case ts.SyntaxKind.PostfixUnaryExpression:
      return true;
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return isPrimitiveSyntax(expr.left) && isPrimitiveSyntax(expr.right);
    }
    if (op === ts.SyntaxKind.CommaToken) {
      return isPrimitiveSyntax(expr.right);
    }
    if (
      op >= ts.SyntaxKind.FirstAssignment &&
      op <= ts.SyntaxKind.LastAssignment
    ) {
      return op === ts.SyntaxKind.EqualsToken
        ? isPrimitiveSyntax(expr.right)
        : // A compound assignment's value is its operator's result.
          op !== ts.SyntaxKind.BarBarEqualsToken &&
            op !== ts.SyntaxKind.AmpersandAmpersandEqualsToken &&
            op !== ts.SyntaxKind.QuestionQuestionEqualsToken;
    }
    return true;
  }
  if (ts.isConditionalExpression(expr)) {
    return (
      isPrimitiveSyntax(expr.whenTrue) && isPrimitiveSyntax(expr.whenFalse)
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// The assignment form
// ---------------------------------------------------------------------------

/** The operators that store their right-hand side's value (`=`, and the logical assignments). */
export function storesValue(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.EqualsToken ||
    op === ts.SyntaxKind.BarBarEqualsToken ||
    op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    op === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

/**
 * Where an assignment stores: the root the escape row cares about.
 *
 * - `ambient`: an ambient global, or a member of one
 *   (`Error.prepareStackTrace = f`, `globalThis.hook = f`, `Promise = P`);
 * - `builtin`: a member of a builtin module's value -- through a name its
 *   own declaration binds to `require("<builtin>")` or an `import` of one
 *   (`fs.readFile = f`), or `require("<builtin>")` itself;
 * - `unproven_object` (task BL-081): a member of a value NOT proven to be
 *   an object the program created ({@link isProvenFreshObject}) -- which
 *   may therefore be a builtin object reached without its name
 *   (`({}).constructor.keys = f`, `function install(O) { O.keys = f; }
 *   install(Object)`, RWF-110 and RWF-063) -- or a bare name written in a
 *   `with` body, which may be a member of the `with` object.
 */
export type EscapeRoot =
  | { readonly kind: "ambient" }
  | { readonly kind: "builtin"; readonly specifier: string }
  | { readonly kind: "unproven_object" };

/**
 * The escape root of an assignment that stores a value which may carry
 * the program's own code into an ambient or builtin value, or `undefined`
 * when the assignment is not one: another target, or a provably primitive
 * value (nothing it stores can ever be invoked).
 *
 * `isBuiltinSpecifier` decides whether a literal specifier names a builtin
 * module (Node's `isBuiltin`, the resolver's own test).
 */
export function escapingAssignmentOf(
  node: ts.BinaryExpression,
  isBuiltinSpecifier: (specifier: string) => boolean,
): EscapeRoot | undefined {
  if (!storesValue(node.operatorToken.kind)) {
    return undefined;
  }
  // A destructuring assignment writes every target it names
  // (`({ a: Math.max } = src)`); any one rooted in a builtin makes it an
  // escape of the whole right-hand side.
  const root = destructuringTargets(skipOuterExpressions(node.left))
    .map((target) => escapeRootOf(target, isBuiltinSpecifier))
    .find((found) => found !== undefined);
  // Checked last: the target is cheaper to rule out than the value. A
  // builtin's own function stored over another builtin
  // (`Array.isArray = setTimeout`, `path.join = Reflect.apply`) carries
  // none of the program's code, but changes what a call trusted as the
  // builtin does -- so anything that is not provably primitive is an
  // escape (task A-3a's re-audit); with nothing attributable to edge to,
  // the site gets an unknown edge.
  return root !== undefined &&
    (escapingValuesOf(node.right).length > 0 || !isPrimitiveSyntax(node.right))
    ? root
    : undefined;
}

/**
 * Task BL-081: the escape root of a `for…of` whose head stores each
 * element of the iterable into a target (`for (O.keys of [f]) {}`) -- the
 * same store as an assignment, one element at a time -- or `undefined`
 * when the head declares its own bindings or no target is an escape root. A-3a's escape row read only
 * assignment expressions, so this form replaced a builtin unseen even when
 * it spelled the builtin's name (RWF-120).
 *
 * A `for…in` head stores only property keys, which are primitive.
 */
export function escapingForOfStoreOf(
  node: ts.ForOfStatement,
  isBuiltinSpecifier: (specifier: string) => boolean,
): EscapeRoot | undefined {
  if (ts.isVariableDeclarationList(node.initializer)) {
    // A `var` head in a `with` body stores through the `with` object when
    // it has the name (audit of task BL-081): `with (Object) { for (var
    // keys of [f]) {} }` writes `Object.keys`. `let` and `const` are
    // block-scoped and never do.
    return isVarList(node.initializer) && insideWith(node)
      ? { kind: "unproven_object" }
      : undefined;
  }
  const root = destructuringTargets(skipOuterExpressions(node.initializer))
    .map((target) => escapeRootOf(target, isBuiltinSpecifier))
    .find((found) => found !== undefined);
  // Whatever the iterable: its iterator may be replaced, and yield any
  // value (task BL-081's second audit round).
  return root;
}

function isVarList(list: ts.VariableDeclarationList): boolean {
  return (list.flags & ts.NodeFlags.BlockScoped) === 0;
}

/**
 * Task BL-081 (its audit): the stores that have no assignment expression.
 * Each writes onto an object not proven to be one the program created, so
 * each is an escape, like an assignment to that object's member:
 *
 * - a `var` declaration with an initializer in a `with` body, which writes
 *   the `with` object when it has the name (`with (Object) { var keys =
 *   f; }`); a block `function` declaration does not (measured);
 * - an instance field of a DERIVED class (`class D extends B { keys = f;
 *   }`), defined onto whatever the base constructor returned -- any
 *   object, a builtin too;
 * - a TypeScript parameter property of a derived class's constructor
 *   (`constructor(public keys) { super(); }`), compiled to `this.keys =
 *   keys` after `super()`.
 *
 * Returns the value the declaration stores, or `undefined` when it is no
 * such store or stores a provable primitive.
 */
export function declarationStoreOf(node: ts.Node): ts.Expression | undefined {
  let value: ts.Expression | undefined;
  if (ts.isVariableDeclaration(node)) {
    const stores =
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.parent) &&
      isVarList(node.parent) &&
      insideWith(node);
    if (stores && !ts.isIdentifier(node.name)) {
      // A pattern reads and may iterate its source, and stores its
      // defaults: a store whatever the initializer is.
      return node.initializer;
    }
    value = stores ? node.initializer : undefined;
  } else if (ts.isPropertyDeclaration(node)) {
    const derived =
      ts.isClassLike(node.parent) && isDerived(node.parent) && !isStatic(node);
    const decorators = ts.getDecorators(node) ?? [];
    if (derived && decorators.length > 0) {
      // A field decorator may replace the initializer with any function's
      // result (TC39 decorators): what is stored is not the initializer.
      return node.initializer ?? decorators[0]!.expression;
    }
    value = derived ? node.initializer : undefined;
  } else if (ts.isParameter(node)) {
    const ctor = node.parent;
    value =
      ts.isIdentifier(node.name) &&
      ts.isParameterPropertyDeclaration(node, ctor) &&
      ts.isClassLike(ctor.parent) &&
      isDerived(ctor.parent)
        ? node.name
        : undefined;
  }
  return value !== undefined &&
    (escapingValuesOf(value).length > 0 || !isPrimitiveSyntax(value))
    ? value
    : undefined;
}

/**
 * Task BL-081 (its two audit rounds): whether a store writes a value the
 * stored expression's own members do not show, so that the store also gets
 * an unknown edge. A destructuring pattern READS its source, and an
 * iteration CALLS an iterator:
 *
 * - a `for…of` head and an array pattern take each element from the
 *   iterable's iterator, which may yield any value -- an object's own
 *   `*[Symbol.iterator]() { yield f; }`, and for an array literal or a
 *   string too, since `Array.prototype[Symbol.iterator]` and `next` can be
 *   replaced (a replacement is an escape of the replacing generator, but
 *   what it yields gets no edge of its own);
 * - an object pattern reads a member of its source, which is attributed
 *   only when the source is an object literal and the pattern goes one
 *   level deep (`({ a: O.k } = { a: f })`); a member of anything else
 *   (`({ a: O.k } = fn)`, `fn.a = f`) is not the source.
 */
export function storeReadsUnseen(
  node:
    | ts.BinaryExpression
    | ts.ForOfStatement
    | ts.VariableDeclaration
    | ts.PropertyDeclaration
    | ts.ParameterDeclaration,
  stored: ts.Expression,
): boolean {
  if (ts.isForOfStatement(node)) {
    return true;
  }
  const pattern = ts.isBinaryExpression(node)
    ? skipOuterExpressions(node.left)
    : ts.isVariableDeclaration(node)
      ? node.name
      : undefined;
  if (pattern === undefined) {
    return false;
  }
  if (
    ts.isArrayLiteralExpression(pattern) ||
    ts.isArrayBindingPattern(pattern)
  ) {
    return true;
  }
  if (
    !ts.isObjectLiteralExpression(pattern) &&
    !ts.isObjectBindingPattern(pattern)
  ) {
    return false;
  }
  return (
    !ts.isObjectLiteralExpression(skipOuterExpressions(stored)) ||
    patternMembers(pattern).some((target) => isPattern(target))
  );
}

/** The targets one level of an object pattern names (a default's value is not a target). */
function patternMembers(
  pattern: ts.ObjectLiteralExpression | ts.ObjectBindingPattern,
): ts.Node[] {
  if (ts.isObjectBindingPattern(pattern)) {
    return pattern.elements.map((element) => element.name);
  }
  return pattern.properties.flatMap((property) => {
    if (ts.isPropertyAssignment(property)) {
      const value = skipOuterExpressions(property.initializer);
      return [
        ts.isBinaryExpression(value) &&
        value.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? skipOuterExpressions(value.left)
          : value,
      ];
    }
    return ts.isSpreadAssignment(property) ? [property.expression] : [];
  });
}

function isPattern(node: ts.Node): boolean {
  return (
    ts.isObjectLiteralExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isObjectBindingPattern(node) ||
    ts.isArrayBindingPattern(node)
  );
}

/** The member keys a stored function or class gains own members through: a function's `prototype`, a module's `exports`. */
const MODEL_KEYS: ReadonlySet<string> = new Set(["prototype", "exports"]);

/**
 * Task BL-081 (its fifth and sixth audit rounds): whether a store may put
 * its value under a `prototype` or `exports` key -- a target member spelled
 * so, one whose key is computed at run time, or a bare name spelled so in a
 * `with` body (`with (F) { prototype = K; }`). A function or class stored
 * there becomes the prototype (or module exports) of an object this file
 * may not follow, and every store through it adds an own member unseen; so
 * the store gives such a value an unknown edge as well.
 */
export function storesUnderPrototypeKey(
  node:
    | ts.BinaryExpression
    | ts.ForOfStatement
    | ts.VariableDeclaration
    | ts.PropertyDeclaration
    | ts.ParameterDeclaration,
): boolean {
  if (ts.isVariableDeclaration(node)) {
    return bindingNames(node.name).some(
      (id) => MODEL_KEYS.has(id.text) && insideWith(id),
    );
  }
  if (!ts.isBinaryExpression(node) && !ts.isForOfStatement(node)) {
    return false;
  }
  if (
    ts.isForOfStatement(node) &&
    ts.isVariableDeclarationList(node.initializer)
  ) {
    return node.initializer.declarations.some((declaration) =>
      bindingNames(declaration.name).some(
        (id) => MODEL_KEYS.has(id.text) && insideWith(id),
      ),
    );
  }
  const left = ts.isBinaryExpression(node) ? node.left : node.initializer;
  return destructuringTargets(skipOuterExpressions(left as ts.Expression)).some(
    (raw) => {
      const target = skipOuterExpressions(raw);
      if (ts.isIdentifier(target)) {
        return MODEL_KEYS.has(target.text) && insideWith(target);
      }
      if (ts.isElementAccessExpression(target)) {
        const key = target.argumentExpression;
        return !ts.isStringLiteralLike(key) || MODEL_KEYS.has(key.text);
      }
      return (
        ts.isPropertyAccessExpression(target) &&
        MODEL_KEYS.has(target.name.text)
      );
    },
  );
}

function bindingNames(name: ts.BindingName): ts.Identifier[] {
  return ts.isIdentifier(name)
    ? [name]
    : name.elements.flatMap((element) =>
        ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
      );
}

/** The builtins that define a property under a key one argument names (its position). */
const KEYED_DEFINERS: ReadonlyMap<string, number> = new Map([
  ["call global:Object.defineProperty", 1],
  ["call global:Reflect.defineProperty", 1],
  ["call global:Reflect.set", 1],
]);

/**
 * The same question at a builtin call (task BL-081's sixth audit round):
 * whether the call may store what it is handed under a `prototype` or
 * `exports` key -- an argument spells the key, as a string or as an object
 * literal's property (or a computed one), at any depth
 * (`Object.assign(F, { prototype: K })`, `Object.defineProperties(F, {
 * prototype: { value: K } })`), or the key position of a builtin that
 * defines a property by key is not a string spelling another key
 * (`Reflect.set(F, k, K)`).
 */
export function builtinMayStoreUnderModelKey(
  behaviourKey: string,
  args: readonly ts.Expression[],
): boolean {
  const spells = (raw: ts.Expression): boolean => {
    const expr = skipOuterExpressions(raw);
    if (ts.isStringLiteralLike(expr)) {
      return MODEL_KEYS.has(expr.text);
    }
    // The same forms `escapingValuesOf` reads a value through, so a key is
    // never read through fewer than its value (task BL-081's tenth audit
    // round: `Object.assign(F, c ? { prototype: K } : {})`).
    if (ts.isConditionalExpression(expr)) {
      return spells(expr.whenTrue) || spells(expr.whenFalse);
    }
    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      if (
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return spells(expr.left) || spells(expr.right);
      }
      if (op === ts.SyntaxKind.CommaToken || op === ts.SyntaxKind.EqualsToken) {
        return spells(expr.right);
      }
    }
    if (ts.isObjectLiteralExpression(expr)) {
      return expr.properties.some(
        (property) =>
          (property.name !== undefined &&
            (ts.isComputedPropertyName(property.name) ||
              ((ts.isIdentifier(property.name) ||
                ts.isStringLiteralLike(property.name)) &&
                MODEL_KEYS.has(property.name.text)))) ||
          (ts.isPropertyAssignment(property) && spells(property.initializer)) ||
          (ts.isSpreadAssignment(property) && spells(property.expression)),
      );
    }
    if (ts.isArrayLiteralExpression(expr)) {
      return expr.elements.some(
        (element) =>
          !ts.isOmittedExpression(element) &&
          spells(ts.isSpreadElement(element) ? element.expression : element),
      );
    }
    return false;
  };
  if (
    args.some((arg) => spells(ts.isSpreadElement(arg) ? arg.expression : arg))
  ) {
    return true;
  }
  const position = KEYED_DEFINERS.get(behaviourKey);
  if (position === undefined) {
    return false;
  }
  const key = args[position];
  return (
    key === undefined ||
    ts.isSpreadElement(key) ||
    !ts.isStringLiteralLike(skipOuterExpressions(key)) ||
    args.slice(0, position).some((arg) => ts.isSpreadElement(arg))
  );
}

/**
 * The default values of a binding pattern (`var { keys = f } = 0`), at any
 * depth: a store when the source has no such member, so a value the store
 * may write. (In an assignment pattern a default is an assignment
 * expression, a site of its own.)
 */
export function bindingPatternDefaults(name: ts.BindingName): ts.Expression[] {
  if (ts.isIdentifier(name)) {
    return [];
  }
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element)
      ? []
      : [
          ...(element.initializer ? [element.initializer] : []),
          ...bindingPatternDefaults(element.name),
        ],
  );
}

/** The targets an assignment's left-hand side writes: itself, or every target of a destructuring pattern. */
export function destructuringTargets(raw: ts.Expression): ts.Expression[] {
  const node = skipOuterExpressions(raw);
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.flatMap((property) =>
      ts.isShorthandPropertyAssignment(property)
        ? [property.name]
        : ts.isPropertyAssignment(property)
          ? destructuringTargets(property.initializer)
          : ts.isSpreadAssignment(property)
            ? destructuringTargets(property.expression)
            : [],
    );
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element) =>
      ts.isOmittedExpression(element)
        ? []
        : destructuringTargets(
            ts.isSpreadElement(element) ? element.expression : element,
          ),
    );
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return destructuringTargets(node.left);
  }
  return [node];
}

/**
 * Only the ambient global VALUES Node supplies ({@link AMBIENT_GLOBAL_NAMES})
 * and builtin modules have implicit invokers the program cannot show at a
 * call site (`Error.prepareStackTrace`, a later `Math.max(1)` trusted as
 * the builtin). A write to any other undeclared name -- an implicit
 * global, `alias = impl` -- is reached only through a call of that name,
 * which is an unknown callee already: every `global:` key of the builtin
 * table is rooted in {@link AMBIENT_GLOBAL_NAMES} (the admission test
 * checks it), so no name outside the list can earn a no-edge proof.
 */
function escapeRootOf(
  target: ts.Expression,
  isBuiltinSpecifier: (specifier: string) => boolean,
): EscapeRoot | undefined {
  if (ts.isIdentifier(target)) {
    // `Promise = P` in sloppy mode replaces the global. The file then
    // "assigns to the bare name", so isAmbientRoot refuses the name
    // everywhere in this file; the question here is only whether an
    // undeclared ambient global is being written.
    const binding = resolveNamedBinding(target);
    if (
      AMBIENT_GLOBAL_NAMES.has(target.text) &&
      binding.kind === "unresolved" &&
      binding.cause === "no_declaration"
    ) {
      return { kind: "ambient" };
    }
    // Task BL-081 (RWF-120): in a `with` body a bare name may be a member
    // of the `with` object -- `with (Object) { keys = f; }` writes
    // `Object.keys` -- and that object may be a builtin.
    return insideWith(target) ? { kind: "unproven_object" } : undefined;
  }
  if (
    !ts.isPropertyAccessExpression(target) &&
    !ts.isElementAccessExpression(target)
  ) {
    return undefined;
  }
  let root: ts.Expression = target;
  while (
    ts.isPropertyAccessExpression(root) ||
    ts.isElementAccessExpression(root)
  ) {
    root = skipOuterExpressions(root.expression);
  }
  if (ts.isIdentifier(root) && mayBeAmbientGlobalValue(root)) {
    return { kind: "ambient" };
  }
  if (ts.isIdentifier(root) && aliasesAmbientValue(root, 0)) {
    // `const M = Math; M.max = f` writes onto the ambient `Math` itself.
    return { kind: "ambient" };
  }
  const specifier = ts.isIdentifier(root)
    ? importSpecifierThroughAliases(root, 0)
    : staticRequireSpecifier(root);
  if (specifier !== undefined && isBuiltinSpecifier(specifier)) {
    return { kind: "builtin", specifier };
  }
  // Task BL-081 (RWF-110, RWF-063): the checks above see a builtin object
  // only when the store SPELLS it -- its ambient name, a `const` alias, a
  // builtin module binding. Every other route to one (a parameter, a
  // container, a returned value, a load, `constructor` / `__proto__` /
  // `Object.getPrototypeOf`, a sloppy call's `this`) is unbounded, so the
  // question is turned around: a store is an escape unless the object it
  // writes onto is PROVEN to be one the program created.
  return isProvenFreshObject(target.expression)
    ? undefined
    : { kind: "unproven_object" };
}

/**
 * The module specifier `id` is bound to, directly (an import or a
 * `require` binding) or through `const` aliases of one
 * (`const p = require("path"); const q = p;` -- task A-3a's re-audit).
 */
function importSpecifierThroughAliases(
  id: ts.Identifier,
  hops: number,
): string | undefined {
  const direct = importSpecifierOf(id);
  if (direct !== undefined || hops > MAX_ALIAS_HOPS) {
    return direct;
  }
  const binding = resolveNamedBinding(id, { followAliases: false });
  if (binding.kind !== "value") {
    return undefined;
  }
  const { root } = memberChainOf(binding.value);
  return ts.isIdentifier(root)
    ? importSpecifierThroughAliases(root, hops + 1)
    : staticRequireSpecifier(root);
}

/**
 * Whether a stable local binding holds an ambient global value, or a
 * member of one, through `const` aliases (`const M = Math`,
 * `const P = Object.prototype`). A write through it writes onto the
 * builtin. Only the lexical `const`-alias form is followed; a builtin
 * object that reaches a user binding any other way (a parameter, a
 * container) is not seen here -- recorded as an open finding by task
 * A-3a.
 */
function aliasesAmbientValue(id: ts.Identifier, hops: number): boolean {
  if (hops > MAX_ALIAS_HOPS) {
    return false;
  }
  // One hop at a time: followed by default, `const M = Math` would resolve
  // straight through to the undeclared `Math` and read as no declaration.
  const binding = resolveNamedBinding(id, { followAliases: false });
  return (
    binding.kind === "value" && mayDenoteAmbientValue(binding.value, hops + 1)
  );
}

/**
 * Whether `expr` may evaluate to an ambient global value or a member of
 * one: through a member chain, a `const` alias, or EITHER branch of a
 * conditional or logical operator (`typeof globalThis !== "undefined" ?
 * globalThis : global`, found by task A-3a's audit).
 */
function mayDenoteAmbientValue(raw: ts.Expression, hops: number): boolean {
  const expr = skipOuterExpressions(raw);
  if (ts.isConditionalExpression(expr)) {
    return (
      mayDenoteAmbientValue(expr.whenTrue, hops) ||
      mayDenoteAmbientValue(expr.whenFalse, hops)
    );
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return (
        mayDenoteAmbientValue(expr.left, hops) ||
        mayDenoteAmbientValue(expr.right, hops)
      );
    }
    return op === ts.SyntaxKind.CommaToken
      ? mayDenoteAmbientValue(expr.right, hops)
      : false;
  }
  const { root } = memberChainOf(expr);
  if (!ts.isIdentifier(root)) {
    return false;
  }
  return mayBeAmbientGlobalValue(root) || aliasesAmbientValue(root, hops);
}

/**
 * Whether a write through `id` may write onto an ambient global value: the
 * name is one of {@link AMBIENT_GLOBAL_NAMES} and no scope declares it.
 * Deliberately NOT {@link isAmbientRoot}, whose answer a bare-name write
 * anywhere in the file turns off (`if (false) { Math = 0; }`): for an
 * ESCAPE, over-approximating only adds edges, so a name that may still be
 * the global counts (task A-3a's third audit round).
 */
function mayBeAmbientGlobalValue(id: ts.Identifier): boolean {
  if (!AMBIENT_GLOBAL_NAMES.has(id.text)) {
    return false;
  }
  const binding = resolveNamedBinding(id);
  return binding.kind === "unresolved" && binding.cause === "no_declaration";
}

/**
 * The literal specifier of `require("<literal>")`, where `require` is the
 * CommonJS module-scope binding: no scope in the file declares or assigns
 * it ({@link isModuleScopeRoot}), so a local `function require` is never
 * taken for it.
 */
export function staticRequireSpecifier(
  expr: ts.Expression,
): string | undefined {
  const call = skipOuterExpressions(expr);
  if (
    ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    call.expression.text === "require" &&
    isModuleScopeRoot(call.expression) &&
    call.arguments.length === 1 &&
    ts.isStringLiteralLike(call.arguments[0]!)
  ) {
    return (call.arguments[0] as ts.StringLiteralLike).text;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Objects the program created (task BL-081)
// ---------------------------------------------------------------------------

/**
 * Whether `raw` provably evaluates to an object the program itself
 * created -- never to a builtin object Node supplies, whatever any module
 * did -- so a store onto one of its members cannot replace a builtin the
 * call graph trusts (task BL-081; RWF-110, RWF-063).
 *
 * THE ARGUMENT. An object's identity never changes; only a binding or a
 * property can come to hold a different object, and only through a store.
 * So each proof below is either a fresh value at the point of evaluation
 * (a literal, a function or class, a base class's `this`) or a binding or
 * member whose EVERY store in this file is checked to hold such a value.
 * A store that makes one of them hold a builtin object through any other
 * route -- another file, a parameter, a `with` body -- is itself a store
 * onto an unproven object (an escape here, whose builtin value gets an
 * unknown edge), and so is a builtin call that writes it
 * (`Object.assign(F, { prototype: P })`: a non-admitted position, whose
 * value gets an edge). Either way the replacement cannot happen unseen.
 *
 * The argument holds only over a CLOSED list of store forms, each a site:
 * an assignment (`=`, `||=`, `&&=`, `??=`, every target of a destructuring
 * pattern), a `for…of` head, a bare name in a `with` body, and the forms
 * with no assignment syntax ({@link declarationStoreOf}: a `var` in a
 * `with` body, a derived class's instance field or parameter property).
 * A binding the language rebinds without a store is refused outright: a
 * decorated class (its decorator's result), the CommonJS wrapper's
 * parameters when `arguments` is read. Task BL-081's first version missed
 * three of these; its independent audit found them.
 *
 * The proofs, each checked against real Node by
 * `tests/oracle/bl081-builtin-replaced-without-name.test.ts`:
 *
 * - an object, array, function, arrow, class or regular-expression literal;
 * - `this` at a module's top level (the CommonJS exports object, or
 *   `undefined` in an ES module, where the store throws), in a constructor
 *   or an instance field initializer of a class with no `extends` (a
 *   fresh instance), or in a static field initializer or static block (the
 *   class itself) -- never in a method or a function, whose `this` is its
 *   receiver, and never in a derived class, whose `this` is what the base
 *   constructor returned;
 * - a name bound, with no write to it, to a `function` or undecorated
 *   `class` declaration or to one of the values above ({@link resolveNamedBinding}'s
 *   stable binding, never inside a `with` body);
 * - in a proven CommonJS module scope ({@link isProvenCommonJsModuleScope}:
 *   the wrapper's `arguments` are never touched), `module` when nothing
 *   writes the name, `exports` when every write to the name stores one of
 *   these values, and `module.exports` when every store onto `module`'s
 *   `exports` member (and no store under a computed key) does. `module`
 *   is not a builtin object any trusted call reads, but Node's loader
 *   does call a member of it on every `require()` (`module.require`):
 *   a store onto it is a loader mutation, lane C's account (measured
 *   `UNKNOWN` there), not this proof's;
 * - `C.prototype` for a class `C` (non-writable), or for a stably bound
 *   function whose `prototype` member every store in this file sets to one
 *   of these values.
 *
 * Everything else is unproven: a parameter, a call or `new` result
 * (a constructor may return any object; `Object.create` may have been
 * replaced), a member read, a load, `arguments`, `super`.
 */
export function isProvenFreshObject(raw: ts.Expression): boolean {
  return isFresh(raw, 0);
}

function isFresh(raw: ts.Expression, hops: number): boolean {
  if (hops > MAX_ALIAS_HOPS) {
    return false;
  }
  const expr = skipOuterExpressions(raw);
  if (ts.isObjectLiteralExpression(expr) && setsOwnPrototype(expr)) {
    // `{ __proto__: globalThis }`: a store onto it may run an inherited
    // setter -- Node's own (`globalThis`'s `Buffer`, `process`) store into
    // the global object (task BL-081's seventh audit round).
    return false;
  }
  if (
    ts.isObjectLiteralExpression(expr) ||
    ts.isArrayLiteralExpression(expr) ||
    ts.isFunctionExpression(expr) ||
    ts.isArrowFunction(expr) ||
    (ts.isClassExpression(expr) && !isDecorated(expr)) ||
    ts.isRegularExpressionLiteral(expr)
  ) {
    return true;
  }
  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    return isFreshThis(expr);
  }
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    // `a = b = {}`: the value of an assignment is its right-hand side.
    return isFresh(expr.right, hops + 1);
  }
  if (ts.isIdentifier(expr)) {
    return isFreshBinding(expr, hops);
  }
  const member = staticMemberOf(expr);
  if (member === undefined || !ts.isIdentifier(member.object)) {
    return false;
  }
  if (
    (member.key === "exports" || member.key === "prototype") &&
    prototypeMayBeChanged(undefined, expr.getSourceFile())
  ) {
    // Its [[Prototype]] may be changed through a store the file makes
    // under `__proto__` through any name (an alias of it too).
    return false;
  }
  if (member.key === "exports" && member.object.text === "module") {
    return (
      isFreshBinding(member.object, hops) &&
      everyMemberStoreIsFresh(member.object, "exports", hops)
    );
  }
  if (member.key === "prototype" && isFreshBinding(member.object, hops)) {
    const binding = resolveNamedBinding(member.object);
    if (
      binding.kind === "class" ||
      (binding.kind === "value" &&
        ts.isClassExpression(skipOuterExpressions(binding.value)))
    ) {
      // A class's `prototype` is non-writable and non-configurable (the
      // binding is proven above, so it is the class, undecorated).
      return true;
    }
    return (
      isFunctionBinding(binding) &&
      everyMemberStoreIsFresh(member.object, "prototype", hops)
    );
  }
  return false;
}

/**
 * Whether the binding is a function with an OWN `prototype` -- a plain or
 * generator function. An async function that is not a generator has none
 * (measured), so its `prototype` is read through its [[Prototype]], which
 * `A.__proto__ = X` redirects (task BL-081's seventh audit round); an
 * arrow has none either.
 */
function isFunctionBinding(
  binding: ReturnType<typeof resolveNamedBinding>,
): boolean {
  const fn =
    binding.kind === "function" || binding.kind === "function-expression"
      ? binding.declaration
      : binding.kind === "value"
        ? skipOuterExpressions(binding.value)
        : undefined;
  if (
    fn === undefined ||
    !(ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn))
  ) {
    return false;
  }
  const isAsync = (ts.getModifiers(fn) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
  );
  return !isAsync || fn.asteriskToken !== undefined;
}

/** Whether an object literal sets its own [[Prototype]] (`{ __proto__: p }`). */
function setsOwnPrototype(literal: ts.ObjectLiteralExpression): boolean {
  return literal.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) ||
        ts.isStringLiteralLike(property.name)) &&
      property.name.text === "__proto__",
  );
}

/**
 * Whether the [[Prototype]] of an object the file names may be changed by
 * a store the file makes: a store under `__proto__` (or a computed key)
 * onto a name that may denote it, or -- for an object no name denotes, a
 * class's instance or `prototype` -- onto any base that is not a name
 * (task BL-081's seventh audit round). `Object.setPrototypeOf` and
 * `Reflect.setPrototypeOf` hand the new prototype to a builtin at a
 * position no admission covers: an edge of their own.
 */
function prototypeMayBeChanged(
  object: ts.Identifier | undefined,
  sourceFile: ts.SourceFile,
): boolean {
  const index = memberStoreIndex(sourceFile);
  if (
    index.nonNameKeys.has("__proto__") ||
    index.nonNameKeys.has(COMPUTED_KEY)
  ) {
    return true;
  }
  if (object === undefined) {
    return index.byKey.has("__proto__");
  }
  return (
    hasStores(storesOnto(object, "__proto__")) ||
    hasStores(storesOnto(object, COMPUTED_KEY))
  );
}

/**
 * Whether a declaration binds no run-time value: a TypeScript `declare`
 * declaration, one in an ambient context or a `.d.ts`, or a function
 * overload with no body. The name is then the global it is spelled like
 * at run time (task BL-081's seventh audit round: `declare class Object
 * {}` was proven to be the program's own object).
 */
function isAmbientDeclaration(declaration: ts.Node): boolean {
  if (
    (ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration)) &&
    declaration.body === undefined
  ) {
    return true;
  }
  for (
    let current: ts.Node | undefined = declaration;
    current;
    current = current.parent
  ) {
    if (ts.isSourceFile(current)) {
      return current.isDeclarationFile;
    }
    if (
      ts.canHaveModifiers(current) &&
      (ts.getModifiers(current) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
      )
    ) {
      return true;
    }
  }
  return false;
}

/** `o.k` or `o["k"]`: the object and the literal key; `undefined` for anything else. */
function staticMemberOf(
  expr: ts.Expression,
): { readonly object: ts.Expression; readonly key: string } | undefined {
  if (ts.isPropertyAccessExpression(expr)) {
    return {
      object: skipOuterExpressions(expr.expression),
      key: expr.name.text,
    };
  }
  if (ts.isElementAccessExpression(expr)) {
    const argument = skipOuterExpressions(expr.argumentExpression);
    // A string or number literal names its key. A symbol does not: even a
    // well-known one is read off the global `Symbol`, which another module
    // may replace with a primitive store no escape sees (`globalThis.Symbol
    // = ""; String.prototype.toStringTag = "__proto__"`; task BL-081's
    // ninth audit round).
    const key =
      ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)
        ? argument.text
        : undefined;
    return key === undefined
      ? undefined
      : { object: skipOuterExpressions(expr.expression), key };
  }
  return undefined;
}

function isFreshThis(node: ts.Node): boolean {
  // A class's instance, the class itself and the exports object inherit
  // from objects whose [[Prototype]] a `__proto__` store may change (task
  // BL-081's seventh audit round).
  if (prototypeMayBeChanged(undefined, node.getSourceFile())) {
    return false;
  }
  return isFreshThisPosition(node);
}

function isFreshThisPosition(node: ts.Node): boolean {
  let child: ts.Node = node;
  for (
    let current = node.parent;
    current;
    child = current, current = current.parent
  ) {
    if (ts.isDecorator(current) || ts.isModuleDeclaration(current)) {
      // A decorator evaluates in the enclosing scope, not on the instance
      // (a computed member name too: for a field, the initializer check
      // below refuses it; for a method or accessor, the function does); a
      // TypeScript `namespace` body compiles to a function whose `this` is
      // not the module's.
      return false;
    }
    if (ts.isArrowFunction(current)) {
      continue;
    }
    if (ts.isSourceFile(current)) {
      return true;
    }
    if (ts.isEnumDeclaration(current)) {
      // A TypeScript `enum` compiles to a function whose `this` is the
      // caller's.
      return false;
    }
    if (ts.isClassStaticBlockDeclaration(current)) {
      // The class itself -- unless a class decorator stands in for it
      // (TC39 decorators run static code on the decorator's result).
      return ts.isClassLike(current.parent) && !isDecorated(current.parent);
    }
    if (ts.isPropertyDeclaration(current) && ts.isClassLike(current.parent)) {
      // A field initializer: `this` is the class for a static field (the
      // decorator's result for a decorated class), the new instance for an
      // instance field.
      return (
        child === current.initializer &&
        (isStatic(current)
          ? !isDecorated(current.parent)
          : !isDerived(current.parent))
      );
    }
    if (ts.isConstructorDeclaration(current)) {
      return ts.isClassLike(current.parent) && !isDerived(current.parent);
    }
    if (ts.isFunctionLike(current) || ts.isClassLike(current)) {
      // A function's or method's `this` is its receiver; a computed key or
      // heritage clause of a class evaluates in the enclosing scope, but
      // is not worth a proof.
      return false;
    }
  }
  return false;
}

function isDecorated(cls: ts.ClassLikeDeclaration): boolean {
  return (ts.getDecorators(cls)?.length ?? 0) > 0;
}

function isStatic(node: ts.PropertyDeclaration): boolean {
  return (ts.getModifiers(node) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
  );
}

function isDerived(cls: ts.ClassLikeDeclaration): boolean {
  return (cls.heritageClauses ?? []).some(
    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
  );
}

function isFreshBinding(id: ts.Identifier, hops: number): boolean {
  if (insideWith(id)) {
    return false;
  }
  const sourceFile = id.getSourceFile();
  if (
    (id.text === "module" || id.text === "exports") &&
    isUndeclaredInProvenCommonJs(id)
  ) {
    if (id.text === "module") {
      return !assignedNames(sourceFile).has("module");
    }
    const stores = storesToName(sourceFile, "exports");
    return (
      !prototypeMayBeChanged(id, sourceFile) &&
      stores.every((value) => value !== undefined && isFresh(value, hops + 1))
    );
  }
  const binding = resolveNamedBinding(id);
  switch (binding.kind) {
    case "function":
    case "function-expression":
    case "class": {
      // A class decorator may hand back any value, which the name is then
      // bound to (`@dec class C {}` compiles to `C = dec(C) || C`; the
      // audit of task BL-081 measured `Object` from both decorator modes).
      if (
        (binding.kind === "class" &&
          ts.isClassLike(binding.declaration) &&
          isDecorated(binding.declaration)) ||
        isAmbientDeclaration(binding.declaration) ||
        prototypeMayBeChanged(id, sourceFile)
      ) {
        return false;
      }
      // A `function` or `class` declaration binds a MUTABLE name
      // (`class C {} C = Object` is legal): `resolveNamedBinding` answers
      // `reassigned` for a name any store writes, through an alias too
      // (PRM-104, task A-5a), so a binding that reaches here is stable.
      return true;
    }
    case "value":
      return (
        isFresh(binding.value, hops + 1) &&
        !prototypeMayBeChanged(id, sourceFile)
      );
    case "unresolved":
      return false;
  }
}

/** The CommonJS wrapper's own `module` / `exports`: no declaration of the name in the file, in a proven CommonJS module scope. */
function isUndeclaredInProvenCommonJs(id: ts.Identifier): boolean {
  const sourceFile = id.getSourceFile();
  if (!isProvenCommonJsModuleScope(sourceFile)) {
    return false;
  }
  const binding = resolveNamedBinding(id);
  return binding.kind === "unresolved" && binding.cause === "no_declaration";
}

/**
 * Whether every store in the file onto `name`'s member `key` -- `module
 * .exports = v`, `F.prototype = v`, through any store form -- stores a
 * value {@link isFresh} proves, and no store onto `name` uses a key
 * computed at run time. Over-approximated by spelling (every `name.key`
 * store, whatever scope `name` resolves to there), which can only refuse.
 */
function everyMemberStoreIsFresh(
  object: ts.Identifier,
  key: string,
  hops: number,
): boolean {
  const index = memberStoreIndex(object.getSourceFile());
  // A base that is not a name may denote the object too (`(a =
  // Fn).prototype = v`, a member chain): any such store under the key, or
  // under a computed one, refuses the proof (task BL-081's second audit
  // round); so does a computed key on any name that may denote it.
  if (
    index.nonNameKeys.has(key) ||
    index.nonNameKeys.has(COMPUTED_KEY) ||
    hasStores(storesOnto(object, COMPUTED_KEY))
  ) {
    return false;
  }
  return everyStoreValueIsFresh(storesOnto(object, key), hops);
}

/** The key under which {@link memberStoreIndex} files a store whose key is computed at run time. */
const COMPUTED_KEY = "\u0000computed";

/**
 * Every member store of a file, indexed once (task BL-081's fifth audit
 * round: scanning every store for every object made the own-member and
 * freshness bookkeeping quadratic in the file's member stores). By key
 * (`COMPUTED_KEY` when computed), a name-based store is filed under its
 * base's spelling and, when the base names a function or class directly,
 * under that definition; any other name-based store is kept for the full
 * same-object check.
 */
interface MemberStoreIndex {
  readonly nonNameKeys: ReadonlySet<string>;
  readonly byKey: ReadonlyMap<
    string,
    {
      readonly bySpelling: Map<string, FileStore[]>;
      readonly byDefinition: Map<ts.Node, FileStore[]>;
      readonly others: { base: ts.Identifier; store: FileStore }[];
    }
  >;
}

const memberStoreIndexCache = new WeakMap<ts.SourceFile, MemberStoreIndex>();

let memberStoreIndexBuilds = 0;
let fullSameObjectChecks = 0;
let storeVisits = 0;

/** Operation counts of the own-member and freshness bookkeeping, for the structural performance test (ARCHITECTURE § 10). */
export function ownMemberBookkeepingCounts(): {
  readonly indexBuilds: number;
  readonly fullSameObjectChecks: number;
  readonly storeVisits: number;
} {
  return {
    indexBuilds: memberStoreIndexBuilds,
    fullSameObjectChecks,
    storeVisits,
  };
}

function memberStoreIndex(sourceFile: ts.SourceFile): MemberStoreIndex {
  const cached = memberStoreIndexCache.get(sourceFile);
  if (cached) {
    return cached;
  }
  memberStoreIndexBuilds += 1;
  const nonNameKeys = new Set<string>();
  const byKey = new Map<
    string,
    {
      bySpelling: Map<string, FileStore[]>;
      byDefinition: Map<ts.Node, FileStore[]>;
      others: { base: ts.Identifier; store: FileStore }[];
    }
  >();
  const push = <K>(map: Map<K, FileStore[]>, k: K, store: FileStore) => {
    const list = map.get(k);
    if (list) {
      list.push(store);
    } else {
      map.set(k, [store]);
    }
  };
  for (const store of fileStores(sourceFile)) {
    const target = skipOuterExpressions(store.target);
    if (
      !ts.isPropertyAccessExpression(target) &&
      !ts.isElementAccessExpression(target)
    ) {
      continue;
    }
    const key = staticMemberOf(target)?.key ?? COMPUTED_KEY;
    const base = skipOuterExpressions(target.expression);
    if (!ts.isIdentifier(base)) {
      nonNameKeys.add(key);
      continue;
    }
    let entry = byKey.get(key);
    if (!entry) {
      entry = { bySpelling: new Map(), byDefinition: new Map(), others: [] };
      byKey.set(key, entry);
    }
    push(entry.bySpelling, base.text, store);
    const definition = denotedDefinitionOf(base);
    if (definition !== undefined) {
      push(entry.byDefinition, definition, store);
    } else {
      entry.others.push({ base, store });
    }
  }
  const index = { nonNameKeys, byKey };
  memberStoreIndexCache.set(sourceFile, index);
  return index;
}

/**
 * The stores {@link storesOnto} answers: the ones found for this object
 * alone, and the list every object shares ({@link SharedStores}).
 */
interface StoreSet {
  readonly own: readonly FileStore[];
  readonly shared: SharedStores | undefined;
}

/**
 * A list of stores that is part of many answers: the stores onto a base
 * that cannot be followed, which may be onto any object. It is never
 * copied into an answer (task BL-091, observation 1: copying it into every
 * answer, and walking it for every object a caller asked about, made the
 * work quadratic in the file's member stores), and what callers ask of it
 * is computed once per alias-hop budget.
 */
class SharedStores {
  private readonly answers = new Map<string, unknown>();

  constructor(readonly stores: readonly FileStore[]) {}

  /** `compute()`, once per `question`; a question that throws is not remembered. */
  memo<T>(question: string, compute: () => T): T {
    if (this.answers.has(question)) {
      return this.answers.get(question) as T;
    }
    const answer = compute();
    this.answers.set(question, answer);
    return answer;
  }
}

/** Whether any store is onto the object. */
function hasStores(set: StoreSet): boolean {
  return set.own.length > 0 || (set.shared?.stores.length ?? 0) > 0;
}

/** Whether every store is of a value {@link isFresh} proves (one `isFresh` per store of the shared list, not per answer). */
function everyStoreValueIsFresh(set: StoreSet, hops: number): boolean {
  const fresh = (store: FileStore): boolean => {
    storeVisits += 1;
    return store.value !== undefined && isFresh(store.value, hops + 1);
  };
  return (
    set.own.every(fresh) &&
    (set.shared === undefined ||
      set.shared.memo(`fresh@${hops}`, () => set.shared!.stores.every(fresh)))
  );
}

/**
 * The definitions {@link definitionsDenotedBy} follows the stored values
 * to; throws {@link DenotationUnknown} when any value cannot be followed.
 * The shared list's definitions are followed once per alias-hop budget.
 */
function storeValueDefinitions(set: StoreSet, hops: number): ts.Node[] {
  const definitions = (store: FileStore): ts.Node[] => {
    storeVisits += 1;
    return store.value === undefined
      ? []
      : definitionsDenotedBy(store.value, hops + 1);
  };
  const own = set.own.flatMap(definitions);
  if (set.shared === undefined) {
    return own;
  }
  const shared = set.shared;
  const followed = shared.memo(`definitions@${hops}`, () => {
    try {
      return [...new Set(shared.stores.flatMap(definitions))];
    } catch (error) {
      if (error instanceof DenotationUnknown) {
        return undefined;
      }
      throw error;
    }
  });
  if (followed === undefined) {
    throw new DenotationUnknown();
  }
  return [...own, ...followed];
}

/** The name-based stores under `key` whose base may denote the object `object` names ({@link mayDenoteSameObject}). */
function storesOnto(object: ts.Identifier, key: string): StoreSet {
  const entry = memberStoreIndex(object.getSourceFile()).byKey.get(key);
  if (!entry) {
    return { own: [], shared: undefined };
  }
  // Memoized per binding and key (task BL-081's sixth audit round: the
  // `others` bucket was checked per pair of objects): the answer depends
  // only on the spelling and on what the binding denotes.
  const binding = resolveNamedBinding(object, { followAliases: false });
  const bindingKey: object =
    binding.kind === "unresolved" ? entry : binding.declaration;
  let perBinding = storesOntoCache.get(bindingKey);
  if (!perBinding) {
    perBinding = new Map();
    storesOntoCache.set(bindingKey, perBinding);
  }
  // Inside a `with` body the name cannot be followed (it may be the `with`
  // object's member), so the answer differs there (task BL-081's tenth
  // audit round: a lookup from a `with` body cached a smaller set). Nor are
  // all unresolved names of one spelling alike: only the module's own
  // `exports` (no declaration, in a CommonJS module) is followed through
  // the values stored to it, a parameter or a `var exports;` of the same
  // spelling is not (task BL-091, observation 2), so the cause is part of
  // the key.
  const kind =
    binding.kind === "unresolved"
      ? `unresolved:${binding.cause}`
      : binding.kind;
  const memoKey = `${object.text}\u0000${key}\u0000${kind}\u0000${String(insideWith(object))}`;
  const memo = perBinding.get(memoKey);
  if (memo) {
    return memo;
  }
  const result = computeStoresOnto(object, entry);
  perBinding.set(memoKey, result);
  return result;
}

const storesOntoCache = new WeakMap<object, Map<string, StoreSet>>();

function computeStoresOnto(
  object: ts.Identifier,
  entry: {
    readonly bySpelling: Map<string, FileStore[]>;
    readonly byDefinition: Map<ts.Node, FileStore[]>;
    readonly others: { base: ts.Identifier; store: FileStore }[];
  },
): StoreSet {
  const found = new Set<FileStore>(entry.bySpelling.get(object.text) ?? []);
  let denoted: readonly ts.Node[] | undefined;
  try {
    denoted = definitionsDenotedBy(object, 0);
  } catch (error) {
    if (!(error instanceof DenotationUnknown)) {
      throw error;
    }
  }
  if (denoted === undefined) {
    // The object cannot be followed: it may be what any of them denote.
    for (const list of entry.byDefinition.values()) {
      list.forEach((store) => found.add(store));
    }
  } else {
    for (const definition of denoted) {
      (entry.byDefinition.get(definition) ?? []).forEach((store) =>
        found.add(store),
      );
    }
  }
  const others = othersIndexOf(entry);
  if (others === undefined || denoted === undefined) {
    // While the index is being built (a re-entrant question), or when the
    // object cannot be followed: the per-pair check, as before.
    for (const { base, store } of entry.others) {
      if (!found.has(store)) {
        fullSameObjectChecks += 1;
        if (mayDenoteSameObject(base, object)) {
          found.add(store);
        }
      }
    }
    return { own: [...found], shared: undefined };
  }
  // `mayDenoteSameObject(base, object)` holds exactly when the base's alias
  // chain spells the object's name, when what the base denotes meets what
  // the object denotes, or when the base cannot be followed (task BL-081's
  // ninth audit round: the per-pair check was quadratic).
  (others.byAliasSpelling.get(object.text) ?? []).forEach((store) =>
    found.add(store),
  );
  for (const definition of denoted) {
    (others.byDenotation.get(definition) ?? []).forEach((store) =>
      found.add(store),
    );
  }
  // The stores onto a base that cannot be followed are every such object's:
  // shared, not copied into each answer.
  return {
    own: [...found],
    shared: others.unknown.stores.length > 0 ? others.unknown : undefined,
  };
}

interface OthersIndex {
  readonly byAliasSpelling: Map<string, FileStore[]>;
  readonly byDenotation: Map<ts.Node, FileStore[]>;
  readonly unknown: SharedStores;
}

const othersIndexCache = new WeakMap<object, OthersIndex | "building">();

/** The `others` bucket of one key, indexed once: `undefined` while it is being built. */
function othersIndexOf(entry: {
  readonly others: { base: ts.Identifier; store: FileStore }[];
}): OthersIndex | undefined {
  const cached = othersIndexCache.get(entry);
  if (cached === "building") {
    return undefined;
  }
  if (cached) {
    return cached;
  }
  othersIndexCache.set(entry, "building");
  const byAliasSpelling = new Map<string, FileStore[]>();
  const byDenotation = new Map<ts.Node, FileStore[]>();
  const unknown: FileStore[] = [];
  const push = <K>(map: Map<K, FileStore[]>, k: K, store: FileStore) => {
    const list = map.get(k);
    if (list) {
      list.push(store);
    } else {
      map.set(k, [store]);
    }
  };
  try {
    for (const { base, store } of entry.others) {
      for (const spelling of aliasSpellingsOf(base)) {
        push(byAliasSpelling, spelling, store);
      }
      try {
        for (const definition of definitionsDenotedBy(base, 0)) {
          push(byDenotation, definition, store);
        }
      } catch (error) {
        if (!(error instanceof DenotationUnknown)) {
          throw error;
        }
        unknown.push(store);
      }
    }
  } catch (error) {
    othersIndexCache.delete(entry);
    throw error;
  }
  const index: OthersIndex = {
    byAliasSpelling,
    byDenotation,
    unknown: new SharedStores(unknown),
  };
  othersIndexCache.set(entry, index);
  return index;
}

/** The names a base's alias chain spells, as {@link mayDenoteSameObject} walks it. */
function aliasSpellingsOf(base: ts.Identifier): string[] {
  const spellings = [base.text];
  let current = base;
  for (let hops = 0; hops <= MAX_ALIAS_HOPS; hops += 1) {
    const alias = resolveNamedBinding(current, { followAliases: false });
    if (alias.kind !== "value") {
      break;
    }
    let value = skipOuterExpressions(alias.value);
    while (
      ts.isBinaryExpression(value) &&
      value.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      value = skipOuterExpressions(value.right);
    }
    if (!ts.isIdentifier(value)) {
      break;
    }
    spellings.push(value.text);
    current = value;
  }
  return spellings;
}

/**
 * Whether the name `base` may denote the object `object` names: spelled
 * alike (whatever scope either resolves to), bound to the same `function`
 * or `class` declaration, or a `const`-like alias whose chain ends at the
 * undeclared name (`const m = module; m.exports = v`). An alias is itself
 * a proven object ({@link isFreshBinding}), so a store through it is no
 * escape: it must be checked here, with the object's own stores.
 */
function mayDenoteSameObject(
  base: ts.Identifier,
  object: ts.Identifier,
): boolean {
  if (base.text === object.text) {
    return true;
  }
  // One hop at a time: followed by default, `const m = module` would
  // resolve straight through to the undeclared `module` and read as no
  // declaration.
  let current = base;
  for (let hops = 0; hops <= MAX_ALIAS_HOPS; hops += 1) {
    const alias = resolveNamedBinding(current, { followAliases: false });
    if (alias.kind !== "value") {
      break;
    }
    // An assignment's value is its right-hand side (`const m = (b =
    // module)`), as `isFresh` reads it.
    let value = skipOuterExpressions(alias.value);
    while (
      ts.isBinaryExpression(value) &&
      value.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      value = skipOuterExpressions(value.right);
    }
    if (!ts.isIdentifier(value)) {
      break;
    }
    if (value.text === object.text) {
      return true;
    }
    current = value;
  }
  // Two names for one function or class, through every route a freshness
  // proof accepts: an alias, a function expression's own name inside it
  // (`const Fn = function Self() { Self.prototype = v; }`), a name bound to
  // `F.prototype`, `module.exports` or an assignment's value holding it
  // (task BL-081's fourth audit round: the one relation
  // {@link definitionsDenotedBy}, never a second copy of the routes).
  try {
    const denoted = new Set(definitionsDenotedBy(object, 0));
    return definitionsDenotedBy(base, 0).some((node) => denoted.has(node));
  } catch (error) {
    if (error instanceof DenotationUnknown) {
      return true;
    }
    throw error;
  }
}

/**
 * The function or class definition a stable name denotes, if any. Its
 * `value` branch is not a second copy of {@link definitionsDenotedBy}'s
 * route through a stable name (task BL-091, observation 3: mutant M23
 * removed it, and the suites passed): `resolveNamedBinding` follows an alias
 * chain in one step, and `definitionsDenotedBy` follows one hop at a time
 * for at most {@link MAX_ALIAS_HOPS}. A name four or more aliases from a
 * function expression (measured: four to twelve) is denoted precisely only
 * through this branch; without it the relation answers "unknown" for it
 * (safe, but every store onto it is then every object's).
 */
function denotedDefinitionOf(id: ts.Identifier): ts.Node | undefined {
  const binding = resolveNamedBinding(id);
  if (
    binding.kind === "function" ||
    binding.kind === "function-expression" ||
    binding.kind === "class"
  ) {
    return isAmbientDeclaration(binding.declaration)
      ? undefined
      : binding.declaration;
  }
  if (binding.kind === "value") {
    const value = skipOuterExpressions(binding.value);
    return ts.isFunctionExpression(value) ||
      ts.isArrowFunction(value) ||
      ts.isClassExpression(value)
      ? value
      : undefined;
  }
  return undefined;
}

/** The value of every store in the file to the bare name `name` (`undefined`: a value the store does not show). */
function storesToName(
  sourceFile: ts.SourceFile,
  name: string,
): readonly (ts.Expression | undefined)[] {
  let index = nameStoreIndexCache.get(sourceFile);
  if (!index) {
    // Indexed once per file (task BL-081's sixth audit round: filtering
    // every store per `exports.x = …` store was quadratic).
    memberStoreIndexBuilds += 1;
    const built = new Map<string, (ts.Expression | undefined)[]>();
    for (const store of fileStores(sourceFile)) {
      const target = skipOuterExpressions(store.target);
      if (ts.isIdentifier(target)) {
        const list = built.get(target.text);
        if (list) {
          list.push(store.value);
        } else {
          built.set(target.text, [store.value]);
        }
      }
    }
    index = built;
    nameStoreIndexCache.set(sourceFile, index);
  }
  return index.get(name) ?? [];
}

const nameStoreIndexCache = new WeakMap<
  ts.SourceFile,
  ReadonlyMap<string, readonly (ts.Expression | undefined)[]>
>();

/**
 * One store a file makes: its target, and the value stored when the store
 * shows it (`a = v`), or `undefined` when it does not -- an element of a
 * destructuring pattern, a `for…of` / `for…in` head.
 */
interface FileStore {
  readonly target: ts.Expression;
  readonly value: ts.Expression | undefined;
}

const fileStoresCache = new WeakMap<ts.SourceFile, readonly FileStore[]>();

/**
 * Every store the file makes that can make a binding or member hold an
 * object: `=` and the logical assignments (`||=`, `&&=`, `??=`), with
 * every target of a destructuring pattern, and the head of a `for…of` or
 * `for…in`. The arithmetic compound assignments and `++` / `--` store a
 * primitive, which is never a builtin object.
 */
function fileStores(sourceFile: ts.SourceFile): readonly FileStore[] {
  const cached = fileStoresCache.get(sourceFile);
  if (cached) {
    return cached;
  }
  const stores: FileStore[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && storesValue(node.operatorToken.kind)) {
      const left = skipOuterExpressions(node.left);
      if (
        ts.isObjectLiteralExpression(left) ||
        ts.isArrayLiteralExpression(left)
      ) {
        for (const target of destructuringTargets(left)) {
          stores.push({ target, value: undefined });
        }
      } else {
        stores.push({ target: left, value: node.right });
      }
    } else if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      for (const target of destructuringTargets(
        skipOuterExpressions(node.initializer),
      )) {
        stores.push({ target, value: undefined });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  fileStoresCache.set(sourceFile, stores);
  return stores;
}
