import ts from "typescript";
import {
  isClosureWideningReason,
  type DynamicCallReason,
  type SourceLocation,
} from "../domain/graph.js";
import { resolveSingleAssignmentValue } from "./local-aliases.js";
import type { ModuleModel } from "./module-model.js";
import { toSourceLocation, type SourceIndex } from "./source-index.js";

/**
 * The single source of truth for "is this construct a route to loading a
 * module or executing generated code, and which one?" (VT-307b semantics;
 * extracted from call-graph.ts in VT-307c-fix-3).
 *
 * Two layers consume it, and they must never drift apart:
 *
 * - `call-graph.ts` asks per visited call/`new`, to emit the correct
 *   `unknown(reason)` edge;
 * - `module-load-closure.ts` asks per LOADED FILE, over that file's whole
 *   AST, to decide whether its own module-load closure can be called
 *   complete.
 *
 * Before this extraction the closure had no classifier of its own and
 * instead adopted already-classified blockers from the call graph. That
 * made closure completeness silently depend on how far the *call* graph
 * happened to walk: a truncated graph never classified a transitively
 * loaded file's top-level `require(dynamicName)`, so the closure reported
 * `complete: true` for a file it had never examined for loaders at all
 * (the VT-307d soundness review's Blocker 3). Owning the classification
 * here makes closure completeness a property of the source the closure
 * actually read, independent of call-graph coverage entirely.
 */

/** The context one file's classification needs: its own AST and its resolved module model. */
export interface LoaderClassificationContext {
  readonly index: SourceIndex;
  readonly model: ModuleModel;
}

/** One closure-widening construct found in a source file, with where to look. */
export interface LoaderConstruct {
  readonly reason: DynamicCallReason;
  readonly location: SourceLocation;
}

/**
 * Node builtin module names this classifier grants provenance-checked
 * access to, mapped to their two valid specifier spellings (bare and
 * `node:`-prefixed) -- VT-307c-fix-5's generalization of the single
 * `module`/`node:module` set VT-307b originally hardcoded for
 * `createRequire` alone.
 */
const NODE_BUILTIN_SPECIFIERS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  ["module", new Set(["module", "node:module"])],
  ["vm", new Set(["vm", "node:vm"])],
  ["worker_threads", new Set(["worker_threads", "node:worker_threads"])],
  ["child_process", new Set(["child_process", "node:child_process"])],
]);

/** The Node builtin `builtinModule` names, or `undefined` if `specifier` isn't one of its recognized spellings. */
function builtinNameFromSpecifier(specifier: string): string | undefined {
  for (const [name, specifiers] of NODE_BUILTIN_SPECIFIERS) {
    if (specifiers.has(specifier)) {
      return name;
    }
  }
  return undefined;
}

/**
 * Whether `localName` is bound, in this file, to the WHOLE value of Node
 * builtin `builtin` -- `const whole = require("vm")`, `import whole from
 * "node:vm"` (ESM default), or `import * as whole from "node:vm"` (ESM
 * namespace). Never a named/destructured single export -- see
 * {@link isNamedBuiltinBinding} for that.
 */
function wholeModuleBuiltinFor(
  localName: string,
  context: LoaderClassificationContext,
): string | undefined {
  for (const imp of context.model.imports) {
    if (imp.localName !== localName) {
      continue;
    }
    // ModuleModel.ImportBinding already normalizes CJS and ESM onto one
    // `kind` vocabulary (see module-model.ts's `toImportBinding`): a
    // whole-module CJS bind (`const whole = require("vm")`, no
    // destructure) collapses onto the SAME `"default"` kind an ESM
    // default import produces, so no separate CJS-specific check is
    // needed here.
    if (imp.kind !== "default" && imp.kind !== "namespace") {
      continue;
    }
    const builtin = builtinNameFromSpecifier(imp.specifier);
    if (builtin) {
      return builtin;
    }
  }
  return undefined;
}

