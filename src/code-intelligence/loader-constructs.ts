import ts from "typescript";
import {
  isClosureWideningReason,
  type DynamicCallReason,
  type SourceLocation,
} from "../domain/graph.js";
import {
  isConstDeclaration,
  resolveSingleAssignmentValue,
} from "./local-aliases.js";
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
 *
 * `module`'s `_load` export is likewise NOT listed here (VT-307c-fix-6): it
 * is subsumed by {@link isModuleConstructorLoader}, which recognizes it
 * through the SAME Node-`Module`-constructor provenance
 * ({@link resolvesToModuleConstructor}) as `Module.prototype.require`/
 * `.prototype.load` and `module.constructor._load` -- keeping one shared
 * check for every spelling of "this is Node's Module constructor" rather
 * than splitting `_load`'s provenance across two separate mechanisms.
 *
 * `child_process`'s launch APIs (VT-307c-fix-6 Part 9) are deliberately
 * ALL of `fork`/`exec`/`execSync`/`execFile`/`execFileSync`/`spawn`/
 * `spawnSync`, not just `fork`: each starts a genuinely separate execution
 * context capable of running arbitrary Node code (`spawn(process.execPath,
 * [file])` is `fork` in every way that matters here, just without the IPC
 * channel `fork` also sets up), and this classifier deliberately never
 * inspects the command/argument payload to decide whether Node is actually
 * being launched -- the same "never resolve the string, always choose the
 * safe answer" discipline the whole loader-widening partition already
 * applies to `require(dynamicValue)`. See `child_process_execution`'s own
 * doc comment in domain/graph.ts for the full policy statement.
 *
 * `module`'s `register` export (VT-307c-fix-7 Part 5) is Node's in-source
 * ESM loader-hook registration API (`node:module`'s `register`, stable
 * since Node 20.6/22): calling it installs a custom `resolve`/`load` hook
 * that runs for every SUBSEQUENT module the realm loads, the ESM analogue
 * of `require.extensions[...] = hook`'s CJS compile-hook mutation --
 * `loader_hook_mutation` reused rather than adding a near-identical reason,
 * per this task's Part 5 instruction.
 *
 * `module`'s `registerHooks` export (VT-307c-fix-11) is `register`'s
 * synchronous, in-realm sibling (stable since Node 22.15): where
 * `register` installs an OUT-OF-THREAD hook module for the ESM loader,
 * `registerHooks` installs `resolve`/`load`/`resolveSync`/`loadSync`
 * functions that run directly in the calling realm for CommonJS and ESM
 * both -- reproduced end-to-end by the final VT-307d go/no-go audit: a
 * `resolve` hook that short-circuits one specific, otherwise ordinarily
 * resolvable specifier to a different installed package's file silently
 * redirects every subsequent `require`/`import` of that specifier. Same
 * `loader_hook_mutation` reason as `register` -- this is still "install a
 * hook that changes what a SUBSEQUENT load resolves to", not a new hazard
 * class. Deliberately distinct from an out-of-process `--experimental-
 * loader`/external hook module, which remains a declared exclusion (see
 * this file's own header doc): `registerHooks` runs the hook functions
 * in-source, in this same realm, which is exactly the "authoritative
 * in-source Node primitive" class every other entry in this table covers.
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
  ["module", "register", "loader_hook_mutation"],
  ["module", "registerHooks", "loader_hook_mutation"],
  ["worker_threads", "Worker", "worker_execution"],
  ["child_process", "fork", "child_process_execution"],
  ["child_process", "exec", "child_process_execution"],
  ["child_process", "execSync", "child_process_execution"],
  ["child_process", "execFile", "child_process_execution"],
  ["child_process", "execFileSync", "child_process_execution"],
  ["child_process", "spawn", "child_process_execution"],
  ["child_process", "spawnSync", "child_process_execution"],
];

/** `vm.Script`'s own execution methods -- each compiles-then-runs (or just runs, for an already-compiled `Script`) arbitrary generated source (VT-307c-fix-5 Part 3/5). */
const VM_SCRIPT_EXECUTION_METHODS: ReadonlySet<string> = new Set([
  "runInThisContext",
  "runInNewContext",
  "runInContext",
]);

/**
 * Whether `expr` is provably an instance of `vm`'s `constructorName` export
 * (VT-307c-fix-5 Part 5; generalized in VT-307c-fix-7 Part 8 from the
 * `vm.Script`-only `isVmScriptInstance` to also serve `SourceTextModule`) --
 * either constructed inline (`new vm.Script(code).runInThisContext()`) or
 * bound to a local `const` whose single initializer constructs one
 * (`const script = new vm.Script(code); script.runInThisContext();`).
 * Deliberately minimal, targeted provenance -- not a general object-type
 * inference engine: it recognizes exactly the `new <constructorName-
 * reference>(...)` shape, reusing {@link referencesBuiltinExport} to
 * confirm the constructor itself (`vm.Script`, or a bare `Script` from a
 * named import) really is the named `vm` export.
 */
function isVmConstructedInstance(
  expr: ts.Expression,
  constructorName: string,
  context: LoaderClassificationContext,
): boolean {
  if (ts.isNewExpression(expr)) {
    return referencesBuiltinExport(
      expr.expression,
      "vm",
      constructorName,
      context,
    );
  }
  if (ts.isIdentifier(expr)) {
    const initializer = resolveSingleAssignmentValue(
      expr.text,
      context.index.sourceFile,
    );
    return (
      initializer !== undefined &&
      ts.isNewExpression(initializer) &&
      referencesBuiltinExport(
        initializer.expression,
        "vm",
        constructorName,
        context,
      )
    );
  }
  return false;
}

/**
 * Whether `expr` is one of the three ambient references to a real `Module`
 * INSTANCE every CommonJS file already has, with no `new` or import
 * involved (VT-307c-fix-7 Parts 3/7; VT-307c-fix-10 adds the third): the
 * current file's own `module`; `require.main`; or `process.mainModule` --
 * Node's historical, still-supported alias for the exact same entry-module
 * object `require.main` refers to (both are the same real `Module`
 * instance, not two different ones). Every one of these is a real `Module`
 * instance, not a wrapper around one, the same way `module` is. The final
 * VT-307d go/no-go audit found this a genuine gap, not merely a missed
 * spelling: `classifyLoaderConstruct` already recognized
 * `process.mainModule.require` as `module_require` (see the bare
 * property-chain check near the bottom of that function), but
 * `isAmbientModuleInstance` -- which backs every OTHER ambient-instance
 * check in this file, including `.constructor` resolution
 * ({@link resolvesToModuleConstructor}) and the `.paths`-array checks
 * ({@link isAmbientModulePathsArray}) -- did not, leaving
 * `process.mainModule.constructor._resolveFilename = fn` and
 * `process.mainModule.paths.unshift(dir)` both invisible even though the
 * `require.main` spelling of the identical attack was already caught.
 * Matched by literal identifier chain only -- the same deliberate
 * ambient-global simplification already applied throughout this file --
 * never something reached through an import, and never a same-file
 * `require`/`process` shadowed by a local variable of that name.
 */
function isAmbientModuleInstance(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr) && expr.text === "module") {
    return true;
  }
  if (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "main" &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "require"
  ) {
    return true;
  }
  if (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "mainModule" &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "process"
  ) {
    return true;
  }
  return false;
}

/**
 * Whether `expr` provably resolves to Node's `Module` constructor itself
 * (VT-307c-fix-6) -- the class every required CommonJS module is an
 * instance of, and the class whose own static/prototype members
 * (`_load`, `prototype.require`, `prototype.load`) ARE `require()`'s
 * underlying implementation. Recognizes every ordinary way a file can
 * reach it:
 *
 * - a whole-module reference to the `module`/`node:module` builtin
 *   itself: Node's own `lib/internal/modules/cjs/loader.js` does
 *   `Module.Module = Module; module.exports = Module;`, so
 *   `require("module")` (or an ESM default/namespace import of it) IS
 *   already the `Module` constructor, not a wrapper around it -- reuses
 *   {@link resolveWholeModuleBuiltin} directly;
 * - `<whole>.Module` -- the same self-reference accessed explicitly
 *   (`require("module").Module`, or `M.Module` for a whole-module-bound
 *   `M`), which real code sometimes writes even though it's redundant
 *   with the point above;
 * - `<ambient-instance>.constructor` -- any real `Module` instance's own
 *   `.constructor` IS the `Module` class, whether that instance is the
 *   ambient `module` or `require.main` ({@link isAmbientModuleInstance},
 *   VT-307c-fix-7 Part 7 generalizes this branch from `module.constructor`
 *   alone to also cover `require.main.constructor`);
 * - ONE `const`-alias hop from any of the above (`const Mod =
 *   module.constructor;` / `const Mod = require("module").Module;`).
 *
 * Never matches an arbitrary same-file class/object that merely happens
 * to be named `Module`, expose a `.Module` property, or have its own
 * `.constructor` -- every branch above requires either real Node-builtin
 * import provenance or one of the two literal ambient module-instance
 * references, never a bare name/shape match (VT-307c-fix-6 Part 3/8's
 * precision requirement; see this file's own precision-control tests).
 */
function resolvesToModuleConstructor(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  if (resolveWholeModuleBuiltin(expr, context) === "module") {
    return true;
  }

  if (ts.isPropertyAccessExpression(expr) && expr.name.text === "Module") {
    if (resolveWholeModuleBuiltin(expr.expression, context) === "module") {
      return true;
    }
  }

  if (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "constructor" &&
    isAmbientModuleInstance(expr.expression)
  ) {
    return true;
  }

  // VT-307c-capability-flow Part 12: `<X>.prototype.constructor` IS `<X>`
  // itself, by JS's own `Fn.prototype.constructor === Fn` invariant -- a
  // provenance-PRESERVING identity step, not a new spelling to enumerate.
  // Closing this over the SAME `resolvesToModuleConstructor` recursion
  // every other branch here already uses means it composes for free with
  // every existing spelling (`Module.prototype.constructor`,
  // `module.constructor.prototype.constructor`, ...) and with the
  // existing unknown-member receiver fallback: once
  // `Module.prototype.constructor` resolves as the Module constructor,
  // `Module.prototype.constructor._preloadModules(...)` converges on the
  // exact same `MODULE_CONSTRUCTOR_STATIC_MEMBERS` dispatch as
  // `Module._preloadModules(...)`, and `Module.prototype.constructor.
  // someFutureThing(...)` converges on the same unknown-member
  // `loader_capability_escape` fallback as `Module.someFutureThing(...)` --
  // with zero new logic beyond this one identity-closure step.
  if (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "constructor" &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "prototype" &&
    resolvesToModuleConstructor(expr.expression.expression, context)
  ) {
    return true;
  }

  if (ts.isIdentifier(expr)) {
    const initializer = resolveSingleAssignmentValue(
      expr.text,
      context.index.sourceFile,
    );
    return initializer !== undefined
      ? resolvesToModuleConstructor(initializer, context)
      : false;
  }

  return false;
}

