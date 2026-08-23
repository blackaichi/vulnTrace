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
 */
function isModuleLoaderAssignmentMutation(
  node: ts.BinaryExpression,
  context: LoaderClassificationContext,
): boolean {
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
    return false;
  }
  const target = node.left;

  if (ts.isElementAccessExpression(target)) {
    return isLoaderHookRegistryObject(target.expression, context);
  }

  if (!ts.isPropertyAccessExpression(target)) {
    return false;
  }

  // Element/property mutation INTO the registry (require.extensions.js =
  // .../ Module._extensions.js = ...) -- the registry object itself is
  // `target.expression`, one level up from the assignment target.
  if (isLoaderHookRegistryObject(target.expression, context)) {
    return true;
  }

  // Whole-OBJECT replacement of the registry itself, or of an ambient
  // Module instance's own `.paths` array -- here `target` ITSELF is the
  // thing being replaced, not something reached through it.
  if (isLoaderHookRegistryObject(target, context)) {
    return true;
  }
  if (isAmbientModulePathsArray(target)) {
    return true;
  }

  // Module-constructor-level loader/resolution member replacement.
  if (isModuleConstructorMutableStaticMember(target, context)) {
    return true;
  }
  if (isModuleConstructorMutablePrototypeMember(target, context)) {
    return true;
  }

  return false;
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
      const reason = classifyClosureWideningCall(node, context);
      if (reason !== undefined) {
        record(reason, node);
      }
    } else if (
      ts.isBinaryExpression(node) &&
      isModuleLoaderAssignmentMutation(node, context)
    ) {
      record("loader_hook_mutation", node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}