/**
 * Whether `localName` is bound, in this file, to `exportName` specifically
 * (not the whole module) of Node builtin `builtin` -- a named ESM import
 * (`import { exportName } from "node:vm"`) or a CommonJS destructure
 * (`const { exportName } = require("vm")`), including the aliased forms
 * both allow (`import { exportName as localName } ...` /
 * `const { exportName: localName } = ...`).
 */
function isNamedBuiltinBinding(
  localName: string,
  builtin: string,
  exportName: string,
  context: LoaderClassificationContext,
): boolean {
  return context.model.imports.some(
    (imp) =>
      imp.localName === localName &&
      imp.importedName === exportName &&
      imp.kind === "named" &&
      builtinNameFromSpecifier(imp.specifier) === builtin,
  );
}

/**
 * Resolves `expr` to the Node builtin module name it refers to as a WHOLE
 * value, or `undefined` if it can't be traced to one. Handles the inline
 * `require("vm")`/`require("node:vm")` call form directly (no local
 * binding at all -- `require("module").createRequire`'s own root shape),
 * a direct whole-module import/require binding
 * ({@link wholeModuleBuiltinFor}), and ONE `const`-alias hop from such a
 * binding (`const whole = require("vm"); const alias = whole;` -- the same
 * single-hop scope {@link resolveSingleAssignmentValue} already documents
 * elsewhere in this codebase).
 */
function resolveWholeModuleBuiltin(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): string | undefined {
  if (ts.isCallExpression(expr) && isStaticRequireCall(expr)) {
    const specifier = (expr.arguments[0] as ts.StringLiteral).text;
    return builtinNameFromSpecifier(specifier);
  }
  if (ts.isIdentifier(expr)) {
    const direct = wholeModuleBuiltinFor(expr.text, context);
    if (direct) {
      return direct;
    }
    const initializer = resolveSingleAssignmentValue(
      expr.text,
      context.index.sourceFile,
    );
    if (initializer) {
      return resolveWholeModuleBuiltin(initializer, context);
    }
  }
  return undefined;
}

/**
 * Whether `expr` provably refers to `exportName` of Node builtin
 * `builtin`, through any of the ordinary ways a file can reach it (VT-307c-
 * fix-5): a property access on a whole-module binding (`whole.exportName`,
 * including the inline `require("vm").exportName` form, via
 * {@link resolveWholeModuleBuiltin}), a direct named import/destructure of
 * `exportName` itself used bare, or ONE `const`-alias hop from such a
 * named binding used bare.
 *
 * This is the SAME provenance discipline VT-307b originally built only for
 * `createRequire` (this function's VT-307c-fix-5 generalization of that
 * original, `createRequire`-only check): a same-file object/function/class
 * that merely happens to
 * share a dangerous name (`vm`, `Worker`, `fork`, `_load`, `createRequire`)
 * has no import binding at all, so every branch here returns `false` for
 * it (see this file's precision-control tests) -- see this task's own
 * Part 4/10/11 provenance requirement.
 */
function referencesBuiltinExport(
  expr: ts.Expression,
  builtin: string,
  exportName: string,
  context: LoaderClassificationContext,
): boolean {
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === exportName) {
    return resolveWholeModuleBuiltin(expr.expression, context) === builtin;
  }

  if (ts.isIdentifier(expr)) {
    if (isNamedBuiltinBinding(expr.text, builtin, exportName, context)) {
      return true;
    }
    const initializer = resolveSingleAssignmentValue(
      expr.text,
      context.index.sourceFile,
    );
    return (
      initializer !== undefined &&
      ts.isIdentifier(initializer) &&
      isNamedBuiltinBinding(initializer.text, builtin, exportName, context)
    );
  }

  return false;
}

/**
 * Every (builtin, exportName) pair that is, on its own, a closure-widening
 * loader/execution primitive when referenced directly (VT-307c-fix-5 Parts
 * 3, 6-11) -- checked via {@link referencesBuiltinExport} against the
 * callee/construct-target expression itself, so it applies uniformly
 * whether that expression is a bare identifier (`fork(x)`, a named import)
 * or a property access (`vm.runInThisContext(x)`, `Module._load(x)`,
 * including the inline `require("vm").runInThisContext(x)` form).
 *
 * `vm`'s `Script` export is deliberately NOT listed here: constructing a
 * `Script` compiles but does not itself execute anything -- only calling
 * one of its own run methods does, handled separately by
 * {@link isVmScriptInstance} below.
 */