/**
 * `Module` instance methods that load/execute a module, keyed to the
 * reason calling them on a real `Module` instance directly (i.e. not via
 * `.prototype.<member>`, which {@link isModuleConstructorLoader} handles)
 * should produce:
 *
 * - `load` (VT-307c-fix-6 Part 7): `new Module(id).load(filename)` is
 *   Node's own low-level primitive underneath `require()` itself.
 * - `_compile` (VT-307c-fix-7 Part 3): `module._compile(code, filename)`
 *   compiles `code` AS IF it were this module's own source and executes it
 *   immediately with a live `require`/`module`/`exports` bound to the
 *   real module -- `vm_execution` rather than a dedicated reason, since it
 *   compiles-then-runs exactly like `vm`'s own execution methods do (see
 *   this task's Part 3 "reuse over proliferation" instruction).
 */
const MODULE_INSTANCE_METHOD_REASONS: ReadonlyMap<string, DynamicCallReason> =
  new Map([
    ["load", "module_internal_load"],
    ["_compile", "vm_execution"],
  ]);

/**
 * Whether `expr` is provably a `Module` instance (VT-307c-fix-6 Part 7;
 * VT-307c-fix-7 Part 3/7 extends this from ONLY explicit `new
 * <ModuleConstructor>(...)` construction to also recognize the two ambient
 * Module-instance references every CommonJS file already has --
 * {@link isAmbientModuleInstance} -- since `module._compile(...)` and
 * `require.main._compile(...)`/`.load(...)` never go through `new` at
 * all). Otherwise either constructed inline (`new M.Module('x').load(path)`)
 * or bound to a local `const` whose single initializer constructs one.
 * Deliberately minimal, targeted provenance mirroring
 * {@link isVmConstructedInstance}'s own identical shape for `vm.Script`/
 * `vm.SourceTextModule` -- not a general object-type inference engine.
 */
function isModuleConstructorInstance(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  if (isAmbientModuleInstance(expr)) {
    return true;
  }
  if (ts.isNewExpression(expr)) {
    return resolvesToModuleConstructor(expr.expression, context);
  }
  if (ts.isIdentifier(expr)) {
    const initializer = resolveSingleAssignmentValue(
      expr.text,
      context.index.sourceFile,
    );
    return (
      initializer !== undefined &&
      ts.isNewExpression(initializer) &&
      resolvesToModuleConstructor(initializer.expression, context)
    );
  }
  return false;
}

/**
 * Strips a trailing `.call`/`.apply` from a property-access chain, so
 * `Module.prototype.require.call(module, x)`'s callee
 * (`Module.prototype.require.call`) and a plain, directly-bound
 * `Module.prototype.require(x)` are recognized by the same underlying
 * shape check (VT-307c-fix-6 Part 4). Only `Function.prototype`'s own
 * `call`/`apply` are stripped -- an unrelated same-file method
 * legitimately named `call`/`apply` on some other object is never reached
 * here regardless, since {@link isModuleConstructorLoader} only accepts
 * the result if what remains resolves to a real `Module.prototype` member.
 */
function stripCallApplySuffix(expr: ts.Expression): ts.Expression {
  if (
    ts.isPropertyAccessExpression(expr) &&
    (expr.name.text === "call" || expr.name.text === "apply")
  ) {
    return expr.expression;
  }
  return expr;
}

/**
 * `<ModuleCtor>.<member>(...)` static members that load/execute a module
 * (VT-307c-fix-6 Part 4 `_load`; VT-307c-fix-7 Part 6 adds `createRequire`
 * so `module.constructor.createRequire(...)`/`require.main.constructor.
 * createRequire(...)` converge on the same `Module`-constructor provenance
 * check as every other spelling, rather than needing their own separate
 * `module.constructor`-aware branch alongside the existing whole-module-
 * only {@link BUILTIN_MEMBER_REASONS} entry for `createRequire`).
 *
 * `_preloadModules` (VT-307c-fix-11) is Node's own direct module-loading
 * primitive underneath `-r`/`--require`'s preload mechanism: it takes an
 * array of specifiers and `require()`s each one immediately, in the
 * calling realm -- reproduced end-to-end by the final VT-307d go/no-go
 * audit (`Module._preloadModules(['vuln-lib'])` loaded and executed a
 * separate, never-otherwise-imported package with no further call needed).
 * `module_internal_load` (not `loader_hook_mutation`) because this DIRECTLY
 * loads modules the moment it's called, the same immediate-effect shape as
 * `_load` right above it, rather than mutating what some SUBSEQUENT
 * `require()` does. Arguments are never inspected -- the same "never
 * resolve the string, always choose the safe answer" discipline this
 * classifier already applies to `require(dynamicValue)` and every other
 * primitive in this file: a literal array of string literals gets the
 * exact same treatment as a fully dynamic one, since the risk here is the
 * PRIMITIVE itself being reachable, not what its arguments happen to say.
 */
const MODULE_CONSTRUCTOR_STATIC_MEMBERS: ReadonlyMap<
  string,
  DynamicCallReason
> = new Map([
  ["_load", "module_internal_load"],
  ["createRequire", "create_require"],
  ["_preloadModules", "module_internal_load"],
]);

/**
 * `<ModuleCtor>.prototype.<member>(...)` members that load/execute a module
 * (VT-307c-fix-6 Part 5-6 `require`/`load`; VT-307c-fix-7 Part 3 adds
 * `_compile`, so `Module.prototype._compile.call(instance, code, filename)`
 * converges on the same provenance check as `.prototype.require`/
 * `.prototype.load`).
 */
const MODULE_CONSTRUCTOR_PROTOTYPE_MEMBERS: ReadonlyMap<
  string,
  DynamicCallReason
> = new Map([
  ["require", "module_internal_load"],
  ["load", "module_internal_load"],
  ["_compile", "vm_execution"],
]);

/**
 * The closure-widening reason for `expr` if it is one of Node's
 * `Module`-constructor-level loading primitives (VT-307c-fix-6 Parts 4-6;
 * VT-307c-fix-7 Parts 3/6): `<ModuleCtor>._load(...)`,
 * `<ModuleCtor>.createRequire(...)`, `<ModuleCtor>.prototype.require(...)`,
 * `<ModuleCtor>.prototype.load(...)`, or `<ModuleCtor>.prototype._compile
 * (...)` -- with or without an explicit `.call`/`.apply` thisArg.
 * `<ModuleCtor>` is resolved via {@link resolvesToModuleConstructor}, so
 * every spelling (`Module._load`, `module.constructor._load`,
 * `require("module").Module._load`, `M.Module.prototype.require.call`,
 * `require.main.constructor._load`, ...) converges on the same provenance
 * check and the same reason. Returns `undefined` (not `false`) when `expr`
 * is not one of these members at all, so callers can distinguish "not a
 * Module-constructor-level primitive" from any specific reason.
 */
function isModuleConstructorLoader(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): DynamicCallReason | undefined {
  const target = stripCallApplySuffix(expr);
  if (!ts.isPropertyAccessExpression(target)) {
    return undefined;
  }

  const staticReason = MODULE_CONSTRUCTOR_STATIC_MEMBERS.get(target.name.text);
  if (staticReason && resolvesToModuleConstructor(target.expression, context)) {
    return staticReason;
  }

  const prototypeReason = MODULE_CONSTRUCTOR_PROTOTYPE_MEMBERS.get(
    target.name.text,
  );
  if (prototypeReason) {
    const owner = target.expression;
    if (
      ts.isPropertyAccessExpression(owner) &&
      owner.name.text === "prototype" &&
      resolvesToModuleConstructor(owner.expression, context)
    ) {
      return prototypeReason;
    }
  }

  return undefined;
}

/**
 * Whether `expr` provably resolves to Node's `createRequire` export of the
 * `module` builtin (VT-307c-fix-7 Part 6) -- either the ordinary
 * whole-module-bound/named-import forms {@link referencesBuiltinExport}
 * already covers, or the `module.constructor.createRequire`/`require.main.
 * constructor.createRequire` forms only {@link isModuleConstructorLoader}
 * recognizes (a same-file `module.constructor` is never itself a builtin
 * EXPORT, so `referencesBuiltinExport` alone can't see it). Both converge
 * on the same `"create_require"` reason regardless of which check matched.
 */
