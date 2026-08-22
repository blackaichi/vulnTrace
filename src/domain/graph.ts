import type { Coverage } from "./coverage.js";

export type GraphNodeId = string;

/**
 * The kinds of code construct a call graph node can represent
 * (see docs/SDD.md § 18).
 */
export type GraphNodeKind =
  "function" | "method" | "constructor" | "callback" | "module";

export interface SourceLocation {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
}

/**
 * A single node in the call graph: a function, method, constructor,
 * callback, or module-level executable region (see docs/SDD.md § 18).
 */
export interface GraphNode {
  readonly id: GraphNodeId;
  readonly kind: GraphNodeKind;
  readonly module: string;
  readonly name?: string;
  readonly location?: SourceLocation;
}

/**
 * `"module_load"` (VT-307a) is deliberately distinct from every other
 * value here: it means "loading the `from` module causes the target
 * module's own top-level code to execute" -- a fact about the module
 * system, never a claim that a function was called. Every other value
 * (`"direct"`, `"method"`, `"constructor"`, `"callback"`, `"import"`)
 * represents an actual JS call/construct site, including `"import"`
 * itself, which means "a call whose callee was bound through an import,"
 * not "an import occurred." Consumers that render or reason about a
 * reachability path (e.g. AFFECTED evidence) MUST NOT describe a
 * `"module_load"` edge as a call -- see docs/REAL-WORLD-BENCHMARK-AUDIT-
 * V0.1.md's RWF-002 module-load-closure work.
 */
export type CallEdgeType =
  "direct" | "method" | "constructor" | "callback" | "import" | "module_load";

/**
 * Why a call could not be resolved to an exact target
 * (see docs/SDD.md § 18, § 21). Originally just the genuinely-dynamic JS
 * constructs; `unresolved_module` and `unresolved_target` were added by
 * TASK-018 (Call Graph) for two adjacent, equally-real uncertainty cases
 * that surface during graph construction: a statically-known import
 * specifier that could not be resolved to a file (e.g. an uninstalled
 * dependency), and a resolved module whose named export could not be
 * matched to a specific function definition. Kept on this same type
 * rather than a parallel one, since both are still "the call edge
 * resolution is uncertain, and must say why."
 */
export type DynamicCallReason =
  | "dynamic_member_access"
  | "dynamic_require"
  | "dynamic_import"
  | "eval"
  | "unresolved_module"
  | "unresolved_target"
  | "unsupported_construct"
  | "declaration_only_resolution"
  | "aliased_require"
  | "create_require"
  | "function_constructor"
  | "aliased_eval"
  | "module_require"
  | "module_internal_load"
  | "vm_execution"
  | "worker_execution"
  | "child_process_execution"
  | "loader_hook_mutation";