const BUILTIN_MEMBER_REASONS: readonly (readonly [
  builtin: string,
  exportName: string,
  reason: DynamicCallReason,
])[] = [
  ["vm", "runInThisContext", "vm_execution"],
  ["vm", "runInNewContext", "vm_execution"],
  ["vm", "runInContext", "vm_execution"],
  ["vm", "compileFunction", "vm_execution"],
  ["module", "createRequire", "create_require"],
  ["module", "_load", "module_internal_load"],
  ["worker_threads", "Worker", "worker_execution"],
  ["child_process", "fork", "child_process_execution"],
];

/** `vm.Script`'s own execution methods -- each compiles-then-runs (or just runs, for an already-compiled `Script`) arbitrary generated source (VT-307c-fix-5 Part 3/5). */
const VM_SCRIPT_EXECUTION_METHODS: ReadonlySet<string> = new Set([
  "runInThisContext",
  "runInNewContext",
  "runInContext",
]);

/**
 * Whether `expr` is provably a `vm.Script` instance (VT-307c-fix-5 Part 5)
 * -- either constructed inline (`new vm.Script(code).runInThisContext()`)
 * or bound to a local `const` whose single initializer constructs one
 * (`const script = new vm.Script(code); script.runInThisContext();`).
 * Deliberately minimal, targeted provenance -- not a general object-type
 * inference engine: it recognizes exactly the `new <Script-reference>(...)`
 * shape, reusing {@link referencesBuiltinExport} to confirm the
 * constructor itself (`vm.Script`, or a bare `Script` from a named import)
 * really is Node's `vm.Script`.
 */
function isVmScriptInstance(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  if (ts.isNewExpression(expr)) {
    return referencesBuiltinExport(expr.expression, "vm", "Script", context);
  }
  if (ts.isIdentifier(expr)) {
    const initializer = resolveSingleAssignmentValue(
      expr.text,
      context.index.sourceFile,
    );
    return (
      initializer !== undefined &&
      ts.isNewExpression(initializer) &&
      referencesBuiltinExport(initializer.expression, "vm", "Script", context)
    );
  }
  return false;
}

/**
 * Detects a call/construct whose CALLEE itself (not its arguments) is a
 * known route to loading an arbitrary module or executing arbitrary
 * generated code, regardless of how ordinary the syntax otherwise looks
 * (VT-307b; see docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md's VT-307
 * soundness review). Before this, every shape here fell into one of two
 * unsafe buckets: most became a plain `unsupported_construct` edge --
 * correctly *an* edge, but classified non-widening, when the construct can
 * in fact load code the graph never discovered -- and the property-access
 * forms rooted in a known global (`module.require`, `globalThis.eval`)
 * were swallowed entirely by call-graph.ts's `KNOWN_GLOBAL_IDENTIFIERS`,
 * producing no edge at all. Checked BEFORE `bindCallee`/the generic
 * known-global suppression in both `classifyCall` and `classifyNew`.
 *
 * Deliberately conservative rather than attempting real alias-aware static
 * resolution: `const r = require; r("./literal")` is classified exactly
 * the same as `const r = require; r(dynamicValue)` -- both
 * `"aliased_require"` -- even though the literal form could, in principle,
 * be resolved exactly like a direct `require("./literal")`. Building that
 * would mean re-deriving `bindCallee`'s own specifier-resolution behavior
 * behind an extra indirection layer; VT-307b scopes this task to
 * classification only and always chooses the safe (widening) answer over
 * a more precise one that risks resolving the alias incorrectly.
 *
 * `const`-only, mirroring {@link resolveSingleAssignmentValue}'s own
 * documented scope (a `let`/`var` alias could be reassigned between
 * declaration and call, so tracking it correctly needs real reassignment
 * analysis -- out of scope here, same as VT-214's identical restriction).
 * A `let r = require; r(x);` therefore still falls through to the generic
 * `unsupported_construct` fallback today -- a known, deliberate boundary,
 * not an oversight; closing it would require the same kind of general
 * alias-analysis redesign this function's own doc comment already declines
 * for the literal-argument case above.
 *
 * VT-307c-fix-5 adds a first, shared check against
 * {@link BUILTIN_MEMBER_REASONS} (via {@link referencesBuiltinExport}):
 * every builtin-provenance-checked form -- `vm.runInThisContext(...)`,
 * `Module._load(...)`, `new Worker(...)`, `child_process.fork(...)`,
 * `require("module").createRequire(...)` (including the previously-
 * unhandled inline-property-access spelling) -- whether reached as a bare
 * identifier (a named import used directly) or a property access on a
 * whole-module binding, resolves through that ONE table rather than a
 * second, near-identical switch. It runs before the per-shape branches
 * below so it applies uniformly regardless of which branch `expr` would
 * otherwise fall into.
 */
