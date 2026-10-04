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
    return;
  }
  if (ts.isClassExpression(expr)) {
    out.push({ kind: "class", node: expr, direct });
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
      return;
    case "class":
      out.push({ kind: "class", node: binding.declaration, direct });
      return;
    case "value": {
      const value = skipOuterExpressions(binding.value);
      if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) {
        out.push({ kind: "function", node: value, direct });
        return;
      }
      if (ts.isClassExpression(value)) {
        out.push({ kind: "class", node: value, direct });
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
 *   (`fs.readFile = f`), or `require("<builtin>")` itself.
 */
export type EscapeRoot =
  | { readonly kind: "ambient" }
  | { readonly kind: "builtin"; readonly specifier: string };

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
    return AMBIENT_GLOBAL_NAMES.has(target.text) &&
      binding.kind === "unresolved" &&
      binding.cause === "no_declaration"
      ? { kind: "ambient" }
      : undefined;
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
  return specifier !== undefined && isBuiltinSpecifier(specifier)
    ? { kind: "builtin", specifier }
    : undefined;
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
