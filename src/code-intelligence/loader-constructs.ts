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
 * {@link namedBuiltinBindingOf} for that.
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
 * The maximum number of `const`-alias hops any recursive resolver in this
 * file will follow before giving up (VT-307c-provenance-closure Part 7).
 * A cyclic alias -- `const a = b; const b = a;`, or any longer cycle a
 * naive same-NAME whole-file search can produce (see
 * {@link resolveSingleAssignmentValue}'s own "first-match-wins,
 * no-scope-awareness" doc comment: two unrelated `const`s in different
 * scopes that happen to share a name can look like a genuine mutual
 * reference to this lookup even when the real runtime data flow is
 * unrelated) -- previously caused UNBOUNDED recursion here, a real
 * `RangeError: Maximum call stack size exceeded` crash reproduced
 * end-to-end at VT-307c-value-flow-closure's own base commit. 40 is far
 * beyond any depth a real alias chain in this codebase's own test suite
 * or the real-world validation corpus ever reaches (the deepest
 * legitimate chain tested is 3 hops), so it never truncates genuine
 * resolution, while still terminating orders of magnitude before any
 * real stack-overflow risk.
 */
const MAX_ALIAS_RESOLUTION_DEPTH = 40;

/**
 * Resolves `expr` to the Node builtin module name it refers to as a WHOLE
 * value, or `undefined` if it can't be traced to one. Handles the inline
 * `require("vm")`/`require("node:vm")` call form directly (no local
 * binding at all -- `require("module").createRequire`'s own root shape),
 * a direct whole-module import/require binding
 * ({@link wholeModuleBuiltinFor}), and an UNBOUNDED-depth `const`-alias
 * chain from such a binding (`const whole = require("vm"); const a2 =
 * whole; const a3 = a2; ...`), cycle/excessive-depth protected via
 * {@link MAX_ALIAS_RESOLUTION_DEPTH} -- VT-307c-provenance-closure widens
 * this from the single-hop scope earlier revisions of this file
 * documented: a `require`-alias chain of depth 2+ was one of the final
 * certification's reproduced blockers (Family D), and this function's own
 * unbounded self-recursion, with no depth guard at all, was separately
 * the exact site of the certification's reproduced crash.
 */