export function classifyLoaderConstruct(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): DynamicCallReason | undefined {
  for (const [builtin, exportName, reason] of BUILTIN_MEMBER_REASONS) {
    if (referencesBuiltinExport(expr, builtin, exportName, context)) {
      return reason;
    }
  }

  if (ts.isIdentifier(expr)) {
    if (expr.text === "Function") {
      return "function_constructor";
    }

    const initializer = resolveSingleAssignmentValue(
      expr.text,
      context.index.sourceFile,
    );
    if (!initializer) {
      return undefined;
    }
    if (ts.isIdentifier(initializer)) {
      if (initializer.text === "require") {
        return "aliased_require";
      }
      if (initializer.text === "eval") {
        return "aliased_eval";
      }
      return undefined;
    }
    // `const r = require("module").createRequire(x); r(y)` / `const r =
    // createRequire(x); r(y)` -- an alias of a createRequire CALL RESULT,
    // distinct from the bare-`createRequire`-identifier case the shared
    // table above already covers.
    if (
      ts.isCallExpression(initializer) &&
      referencesBuiltinExport(
        initializer.expression,
        "module",
        "createRequire",
        context,
      )
    ) {
      return "create_require";
    }
    return undefined;
  }

  if (ts.isCallExpression(expr)) {
    // createRequire(...)(...) called inline, no intermediate alias --
    // covers both a bare named-import `createRequire` and the inline
    // `require("module").createRequire(...)` whole-module form, both via
    // `referencesBuiltinExport`.
    if (
      referencesBuiltinExport(
        expr.expression,
        "module",
        "createRequire",
        context,
      )
    ) {
      return "create_require";
    }
    return undefined;
  }

  if (ts.isPropertyAccessExpression(expr)) {
    // `vm.Script` instance execution methods (VT-307c-fix-5 Part 3/5) --
    // provenance is to the `script` VALUE, not a builtin export, so this
    // does not fit the shared table above.
    if (
      VM_SCRIPT_EXECUTION_METHODS.has(expr.name.text) &&
      isVmScriptInstance(expr.expression, context)
    ) {
      return "vm_execution";
    }

    // Ambient ECMAScript/Node globals (`module`, `process`, `require`,
    // `globalThis`) are always available regardless of any import, so no
    // provenance check applies here -- matched by literal identifier name
    // only, the same deliberate VT-307b simplification already documented
    // for `module`/`process`/`globalThis` below.
    const chain: string[] = [];
    let current: ts.Expression = expr;
    while (ts.isPropertyAccessExpression(current)) {
      chain.unshift(current.name.text);
      current = current.expression;
    }
    if (!ts.isIdentifier(current)) {
      return undefined;
    }
    const root = current.text;
    const propertyPath = chain.join(".");

    if (root === "module" && propertyPath === "require") {
      return "module_require";
    }
    if (root === "process" && propertyPath === "mainModule.require") {
      return "module_require";
    }
    if (root === "require" && propertyPath === "main.require") {
      return "module_require";
    }
    if (root === "globalThis" && propertyPath === "eval") {
      return "aliased_eval";
    }
    return undefined;
  }

  return undefined;
}