function resolvesToCreateRequireExport(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  return (
    referencesBuiltinExport(expr, "module", "createRequire", context) ||
    isModuleConstructorLoader(expr, context) === "create_require"
  );
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

  // Node `Module`-constructor-level loading primitives (VT-307c-fix-6/7):
  // `<ModuleCtor>._load(...)`, `<ModuleCtor>.createRequire(...)`,
  // `<ModuleCtor>.prototype.require(...)`, `<ModuleCtor>.prototype.load
  // (...)`, `<ModuleCtor>.prototype._compile(...)`, with or without an
  // explicit `.call`/`.apply` thisArg. Checked here, before the per-shape
  // branches below, for the same reason the shared table above is: it
  // applies uniformly to whatever shape `expr` takes.
  const moduleConstructorReason = isModuleConstructorLoader(expr, context);
  if (moduleConstructorReason) {
    return moduleConstructorReason;
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
    // createRequire(x); r(y)` / `const r = module.constructor.
    // createRequire(x); r(y)` -- an alias of a createRequire CALL RESULT,
    // distinct from the bare-`createRequire`-identifier case the shared
    // table above already covers.
    if (
      ts.isCallExpression(initializer) &&
      resolvesToCreateRequireExport(initializer.expression, context)
    ) {
      return "create_require";
    }
    return undefined;
  }

  if (ts.isCallExpression(expr)) {
    // createRequire(...)(...) called inline, no intermediate alias --
    // covers a bare named-import `createRequire`, the inline
    // `require("module").createRequire(...)` whole-module form, and
    // `module.constructor.createRequire(...)`/`require.main.constructor.
    // createRequire(...)` (VT-307c-fix-7 Part 6), via
    // `resolvesToCreateRequireExport`.
    if (resolvesToCreateRequireExport(expr.expression, context)) {
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
      isVmConstructedInstance(expr.expression, "Script", context)
    ) {
      return "vm_execution";
    }

    // `vm.SourceTextModule` instance evaluation (VT-307c-fix-7 Part 8) --
    // `new vm.SourceTextModule(code).evaluate()` compiles-and-executes the
    // module's own top-level source, the ESM analogue of `vm.Script`'s own
    // run methods above. `.link(...)` is deliberately NOT classified here
    // (see this file's `findClosureWideningConstructs` doc comment /
    // VT-307c-fix-7's FINAL REPORT Part 8 decision): it only wires up
    // import bindings via a caller-supplied linker callback, it does not
    // itself execute the module's own body -- that happens at `.evaluate()`
    // -- and the linker callback's own behavior is an ordinary
    // higher-order-callback-argument question already outside this
    // classifier's scope, the same as any other function passed as a
    // plain argument elsewhere in this codebase.
    if (
      expr.name.text === "evaluate" &&
      isVmConstructedInstance(expr.expression, "SourceTextModule", context)
    ) {
      return "vm_execution";
    }

    // `Module` instance's own `.load(filename)` (VT-307c-fix-6 Part 7) /
    // `._compile(code, filename)` (VT-307c-fix-7 Part 3) -- called
    // directly on the instance (not via `.prototype.<member>.call`, which
    // `isModuleConstructorLoader` above already handles), with or without
    // an explicit `.call`/`.apply` thisArg (`module._compile.call(module,
    // code, filename)`). Same shape as the `vm` checks above: provenance
    // is to the constructed/ambient VALUE, not a builtin export.
    {
      const instanceTarget = stripCallApplySuffix(expr);
      if (ts.isPropertyAccessExpression(instanceTarget)) {
        const instanceReason = MODULE_INSTANCE_METHOD_REASONS.get(
          instanceTarget.name.text,
        );
        if (
          instanceReason &&
          isModuleConstructorInstance(instanceTarget.expression, context)
        ) {
          return instanceReason;
        }
      }
    }

    // Mutating-array-method calls on an ambient Module instance's own
    // `.paths` (VT-307c-fix-9 Part 6/7): `module.paths.unshift(dir)` /
    // `require.main.paths.push(dir)` and friends. Provenance is to the
    // ambient VALUE (`module`/`require.main`), same shape as the vm/Module
    // instance-method checks above -- see
    // {@link isModuleLoaderPathArrayMutatingCall}.
    if (isModuleLoaderPathArrayMutatingCall(expr)) {
      return "loader_hook_mutation";
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

    // VT-307c-capability-floor Part 3/6: every check above this point in
    // the property-access branch is a NAMED, precise construct. If none
    // matched and the receiver reaches an authoritative loader capability
    // ({@link isAuthoritativeCapabilityReceiver} -- directly, or through
    // the one named `.prototype` hop), an unrecognized member call on it
    // must fail closed rather than silently stay unclassified -- unless
    // it is in the narrow, explicitly-reviewed safe-call allowlist (which
    // only ever applies to the direct `Module.<member>` form).
    // Deliberately no deeper: `module.exports.foo()` (calling something
    // off your OWN exports) has receiver `module.exports`, not `module`
    // or `module.prototype`, and is correctly untouched by this check.
    if (resolvesToModuleConstructor(expr.expression, context)) {
      return MODULE_CONSTRUCTOR_SAFE_CALLS.has(expr.name.text)
        ? undefined
        : "loader_capability_escape";
    }
    if (isAuthoritativeCapabilityReceiver(expr.expression, context)) {
      return "loader_capability_escape";
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

  const preciseReason = classifyLoaderConstruct(node.expression, context);
  if (preciseReason !== undefined) {
    return preciseReason;
  }

  // VT-307c-capability-floor Part 7A/9/13/19: the callee itself isn't a
  // recognized construct. Two remaining CALL-SHAPED soundness-floor
  // checks, kept in this SHARED function (not the closure-only whole-file
  // scanner) specifically so CallGraph gets the same
  // `unknown(loader_capability_escape)` edge ModuleLoadClosure does --
  // both are ordinary call/`new` sites, unlike the assignment/return/
  // export-shaped escape forms `findClosureWideningConstructs` handles on
  // its own (see that function's own doc comment for why those have no
  // CallGraph edge shape to populate):
  //
  // - a reflection-API mutation of the capability itself
  //   (`Object.assign(Module, ...)`, `Reflect.set(Module, ...)`, ...);
  // - an authoritative capability passed as an ARGUMENT to a callee that
  //   isn't itself an already-modeled construct (`configure(Module)`,
  //   `run(require)`, and -- VT-307c-capability-flow -- `configure({
  //   loader: Module })`/`configure([Module])`, via
  //   {@link isEscapingCapabilityUse}'s composite-containment check).
  //   Checked only here, after `preciseReason` above already came back
  //   empty, so a call already flagged through its own callee
  //   (`Module._load(x, module, false)`, where `module` is `_load`'s own
  //   legitimate second argument) is never ALSO flagged for that same
  //   argument (VT-307c-capability-floor Part 15).
  if (
    ts.isCallExpression(node) &&
    isCapabilityMutationViaReflectionCall(node, context)
  ) {
    return "loader_capability_escape";
  }
  for (const argument of node.arguments ?? []) {
    if (isEscapingCapabilityUse(argument, context)) {
      return "loader_capability_escape";
    }
  }

  return undefined;
}

/**
 * Whether `expr` is the ambient `require.extensions` object -- Node's own
 * CommonJS compile-hook registry (VT-307c-fix-6 Part 11). Matched by
 * literal identifier chain only (`require` is an ambient CJS wrapper-scope
 * variable, the same deliberate simplification VT-307b already applies to
 * `module.require`/`process.mainModule.require`/`require.main.require`
 * elsewhere in this file) -- never a same-file `obj.extensions`, which has
 * no relationship to Node's module system.
 */
function isRequireExtensionsObject(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "extensions" &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "require"
  );
}

/**
 * Whether `expr` is `<ModuleCtor>._extensions` (VT-307c-fix-7 Part 4) --
 * `Module._extensions`, `module.constructor._extensions`,
 * `require("module").Module._extensions`, or any other spelling
 * {@link resolvesToModuleConstructor} recognizes. Node's CJS loader
 * defines `Module._extensions` and `require.extensions` as the exact SAME
 * object (`Module._extensions = Module.prototype._extensions =
 * require.extensions` alias each other in `lib/internal/modules/cjs/
 * loader.js`), so this is a second name for {@link isRequireExtensionsObject}'s
 * same registry, not a different one.
 */
function isModuleExtensionsObject(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "_extensions" &&
    resolvesToModuleConstructor(expr.expression, context)
  );
}

/**
 * Whether `expr` is the ambient `require.cache` object -- Node's own
 * module-instance cache, keyed by resolved filename (VT-307c-fix-9 Part
 * 16's own nearby-mutation audit). Populating an entry for a filename Node
 * hasn't loaded yet (or overwriting an existing one) makes the NEXT
 * `require()` of that resolved file return the planted object instead of
 * ever reading/compiling/executing the real file -- reproduced end-to-end:
 * pre-seeding `require.cache[require.resolve('safe-lib')]` with a module
 * object whose `exports` come from a separate, never-otherwise-imported
 * package silently redirects every subsequent `require('safe-lib')`.
 * Matched by literal identifier chain only, the same deliberate
 * ambient-global simplification `isRequireExtensionsObject` above already
 * applies to `require.extensions`.
 */
function isRequireCacheObject(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "cache" &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "require"
  );
}

/**
 * Whether `expr` is `<ModuleCtor>._cache` (VT-307c-fix-9 Part 16) --
 * `Module._cache`, `module.constructor._cache`, or any other spelling
 * {@link resolvesToModuleConstructor} recognizes. Node's CJS loader
 * defines `Module._cache` and `require.cache` as the exact SAME object
 * (`Module._cache = require.cache = {}` in `lib/internal/modules/cjs/
 * loader.js`), the same relationship {@link isModuleExtensionsObject}'s
 * doc comment already describes for `_extensions`/`require.extensions`.
 */
function isModuleCacheObject(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "_cache" &&
    resolvesToModuleConstructor(expr.expression, context)
  );
}

/**
 * Whether `expr` is `<ModuleCtor>.wrapper` (VT-307c-fix-10) -- the two-
 * element array (`["(function (exports, require, module, __filename,
 * __dirname) { ", "\n});"]`) Node's CJS loader wraps every module's raw
 * source in before compiling it. Mutating either element -- or replacing
 * the array outright -- injects attacker-chosen source into the wrapper
 * function EVERY SUBSEQUENTLY loaded CommonJS module runs inside,
 * reproduced end-to-end by the final VT-307d go/no-go audit
 * (`Module.wrapper[0] = Module.wrapper[0] + "require('vuln-lib');"` made a
 * separate, never-imported package execute on the very next `require()`).
 * Same object-mutation shape as {@link isModuleExtensionsObject}/
 * {@link isModuleCacheObject} -- an array rather than a plain object, but
 * `require()`'s element-access assignment (`Module.wrapper[0] = ...`) and
 * whole-value replacement (`Module.wrapper = [...]`) are exactly the two
 * mutation shapes {@link isLoaderHookRegistryObject}'s existing callers
 * already handle for every other registry, so no new mutation-detection
 * code is needed beyond recognizing this object.
 */
function isModuleWrapperObject(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "wrapper" &&
    resolvesToModuleConstructor(expr.expression, context)
  );
}

/**
 * Whether `expr` is `<ModuleCtor>._pathCache` (VT-307c-fix-11) -- Node's
 * OWN resolved-path memoization cache, keyed by a combination of the
 * requested specifier and search paths (`Module._pathCache`, distinct
 * from `Module._cache`/`require.cache`'s module-INSTANCE cache above).
 * Pre-populating an entry for a specifier/search-path combination Node
 * hasn't resolved yet (or overwriting an existing one) redirects the NEXT
 * `require()`/resolution of that exact combination to the planted file
 * path, without ever running the real resolution algorithm -- reproduced
 * end-to-end by the final VT-307d go/no-go audit: poisoning the cache
 * entry for an otherwise perfectly ordinary, statically-resolvable
 * `require('safe-lib')` made it load a separate, never-imported
 * `vuln-lib` instance instead. Unlike `_cache`, `_pathCache` has no
 * `require`-namespaced alias of its own to fold in here (Node never
 * exposes it as `require.pathCache`) -- only the `<ModuleCtor>` spellings
 * {@link resolvesToModuleConstructor} already recognizes.
 */
function isModulePathCacheObject(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "_pathCache" &&
    resolvesToModuleConstructor(expr.expression, context)
  );
}

/**
 * Whether `expr` is one of the module system's own mutable registry
 * objects, under any of their aliasing names -- the compile-hook registry
 * (VT-307c-fix-6 Part 11 `require.extensions`; VT-307c-fix-7 Part 4
 * `<ModuleCtor>._extensions`; see {@link isModuleExtensionsObject}'s doc
 * comment for why these two are the same underlying object), the
 * module-instance cache (VT-307c-fix-9 Part 16 `require.cache`/
 * `<ModuleCtor>._cache`; see {@link isModuleCacheObject}'s doc comment for
 * the same relationship), the source-wrapper array (VT-307c-fix-10
 * `<ModuleCtor>.wrapper`; see {@link isModuleWrapperObject}'s doc
 * comment), and the resolved-path cache (VT-307c-fix-11
 * `<ModuleCtor>._pathCache`; see {@link isModulePathCacheObject}'s doc
 * comment). Populating/replacing an entry in any of these -- or replacing
 * the registry object itself -- changes what a SUBSEQUENT `require()`/
 * module compile/resolution actually does, the same class of hazard for
 * all four: this is deliberately one shared check, not four, so any
 * future spelling generalization (a new provenance path onto any of these
 * registries) benefits every consumer at once.
 */