function resolveWholeModuleBuiltin(
  expr: ts.Expression,
  context: LoaderClassificationContext,
  depth = 0,
): string | undefined {
  if (depth > MAX_ALIAS_RESOLUTION_DEPTH) {
    return undefined;
  }
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
      return resolveWholeModuleBuiltin(initializer, context, depth + 1);
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
  const capability = resolveLoaderCapability(expr, context);
  if (capability === undefined) {
    return false;
  }
  // `module` members collapse onto `module_constructor_member` -- see
  // {@link capabilityForBuiltinMember} for why the whole `module` builtin
  // and the `Module` constructor are the same value.
  if (builtin === "module") {
    return (
      capability.kind === "module_constructor_member" &&
      capability.member === exportName
    );
  }
  return (
    capability.kind === "builtin_member" &&
    capability.builtin === builtin &&
    capability.member === exportName
  );
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
  const capability = resolveLoaderCapability(expr, context);
  return (
    capability?.kind === "vm_instance" &&
    capability.constructorName === constructorName
  );
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
function isAmbientModuleInstance(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  return resolveLoaderCapability(expr, context)?.kind === "module_instance";
}

/**
 * Whether `localName` is bound, in this file, as an ESM NAMESPACE import
 * (`import * as localName from "..."`) of Node builtin `builtin` -- the
 * receiver-side half of the `.default` self-reference check below
 * ({@link resolveLoaderCapability}'s Family-A namespace case).
 */
function isNamespaceBuiltinBinding(
  localName: string,
  builtin: string,
  context: LoaderClassificationContext,
): boolean {
  return context.model.imports.some(
    (imp) =>
      imp.localName === localName &&
      imp.kind === "namespace" &&
      builtinNameFromSpecifier(imp.specifier) === builtin,
  );
}

/**
 * The `(builtin, exportName)` pair `localName` is bound to by a NAMED
 * import/destructure of any modeled Node builtin, or `undefined`
 * (VT-307c-builtin-closure). The open-ended sibling of
 * the removed `isNamedBuiltinBinding`, which answered the same question only for
 * one caller-supplied `(builtin, exportName)` guess at a time: this one
 * lets {@link resolveLoaderCapability} discover WHICH builtin export a
 * bare identifier denotes without being told what to look for, so
 * `const { fork } = require("child_process")` resolves through the same
 * single relation `const { Module } = require("module")` already did.
 */
function namedBuiltinBindingOf(
  localName: string,
  context: LoaderClassificationContext,
): { readonly builtin: string; readonly exportName: string } | undefined {
  for (const imp of context.model.imports) {
    if (
      imp.localName !== localName ||
      imp.kind !== "named" ||
      imp.importedName === undefined
    ) {
      continue;
    }
    const builtin = builtinNameFromSpecifier(imp.specifier);
    if (builtin) {
      return { builtin, exportName: imp.importedName };
    }
  }
  return undefined;
}

/**
 * The capability kind for `<builtin>.<member>`, normalizing the one case
 * where the two spellings collapse: because the whole `module` builtin IS
 * the `Module` constructor, `require("module").createRequire` and
 * `Module.createRequire` are the same value, so a `module` member always
 * resolves to `"module_constructor_member"` and never to
 * `"builtin_member"`. Every other modeled builtin uses
 * `"builtin_member"`. Keeping this in ONE place is what lets
 * {@link resolveLoaderCapability}'s several entry paths (a named
 * destructure, a property access off a namespace, an ESM named import)
 * agree on the answer without each repeating the special case.
 */
function capabilityForBuiltinMember(
  builtin: string,
  member: string,
): ResolvedLoaderCapability {
  if (builtin !== "module") {
    return { kind: "builtin_member", builtin, member };
  }
  // `module`'s own `Module` export is the self-reference Node's loader
  // sets up (`Module.Module = Module`), so it IS the constructor rather
  // than a member OF it -- the same identity the property-access branch
  // of {@link resolveLoaderCapability} applies to `<X>.Module`. Handling
  // it here too is what keeps a NAMED binding of it
  // (`import { Module } from "module"`, `const { Module } =
  // require("module")`) resolving to the constructor, which every
  // `Module.<member>` classification downstream depends on.
  if (member === "Module") {
    return { kind: "module_constructor" };
  }
  return { kind: "module_constructor_member", member };
}

/**
 * Whether `<builtin>.<member>` is a member this classifier considers a
 * loader/execution capability at all (VT-307c-builtin-closure).
 *
 * The split this function draws is deliberate and is what keeps
 * {@link resolveLoaderCapability} a pure RESOLUTION relation. That
 * relation answers "what does this expression denote" and resolves EVERY
 * member of a modeled builtin, dangerous or not -- so
 * `child_process.fork` and `worker_threads.isMainThread` both resolve,
 * and an alias chain to either is followed identically. This predicate
 * then answers the separate question "does losing track of this value
 * matter", consulting the SAME {@link BUILTIN_MEMBER_REASONS} table the
 * call-classification path already uses rather than a second list of its
 * own. Without the split, `const notMainThread = wt.isMainThread` -- an
 * ordinary boolean read -- would become a capability escape purely
 * because the relation could now resolve it.
 */
function isDangerousBuiltinMember(builtin: string, member: string): boolean {
  return BUILTIN_MEMBER_REASONS.some(
    ([tableBuiltin, tableExport]) =>
      tableBuiltin === builtin && tableExport === member,
  );
}

/**
 * What {@link resolveLoaderCapability} can determine an expression denotes:
 * either one of the five BASE authoritative-capability shapes this
 * classifier has always modeled (the `Module` constructor itself, a real
 * `Module` INSTANCE, `Module.prototype`, the ambient `require` FUNCTION,
 * or the RESULT of calling `createRequire(...)`), a MEMBER value read off
 * the constructor or its prototype (`Module._preloadModules`,
 * `Module.prototype.require`, ... -- present whether that member is
 * itself dangerous, safe, or unrecognized; the reason tables this
 * classifier already maintains decide that, not this relation), the
 * ambient `eval` identifier (tracked here only so alias-chasing it is the
 * SAME mechanism as `require`'s, not a parallel one), or `"ambiguous"`
 * (resolution hit {@link MAX_ALIAS_RESOLUTION_DEPTH} -- a cycle, or a
 * chain too deep to safely keep following -- and must not be silently
 * treated as "no capability here").
 */
type ResolvedLoaderCapability =
  | { readonly kind: "module_constructor" }
  | { readonly kind: "module_instance" }
  | { readonly kind: "module_prototype" }
  | { readonly kind: "ambient_require" }
  | { readonly kind: "ambient_eval" }
  | { readonly kind: "create_require_result" }
  | { readonly kind: "module_constructor_member"; readonly member: string }
  | { readonly kind: "module_prototype_member"; readonly member: string }
  /**
   * The WHOLE value of one of the OTHER modeled loader/execution builtins
   * -- `vm`, `child_process`, `worker_threads` (VT-307c-builtin-closure).
   * `module` never produces this kind: Node's own loader does
   * `module.exports = Module`, so the whole `module` builtin IS the
   * `Module` constructor and resolves to `"module_constructor"` instead.
   */
  | { readonly kind: "builtin_namespace"; readonly builtin: string }
  /**
   * A MEMBER value read off one of those other builtins (`vm.Script`,
   * `child_process.fork`, `worker_threads.Worker`, ...) -- present
   * whether that member is dangerous, safe, or unrecognized, exactly as
   * `module_constructor_member` is. Whether a given member MATTERS is
   * {@link BUILTIN_MEMBER_REASONS}/{@link isDangerousBuiltinMember}'s
   * job, never this relation's.
   */
  | {
      readonly kind: "builtin_member";
      readonly builtin: string;
      readonly member: string;
    }
  /** An instance constructed from one of `vm`'s own constructors (`new vm.Script(...)`). */
  | { readonly kind: "vm_instance"; readonly constructorName: string }
  /**
   * The ambient `process` object, and the global object itself
   * (`globalThis`/`global`) -- tracked ONLY as intermediate steps on the
   * way to a real capability (`process.mainModule`,
   * `globalThis.process.mainModule`, `globalThis.require`), never
   * capabilities in their own right (see
   * {@link isAuthoritativeCapabilityValue}'s explicit exclusion).
   * Making them resolvable KINDS rather than literal identifier matches
   * is what lets an ambient chain be reached through an ALIAS
   * (`const p = process; p.mainModule.constructor`) or through a global
   * prefix (`globalThis.process...`, `global.process...`) -- five such
   * spellings were reproduced end-to-end as real invariant violations
   * while the OWNER position of an ambient chain was still matched by
   * literal name only, the same defect class as every other round of
   * this series, one level further out.
   */
  | { readonly kind: "ambient_process" }
  | { readonly kind: "ambient_global" }
  /**
   * One of the module system's own MUTABLE REGISTRY objects -- the
   * compile-hook table (`Module._extensions`/`require.extensions`), the
   * module-instance cache (`Module._cache`/`require.cache`), the source
   * wrapper array (`Module.wrapper`), or the resolved-path cache
   * (`Module._pathCache`). Mutating any of them changes what a
   * SUBSEQUENT load resolves to or executes.
   *
   * A resolvable KIND rather than a syntactic `<owner>.<name>` shape
   * because holding a registry in a local const and mutating through
   * THAT (`const ext = Module._extensions; ext['.js'] = hook;`) was
   * reproduced end-to-end as a real invariant violation -- the same
   * owner-not-resolved defect this series has now closed at four
   * successive layers (value containers, capability provenance, builtin
   * members, ambient owners), reaching the registries last.
   */
  | { readonly kind: "loader_registry" }
  | { readonly kind: "ambiguous" };

/**
 * VT-307c-provenance-closure. The final invariant certification found 12
 * end-to-end violations (real Node execution + a gate-eligible, complete
 * closure + the exact installed package OUT), all instances of ONE
 * property, not twelve spellings: THE ALIAS-EXEMPTION RELATION WAS
 * BROADER THAN THE PROVENANCE-RESOLUTION RELATION. A `const <id> = <capability
 * expr>` declaration was exempted from escape (per
 * {@link isNonAliasCapabilityEscape}) on the promise that the SAME
 * capability would be recognized again wherever `<id>` was later USED --
 * but the five resolvers doing that recognition (this function's
 * predecessor `resolvesToModuleConstructor`, {@link isAuthoritativeCapabilityReceiver},
 * {@link isModuleConstructorLoader}, {@link resolvesToCreateRequireExport},
 * and `classifyLoaderConstruct`'s own identifier branch) each independently
 * resolved LESS than the exemption assumed: one hop instead of unbounded
 * depth for `require`; identifier-only instead of stored PROPERTY VALUES
 * for named exports; purely syntactic (never alias-resolving) for the
 * `.prototype` receiver case; non-recursive for the `<whole>.Module`
 * self-reference, unlike its own `.constructor` sibling; and no
 * consultation of any named-binding lookup at all for ESM named
 * imports of `Module` itself. Wherever the promise wasn't kept, the
 * capability vanished in BOTH directions at once: no escape recorded at
 * the declaration, no provenance recognized at the use.
 *
 * The fix is architectural, not five patches: THIS function is now the
 * SINGLE relation every one of those five call sites consults (each
 * reduced to a thin wrapper below), so "what capability does this
 * declaration's initializer denote" and "what capability does this USE
 * SITE'S expression denote" are answered by the literal same code, not by
 * two hand-maintained checks that can drift apart again. The alias
 * exemption ({@link isNonAliasCapabilityEscape}) is unchanged in its OWN
 * logic -- it still asks "does `isAuthoritativeCapabilityValue` hold for
 * this initializer" -- but `isAuthoritativeCapabilityValue` itself is now
 * `resolveLoaderCapability(expr) !== undefined`, so the exemption is the
 * exact inverse of resolution BY CONSTRUCTION, not by two authors keeping
 * two functions in sync by hand.
 *
 * Recognizes every ordinary way a file can reach an authoritative
 * capability, UNBOUNDED-depth and cycle-safe throughout (every recursive
 * call below threads `depth`, checked once at the top against
 * {@link MAX_ALIAS_RESOLUTION_DEPTH}):
 *
 * - a whole-module reference to the `module`/`node:module` builtin
 *   itself IS the `Module` constructor (`require("module")`, or an ESM
 *   default/namespace import of it) -- {@link resolveWholeModuleBuiltin};
 * - a NAMED/destructured `Module` export binding (`import { Module } from
 *   "module"`, `const { Module } = require("module")`, including aliased
 *   forms) -- reuses {@link namedBuiltinBindingOf}, the SAME mechanism
 *   already modeling every other named builtin export, rather than a
 *   parallel one;
 * - an ESM NAMESPACE import's `.default` property, which Node's CJS-ESM
 *   interop sets to the whole `module.exports` value (`import * as M from
 *   "module"; M.default`);
 * - `<X>.Module` -- the self-reference Node's own loader sets up
 *   (`Module.Module = Module`) -- recognized through the SAME recursive
 *   call this function makes for every other shape, so
 *   `Module.Module.Module...` converges at any depth with no per-depth
 *   branch, unlike the non-recursive check this replaces;
 * - `<X>.prototype` off the constructor -- `Module.prototype` -- is now a
 *   first-class capability kind of its own (`module_prototype`), not
 *   merely a syntactic pattern `.prototype.<member>` had to spell out
 *   inline; this is what lets `const proto = Module.prototype;` alone
 *   carry full provenance, aliased or not;
 * - `<X>.constructor` off a `Module` INSTANCE (ambient `module`,
 *   `require.main`, `process.mainModule`, or an ALIAS of any of them) OR
 *   off `Module.prototype` IS the `Module` constructor -- by definition
 *   for the former, by JS's own `Fn.prototype.constructor === Fn`
 *   invariant for the latter;
 * - any OTHER member off the constructor or its prototype is a
 *   resolvable MEMBER VALUE (`Module._preloadModules`,
 *   `Module.createRequire`, `Module.prototype.require`, ...) --
 *   deliberately member-NAME-agnostic: this relation answers "what does
 *   this expression denote", never "is this specific member dangerous"
 *   (that remains {@link MODULE_CONSTRUCTOR_STATIC_MEMBERS}/
 *   {@link MODULE_CONSTRUCTOR_PROTOTYPE_MEMBERS}/
 *   {@link MODULE_CONSTRUCTOR_SAFE_CALLS}'s job, applied at the
 *   classification site);
 * - `new <ctor>(...)` where `<ctor>` resolves to the constructor produces
 *   a `Module` INSTANCE;
 * - a call whose callee resolves to the constructor's own `createRequire`
 *   member produces a createRequire RESULT;
 * - an UNBOUNDED-depth same-file `const`-alias chain from any of the
 *   above, cycle-safe via the shared depth budget.
 *
 * Never matches an arbitrary same-file class/object that merely happens
 * to be named `Module`, expose a `.Module`/`.prototype` property, or have
 * its own `.constructor` -- every branch requires either real Node-builtin
 * import provenance or one of the ambient module-instance references,
 * never a bare name/shape match (see this file's own precision-control
 * tests).
 */
function resolveLoaderCapability(
  expr: ts.Expression,
  context: LoaderClassificationContext,
  depth = 0,
): ResolvedLoaderCapability | undefined {
  if (depth > MAX_ALIAS_RESOLUTION_DEPTH) {
    return { kind: "ambiguous" };
  }

  // Ambient globals. Each is a LEAF of this relation -- an identifier
  // with no import binding and no local declaration -- so every way of
  // REACHING one (an alias, a `globalThis.`/`global.` prefix, a longer
  // chain) is handled by the ordinary recursion below rather than by a
  // literal identifier-chain match, which is what previously lost
  // `const p = process; p.mainModule.constructor` and its four siblings.
  // A same-file `const <name> = ...` shadows the ambient global and is
  // resolved as the ordinary alias it is (the `require` case matters in
  // real ESM code: `const require = createRequire(import.meta.url)`).
  if (ts.isIdentifier(expr)) {
    const shadowed =
      resolveSingleAssignmentValue(expr.text, context.index.sourceFile) !==
      undefined;
    if (!shadowed) {
      switch (expr.text) {
        case "module":
          return { kind: "module_instance" };
        case "require":
          return { kind: "ambient_require" };
        case "eval":
          return { kind: "ambient_eval" };
        case "process":
          return { kind: "ambient_process" };
        case "globalThis":
        case "global":
          return { kind: "ambient_global" };
        default:
          break;
      }
    }
  }

  // Whole-value reference to a modeled builtin. For `module` that value
  // IS the `Module` constructor (Node's own loader does
  // `module.exports = Module`); for the others it is the namespace
  // object, whose members the property-access branch below resolves.
  const wholeBuiltin = resolveWholeModuleBuiltin(expr, context, depth);
  if (wholeBuiltin !== undefined) {
    return wholeBuiltin === "module"
      ? { kind: "module_constructor" }
      : { kind: "builtin_namespace", builtin: wholeBuiltin };
  }

  // Named/destructured export binding of ANY modeled builtin
  // (VT-307c-builtin-closure generalizes VT-307c-provenance-closure's
  // `module`-only Family-A case): `const { Module } = require("module")`,
  // `import { Module as M } from "node:module"`, and equally
  // `const { fork } = require("child_process")` /
  // `import { Worker } from "node:worker_threads"`.
  if (ts.isIdentifier(expr)) {
    const named = namedBuiltinBindingOf(expr.text, context);
    if (named) {
      return capabilityForBuiltinMember(named.builtin, named.exportName);
    }
  }

  if (ts.isPropertyAccessExpression(expr)) {
    // ESM namespace import's `.default` IS the whole default export.
    const namespaceOwner = expr.expression;
    if (expr.name.text === "default" && ts.isIdentifier(namespaceOwner)) {
      for (const [builtin] of NODE_BUILTIN_SPECIFIERS) {
        if (isNamespaceBuiltinBinding(namespaceOwner.text, builtin, context)) {
          return builtin === "module"
            ? { kind: "module_constructor" }
            : { kind: "builtin_namespace", builtin };
        }
      }
    }

    const receiverKind = resolveLoaderCapability(
      expr.expression,
      context,
      depth + 1,
    );

    // Ambient chains, resolved through the SAME recursion as everything
    // else: `globalThis.X` IS `X` for every genuine global, `<require>
    // .main` and `<process>.mainModule` are both the entry `Module`
    // INSTANCE (the very same object, under Node's two historical
    // spellings). Because the receiver is RESOLVED rather than
    // name-matched, an alias or a global prefix anywhere along the chain
    // composes for free.
    if (receiverKind?.kind === "ambient_global") {
      switch (expr.name.text) {
        case "process":
          return { kind: "ambient_process" };
        case "require":
          return { kind: "ambient_require" };
        case "module":
          return { kind: "module_instance" };
        case "eval":
          return { kind: "ambient_eval" };
        default:
          // `globalThis.<anything else>` is an ordinary global read.
          return undefined;
      }
    }
    if (receiverKind?.kind === "ambient_require" && expr.name.text === "main") {
      return { kind: "module_instance" };
    }
    // The module system's own mutable registries, under BOTH of Node's
    // aliasing names for each (`Module._extensions` and
    // `require.extensions` are the same object; so are `Module._cache`
    // and `require.cache`).
    if (
      (receiverKind?.kind === "module_constructor" &&
        MODULE_CONSTRUCTOR_REGISTRY_MEMBERS.has(expr.name.text)) ||
      (receiverKind?.kind === "ambient_require" &&
        AMBIENT_REQUIRE_REGISTRY_MEMBERS.has(expr.name.text))
    ) {
      return { kind: "loader_registry" };
    }
    if (
      receiverKind?.kind === "ambient_process" &&
      expr.name.text === "mainModule"
    ) {
      return { kind: "module_instance" };
    }
    if (receiverKind?.kind === "ambient_process") {
      // `process.<anything else>` is an ordinary process read.
      return undefined;
    }

    // `<X>.Module` self-reference off an already-resolved constructor
    // (Family B) -- recurses through this SAME function, so arbitrary-
    // depth self-reference chains converge with no per-depth logic.
    if (
      expr.name.text === "Module" &&
      receiverKind?.kind === "module_constructor"
    ) {
      return { kind: "module_constructor" };
    }

    // `<X>.prototype` off the constructor -> Module.prototype, a
    // first-class capability kind (Family C).
    if (
      expr.name.text === "prototype" &&
      receiverKind?.kind === "module_constructor"
    ) {
      return { kind: "module_prototype" };
    }

    // `<X>.constructor` off a Module instance OR off Module.prototype IS
    // the Module constructor.
    if (
      expr.name.text === "constructor" &&
      (receiverKind?.kind === "module_instance" ||
        receiverKind?.kind === "module_prototype")
    ) {
      return { kind: "module_constructor" };
    }

    // Any other member off the constructor, its prototype, or one of the
    // other builtins' namespace objects is a resolvable member value,
    // whether reached directly or through an arbitrary alias chain.
    if (receiverKind?.kind === "module_constructor") {
      return { kind: "module_constructor_member", member: expr.name.text };
    }
    if (receiverKind?.kind === "module_prototype") {
      return { kind: "module_prototype_member", member: expr.name.text };
    }
    if (receiverKind?.kind === "builtin_namespace") {
      return capabilityForBuiltinMember(receiverKind.builtin, expr.name.text);
    }

    if (receiverKind?.kind === "ambiguous") {
      return { kind: "ambiguous" };
    }
  }

  // `new <ctor>(...)`: off the `Module` constructor this produces a
  // `Module` INSTANCE; off one of `vm`'s own constructors it produces the
  // corresponding `vm` instance (`new vm.Script(code)`), which
  // {@link isVmConstructedInstance} then recognizes through this same
  // relation rather than its own separate one-hop alias check.
  if (ts.isNewExpression(expr)) {
    const ctorKind = resolveLoaderCapability(
      expr.expression,
      context,
      depth + 1,
    );
    if (ctorKind?.kind === "module_constructor") {
      return { kind: "module_instance" };
    }
    if (ctorKind?.kind === "builtin_member" && ctorKind.builtin === "vm") {
      return { kind: "vm_instance", constructorName: ctorKind.member };
    }
    if (ctorKind?.kind === "ambiguous") {
      return { kind: "ambiguous" };
    }
  }

  // A call whose callee resolves to the constructor's own `createRequire`
  // member -- directly or through an alias -- produces a createRequire
  // RESULT (Family D).
  if (ts.isCallExpression(expr)) {
    const calleeKind = resolveLoaderCapability(
      expr.expression,
      context,
      depth + 1,
    );
    if (
      calleeKind?.kind === "module_constructor_member" &&
      calleeKind.member === "createRequire"
    ) {
      return { kind: "create_require_result" };
    }
    if (calleeKind?.kind === "ambiguous") {
      return { kind: "ambiguous" };
    }
  }

  // Same-file `const`-alias chain, unbounded depth (bounded only by the
  // shared budget above), cycle-safe.
  if (ts.isIdentifier(expr)) {
    const initializer = resolveSingleAssignmentValue(
      expr.text,
      context.index.sourceFile,
    );
    if (initializer !== undefined) {
      return resolveLoaderCapability(initializer, context, depth + 1);
    }
  }

  return undefined;
}

/**
 * Whether `expr` provably resolves to Node's `Module` constructor itself
 * -- a thin wrapper over {@link resolveLoaderCapability}, kept under this
 * name since it is still the most-called single check in this file
 * (VT-307c-fix-6 through VT-307c-value-flow-closure all reference it by
 * name); every one of its many existing call sites (the `_extensions`/
 * `_cache`/`wrapper`/`_pathCache` registry checks,
 * {@link isModuleConstructorMutableStaticMember}, ...) now benefits from
 * the shared relation's full resolving power with no edit of its own.
 */
function resolvesToModuleConstructor(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  return resolveLoaderCapability(expr, context)?.kind === "module_constructor";
}

/** Whether `expr` provably resolves to `Module.prototype` itself -- a thin wrapper over {@link resolveLoaderCapability}. */
function resolvesToModulePrototype(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  return resolveLoaderCapability(expr, context)?.kind === "module_prototype";
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
 * Whether `expr` is provably a `Module` instance -- a thin wrapper over
 * {@link resolveLoaderCapability}, which recognizes the ambient instances
 * (`module`/`require.main`/`process.mainModule`), `new <ctor>(...)`
 * construction where `<ctor>` resolves to the `Module` constructor, and
 * an UNBOUNDED-depth `const`-alias chain from either -- strictly more
 * powerful than this function's predecessor, which only followed ONE
 * alias hop and only for the `new`-construction case (an ambient-instance
 * ALIAS, `const mod = module;`, previously round-tripped through
 * {@link isAuthoritativeCapabilityValue}'s own separate identifier-alias
 * branch but not through this specific check).
 */
function isModuleConstructorInstance(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  return resolveLoaderCapability(expr, context)?.kind === "module_instance";
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
 * `Module`-constructor-level loading primitives: `<ModuleCtor>._load(...)`,
 * `<ModuleCtor>.createRequire(...)`, `<ModuleCtor>.prototype.require(...)`,
 * `<ModuleCtor>.prototype.load(...)`, or `<ModuleCtor>.prototype._compile
 * (...)` -- with or without an explicit `.call`/`.apply` thisArg, reached
 * DIRECTLY or through an arbitrary `const`-alias chain
 * (VT-307c-provenance-closure: `const pre = Module._preloadModules; pre(
 * ['vuln'])` and `const proto = Module.prototype; proto.constructor.
 * _preloadModules(...)` were both reproduced end-to-end blockers of the
 * predecessor of this function, which required `expr` to be SYNTACTICALLY
 * a property access and so never saw either aliased form).
 *
 * `expr` (after `.call`/`.apply` stripping) is resolved as a single
 * expression through {@link resolveLoaderCapability} -- the SAME relation
 * every other receiver/value check in this file now shares -- so a bare
 * alias of a static/prototype member resolves through the identical
 * "member off constructor/prototype" step a DIRECT `Module.<member>`
 * access does, with no separate logic for the two forms. Returns
 * `undefined` (not `false`) when `expr` is not one of these members at
 * all, so callers can distinguish "not a Module-constructor-level
 * primitive" from any specific reason.
 */
function isModuleConstructorLoader(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): DynamicCallReason | undefined {
  const target = stripCallApplySuffix(expr);
  const capability = resolveLoaderCapability(target, context);
  if (capability === undefined) {
    return undefined;
  }
  if (capability.kind === "module_constructor_member") {
    return MODULE_CONSTRUCTOR_STATIC_MEMBERS.get(capability.member);
  }
  if (capability.kind === "module_prototype_member") {
    return MODULE_CONSTRUCTOR_PROTOTYPE_MEMBERS.get(capability.member);
  }
  return undefined;
}

/**
 * Whether `expr` provably resolves to Node's `createRequire` export of the
 * `module` builtin -- either the ordinary whole-module-bound/named-import
 * forms {@link referencesBuiltinExport} already covers, or a reference to
 * the constructor's own `createRequire` MEMBER via
 * {@link resolveLoaderCapability} (VT-307c-provenance-closure: this now
 * resolves through an arbitrary alias chain, not just the direct
 * `Module.createRequire`/`module.constructor.createRequire` forms --
 * `const cr = require('module').createRequire;`/`const cr = Module.
 * createRequire;`, each later called as `cr(__filename)`, were both
 * reproduced end-to-end blockers of the narrower check this replaces).
 * Both converge on the same `"create_require"` reason regardless of which
 * check matched.
 */
function resolvesToCreateRequireExport(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  if (referencesBuiltinExport(expr, "module", "createRequire", context)) {
    return true;
  }
  const capability = resolveLoaderCapability(expr, context);
  return (
    capability?.kind === "module_constructor_member" &&
    capability.member === "createRequire"
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

    // VT-307c-provenance-closure: resolved through the SAME shared
    // relation every other check in this file now uses, so an identifier
    // aliasing `require`/`eval` at ANY depth (`const r1 = require; const
    // r2 = r1; ...`, both reproduced end-to-end blockers of the
    // single-hop check this replaces), a stored createRequire RESULT, or
    // a stored Module-constructor/prototype MEMBER value
    // (`const pre = Module._preloadModules; pre(['vuln'])`, also a
    // reproduced blocker) all converge on the identical classification a
    // direct, non-aliased reference to the same capability would get.
    const capability = resolveLoaderCapability(expr, context);
    if (capability === undefined) {
      return undefined;
    }
    switch (capability.kind) {
      case "ambient_require":
        return "aliased_require";
      case "ambient_eval":
        return "aliased_eval";
      case "create_require_result":
        return "create_require";
      case "module_constructor_member": {
        const reason = MODULE_CONSTRUCTOR_STATIC_MEMBERS.get(capability.member);
        if (reason) {
          return reason;
        }
        return MODULE_CONSTRUCTOR_SAFE_CALLS.has(capability.member)
          ? undefined
          : "loader_capability_escape";
      }
      case "module_prototype_member": {
        const reason = MODULE_CONSTRUCTOR_PROTOTYPE_MEMBERS.get(
          capability.member,
        );
        return reason ?? "loader_capability_escape";
      }
      case "ambiguous":
        return "loader_capability_escape";
      default:
        // `module_constructor`/`module_instance`/`module_prototype` used
        // BARE as a callee (`Module()`, `module()`) is not a real Node
        // scenario -- calling the class/instance/prototype object itself
        // throws -- so no reason applies here; every meaningful case is a
        // MEMBER of one of these, already handled above.
        return undefined;
    }
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
    if (isModuleLoaderPathArrayMutatingCall(expr, context)) {
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
 * `<ModuleCtor>.<member>` names that ARE one of the module system's own
 * mutable registries. Node's CJS loader aliases each of these under a
 * second name on `require` as well (`Module._extensions ===
 * require.extensions`, `Module._cache === require.cache`), which
 * {@link AMBIENT_REQUIRE_REGISTRY_MEMBERS} covers -- the two tables name
 * the same four objects, not eight.
 *
 * `wrapper` is the two-element array Node wraps every module's source in
 * before compiling it; `_pathCache` is the resolved-path memoization
 * cache. Populating, replacing, or mutating any entry of any of these
 * changes what a SUBSEQUENT `require()` resolves to or executes, which is
 * why all four share one `loader_hook_mutation` reason.
 */
const MODULE_CONSTRUCTOR_REGISTRY_MEMBERS: ReadonlySet<string> = new Set([
  "_extensions",
  "_cache",
  "wrapper",
  "_pathCache",
]);

/** The same registries under their `require`-namespaced aliases. */
const AMBIENT_REQUIRE_REGISTRY_MEMBERS: ReadonlySet<string> = new Set([
  "extensions",
  "cache",
]);

/**
 * Whether `expr` is one of the module system's own mutable registry
 * objects, under any of their aliasing names, reached DIRECTLY or through
 * an arbitrary `const`-alias chain -- a thin wrapper over
 * {@link resolveLoaderCapability} (VT-307c-registry-closure).
 *
 * This replaces six near-identical syntactic helpers (one per registry
 * per aliasing name), each of which required the registry to appear
 * literally as `<owner>.<name>` at the mutation site. Holding a registry
 * in a local const and mutating through THAT -- `const ext =
 * Module._extensions; ext['.js'] = hook;`, `const wrap = Module.wrapper;
 * wrap[0] = injectedSource;` -- was reproduced end-to-end as a real
 * invariant violation against all six, while the direct spellings they
 * did match kept working. Routing them through the shared relation makes
 * every aliasing path resolve for free, exactly as it already does for
 * the constructor, its prototype, the builtin namespaces, and the
 * ambient chain owners.
 */
function isLoaderHookRegistryObject(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  return resolveLoaderCapability(expr, context)?.kind === "loader_registry";
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
 * Whether `expr` is a receiver with authoritative Node loader-capability
 * provenance -- Node's `Module` constructor, an ambient `Module`
 * INSTANCE, or `Module.prototype` itself -- consulted when classifying a
 * CALL or a WRITE whose target reaches one of these, to decide whether an
 * otherwise-unrecognized member interaction must fail closed. A thin
 * wrapper over {@link resolveLoaderCapability} (VT-307c-provenance-
 * closure): every one of these three receiver kinds now resolves through
 * an UNBOUNDED-depth alias chain, not just the `Module`-constructor case
 * the predecessor of this function alone alias-resolved -- `const proto =
 * Module.prototype; proto.require = hook;` (a reproduced end-to-end
 * blocker: it silently redirects an ordinary, statically-resolvable
 * `require()`) reaches this check via its WRITE-target's receiver, and an
 * aliased ambient instance (`const mod = module;`) now round-trips here
 * exactly as it already did for {@link isAuthoritativeCapabilityValue}.
 * `"ambiguous"` (a cycle/excessive-depth resolution) is treated as a
 * receiver too -- an unresolvable alias chain must fail closed, not
 * silently pass. Deliberately excludes the ambient `require` FUNCTION and
 * `createRequire(...)` results -- neither exposes meaningful mutable
 * object state of its own beyond the handful of properties this file
 * already models exhaustively, so there is no unknown-member surface on
 * `require` itself worth failing closed on; `require`'s own capability-
 * floor role is entirely on the ESCAPE side (see
 * {@link isAuthoritativeCapabilityValue}), not the receiver side.
 */
function isAuthoritativeCapabilityReceiver(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  const capability = resolveLoaderCapability(expr, context);
  return (
    capability?.kind === "module_constructor" ||
    capability?.kind === "module_instance" ||
    capability?.kind === "module_prototype" ||
    capability?.kind === "ambiguous"
  );
}

/**
 * Whether `expr` is (or, through a same-file `const` alias chain of
 * UNBOUNDED depth, resolves to) an authoritative Node loader-capability
 * VALUE: Node's `Module` constructor, an ambient `Module` instance,
 * `Module.prototype` itself, the ambient `require`/`eval` functions, the
 * result of calling `createRequire(...)`, or a MEMBER of the constructor
 * or its prototype (`Module._preloadModules`, `Module.createRequire`,
 * `Module.prototype.require`, ...). This is the VALUE-side half of the
 * capability floor -- used everywhere a capability can ESCAPE this
 * classifier's provenance tracking by appearing in a position other than
 * the receiver of an already-modeled call/mutation: a call argument, an
 * assignment's right-hand side, a `return`, or an ESM export. Once a
 * capability value is found in one of those positions, the closure must
 * go incomplete regardless of what the receiving position does with it --
 * this function deliberately does NOT attempt to follow the value past
 * that point.
 *
 * A thin wrapper over {@link resolveLoaderCapability}
 * (VT-307c-provenance-closure): TRUE for ANY resolvable capability kind,
 * including `"ambiguous"` (a cycle/excessive-depth resolution must fail
 * closed, not silently be treated as "no capability here"). Every
 * resolvable capability now shares the identical unbounded-depth,
 * cycle-safe alias-chase this function's predecessor only performed for
 * itself -- the whole point of routing every escape/receiver check
 * through one relation is that this function's own definition no longer
 * needs to independently re-implement that traversal.
 */
function isAuthoritativeCapabilityValue(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  const capability = resolveLoaderCapability(expr, context);
  // Deliberate exclusion: `"ambient_eval"` is tracked in the shared
  // relation ONLY so an aliased-callee chain (`const e1 = eval; const e2 =
  // e1; e2(...)`) resolves at the SAME unbounded depth `require`'s
  // identical chain now does (via `classifyLoaderConstruct`'s identifier
  // branch, the only consumer that switches on this specific kind) --
  // not so that `eval` participates in the broader VALUE-escape sweep
  // this function backs. Widening this check to also flag `eval` merely
  // being STORED in a composite (an object literal, an array, ...) was
  // tried and reverted: it fired on `get-intrinsic` -- an extremely
  // widely-depended-on real-world package (a transitive dependency of
  // `qs` and much of the ecosystem) whose `INTRINSICS['%eval%'] = eval`
  // lookup-table entry never itself calls `eval`, exec's nothing, and was
  // never part of any of this task's certified blockers. `eval` was never
  // an authoritative capability VALUE before this task either (see this
  // function's own history) -- this exclusion restores exactly that prior
  // scope while still gaining the unbounded-depth CALLEE fix.
  if (capability === undefined || capability.kind === "ambient_eval") {
    return false;
  }
  // `vm_instance` is likewise a RESOLUTION-only kind: constructing a
  // `vm.Script`/`vm.SourceTextModule` compiles but executes nothing until
  // one of its own run methods is called, which
  // {@link classifyLoaderConstruct} detects directly via
  // {@link isVmConstructedInstance}. Treating the constructed instance as
  // an escaping capability VALUE would contradict that long-standing,
  // separately-tested distinction (see this file's `BUILTIN_MEMBER_REASONS`
  // doc comment on why `vm`'s `Script` export is deliberately absent from
  // it, and the "(AG control)" / "construction is not itself execution"
  // precision controls in module-load-closure.test.ts).
  if (capability.kind === "vm_instance") {
    return false;
  }
  // `ambient_global`/`ambient_process` are likewise RESOLUTION-only: they
  // exist so an ambient CHAIN (`globalThis.process.mainModule`) resolves
  // through the ordinary recursion, not because the global object or
  // `process` is itself a loader capability. Treating them as escaping
  // VALUES was tried and reverted after measuring the real-world
  // corpus: `var freeGlobal = typeof global == 'object' && global && ...`
  // (lodash and its satellites) and `else if (typeof global !==
  // 'undefined') globalVar = global;` (url-parse) are ordinary
  // global-object detection preambles, ubiquitous in published packages,
  // that hand out no loader capability at all. The chain-resolving power
  // this kind exists for is unaffected -- only the escape sweep is.
  if (
    capability.kind === "ambient_global" ||
    capability.kind === "ambient_process"
  ) {
    return false;
  }
  // VT-307c-builtin-closure: a member of one of the non-`module`
  // builtins is a capability only when the shared
  // {@link BUILTIN_MEMBER_REASONS} table (or `vm`'s capability
  // constructors) says so -- see {@link isDangerousBuiltinMember} for why
  // RESOLUTION and DANGER are deliberately separate questions, and what
  // would break if they were not.
  if (capability.kind === "builtin_member") {
    return isDangerousBuiltinMember(capability.builtin, capability.member);
  }
  return true;
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
  if (!ts.isVariableDeclaration(node)) {
    return false;
  }
  if (ts.isIdentifier(node.name) && isConstDeclaration(node)) {
    return true;
  }
  // VT-307c-builtin-closure: a DESTRUCTURE of a builtin `require(...)`
  // call is followable too, for exactly the same reason -- the module
  // model records `const { fork } = require("child_process")` as a named
  // import binding, so {@link namedBuiltinBindingOf} resolves every name
  // it introduces back to the right `(builtin, export)` pair later,
  // precisely as {@link resolveSingleAssignmentValue} resolves a plain
  // `const` alias. Withholding the exemption here made
  // `const { isMainThread } = require("worker_threads")` -- an ordinary,
  // extremely common read of a boolean -- report a capability escape
  // purely because the WHOLE-namespace initializer is a capability,
  // even though the binding extracts a member that is not one.
  //
  // Gated on the initializer being SYNTACTICALLY a static
  // `require("<builtin>")` call, which is exactly the shape the module
  // model records: `const { prototype } = Module` (initializer an
  // identifier, no import binding recorded, `prototype` therefore NOT
  // resolvable later) is deliberately excluded and still escapes.
  const { initializer } = node;
  return (
    ts.isObjectBindingPattern(node.name) &&
    initializer !== undefined &&
    ts.isCallExpression(initializer) &&
    isStaticRequireCall(initializer) &&
    builtinNameFromSpecifier(
      (initializer.arguments[0] as ts.StringLiteral).text,
    ) !== undefined
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
 * {@link MODULE_CONSTRUCTOR_MUTABLE_PROTOTYPE_MEMBERS}, reached DIRECTLY
 * or through an arbitrary `const`-alias chain of the `.prototype` value
 * itself (VT-307c-provenance-closure: `const proto = Module.prototype;
 * proto.require = hook;` was a reproduced end-to-end blocker -- it
 * silently redirects an ordinary, statically-resolvable `require()` --
 * that the predecessor of this function, requiring the assignment target
 * to be SYNTACTICALLY `<X>.prototype.<member>`, could never see). Mirrors
 * {@link isModuleConstructorLoader}'s own owner-resolution exactly,
 * applied to the assignment target instead of a call callee -- both now
 * resolve the owner expression through {@link resolveLoaderCapability}.
 */
function isModuleConstructorMutablePrototypeMember(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    MODULE_CONSTRUCTOR_MUTABLE_PROTOTYPE_MEMBERS.has(expr.name.text) &&
    resolvesToModulePrototype(expr.expression, context)
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
function isAmbientModulePathsArray(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "paths" &&
    isAmbientModuleInstance(expr.expression, context)
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
function isModuleLoaderPathArrayMutatingCall(
  expr: ts.Expression,
  context: LoaderClassificationContext,
): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ARRAY_MUTATING_METHODS.has(expr.name.text) &&
    isAmbientModulePathsArray(expr.expression, context)
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
  if (isAmbientModulePathsArray(target, context)) {
    return "loader_hook_mutation";
  }

  // Module-constructor-level loader/resolution member replacement.
  if (isModuleConstructorMutableStaticMember(target, context)) {
    return "loader_hook_mutation";
  }
  if (isModuleConstructorMutablePrototypeMember(target, context)) {
    return "loader_hook_mutation";
  }

  // Soundness-floor fallback: an unrecognized WRITE into an authoritative
  // capability's own member surface (directly, or through any alias
  // {@link isAuthoritativeCapabilityReceiver} recognizes) -- unless it is
  // the one explicitly-reviewed safe write (`module.exports = ...`, which
  // applies to the ambient-instance form -- direct OR aliased
  // (VT-307c-provenance-closure: `const mod = module; mod.exports = ...`
  // must stay exempt too, matching direct `module.exports = ...`, now
  // that {@link isAuthoritativeCapabilityReceiver} below resolves an
  // ambient-instance ALIAS as a receiver where it previously didn't --
  // never `.prototype.exports`, which isn't a real member).
  if (
    resolveLoaderCapability(target.expression, context)?.kind ===
      "module_instance" &&
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
      // VT-307c-builtin-closure Family G: a RE-EXPORT whose source is one
      // of the modeled loader/execution builtins -- `export { Module }
      // from "module"`, `export { createRequire } from "node:module"`,
      // `export * from "vm"`. Both spellings were reproduced end-to-end
      // as real invariant violations: the IMPORTING file sees only a
      // relative specifier (`./reexport.mjs`), so no builtin binding
      // exists there to resolve, and this file -- which does have the
      // builtin provenance -- previously skipped every re-export
      // outright via the `moduleSpecifier === undefined` guard above.
      // Both files were loaded and whole-file scanned; neither flagged.
      //
      // Deliberately does NOT inspect the exported NAMES: re-exporting
      // anything at all out of `module`/`vm`/`child_process`/
      // `worker_threads` hands a binding from a loader/execution builtin
      // to consumers this per-file classifier cannot see, and the
      // name-agnostic rule also covers `export * from`, which has no
      // names to inspect. Re-exporting from these four builtins is
      // vanishingly rare in real code (zero occurrences across the whole
      // validation corpus), so the conservative answer costs nothing
      // measurable.
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      builtinNameFromSpecifier(node.moduleSpecifier.text) !== undefined
    ) {
      record("loader_capability_escape", node);
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