/**
 * Whether `call` is a statically resolvable `require("string-literal")` --
 * import setup already captured in the module model, not a call into a
 * target and not a widening construct.
 */
export function isStaticRequireCall(call: ts.CallExpression): boolean {
  if (
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== "require" ||
    call.arguments.length !== 1
  ) {
    return false;
  }
  const [argument] = call.arguments;
  return argument !== undefined && ts.isStringLiteral(argument);
}

/**
 * The closure-widening reason for one call/`new` expression, or
 * `undefined` when it is not a loader construct at all.
 *
 * Ordering is load-bearing and deliberately identical to the sequence
 * `classifyCall` applied before VT-307c-fix-3 extracted it: the call-only
 * forms first (each keyed on an exact callee shape), then the general
 * {@link classifyLoaderConstruct} dispatch. In particular a static
 * `require("literal")` short-circuits to `undefined` BEFORE
 * `classifyLoaderConstruct` runs, which matters for the real ESM pattern
 * `const require = createRequire(import.meta.url)`: without the
 * short-circuit, every ordinary `require("fs")` in such a file would
 * newly classify as `create_require`. It is statically resolvable, the
 * closure traverses it like any other static import, and it was never a
 * loader edge before -- so it must not become one now.
 *
 * The call-only forms are gated on {@link ts.isCallExpression} so a `new`
 * expression is classified exactly as it was before -- `new Function(...)`
 * via `classifyLoaderConstruct`, and nothing else newly flagged.
 */
export function classifyClosureWideningCall(
  node: ts.CallExpression | ts.NewExpression,
  context: LoaderClassificationContext,
): DynamicCallReason | undefined {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;

    if (isStaticRequireCall(node)) {
      return undefined;
    }

    if (ts.isIdentifier(callee) && callee.text === "eval") {
      return "eval";
    }

    if (callee.kind === ts.SyntaxKind.ImportKeyword) {
      // Dynamic import() is always treated as uncertain in this MVP, even
      // when its argument happens to be a string literal -- statically
      // resolving it like a declaration-form import is not attempted here
      // (see TASK-018 completion report).
      return "dynamic_import";
    }

    if (
      ts.isIdentifier(callee) &&
      callee.text === "require" &&
      node.arguments.length === 1
    ) {
      return "dynamic_require";
    }
  }

  return classifyLoaderConstruct(node.expression, context);
}

/**
 * Every closure-widening construct anywhere in `context`'s source file
 * (VT-307c-fix-3).
 *
 * Scans the WHOLE file, not only the parts some other traversal reached.
 * That is the entire point: a loaded file's uninspected region is exactly
 * where an unaccounted-for loader hides, and "nobody looked" must never
 * read as "nothing there". It is deliberately more conservative than the
 * call graph's own per-visited-call classification -- a `require(name)`
 * inside a function of this file that no entrypoint ever calls is still
 * reported here, because deciding it is unreachable is a CALL-reachability
 * question, and a module-load closure that leaned on call reachability to
 * declare itself complete would re-acquire the exact dependency
 * VT-307c-fix-3 removed.
 *
 * Only reasons in the normative closure-widening partition
 * (`isClosureWideningReason`, domain/graph.ts) are returned; the check is
 * belt-and-braces, since {@link classifyClosureWideningCall} can only
 * produce loader-shaped reasons anyway, and exists so a future
 * reclassification on either side can never silently let a non-widening
 * construct mark a closure incomplete.
 */
export function findClosureWideningConstructs(
  context: LoaderClassificationContext,
): LoaderConstruct[] {
  const { sourceFile } = context.index;
  const found: LoaderConstruct[] = [];
  const seen = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const reason = classifyClosureWideningCall(node, context);
      if (reason !== undefined && isClosureWideningReason(reason)) {
        const location = toSourceLocation(sourceFile, node);
        const key = `${reason}|${location.line}:${location.column}`;
        if (!seen.has(key)) {
          seen.add(key);
          found.push({ reason, location });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}