function isLoaderHookRegistryObject(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  return (
    isRequireExtensionsObject(expr) ||
    isModuleExtensionsObject(expr, context) ||
    isRequireCacheObject(expr) ||
    isModuleCacheObject(expr, context) ||
    isModuleWrapperObject(expr, context) ||
    isModulePathCacheObject(expr, context)
  );
}

/**
 * `<ModuleCtor>.<staticMember>` names whose REASSIGNMENT redirects/subverts
 * `require()`'s own resolution algorithm for every SUBSEQUENT load
 * (VT-307c-fix-9, from the final VT-307d safety audit's reproduced
 * blockers A/C): `_resolveFilename` is the function that turns a bare
 * specifier into a resolved file path -- replacing it lets an attacker
 * redirect ANY subsequent `require(anything)` to a file of their choosing
 * regardless of what the specifier says (reproduced end-to-end: a
 * `require('safe-lib')` redirected to execute a separate, never-imported
 * `vuln-lib` instance). `_load` is `require()`'s own top-level entry point
 * (its CALL form is already `module_internal_load` via
 * {@link MODULE_CONSTRUCTOR_STATIC_MEMBERS} -- this is the separate
 * ASSIGNMENT form, reproduced the same way). `_findPath` and
 * `_resolveLookupPaths` are `_resolveFilename`'s own two lookup primitives
 * (file-existence probing and search-path enumeration respectively) --
 * replacing either has the same practical effect as replacing
 * `_resolveFilename` itself, just at a different layer of the same
 * algorithm. `wrap` (VT-307c-fix-9 Part 16's own nearby-mutation audit,
 * reproduced end-to-end the same way) is the function that wraps a loaded
 * file's raw source in the function wrapper Node compiles and executes --
 * every subsequent module's `_compile` call passes its source through
 * `Module.wrap` first, so replacing it lets an attacker inject arbitrary
 * additional source into every module loaded afterward, the same hazard
 * class as replacing `_compile` itself
 * ({@link MODULE_CONSTRUCTOR_MUTABLE_PROTOTYPE_MEMBERS} below), just
 * reached one level earlier in the same pipeline. `_readPackage`
 * (VT-307c-fix-11, from the final VT-307d go/no-go audit) is
 * `_resolveFilename`'s own package-metadata reader: it parses a candidate
 * directory's `package.json` and returns the parsed result (including
 * `main`) to the resolution algorithm -- replacing it lets an attacker
 * rewrite the `main` field Node resolves for an OTHERWISE ORDINARY,
 * statically-resolvable `require()` of a real installed package,
 * redirecting it to a different file entirely. Reproduced end-to-end: a
 * plain `require('safe-lib')` -- with no dynamic construct anywhere on it
 * -- loaded a separate, never-imported `vuln-lib` instance instead, once
 * `Module._readPackage` had been replaced earlier in the same file.
 *
 * `Module._stat` (also considered during this fix's own nearby-mutation
 * audit) is deliberately NOT included: it reports only a boolean
 * existence code (file/directory/absent) for a candidate path the
 * resolver itself already constructed -- it never supplies or redirects
 * to a different path the way `_resolveFilename`/`_findPath`/
 * `_resolveLookupPaths`/`_readPackage` all do. Reproduced directly: even
 * an aggressive `_stat` override that unconditionally claims every probed
 * path exists could not make resolution load a different real file --
 * the candidate paths `_findPath` probes are unaffected by what `_stat`
 * reports about them. Left out on this evidence, not by oversight.
 */
const MODULE_CONSTRUCTOR_MUTABLE_STATIC_MEMBERS: ReadonlySet<string> = new Set([
  "_resolveFilename",
  "_load",
  "_findPath",
  "_resolveLookupPaths",
  "wrap",
  "_readPackage",
]);

/**
 * `<ModuleCtor>.prototype.<protoMember>` names whose REASSIGNMENT changes
 * what loading ANY subsequently-constructed module instance actually does
 * (VT-307c-fix-9, reproduced blocker B): every CommonJS module Node loads
 * is a `Module` instance, and `.require`/`.load`/`._compile` are the
 * INSTANCE methods `require()` itself calls to resolve, read, and execute
 * each one -- replacing any of them on the shared prototype redirects that
 * behavior for every module loaded afterward, the same way replacing the
 * static members above does for resolution. Their CALL forms are already
 * `MODULE_CONSTRUCTOR_PROTOTYPE_MEMBERS` above; this is the separate
 * ASSIGNMENT form.
 */
const MODULE_CONSTRUCTOR_MUTABLE_PROTOTYPE_MEMBERS: ReadonlySet<string> =
  new Set(["require", "load", "_compile"]);

/**
 * VT-307c-capability-floor. Every check above this point answers "is this
 * ONE SPECIFIC, NAMED construct dangerous?" -- an enumeration that, per
 * the final VT-307d architecture review, silently preserves
 * `complete: true` for anything it doesn't yet name, and for an
 * already-modeled capability whose provenance is lost once it is passed,
 * stored, returned, or exported. The functions below are the resulting
 * SOUNDNESS FLOOR: instead of asking "is this a known dangerous
 * interaction with `Module`/`module`/`require`?", they ask "is this an
 * authoritative loader capability at all, interacted with or lost track
 * of in a way nothing above already proved safe?" -- and default to
 * `loader_capability_escape` when the answer isn't a proven "yes, safe."
 * Every named reason above still fires FIRST (see this file's
 * `classifyLoaderConstruct`/`isModuleLoaderAssignmentMutation`/
 * `findClosureWideningConstructs` for the exact precedence): these
 * functions are consulted only once a specific, precise classification
 * has already had its chance to match and did not.
 */

/**
 * Whether `expr` is the ambient `require` FUNCTION VALUE itself (VT-307c-
 * capability-floor) -- the bare identifier, used as a value rather than as
 * the callee of `require(...)` or the base of an already-modeled
 * property-access chain (`require.main`, `require.cache`,
 * `require.extensions`, `require.resolve`, ...). Matched by literal
 * identifier only, the same deliberate ambient-global simplification this
 * file already applies to `module`/`process`/`require` elsewhere -- never
 * a same-file `require` shadowed by a local variable of that name.
 */
function isAmbientRequireFunctionIdentifier(expr: ts.Expression): boolean {
  return ts.isIdentifier(expr) && expr.text === "require";
}

/**
 * Whether `expr` is a receiver with authoritative Node loader-capability
 * provenance (VT-307c-capability-floor) -- Node's `Module` constructor
 * ({@link resolvesToModuleConstructor}), an ambient `Module` INSTANCE
 * ({@link isAmbientModuleInstance}), or `<ModuleCtor>.prototype` itself
 * (the one named, precedented two-hop exception: every OTHER known
 * prototype member in this file -- `.prototype.require`/`.prototype.load`/
 * `.prototype._compile`, both as calls and as mutable-member assignments
 * -- already reaches through this exact same `.prototype` hop, so an
 * UNRECOGNIZED `.prototype.<member>` interaction must fail closed the
 * same way a direct `Module.<member>` one does; explicitly requested by
 * name in the capability-floor task's own Part 3 example list). This is
 * the receiver-side half of the capability floor: consulted when
 * classifying a CALL or a WRITE whose target reaches one of these, to
 * decide whether an otherwise-unrecognized member interaction must fail
 * closed. Deliberately excludes the ambient `require` FUNCTION and
 * `createRequire(...)` results here -- neither exposes meaningful mutable
 * object state of its own beyond the handful of properties (`.main`,
 * `.cache`, `.extensions`, `.resolve`) this file already models
 * exhaustively, so there is no unknown-member surface on `require` itself
 * worth failing closed on; `require`'s own capability-floor role is
 * entirely on the ESCAPE side (see {@link isAuthoritativeCapabilityValue}),
 * not the receiver side. Deliberately does NOT walk any further/deeper
 * chain than this one named `.prototype` exception -- a genuinely
 * unknown, arbitrarily-nested property off `Module` (`Module._foo.bar`)
 * is out of this task's scope (see this file's header doc on
 * interprocedural/general-alias-engine scope) and remains a documented
 * boundary, not an oversight.
 */
function isAuthoritativeCapabilityReceiver(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  if (
    resolvesToModuleConstructor(expr, context) ||
    isAmbientModuleInstance(expr)
  ) {
    return true;
  }
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "prototype" &&
    resolvesToModuleConstructor(expr.expression, context)
  );
}

/**
 * Whether `expr` is (or, through a same-file `const` alias chain of
 * unbounded depth, resolves to) an authoritative Node loader-capability
 * VALUE (VT-307c-capability-floor Part 1): Node's `Module` constructor, an
 * ambient `Module` instance, the ambient `require` function, or the
 * result of calling `createRequire(...)` inline. This is the VALUE-side
 * half of the capability floor -- used everywhere a capability can ESCAPE
 * this classifier's provenance tracking by appearing in a position other
 * than the receiver of an already-modeled call/mutation: a call argument,
 * an assignment's right-hand side, a `return`, or an ESM export. Once a
 * capability value is found in one of those positions, the closure must
 * go incomplete regardless of what the receiving position does with it --
 * this function deliberately does NOT attempt to follow the value past
 * that point (see this file's own header doc on interprocedural scope).
 *
 * Local `const` aliasing remains fully precise and is NOT itself treated
 * as an escape (VT-307c-capability-floor Part 8): `const M = require(
 * "module"); const M2 = M; const M3 = M2;` still resolves all the way
 * through, the same unbounded-depth chain {@link resolvesToModuleConstructor}
 * already supports for the `Module`-constructor case -- this function
 * extends that same recursive alias resolution uniformly to every
 * capability kind, including the ambient-instance and bare-`require`
 * cases {@link resolvesToModuleConstructor} alone does not cover.
 */
function isAuthoritativeCapabilityValue(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  if (resolvesToModuleConstructor(expr, context)) {
    return true;
  }
  if (isAmbientModuleInstance(expr)) {
    return true;
  }
  if (isAmbientRequireFunctionIdentifier(expr)) {
    return true;
  }
  if (
    ts.isCallExpression(expr) &&
    resolvesToCreateRequireExport(expr.expression, context)
  ) {
    return true;
  }
  if (ts.isIdentifier(expr)) {
    const initializer = resolveSingleAssignmentValue(
      expr.text,
      context.index.sourceFile,
    );
    return (
      initializer !== undefined &&
      isAuthoritativeCapabilityValue(initializer, context)
    );
  }
  return false;
}