/**
 * Whether a {@link DynamicCallReason} widens the module-load closure --
 * i.e. whether the underlying construct could, at runtime, load or invoke
 * a module the call graph never discovered while it was built (see
 * docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 3, RWF-002/RWF-008; VT-300).
 *
 * Closure-widening (`true`): the construct can name or load an arbitrary
 * module at runtime that graph construction had no way to discover.
 * `dynamic_require`/`dynamic_import` can load literally any installed
 * module; `eval` can do anything, including calling `require` itself;
 * `unresolved_module` means the specifier itself could not even be
 * identified, so whatever module it names (or that module's own
 * transitive requires) is unknown by definition.
 *
 * Non-widening (`false`): the construct's uncertainty is bounded to
 * values/modules the graph already discovered. `unsupported_construct`
 * and `dynamic_member_access` can only ever reach a function value
 * already in scope, from a module already loaded; `unresolved_target`
 * means the module itself resolved successfully and only the specific
 * export lookup inside it failed.
 *
 * `declaration_only_resolution` (VT-304, RWF-005/R-4) is widening: it means
 * the specifier resolved only to a TypeScript declaration file (`.d.ts`/
 * `.d.cts`/`.d.mts`) -- type information with no executable function
 * bodies -- because no real runtime implementation could be identified
 * (see module-resolver.ts). Unlike `unresolved_target`, the module that
 * actually runs at runtime was never discovered or indexed at all, so
 * whatever it does (including further `require`/`import` calls) is exactly
 * as unknown as an `unresolved_module`. Treating it as bounded/non-widening
 * would let a body-less declaration file stand in as "this region was
 * fully analyzed and has no further edges" -- precisely the
 * confident-`unreachable` fabrication risk the audit identifies.
 *
 * `aliased_require`, `create_require`, `function_constructor`,
 * `aliased_eval`, and `module_require` (VT-307b) are all widening for the
 * same underlying reason as `dynamic_require`/`dynamic_import`/`eval`
 * themselves: each names a *different syntactic route* to the exact same
 * "load or execute arbitrary code at runtime" capability, which the VT-307
 * soundness review found `unsupported_construct` was silently swallowing
 * (or, for property-access forms rooted in a known global like `module`/
 * `process`/`globalThis`, not even producing an edge at all). Splitting
 * these out preserves `unsupported_construct`'s own precision for
 * constructs that genuinely cannot introduce a new module (see below) --
 * the fix is a more precise partition, not a blanket "make
 * `unsupported_construct` widening" retreat:
 * - `aliased_require`: `const r = require; r(x)` -- a local binding whose
 *   value is exactly the `require` function itself, called indirectly.
 *   Classified as widening regardless of whether `x` is a literal or
 *   dynamic (VT-307b deliberately does not attempt alias-aware static
 *   resolution of the literal case -- see call-graph.ts's own doc comment
 *   on this boundary).
 * - `create_require`: `require("module").createRequire(...)` (aliased or
 *   called inline) -- Node's own sanctioned way to mint a *new* `require`
 *   function at runtime; the same call-through-the-result risk as
 *   `aliased_require`.
 * - `function_constructor`: `Function(...)`/`new Function(...)` --
 *   compiles and can execute arbitrary generated source, which may itself
 *   call `require`/`import`. VT-307b classifies the construct itself as
 *   widening; it never inspects or executes the string argument.
 * - `aliased_eval`: `const e = eval; e(x)` or `globalThis.eval(x)` --
 *   indirect eval is still eval.
 * - `module_require`: `module.require(x)` / `process.mainModule.require(x)`
 *   / `require.main.require(x)` -- explicit alternate spellings of
 *   `require` reached through a property access on a known global, which
 *   the pre-VT-307b `KNOWN_GLOBAL_IDENTIFIERS` suppression let through
 *   with no edge at all (see call-graph.ts).
 *
 * VT-307c-fix-5 adds four more, all found by the VT-307d soundness
 * review's own final pass over remaining Node runtime primitives that can
 * load a module or execute generated code outside anything the graph
 * discovers, each requiring real provenance to the specific Node builtin
 * export it names (never a bare method/class name match -- see
 * loader-constructs.ts's `referencesBuiltinExport`):
 * - `module_internal_load`: `Module._load(x)` (`Module` provably bound to
 *   the real `module`/`node:module` builtin) -- Node's own loader
 *   primitive underneath `require()` itself, kept as its own reason rather
 *   than folded into `module_require`: it bypasses the ordinary `require`
 *   resolution machinery entirely, which is worth keeping visible in
 *   diagnostics as a materially different route.
 * - `vm_execution`: `vm.runInThisContext(code)` /
 *   `vm.runInNewContext(code)` / `vm.runInContext(code)` /
 *   `vm.compileFunction(code)` (`vm` provably bound to the real
 *   `vm`/`node:vm` builtin), and the equivalent `Script`-based form
 *   (`new vm.Script(code)` then `.runInThisContext()` /
 *   `.runInNewContext()` / `.runInContext()` on that same value) -- all
 *   compile and can execute arbitrary generated source, the same
 *   capability `function_constructor` already covers for `Function(...)`.
 *   Construction of a `vm.Script` alone is NOT widening (nothing executes
 *   until one of its own run methods is called); only the execution step
 *   is.
 * - `worker_execution`: `new Worker(file)` (`Worker` provably bound to the
 *   real `worker_threads`/`node:worker_threads` builtin) -- starts a
 *   genuinely separate execution context that can run application/package
 *   code VulnTrace does not model at all. A deliberate MVP product-scope
 *   decision, not an oversight: until worker/child execution contexts are
 *   modeled explicitly, a reachable one must prevent a confident
 *   package-absence conclusion, the same as any other unmodeled code path.
 * - `child_process_execution`: `child_process.fork(file)` (`fork` provably
 *   bound to the real `child_process`/`node:child_process` builtin) --
 *   the same execution-boundary reasoning as `worker_execution`. `exec`/
 *   `spawn` are deliberately NOT included: VT-307c-fix-5 scoped this to
 *   primitives that load and run a JavaScript FILE the way `fork` does;
 *   `exec`/`spawn` run an arbitrary OS command, not specifically
 *   JavaScript module code, and are out of scope for a future decision
 *   rather than an oversight here.
 *
 * VT-307c-fix-6's readiness review found five more authoritative Node
 * `Module`-constructor-level loading primitives sharing `module_internal_load`
 * (`Module.prototype.require`/`.prototype.load`, `module.constructor._load`,
 * `require("module").Module._load`, an instance's own `.load(path)`) --
 * see loader-constructs.ts's `resolvesToModuleConstructor` for the shared
 * provenance check all five converge on -- generalized `child_process`
 * coverage from `fork` alone to every authoritative launch API (`exec`,
 * `execSync`, `execFile`, `execFileSync`, `spawn`, `spawnSync`, in addition
 * to `fork`) under the explicit v0.1 policy that Node subprocess execution
 * is in scope and command/argument payloads are never inspected to guess
 * whether the child process is actually Node -- and adds one new reason:
 * - `loader_hook_mutation`: `require.extensions[ext] = hook` /
 *   `require.extensions.ext = hook` -- registering a custom compiler for
 *   `require()`'s own module-extension dispatch table. Unlike every other
 *   widening reason above, this is a MUTATION of the module-loading
 *   mechanism itself, not a call/construct that can load one more module:
 *   it changes what `require()` does for every SUBSEQUENT load of that
 *   extension. `require` is matched by literal ambient identifier only
 *   (the same VT-307b simplification already used for `module.require`),
 *   never a same-file `obj.extensions` unrelated to Node's module system.
 *   Deliberately closure-only (see `findClosureWideningConstructs`'s own
 *   doc comment): `CallGraph`'s `CallEdge`/`UnresolvedEdge` types are both
 *   inherently anchored to a call/construct SITE (`from: GraphNodeId`) --
 *   an assignment statement has no such site, so there is no call-graph
 *   edge shape this could ever populate without inventing a parallel,
 *   non-call diagnostic concept purely for this one construct. This is a
 *   deliberate, documented architectural boundary, not an oversight.
 *
 * This partition is normative (see the audit doc's § 3.3/§ 12) and MUST
 * NOT be changed silently: every current consumer
 * (`resolveTargetNodes`'s `confirmedAbsentInstance` guard, src/analysis
 * /verdict.ts) treats it as a soundness boundary, not a precision knob.
 * The exhaustive `switch` (no `default` case) is deliberate: adding a new
 * `DynamicCallReason` value without updating this function is a compile
 * error, not a silent misclassification.
 */