/**
 * ECMAScript binary operators whose result is a freshly-produced
 * PRIMITIVE -- arithmetic, string concatenation, bitwise, shift,
 * comparison, `instanceof`/`in`, and the compound-arithmetic assignments
 * (`+=`, `&=`, ...). A loader capability used as an operand of any of
 * these provably cannot survive into the RESULT value: `Module + 1` is a
 * string, `Module === x` is a boolean, `x += Module` stores a string.
 * That is a semantic guarantee of the operators themselves, not an
 * assumption about how the code is written.
 *
 * Deliberately enumerated as the SAFE set rather than as its complement,
 * per this task's Part 8: an operator MISSING from this list -- including
 * a future one this codebase has never seen -- falls through to
 * {@link binaryValueOperandsOf}'s final branch and recurses into BOTH
 * operands, i.e. fails closed. The list of things that stop the
 * traversal is the enumerated one; the list of things that continue it
 * is open.
 *
 * This governs capability VALUE PROPAGATION only. An unmodeled direct
 * USE of a capability is a separate question, answered by separate
 * checks these exclusions never reach: an unrecognized member call or
 * write on a capability receiver still fails closed via
 * {@link classifyLoaderConstruct}/{@link isModuleLoaderAssignmentMutation},
 * and a capability handed to an unmodeled callee still fails closed via
 * {@link classifyClosureWideningCall}'s own argument check.
 */
const PRIMITIVE_RESULT_BINARY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.InstanceOfKeyword,
  ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
]);

/**
 * Assignment operators that store their RIGHT operand as-is, so the
 * assigned value (and the assignment expression's own result) can BE a
 * capability: plain `=` and the three logical assignments `||=`/`&&=`/
 * `??=`. The compound ARITHMETIC assignments (`+=`, `&=`, ...) are
 * deliberately absent -- they store a computed primitive, and live in
 * {@link PRIMITIVE_RESULT_BINARY_OPERATORS} instead.
 *
 * Shared by {@link binaryValueOperandsOf} (value propagation) and by
 * {@link isModuleLoaderAssignmentMutation}/
 * {@link findClosureWideningConstructs} (the assignment POSITION checks),
 * so `Module._resolveFilename ||= hook` and `registry.loader ??= Module`
 * are treated exactly like their plain-`=` spellings rather than
 * silently slipping past an `EqualsToken`-only guard -- `x ||= Module`
 * was one of this task's own reproduced blockers.
 */
const CAPABILITY_STORING_ASSIGNMENT_OPERATORS: ReadonlySet<ts.SyntaxKind> =
  new Set([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
  ]);

/** Whether `kind` is an assignment operator that stores its right operand unchanged. */
function isCapabilityStoringAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return CAPABILITY_STORING_ASSIGNMENT_OPERATORS.has(kind);
}

/**
 * The operands of a binary expression whose own values can become its
 * result value, or `undefined` when the result provably cannot be either
 * operand ({@link PRIMITIVE_RESULT_BINARY_OPERATORS}).
 */
function binaryValueOperandsOf(
  expr: ts.BinaryExpression,
): readonly ts.Expression[] | undefined {
  const operator = expr.operatorToken.kind;

  if (
    operator === ts.SyntaxKind.AmpersandAmpersandToken ||
    operator === ts.SyntaxKind.CommaToken
  ) {
    // `a && b` evaluates TO `a` only when `a` is FALSY, and every
    // authoritative loader capability is a live function/object -- never
    // falsy -- so a capability on the left can never be `&&`'s result.
    // `(a, b)` evaluates TO `b` outright; `a` is evaluated and discarded.
    // Either way only the RIGHT operand can carry the capability out.
    return [expr.right];
  }

  if (isCapabilityStoringAssignmentOperator(operator)) {
    // An assignment expression evaluates to the value assigned.
    return [expr.right];
  }

  if (PRIMITIVE_RESULT_BINARY_OPERATORS.has(operator)) {
    return undefined;
  }

  // `||`, `??`, and any operator not named above (a future addition
  // included): either operand may be the result -- recurse into both.
  return [expr.left, expr.right];
}

/**
 * The value-carrying operands of an object literal: each property's own
 * value expression. Accessors and methods are deliberately absent -- see
 * {@link valueFlowOperandsOf}'s Exclusion 4 for why a function body is a
 * statement-level question the whole-file scanner answers instead (this
 * task's own sweep confirmed every getter/setter/method/static-block
 * form is already flagged through that route). An unrecognized future
 * property kind falls through to the final branch and recurses into all
 * of its expression children, so it fails closed.
 */
function objectLiteralValueOperandsOf(
  expr: ts.ObjectLiteralExpression,
): readonly ts.Expression[] {
  const operands: ts.Expression[] = [];
  for (const property of expr.properties) {
    if (ts.isPropertyAssignment(property)) {
      operands.push(property.initializer);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      operands.push(property.name);
    } else if (ts.isSpreadAssignment(property)) {
      operands.push(property.expression);
    } else if (
      !ts.isMethodDeclaration(property) &&
      !ts.isGetAccessorDeclaration(property) &&
      !ts.isSetAccessorDeclaration(property)
    ) {
      ts.forEachChild(property, (child) => {
        if (!ts.isTypeNode(child)) {
          operands.push(child as ts.Expression);
        }
      });
    }
  }
  return operands;
}

/**
 * The operands of `expr` whose own runtime values can BECOME, or be
 * reachable from, `expr`'s runtime value -- or `undefined` when `expr` is
 * value-OPAQUE: its result provably cannot be (or contain) an
 * authoritative loader capability, whatever its children are.
 *
 * `undefined` is the ONLY way {@link containsEscapingLoaderCapabilityValue}'s
 * traversal stops. Each one below is an entry in this task's explicit
 * exclusion policy and is justified where it appears. Everything else --
 * INCLUDING every node kind this function never mentions -- reaches the
 * final branch and recurses into its expression children, so an
 * unrecognized or future value container fails closed by construction.
 * That inversion is the whole point of VT-307c-value-flow-closure: the
 * enumerated list is now the list of things proven SAFE to stop at,
 * not the list of containers remembered as dangerous.
 */
function valueFlowOperandsOf(
  expr: ts.Expression,
): readonly ts.Expression[] | undefined {
  // --- Exclusion 1: member access. -------------------------------------
  // `x.y` / `x[k]` produce a MEMBER of the receiver, never the receiver
  // itself. Member INTERACTIONS with a capability are governed by
  // receiver-side precedence instead (`classifyLoaderConstruct` for
  // calls, `isModuleLoaderAssignmentMutation` for writes -- both of
  // which already fail closed on an unrecognized member), and the member
  // READS that are themselves a capability (`module.constructor`,
  // `require.main`, `Module.prototype.constructor`, `<whole>.Module`)
  // are already recognized by `isAuthoritativeCapabilityValue`'s base
  // case before this function is ever consulted. Recursing here would
  // instead flag the `module.exports` in every CommonJS file ever
  // written, for no soundness gain at all.
  if (
    ts.isPropertyAccessExpression(expr) ||
    ts.isElementAccessExpression(expr)
  ) {
    return undefined;
  }

  // --- Exclusion 2: call results. --------------------------------------
  // A call's value is whatever the callee returns -- never one of the
  // operands by construction, and not statically knowable here. The one
  // call whose result IS a capability (`createRequire(...)`) is already
  // an `isAuthoritativeCapabilityValue` base case. Capability ARGUMENTS
  // are not dropped by this exclusion, only checked at the right layer:
  // `classifyClosureWideningCall` checks them with proper precedence (so
  // `Module._load(x, module, false)`'s own legitimate `module` argument
  // is not double-flagged) and `findClosureWideningConstructs` checks a
  // tagged template's substitutions. Recursing here would flag an
  // ordinary `const ok = Module.isBuiltin('fs')`.
  if (
    ts.isCallExpression(expr) ||
    ts.isNewExpression(expr) ||
    ts.isTaggedTemplateExpression(expr)
  ) {
    return undefined;
  }

  // --- Exclusion 3: operators with a primitive result. ------------------
  // `typeof x`, `void x`, `delete x.y`, a template literal, and the
  // prefix/postfix unary operators each produce a fresh string, boolean,
  // number, or `undefined` -- the capability cannot survive as the
  // result. `typeof module === 'object'` and `` `${module.id}` `` are
  // ordinary, ubiquitous code. (`delete <capability>.<member>` is a
  // MUTATION, not a value flow, and is still caught as such by
  // {@link isCapabilityDeleteMutation}.)
  if (
    ts.isTypeOfExpression(expr) ||
    ts.isVoidExpression(expr) ||
    ts.isDeleteExpression(expr) ||
    ts.isTemplateExpression(expr) ||
    ts.isPrefixUnaryExpression(expr) ||
    ts.isPostfixUnaryExpression(expr)
  ) {
    return undefined;
  }

  // --- Exclusion 4: function and class VALUES. --------------------------
  // The value of a `function`/`class` expression is the function or class
  // itself, never a capability its body happens to close over. What the
  // body DOES with a captured capability is a statement-level question,
  // and every statement-level escape position inside it -- `return`,
  // `throw`, `yield`, an assignment, a declaration -- is visited
  // independently by `findClosureWideningConstructs`'s own whole-file
  // walk, which does not depend on anything reaching the body from here.
  // This task's pre-implementation sweep confirmed that empirically:
  // object getters, class getters, class methods, object method
  // shorthand, static blocks, and IIFEs were ALL already flagged through
  // that route. A concise-body arrow is the one exception -- its body IS
  // its returned value (`() => Module` is `return Module;` in disguise),
  // so it recurses.
  if (ts.isFunctionExpression(expr) || ts.isClassExpression(expr)) {
    return undefined;
  }
  if (ts.isArrowFunction(expr)) {
    return ts.isBlock(expr.body) ? undefined : [expr.body];
  }

  // --- Exclusion 5 (and the value-SELECTING operators). -----------------
  if (ts.isBinaryExpression(expr)) {
    return binaryValueOperandsOf(expr);
  }

  // A conditional evaluates to one of its two branches.
  if (ts.isConditionalExpression(expr)) {
    return [expr.whenTrue, expr.whenFalse];
  }

  // Composite literals: every element/property value is reachable from
  // the resulting object, at any nesting depth. Array elements include
  // `SpreadElement`s and holes, both of which the final branch below
  // handles correctly once recursed into.
  if (ts.isObjectLiteralExpression(expr)) {
    return objectLiteralValueOperandsOf(expr);
  }
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements;
  }

  // --- DEFAULT: closed by construction. ---------------------------------
  // Everything not named above -- parenthesization, the TS type-wrapping
  // forms (`x as T`, `x satisfies T`, `x!`, `<T>x`), `await`, `yield`,
  // spreads, and any syntax added to the language after this was written
  // -- recurses into its expression children. Type nodes are skipped
  // because they carry no runtime value at all; nothing else is.
  const operands: ts.Expression[] = [];
  ts.forEachChild(expr, (child) => {
    if (!ts.isTypeNode(child)) {
      operands.push(child as ts.Expression);
    }
  });
  return operands;
}

/**
 * VT-307c-value-flow-closure. VT-307c-capability-flow had already
 * replaced VT-307c-capability-floor's enumeration of syntactic POSITIONS
 * with a value-oriented walker -- but that walker was itself still an
 * ENUMERATION, this time of container NODE KINDS (object literal, array
 * literal, conditional, parenthesization, TS type-wrapping, concise
 * arrow, `new Set`/`new Map`), so any value-producing form missing from
 * the list failed OPEN. The final go/no-go invariant review reproduced
 * SEVEN end-to-end violations from that one structural fact -- real Node
 * execution, a gate-eligible closure, `complete: true`, the exact
 * installed package OUT, and an EMPTY `incompleteness` array -- every one
 * an ordinary JavaScript value form the list simply did not name:
 * `const { l = Module } = {}`, `const [ l = Module ] = []`,
 * `const x = (0, Module)`, `class H { loader = Module }`,
 * `class H { static loader = Module }`, `const x = a || Module`, and
 * `const x = a ?? Module`. This task's own pre-implementation sweep found
 * THIRTEEN more of the same family (`a && Module`, `x ||= Module`,
 * `await Module`, `let`/`var` alias bindings, the composite variants of
 * the destructuring and class-field forms, `for (const m of [Module])`,
 * `yield Module`, a computed-name class field, and a tagged-template
 * substitution) -- confirming that the defect was the enumeration
 * ITSELF, not the twenty spellings it happened to omit. Adding those
 * twenty would only have restarted the loop.
 *
 * So the traversal is INVERTED here. It no longer asks "is this one of
 * the container kinds we remembered?", stopping at everything else; it
 * asks "what does this expression's runtime value consist of?" and
 * recurses into every operand that can contribute to it, with the
 * DEFAULT for an unnamed node kind being to recurse
 * ({@link valueFlowOperandsOf}'s final branch). The safety property now
 * rests on the explicitly enumerated, individually justified list of
 * value-OPAQUE forms -- expressions whose result provably cannot be the
 * capability -- rather than on a list of dangerous containers that new
 * or overlooked syntax can fall outside of.
 *
 * Deliberately does NOT resolve an identifier through its alias
 * initializer looking for composites (`const inner = { l: Module };
 * const outer = inner;` does not re-flag at `outer`): `inner`'s OWN
 * declaration is already an escape, so the file is already incomplete,
 * and not following aliases into composites keeps this walk a simple
 * tree traversal with no cycle risk (`const a = [a];`). Bare-capability
 * alias chains are still fully resolved, by
 * {@link isAuthoritativeCapabilityValue}'s own base case.
 */
function containsEscapingLoaderCapabilityValue(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  if (isAuthoritativeCapabilityValue(expr, context)) {
    return true;
  }
  const operands = valueFlowOperandsOf(expr);
  if (operands === undefined) {
    return false;
  }
  return operands.some((operand) =>
    containsEscapingLoaderCapabilityValue(operand, context),
  );
}

/**
 * Whether `expr`, used in a VALUE-FLOWING position (an assignment's
 * right-hand side, a `return`/`throw` operand, an export, or a call
 * argument not belonging to an already-modeled primitive), constitutes a
 * capability escape -- either because `expr` itself directly denotes an
 * authoritative capability (the pre-existing VT-307c-capability-floor
 * bare-value check), or because a composite value CONTAINS one nested
 * inside it (the new VT-307c-capability-flow check). Every caller of this
 * function is a position where a bare capability reference was ALREADY
 * being treated as an escape before this task -- this only widens what
 * counts as "the capability is here" at each of those same positions, it
 * never changes which positions are checked.
 */
function isEscapingCapabilityUse(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  return (
    isAuthoritativeCapabilityValue(expr, context) ||
    containsEscapingLoaderCapabilityValue(expr, context)
  );
}

/**
 * Whether an initializer `expr` is a capability escape, EXCLUDING the one
 * case that must stay safe: `expr` itself being a bare, direct capability
 * reference (`const alias = Module;` -- alias creation, VT-307c-
 * capability-floor Part 8). A COMPOSITE initializer that merely CONTAINS
 * the capability (`const registry = { loader: Module };`) is still an
 * escape.
 *
 * Applied only where the binding being created is one this classifier can
 * actually FOLLOW ({@link isFollowableAliasDeclaration}). VT-307c-value-
 * flow-closure narrowed that from "any variable declaration" to exactly
 * `const <identifier> = ...`, because the exemption's entire
 * justification is that {@link resolveSingleAssignmentValue} can resolve
 * the alias back to the capability later -- and that function has always
 * been `const`-and-identifier-only. A `let`/`var` binding got the
 * exemption without the resolution, so `let x = Module; x._preloadModules
 * (['vuln']);` lost the capability in BOTH directions at once: no escape
 * recorded at the declaration, and no provenance at the call. Both
 * `let` and `var` spellings were reproduced end-to-end as genuine
 * blockers (real Node execution + complete closure + the package OUT)
 * during this task's own pre-implementation sweep. Every other
 * value-flowing position treats a bare reference as an escape too, via
 * {@link isEscapingCapabilityUse} directly, since none of them creates a
 * followable alias.
 */
function isNonAliasCapabilityEscape(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  if (isAuthoritativeCapabilityValue(expr, context)) {
    return false;
  }
  return containsEscapingLoaderCapabilityValue(expr, context);
}

/**
 * Whether `node` declares a binding whose value this classifier can
 * resolve back to later -- exactly `const <identifier> = <value>`, the
 * shape {@link resolveSingleAssignmentValue} looks up. This is the ONLY
 * declaration form that earns the bare-capability alias exemption
 * described on {@link isNonAliasCapabilityEscape}: for every other
 * declaration form (a `let`/`var` binding, a destructuring pattern, a
 * parameter or binding-element default, a class field, an enum member)
 * the capability's provenance is genuinely lost at the declaration, so a
 * bare capability there is an escape like any other.
 */
function isFollowableAliasDeclaration(node: ts.Node): boolean {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    isConstDeclaration(node)
  );
}

/**
 * One position where a value LEAVES the expression tree that computed it,
 * with the expression whose value it is.
 */
interface ConsumedValuePosition {
  readonly expression: ts.Expression;
  /** Whether this position creates a binding {@link resolveSingleAssignmentValue} can follow. */
  readonly aliasFollowable: boolean;
}

/**
 * The value `node` consumes out of the expression tree that produced it,
 * or `undefined` when `node` is not such a position at all.
 *
 * VT-307c-value-flow-closure's answer to this task's Part 7. Where
 * VT-307c-capability-flow enumerated individual node kinds here
 * (`VariableDeclaration`, `Parameter`, `ReturnStatement`,
 * `ThrowStatement`, `ExportAssignment`) -- and thereby missed
 * `BindingElement`, `PropertyDeclaration`, `EnumMember`,
 * `YieldExpression`, and the `for`-loop iterables, ALL of which this
 * task reproduced end-to-end -- this collapses them into three SEMANTIC
 * categories, only one of which is even node-kind-aware:
 *
 * 1. **Stored under a name.** Duck-typed on the AST's own `initializer`
 *    field rather than enumerated by kind, so every declaration form
 *    TypeScript has (and every one it gains later) is covered the moment
 *    it carries an initializer: variable declarations, parameters,
 *    binding elements (destructuring defaults, at any nesting depth),
 *    class instance and static fields, object-literal property
 *    assignments, enum members. The one non-expression `initializer` in
 *    the AST -- a `for` statement's `VariableDeclarationList` -- is
 *    excluded explicitly; its declarations are visited on their own.
 * 2. **Handed out of the current computation.** `return`, `throw`,
 *    `yield`, and the `export =`/`export default` assignment forms: in
 *    each the value leaves this function/module entirely, and nothing
 *    here tracks where it lands.
 * 3. **Iterated.** `for (const m of <expr>)` / `for (const k in <expr>)`
 *    -- the iterable is consumed to produce the loop bindings, so a
 *    capability inside it (`for (const m of [Module])`, a reproduced
 *    blocker) escapes into the loop body.
 *
 * Only category 1 can be alias-followable, and only for the one
 * declaration shape {@link isFollowableAliasDeclaration} names.
 *
 * Assignments and call/`new` arguments are deliberately NOT handled here:
 * both have precedence interactions of their own (a target-side mutation
 * reason must win over the right-hand side; a precisely-classified callee
 * must suppress its own legitimate capability arguments), so they keep
 * their dedicated checks in {@link findClosureWideningConstructs} and
 * {@link classifyClosureWideningCall} respectively.
 */
function consumedValuePositionOf(
  node: ts.Node,
): ConsumedValuePosition | undefined {
  // Category 1: stored under a name.
  const initializer = (node as { readonly initializer?: ts.Node }).initializer;
  if (initializer !== undefined && !ts.isVariableDeclarationList(initializer)) {
    return {
      expression: initializer as ts.Expression,
      aliasFollowable: isFollowableAliasDeclaration(node),
    };
  }

  // Category 2: handed out of the current computation.
  if (
    ts.isReturnStatement(node) ||
    ts.isThrowStatement(node) ||
    ts.isYieldExpression(node) ||
    ts.isExportAssignment(node)
  ) {
    return node.expression === undefined
      ? undefined
      : { expression: node.expression, aliasFollowable: false };
  }

  // Category 3: iterated.
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    return { expression: node.expression, aliasFollowable: false };
  }

  return undefined;
}

/**
 * The substitution expressions of a tagged template -- `tag`${Module}``'s
 * `Module`. A tagged template IS a call (the tag function receives every
 * substitution as an argument), but it is neither a `CallExpression` nor
 * a `NewExpression`, so {@link classifyClosureWideningCall}'s argument
 * check never sees it; passing a capability this way was a reproduced
 * blocker. An untagged template literal needs no equivalent: its result
 * is always a string ({@link valueFlowOperandsOf}'s Exclusion 3).
 */
function taggedTemplateSubstitutionsOf(
  node: ts.TaggedTemplateExpression,
): readonly ts.Expression[] {
  return ts.isTemplateExpression(node.template)
    ? node.template.templateSpans.map((span) => span.expression)
    : [];
}

/**
 * The narrow, explicitly-reviewed set of `<ModuleCtor>.<member>(...)`
 * calls proven read-only/non-loading (VT-307c-capability-floor Part 4) --
 * the ONLY calls on Node's `Module` constructor this classifier accepts
 * as safe without a specific widening classification above. Each was
 * individually verified, not assumed:
 *
 * - `isBuiltin(name)`: a pure predicate over Node's own fixed builtin-name
 *   list: reads nothing resolution-related, loads nothing.
 * - `findPackageJSON(specifier, base)` (Node 22.14+): parses and returns
 *   the nearest `package.json` for a specifier -- a read-only lookup, the
 *   same operation `_readPackage` performs internally, but returned to
 *   the CALLER rather than consulted BY the resolution algorithm itself;
 *   it cannot redirect what any subsequent `require()` resolves to.
 * - `getCompileCacheDir()`: returns the configured compile-cache
 *   directory path, or `undefined` -- pure state read, no loading effect.
 * - `stripTypeScriptTypes(code, options)`: a pure string-transform
 *   (returns type-stripped source text); it does not compile, execute, or
 *   load anything -- the caller decides what (if anything) to do with the
 *   returned string.
 *
 * Deliberately NOT a general "read-only member" heuristic: every member
 * NOT in this set -- including any future Node addition -- fails closed
 * (`loader_capability_escape`) rather than silently joining this list.
 */