export function isClosureWideningReason(reason: DynamicCallReason): boolean {
  switch (reason) {
    case "dynamic_require":
    case "dynamic_import":
    case "eval":
    case "unresolved_module":
    case "declaration_only_resolution":
    case "aliased_require":
    case "create_require":
    case "function_constructor":
    case "aliased_eval":
    case "module_require":
    case "module_internal_load":
    case "vm_execution":
    case "worker_execution":
    case "child_process_execution":
    case "loader_hook_mutation":
      return true;
    case "unsupported_construct":
    case "dynamic_member_access":
    case "unresolved_target": {
      return false;
    }
  }
}

/**
 * A call edge either resolves to an exact node, or is explicitly
 * represented as uncertain. Dynamic constructs (`foo[method]()`,
 * `require(variable)`, `import(variable)`) must never fabricate exact
 * edges (see docs/SDD.md § 18, § 21).
 */
export type CallEdgeResolution =
  | { readonly kind: "resolved"; readonly target: GraphNodeId }
  | {
      readonly kind: "unknown";
      readonly reason: DynamicCallReason;
      readonly potentialTargets: readonly string[];
    };

export interface CallEdge {
  readonly from: GraphNodeId;
  readonly type: CallEdgeType;
  readonly resolution: CallEdgeResolution;
  readonly location?: SourceLocation;
}

/** The structure Reachability operates over (see docs/SDD.md § 18). */
export interface CallGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly CallEdge[];
}

export type ReachabilityState = "reachable" | "unreachable" | "unknown";

export interface UnresolvedEdge {
  readonly from: GraphNodeId;
  readonly reason: DynamicCallReason;
}

/**
 * The result of a reachability query. Modeled as a discriminated union on
 * `state` because the payload genuinely differs per case: only `reachable`
 * has a concrete `path`; only `unknown` carries `unresolvedEdges` (the
 * specific dynamic constructs that blocked a definite answer). This
 * mirrors docs/SDD.md § 20's requirement that the result include "path if
 * known" and "unresolved edges encountered" — i.e. these are conditionally
 * present, not always-empty placeholders. `unreachable` requires the
 * analysis to have positively established non-reachability with sufficient
 * coverage, never merely "no path was found" (see docs/SDD.md § 5, § 23).
 */
export type ReachabilityResult =
  | {
      readonly state: "reachable";
      readonly source: GraphNodeId;
      readonly target: GraphNodeId;
      readonly path: readonly GraphNodeId[];
      readonly coverage: Coverage;
    }
  | {
      readonly state: "unreachable";
      readonly source: GraphNodeId;
      readonly target: GraphNodeId;
      readonly blockers: readonly string[];
      readonly coverage: Coverage;
    }
  | {
      readonly state: "unknown";
      readonly source: GraphNodeId;
      readonly target: GraphNodeId;
      readonly blockers: readonly string[];
      readonly unresolvedEdges: readonly UnresolvedEdge[];
      readonly coverage: Coverage;
    };

/** See docs/SDD.md § 20. */
export interface ReachabilityEngine {
  analyze(
    graph: CallGraph,
    source: GraphNode,
    target: GraphNode,
  ): ReachabilityResult;
}

export function isCallResolved(
  resolution: CallEdgeResolution,
): resolution is Extract<CallEdgeResolution, { kind: "resolved" }> {
  return resolution.kind === "resolved";
}

export function isReachable(
  result: ReachabilityResult,
): result is Extract<ReachabilityResult, { state: "reachable" }> {
  return result.state === "reachable";
}