const MODULE_CONSTRUCTOR_SAFE_CALLS: ReadonlySet<string> = new Set([
  "isBuiltin",
  "findPackageJSON",
  "getCompileCacheDir",
  "stripTypeScriptTypes",
]);

/**
 * The narrow set of ambient `Module`-INSTANCE (`module`/`require.main`/
 * `process.mainModule`) property WRITES proven safe (VT-307c-capability-
 * floor Part 4) -- `exports` alone: `module.exports = ...` is the single
 * most common statement in all of CommonJS, an ordinary data assignment
 * with no relationship to loader/resolution state. No other ambient-
 * instance property is safe-listed for writes: `.paths` mutation is
 * already precisely modeled above ({@link isAmbientModulePathsArray}/
 * {@link isModuleLoaderPathArrayMutatingCall}) and therefore never reaches
 * this fallback at all (precedence); everything else (`.id`, `.filename`,
 * `.loaded`, `.parent`, `.children`, `.path`, `.isPreloading`, or any
 * future member) is rare enough in ordinary code, and unproven enough to
 * be safe, that an unrecognized write to it fails closed.
 */
const AMBIENT_MODULE_INSTANCE_SAFE_WRITES: ReadonlySet<string> = new Set([
  "exports",
]);

/**
 * Whether `node` is `Object.assign(target, ...)` / `Object.defineProperty(
 * target, ...)` / `Object.defineProperties(target, ...)` /
 * `Object.setPrototypeOf(target, ...)` / `Reflect.set(target, ...)` /
 * `Reflect.defineProperty(target, ...)` / `Reflect.deleteProperty(target,
 * ...)` / `Reflect.setPrototypeOf(target, ...)` where `target` (the first
 * argument) is an authoritative loader-capability receiver (VT-307c-
 * capability-floor Part 5) -- the reflection-API mutation primitives that
 * rewrite/redefine/remove a property on an object WITHOUT going through
 * an ordinary `target.member = value` assignment expression at all, so
 * {@link isModuleLoaderAssignmentMutation}'s own BinaryExpression-shaped
 * detection can never see them. Property NAMES are never inspected here
 * (the same "never resolve the string, choose the safe answer" discipline
 * this whole classifier already applies elsewhere) -- ANY reflection-API
 * mutation targeting the capability itself fails closed, regardless of
 * which property it names.
 */
function isCapabilityMutationViaReflectionCall(
  node: ts.CallExpression,
  context: LoaderClassificationContext,
): boolean {
  const callee = node.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression)
  ) {
    return false;
  }
  const owner = callee.expression.text;
  const member = callee.name.text;
  const isReflectionMutator =
    (owner === "Object" &&
      (member === "assign" ||
        member === "defineProperty" ||
        member === "defineProperties" ||
        member === "setPrototypeOf")) ||
    (owner === "Reflect" &&
      (member === "set" ||
        member === "defineProperty" ||
        member === "deleteProperty" ||
        member === "setPrototypeOf"));
  if (!isReflectionMutator) {
    return false;
  }
  const target = node.arguments[0];
  return (
    target !== undefined && isAuthoritativeCapabilityReceiver(target, context)
  );
}

/**
 * Whether `node` is `delete <capability>.<member>` (VT-307c-capability-
 * floor Part 5) -- Node's own `delete` operator applied directly to an
 * authoritative loader capability's own property surface, the one
 * mutation shape that is neither a `BinaryExpression` assignment nor a
 * call. The member name is never inspected -- same discipline as
 * {@link isCapabilityMutationViaReflectionCall}.
 */
function isCapabilityDeleteMutation(
  node: ts.DeleteExpression,
  context: LoaderClassificationContext,
): boolean {
  const target = node.expression;
  return (
    ts.isPropertyAccessExpression(target) &&
    isAuthoritativeCapabilityReceiver(target.expression, context)
  );
}

/**
 * Whether `expr` is `<ModuleCtor>.<staticMember>` for one of
 * {@link MODULE_CONSTRUCTOR_MUTABLE_STATIC_MEMBERS} (VT-307c-fix-9) --
 * reuses {@link resolvesToModuleConstructor} for the same provenance
 * discipline every other Module-constructor check in this file applies:
 * a same-file class/object that merely happens to be named `Module` or
 * expose a same-named static member is never matched (see this file's
 * precision-control tests).
 */
function isModuleConstructorMutableStaticMember(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    MODULE_CONSTRUCTOR_MUTABLE_STATIC_MEMBERS.has(expr.name.text) &&
    resolvesToModuleConstructor(expr.expression, context)
  );
}

/**
 * Whether `expr` is `<ModuleCtor>.prototype.<protoMember>` for one of
 * {@link MODULE_CONSTRUCTOR_MUTABLE_PROTOTYPE_MEMBERS} (VT-307c-fix-9) --
 * mirrors {@link isModuleConstructorLoader}'s own `.prototype`-owner
 * shape/provenance check exactly, applied to the assignment target instead
 * of a call callee.
 */
function isModuleConstructorMutablePrototypeMember(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  if (
    !ts.isPropertyAccessExpression(expr) ||
    !MODULE_CONSTRUCTOR_MUTABLE_PROTOTYPE_MEMBERS.has(expr.name.text)
  ) {
    return false;
  }
  const owner = expr.expression;
  return (
    ts.isPropertyAccessExpression(owner) &&
    owner.name.text === "prototype" &&
    resolvesToModuleConstructor(owner.expression, context)
  );
}

/**
 * Whether `expr` is an ambient Module instance's own `.paths` array
 * (VT-307c-fix-9, reproduced blockers D/E) -- `module.paths` or
 * `require.main.paths`, Node's own ordered list of directories `require()`
 * searches for a bare (non-relative, non-builtin) specifier. Reuses
 * {@link isAmbientModuleInstance}, the same ambient-reference provenance
 * every other `module`/`require.main` check in this file applies -- never
 * a same-file `obj.paths`/`obj.main.paths` that merely happens to share the
 * name (see this file's precision-control tests).
 */
function isAmbientModulePathsArray(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "paths" &&
    isAmbientModuleInstance(expr.expression)
  );
}

/**
 * `Array.prototype`'s own COMPLETE set of in-place-mutating method names
 * (VT-307c-fix-9 Part 7) -- every method that can alter an array's contents
 * or ordering, as opposed to a non-mutating method (`slice`, `indexOf`,
 * `includes`, `map`, `forEach`, ...) that leaves it untouched. Called on
 * `module.paths`/`require.main.paths`, any of these can change which
 * directory `require()`'s bare-specifier resolution searches, and in what
 * order, for a SUBSEQUENT load: `unshift`/`push` add a new, attacker-chosen
 * search directory (the final VT-307d safety audit reproduced `unshift`
 * end-to-end as a genuine shadowing attack against an otherwise-resolvable
 * specifier); `splice` can do both at once; `sort`/`reverse` change
 * resolution PRIORITY among the existing directories without adding
 * anything, which can just as well expose an already-installed instance
 * that would otherwise have been shadowed by a nearer one; `pop`/`shift`
 * remove an entry, which can likewise expose a farther, already-installed
 * instance that a nearer entry was previously shadowing; `copyWithin`/
 * `fill` are the two remaining ways to overwrite array contents in place.
 * Deliberately this small, fully-enumerated method-name set -- never "any
 * method call on `.paths`" -- so a genuinely read-only inspection
 * (`module.paths.slice()`, `.includes(x)`, `.indexOf(x)`) is never flagged
 * (see this file's precision-control tests).
 */
const ARRAY_MUTATING_METHODS: ReadonlySet<string> = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "copyWithin",
  "fill",
]);

/**
 * Whether `expr` is a mutating-array-method CALL on an ambient Module
 * instance's own `.paths` (VT-307c-fix-9) -- e.g.
 * `module.paths.unshift(dir)`, `require.main.paths.push(dir)`. This is a
 * CALL-shaped construct (unlike every other check in this section, which
 * detects an assignment), so it is consulted from
 * {@link classifyLoaderConstruct} rather than from
 * {@link isModuleLoaderAssignmentMutation} below -- see that call site's
 * own comment.
 */
function isModuleLoaderPathArrayMutatingCall(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ARRAY_MUTATING_METHODS.has(expr.name.text) &&
    isAmbientModulePathsArray(expr.expression)
  );
}

/**
 * Whether `node` is an assignment that mutates Node's own module-loading/
 * resolution machinery (VT-307c-fix-6 Part 11; VT-307c-fix-7 Part 4;
 * VT-307c-fix-9 generalizes this considerably further, per the final
 * VT-307d safety audit's four reproduced loaded-but-OUT blockers):
 *
 * - compile-hook/module-cache registry ELEMENT/PROPERTY mutation:
 *   `require.extensions['.js'] = hook`, `require.extensions.js = hook`,
 *   `Module._extensions['.js'] = hook`, `module.constructor._extensions
 *   ['.js'] = hook` (unchanged from VT-307c-fix-6/7) -- installs a custom
 *   compiler for one extension; and, sharing the exact same check
 *   (`isLoaderHookRegistryObject` now also recognizes `require.cache`/
 *   `<ModuleCtor>._cache`, VT-307c-fix-9 Part 16), `require.cache[resolved]
 *   = fakeModule` -- plants a poisoned module object that the NEXT
 *   `require()` of that resolved file returns without ever loading the
 *   real one (reproduced end-to-end);
 * - compile-hook/module-cache registry WHOLE-OBJECT replacement
 *   (VT-307c-fix-9 Part 5, Part 16): `Module._extensions = newRegistry` /
 *   `require.cache = {}` -- replaces the ENTIRE table, not merely one
 *   entry in it -- a genuinely distinct assignment SHAPE the
 *   element/property check above cannot see, since here the registry
 *   object itself is the assignment TARGET rather than something the
 *   target is reached THROUGH;
 * - Module CONSTRUCTOR loader/resolution member replacement
 *   (VT-307c-fix-9 Part 3, reproduced blockers A/C):
 *   {@link isModuleConstructorMutableStaticMember};
 * - Module PROTOTYPE loader member replacement (VT-307c-fix-9 Part 4,
 *   reproduced blocker B): {@link isModuleConstructorMutablePrototypeMember};
 * - ambient Module instance PATH-ARRAY whole-array replacement
 *   (VT-307c-fix-9 Part 6, reproduced blockers D/E):
 *   `module.paths = [...]`, `require.main.paths = [...]` -- the
 *   assignment-shaped sibling of {@link isModuleLoaderPathArrayMutatingCall}
 *   above, which handles the CALL-shaped mutating-method forms instead.
 *
 * Every one of these mutates the module-LOADING MECHANISM itself for every
 * SUBSEQUENT load, not a call/construct that merely reaches one more
 * module -- which is why all of them are detected as an assignment shape
 * rather than folded into {@link classifyLoaderConstruct} (call/`new`-only).
 *
 * VT-307c-capability-floor adds one final fallback branch (Part 3/5),
 * consulted only once every named check above has already had its chance
 * to match and did not: an assignment TARGET that directly (one hop)
 * reaches an authoritative loader capability
 * ({@link isAuthoritativeCapabilityReceiver}) through a member this
 * classifier does not otherwise recognize -- `Module.someUnknownThing =
 * fn`, `module.someUnknownThing = fn`, `Module[dynamicKey] = fn` -- fails
 * closed (`loader_capability_escape`) rather than silently staying
 * unclassified, EXCEPT the one explicitly-reviewed safe write
 * (`module.exports = ...`, see {@link AMBIENT_MODULE_INSTANCE_SAFE_WRITES}).
 * Returns the specific `DynamicCallReason` now (not a bare boolean), so a
 * precise match and the generic fallback remain distinguishable to the
 * caller.
 */
function isModuleLoaderAssignmentMutation(
  node: ts.BinaryExpression,
  context: LoaderClassificationContext,
): DynamicCallReason | undefined {
  // VT-307c-value-flow-closure widens this from `=` alone to the three
  // logical assignments as well: `Module._resolveFilename ||= hook`
  // replaces the resolver exactly as `Module._resolveFilename = hook`
  // does, and an `EqualsToken`-only guard let it through untouched.
  if (!isCapabilityStoringAssignmentOperator(node.operatorToken.kind)) {
    return undefined;
  }
  const target = node.left;

  if (ts.isElementAccessExpression(target)) {
    if (isLoaderHookRegistryObject(target.expression, context)) {
      return "loader_hook_mutation";
    }
    if (isAuthoritativeCapabilityReceiver(target.expression, context)) {
      return "loader_capability_escape";
    }
    return undefined;
  }

  if (!ts.isPropertyAccessExpression(target)) {
    return undefined;
  }

  // Element/property mutation INTO the registry (require.extensions.js =
  // .../ Module._extensions.js = ...) -- the registry object itself is
  // `target.expression`, one level up from the assignment target.
  if (isLoaderHookRegistryObject(target.expression, context)) {
    return "loader_hook_mutation";
  }

  // Whole-OBJECT replacement of the registry itself, or of an ambient
  // Module instance's own `.paths` array -- here `target` ITSELF is the
  // thing being replaced, not something reached through it.
  if (isLoaderHookRegistryObject(target, context)) {
    return "loader_hook_mutation";
  }
  if (isAmbientModulePathsArray(target)) {
    return "loader_hook_mutation";
  }

  // Module-constructor-level loader/resolution member replacement.
  if (isModuleConstructorMutableStaticMember(target, context)) {
    return "loader_hook_mutation";
  }
  if (isModuleConstructorMutablePrototypeMember(target, context)) {
    return "loader_hook_mutation";
  }

  // VT-307c-capability-floor fallback: an unrecognized WRITE into an
  // authoritative capability's own member surface (directly, or through
  // the one named `.prototype` hop {@link isAuthoritativeCapabilityReceiver}
  // recognizes) -- unless it is the one explicitly-reviewed safe write
  // (`module.exports = ...`, which only applies to the direct ambient-
  // instance form, never `.prototype.exports`, which isn't a real member).
  if (
    isAmbientModuleInstance(target.expression) &&
    AMBIENT_MODULE_INSTANCE_SAFE_WRITES.has(target.name.text)
  ) {
    return undefined;
  }
  if (isAuthoritativeCapabilityReceiver(target.expression, context)) {
    return "loader_capability_escape";
  }

  return undefined;
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
 *
 * VT-307c-fix-6 adds non-call constructs to this same whole-file scan:
 * assignments that mutate Node's own module-loading/resolution machinery
 * ({@link isModuleLoaderAssignmentMutation} -- originally just
 * `require.extensions[...] = hook` / `Module._extensions[...] = hook`,
 * considerably generalized by VT-307c-fix-7 Part 4 and VT-307c-fix-9 to
 * also cover whole-object `_extensions` replacement, Module-constructor
 * static/prototype loader-member replacement, and ambient `.paths`-array
 * replacement) mutate `require()`'s own machinery rather than calling
 * anything, so they have no call/`new` node for
 * {@link classifyClosureWideningCall} to ever see. This scanner -- already
 * a generic AST walk over the whole file, not merely over calls -- is the
 * natural, single place to also catch them; `CallGraph` has no equivalent
 * edge shape for a non-call mutation (see `loader_hook_mutation`'s own doc
 * comment in domain/graph.ts) and does not attempt to represent it. The
 * CALL-shaped sibling of the `.paths`-array case
 * ({@link isModuleLoaderPathArrayMutatingCall}, e.g.
 * `module.paths.unshift(dir)`) IS an ordinary call/`new` node, so it is
 * classified through {@link classifyLoaderConstruct} instead and DOES
 * automatically get a `CallGraph` `unknown(loader_hook_mutation)` edge,
 * same as any other call-shaped loader construct.
 *
 * VT-307c-capability-floor adds the SOUNDNESS-FLOOR fallback's remaining,
 * NON-call-shaped pieces to this same whole-file scan -- the CALL-shaped
 * pieces (an authoritative capability passed as a call/`new` argument to
 * an unmodeled callee, and reflection-API mutation calls like
 * `Object.assign(Module, ...)`) live INSIDE
 * {@link classifyClosureWideningCall} itself, shared with `CallGraph`, so
 * this scanner needs no separate logic for those -- it inherits both for
 * free through the ordinary `classifyClosureWideningCall(node, context)`
 * call already made for every visited call/`new` below. What genuinely
 * has no call/`new` node, and therefore belongs here instead:
 *
 * - a capability as the right-hand side of an assignment whose TARGET
 *   isn't itself a recognized mutation (`registry.loader = Module`,
 *   `exports.loader = Module`, a bare `let`-reassignment, and -- VT-307c-
 *   value-flow-closure -- the logical assignments `||=`/`&&=`/`??=`) --
 *   checked only when {@link isModuleLoaderAssignmentMutation} found no
 *   target-side reason, so `module.exports = Module` correctly reports
 *   the escape via its RHS (this branch) rather than a spurious mutation
 *   flag on `.exports` itself (which stays safe-listed on the target
 *   side);
 * - a tagged template's substitutions
 *   ({@link taggedTemplateSubstitutionsOf}) -- call-shaped, but neither a
 *   `CallExpression` nor a `NewExpression`, so
 *   {@link classifyClosureWideningCall}'s argument check cannot see it;
 * - `export { localName };` (a same-file named re-export of a local
 *   capability-bound identifier; deliberately NOT `export { x } from
 *   "pkg"`, which re-exports something from elsewhere, not this file's
 *   own value)
 * - `delete <capability>.<member>;` ({@link isCapabilityDeleteMutation}) --
 *   the one mutation shape that is neither a `BinaryExpression` nor a
 *   call at all;
 * - and every remaining position where a value LEAVES the expression
 *   tree that computed it, resolved through the single semantic
 *   abstraction {@link consumedValuePositionOf} rather than a per-node-
 *   kind chain: values stored under a name (any declaration carrying an
 *   `initializer` -- variable, parameter, binding element, class field,
 *   enum member), values handed out of the current computation
 *   (`return`/`throw`/`yield`/`export =`/`export default`), and values
 *   consumed by iteration (`for...of`/`for...in`). VT-307c-value-flow-
 *   closure replaced the previous hand-listed branches here after this
 *   task reproduced `BindingElement`, `PropertyDeclaration`,
 *   `YieldExpression`, and `for`-iterable escapes end-to-end -- the same
 *   enumeration failure mode, one layer up from the value walker's own.
 *
 * Once a capability escapes into any of these positions, this scanner
 * does not attempt to follow it further (no interprocedural analysis of
 * what a callee/consumer does with it) -- soundness over precision, per
 * the architecture review's own explicit instruction: the closure simply
 * goes incomplete at the escape site itself.
 */
export function findClosureWideningConstructs(
  context: LoaderClassificationContext,
): LoaderConstruct[] {
  const { sourceFile } = context.index;
  const found: LoaderConstruct[] = [];
  const seen = new Set<string>();

  function record(reason: DynamicCallReason, node: ts.Node): void {
    if (!isClosureWideningReason(reason)) {
      return;
    }
    const location = toSourceLocation(sourceFile, node);
    const key = `${reason}|${location.line}:${location.column}`;
    if (!seen.has(key)) {
      seen.add(key);
      found.push({ reason, location });
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      // VT-307c-capability-floor/flow: reflection-API mutation calls and
      // argument-position capability escapes (including a capability
      // nested in a composite argument) are both handled INSIDE
      // classifyClosureWideningCall itself (shared with CallGraph -- see
      // that function's own doc comment), so this scanner needs no
      // separate logic for either; it inherits both automatically.
      const reason = classifyClosureWideningCall(node, context);
      if (reason !== undefined) {
        record(reason, node);
      }
    } else if (ts.isTaggedTemplateExpression(node)) {
      // VT-307c-value-flow-closure: a tagged template hands every
      // substitution to the tag function as an argument, but is neither
      // a CallExpression nor a NewExpression, so
      // `classifyClosureWideningCall`'s argument check never sees it.
      // Closure-only, like the other non-call escape positions here --
      // CallGraph has no edge shape for it (see this function's own doc
      // comment).
      for (const substitution of taggedTemplateSubstitutionsOf(node)) {
        if (isEscapingCapabilityUse(substitution, context)) {
          record("loader_capability_escape", substitution);
        }
      }
    } else if (ts.isBinaryExpression(node)) {
      const targetReason = isModuleLoaderAssignmentMutation(node, context);
      if (targetReason !== undefined) {
        record(targetReason, node);
      } else if (
        isCapabilityStoringAssignmentOperator(node.operatorToken.kind) &&
        isEscapingCapabilityUse(node.right, context)
      ) {
        record("loader_capability_escape", node.right);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier === undefined &&
      node.exportClause !== undefined &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const specifier of node.exportClause.elements) {
        const localName = specifier.propertyName ?? specifier.name;
        if (isAuthoritativeCapabilityValue(localName, context)) {
          record("loader_capability_escape", specifier);
        }
      }
    } else if (
      ts.isDeleteExpression(node) &&
      isCapabilityDeleteMutation(node, context)
    ) {
      record("loader_capability_escape", node);
    } else {
      // VT-307c-value-flow-closure: every remaining position where a
      // value leaves the expression tree that computed it, resolved
      // through ONE semantic abstraction rather than a per-node-kind
      // chain -- see {@link consumedValuePositionOf} for the three
      // categories and why they are stated semantically. A bare
      // capability is an escape in all of them EXCEPT the one
      // declaration form whose alias this classifier can follow
      // afterwards (`const alias = Module`).
      const consumed = consumedValuePositionOf(node);
      if (
        consumed !== undefined &&
        (consumed.aliasFollowable
          ? isNonAliasCapabilityEscape(consumed.expression, context)
          : isEscapingCapabilityUse(consumed.expression, context))
      ) {
        record("loader_capability_escape", consumed.expression);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}
