import type { Coverage } from "./coverage.js";

export type GraphNodeId = string;

/**
 * The kinds of code construct a call graph node can represent
 * (see docs/SDD.md § 18).
 */
export type GraphNodeKind =
  "function" | "method" | "constructor" | "callback" | "accessor" | "module";

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
  /**
   * P1-B1 -- the eight measured frontend gaps that `unsupported_construct`
   * used to carry undifferentiated, plus the token itself, retained as
   * their runtime floor. Every one of them is NON-WIDENING and
   * `unmodeled_construct`, exactly as the single token was: the split
   * explains an UNKNOWN and moves no soundness boundary. See
   * `code-intelligence/unsupported-construct.ts` for what each one means
   * and how an occurrence is assigned to one.
   */
  | "unsupported_callee_binding"
  | "unsupported_receiver_binding"
  | "unsupported_this_receiver"
  | "unsupported_indexed_receiver"
  | "unsupported_call_result_receiver"
  | "unsupported_literal_receiver"
  | "unsupported_expression_receiver"
  | "unsupported_computed_callee"
  /**
   * Task A-3a (ADR 0008 § 3): a value that may carry the program's own
   * code -- a function, or an object whose methods a builtin may run --
   * escapes into code the graph does not model (an argument of a builtin
   * call at a position not admitted to the non-invoking allowlist, a value
   * stored on an ambient or builtin object, the arguments an implicit
   * constructor forwards to an ambient or builtin base), and the graph
   * cannot attribute it. `unmodeled_construct`, non-widening: the value is
   * already in scope, in a module already loaded.
   */
  | "escaped_value"
  /**
   * Task A-3b (AUD-02, ADR 0008 § 2's own-export row): a module calls (or
   * constructs) its own export through the CommonJS module-scope bindings,
   * `exports.x()`, `module.exports.x()`, `exports["x"]()`. Which function
   * the export holds at that moment is the export's complete write set
   * (lane E, ADR 0009): today's attribution sees neither in-module write
   * order nor the `exports` alias going stale after `module.exports = …`,
   * so it is no authority for a resolved edge yet (backlog BL-042).
   * `unmodeled_construct`, non-widening: the value is the module's own.
   */
  | "own_export_call"
  /**
   * Task A-3b (PRM-116, ADR 0008 § 2's JSX row): a JSX element or
   * fragment, compiled for the classic runtime, calls its factory
   * (`React.createElement`, a `jsxFactory`, an `@jsx` pragma), a binding
   * in scope the graph does not yet resolve (backlog BL-041).
   * `unmodeled_construct`, non-widening: the factory is a value already in
   * scope, in a module already loaded.
   */
  | "jsx_factory_call"
  /**
   * Task A-4 (ADR 0008 § 2's protocol-member row): a value the runtime may
   * invoke implicitly -- stored under a key that may be a protocol member
   * (`{ then: v }`, `o.toString = v`, `o[k] = v`, a protocol-named
   * getter's return value) -- that the graph cannot attribute.
   * `unmodeled_construct`, non-widening: the value is already in scope, in
   * a module already loaded (a loader handed over as a value is the
   * module-load closure's, `loader-constructs.ts`).
   */
  | "protocol_value"
  /**
   * Task A-3b (PRM-116, RWF-066): a JSX element or fragment whose compiled
   * form may LOAD a module the graph does not follow: the automatic
   * runtime's implicit `require("<jsxImportSource>/jsx-runtime")`, a
   * runtime this analyzer cannot determine (`jsx: preserve`, no project),
   * or a classic factory rooted in the module's own loader (`require`,
   * `module`). Widening, `capability_escape`; the module-load closure
   * records the same site (`loader-constructs.ts`).
   */
  | "jsx_runtime_load"
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
  | "loader_hook_mutation"
  | "loader_capability_escape";

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
 * The final VT-307d architecture review (VT-307c-capability-floor) found
 * that fixes 5-11's named reasons, however thorough, are still an
 * ENUMERATION: an authoritative loader capability (Node's `Module`
 * constructor, an ambient `module`/`require.main`/`process.mainModule`
 * instance, the ambient `require` function, or a `createRequire(...)`
 * result) used through a member this classifier does not yet name, or
 * passed/stored/returned/exported into a position where its provenance is
 * lost, silently preserved `complete: true` -- reproduced end-to-end with
 * NO unknown API name at all (`registry.loader = Module; registry.loader.
 * _load(...)` executed a genuinely-installed OUT package through members
 * every earlier fix already modeled). `loader_capability_escape` is the
 * resulting SOUNDNESS-FLOOR reason: "an authoritative loader capability
 * was used or lost track of in a way this classifier cannot prove safe."
 * It is deliberately the LAST-RESORT fallback, never the first match --
 * every named reason above still fires first and stays the precise,
 * diagnosable answer when the construct is one this classifier already
 * understands (see loader-constructs.ts's own capability-floor doc
 * comments for the exact precedence and the narrow read-only allowlist
 * that keeps ordinary, harmless `node:module` introspection quiet).
 *
 * This partition is normative (see the audit doc's § 3.3/§ 12) and MUST
 * NOT be changed silently: every current consumer
 * (`resolveTargetNodes`'s `confirmedAbsentInstance` guard, src/analysis
 * /verdict.ts) treats it as a soundness boundary, not a precision knob.
 *
 * EXHAUSTIVENESS AND FAIL-CLOSED BEHAVIOR (FOUNDATION-F2/F2-B).
 *
 * Two separate guarantees, which were previously conflated:
 *
 * 1. COMPILE TIME. Adding a `DynamicCallReason` without classifying it
 *    here is a build error. This already held -- a `switch` with no
 *    `default` and a declared `: boolean` return made an unhandled value
 *    fall off the end, which `strict` rejects ("Function lacks ending
 *    return statement"). It is now carried by an explicit
 *    {@link unclassifiedReasonFailsClosed} call taking `never`, which
 *    holds the same line but reports the ACTUAL offending value
 *    ("Argument of type '\"my_new_reason\"' is not assignable to
 *    parameter of type 'never'") instead of pointing at the closing brace.
 *
 * 2. RUNTIME. An unrecognized value at runtime is treated as WIDENING.
 *    This did NOT hold before. Falling off the end of the old `switch`
 *    returned `undefined`, which is falsy, so an unknown reason was
 *    silently classified NON-widening -- fail-OPEN in both consumers:
 *    `findClosureWideningConstructs` (loader-constructs.ts) skips
 *    recording a construct it considers non-widening, leaving the closure
 *    `complete`, and `hasReachableClosureWideningBlocker` (verdict.ts)
 *    finds no blocker among the unresolved edges. Either one lets a
 *    negative proof through on the strength of a construct nobody
 *    classified. Verified directly before the fix:
 *    `isClosureWideningReason("<unknown>")` returned `undefined`.
 *
 * The runtime half is defence in depth rather than a reachable production
 * path today: `DynamicCallReason` is internal and type-closed, produced
 * only by call-graph.ts and loader-constructs.ts, and no deserialization
 * boundary (the OSV cache included) carries one. That is a property of
 * today's code, not a guarantee about tomorrow's, and it costs one branch
 * to stop depending on it.
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
    case "loader_capability_escape":
    case "jsx_runtime_load":
      return true;
    // P1-B1: every `unsupported_*` subtype is non-widening for exactly the
    // reason the undifferentiated token was -- each one names a value that
    // is already in scope, in a module the graph already loaded, so none of
    // them can introduce a module graph construction never discovered.
    // Listed individually rather than matched by prefix deliberately: the
    // `never` floor below only stays load-bearing while every reason is
    // named, and a prefix test would silently absorb a future
    // `unsupported_*` token that nobody had classified.
    case "unsupported_construct":
    case "unsupported_callee_binding":
    case "unsupported_receiver_binding":
    case "unsupported_this_receiver":
    case "unsupported_indexed_receiver":
    case "unsupported_call_result_receiver":
    case "unsupported_literal_receiver":
    case "unsupported_expression_receiver":
    case "unsupported_computed_callee":
    case "dynamic_member_access":
    case "unresolved_target":
    case "own_export_call":
    case "jsx_factory_call":
    case "protocol_value":
    case "escaped_value": {
      // Task A-3a, `escaped_value`: the escaped value is already in scope,
      // in a module the graph already loaded; a builtin running it cannot
      // introduce a module graph construction never discovered. (A builtin
      // that LOADS code is a loader construct, classified before any
      // escape is considered.)
      return false;
    }
    default:
      return unclassifiedReasonFailsClosed(reason);
  }
}

/**
 * The fail-closed floor for {@link isClosureWideningReason}
 * (FOUNDATION-F2/F2-B).
 *
 * Takes `never`, so it only typechecks when every `DynamicCallReason` has
 * already been classified -- adding one without a `case` makes THIS call
 * the compile error, naming the unclassified value.
 *
 * Returns `true` at runtime, where no static guarantee applies. An
 * unrecognized reason is one nobody has reasoned about, and the only safe
 * assumption about an unreasoned-about construct is that it can widen the
 * module-load closure: that answer withdraws a negative proof, which costs
 * precision, where `false` would grant one on no evidence, which costs
 * soundness. Deliberately does NOT throw -- these consumers run inside a
 * scan whose contract is that uncertainty becomes UNKNOWN rather than an
 * exception (the same rule `buildFinding` follows for an untrusted
 * `AnalysisProofContext`), and crashing an end user's scan over an
 * internal enum slip would be strictly worse than the conservative verdict
 * the analyzer already knows how to produce.
 */
function unclassifiedReasonFailsClosed(reason: never): boolean {
  void reason;
  return true;
}

/**
 * A call edge either resolves to an exact node, may invoke a known node,
 * or is explicitly represented as uncertain. Dynamic constructs
 * (`foo[method]()`, `require(variable)`, `import(variable)`) must never
 * fabricate exact edges (see docs/SDD.md § 18, § 21).
 *
 * - `resolved`: an authority proved that the call site invokes exactly
 *   `target` whenever it runs (ADR 0008 § 1, invariant A2).
 * - `possible` (ADR 0008 § 1, task A-2): the program MAY invoke `target`
 *   here, and nothing proves that it does -- an escaped function value
 *   handed to code the graph does not model, a JSX component, a protocol
 *   member, an accessor body. Reachability traverses it: the code behind
 *   it is searched and its own unknown edges count against family C's
 *   completeness. It is never part of an AFFECTED path, and a target
 *   reached only through `possible` edges is UNKNOWN (SOUNDNESS-CONTRACT
 *   § 1 and § 3; ADR 0008 Decision 2; `analysis/reachability.ts`).
 * - `unknown`: which function, if any, is invoked is not established.
 *
 * WHAT BINDS A PRODUCER OF A `possible` EDGE. Nothing in this type can
 * check these, so they are stated here and in REMEDIATION-PLAN § 5a
 * ("A-2 additions to lane-A acceptance"):
 *
 * 1. Only for an over-approximated invocation ADR 0008 § 2 names, and
 *    only when the invoked value is attributable to `target`. An
 *    unattributable value gets an `unknown` edge (§ 3), never a
 *    `possible` edge to a guess.
 * 2. The target's file is walked exactly as it would be for a resolved
 *    edge. Reachability reads "no outgoing edges" as "searched, and calls
 *    nothing"; a `possible` edge into a body the graph never walked would
 *    make an unsearched region look complete, which is how a false family
 *    C would appear.
 * 3. Never where the language guarantees the call: that is `resolved`,
 *    with its authority (decorators, implicit `super`, documented
 *    invoking builtins; ADR 0008 § 4).
 */
export type CallEdgeResolution =
  | { readonly kind: "resolved"; readonly target: GraphNodeId }
  | { readonly kind: "possible"; readonly target: GraphNodeId }
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

/**
 * ADR 0008 invariant A1 (task A-1): every invocation-capable site in a
 * walked file yields an ACCOUNT, and there is no silent outcome. The
 * producers (`call-graph.ts`'s invocation-site handlers) return this
 * closed union rather than `CallEdge | undefined`, so a branch that
 * forgets to account for a site is a type error, not a missing edge.
 *
 * - `edges`: one or more call edges, each resolved, possible or unknown.
 *   Task A-2 added the `possible` kind (ADR 0008 § 1); task A-3a is its
 *   first producer (escaped function values, ADR 0008 § 2's escape row).
 * - `no_edge`: the site gets no edge, and a {@link NoEdgeProof} from ADR
 *   0008 § 2's closed set says why none is needed.
 * - `unproven_no_edge`: the site gets no edge, AND nothing proves that is
 *   sound. See {@link UnprovenNoEdgeReason}.
 *
 * ADR 0008 § 2 closes the set of no-edge proofs (`AmbientStaticRequire`,
 * `PrimitiveOnlyArguments`, `NonInvokingBuiltin`, `ProvablyDeadBranch`).
 * Task A-3a made the two builtin ones real; the other two are still
 * unproven reasons below (`static_require_by_text`,
 * `constant_folded_branch`, both task A-5's).
 */
export type InvocationAccount =
  | {
      readonly kind: "edges";
      readonly edges: readonly [CallEdge, ...CallEdge[]];
    }
  | {
      readonly kind: "no_edge";
      readonly proof: NoEdgeProof;
    }
  | {
      readonly kind: "unproven_no_edge";
      readonly reason: UnprovenNoEdgeReason;
    };

/**
 * Why a call of a known builtin (`code-intelligence/builtin-callables.ts`)
 * needs no edge (ADR 0008 § 2's closed no-edge proofs; task A-3a). Both
 * hold only for a callee PROVEN to be the builtin: an ambient global whose
 * root name no enclosing scope declares, or a builtin module's export
 * reached through the binder's own declaration authority -- never a name
 * that merely looks like one. `builtin` is the behaviour key
 * (`"call global:Array.isArray"`, `"call module:path:join"`).
 *
 * - `primitive_only_arguments`: every argument is provably primitive, so
 *   the builtin is handed nothing that can carry the program's own code.
 * - `non_invoking_builtin`: every argument is primitive or sits at a
 *   position admitted to the non-invoking allowlist (mechanically, by
 *   `tests/oracle/builtin-admission.test.ts`), and no argument is an
 *   attributable function (the escape row would give that one an edge,
 *   and it takes precedence over every admitted position).
 *
 * Each variant's owner test is in `call-graph.invocation-account.test.ts`.
 */
export type NoEdgeProof =
  | { readonly kind: "primitive_only_arguments"; readonly builtin: string }
  | { readonly kind: "non_invoking_builtin"; readonly builtin: string };

/**
 * The no-edge branches the graph still takes WITHOUT a proof, each named
 * by the certified decision it comes from. They are open soundness
 * defects, not exceptions: each is reproduced as a false NOT_AFFECTED in
 * `tests/validation/FINDINGS.md`, and each is removed by a named lane-A
 * task ({@link UNPROVEN_NO_EDGE_LEDGER}). ADR 0008's end state is that
 * this type is empty.
 *
 * VT-201's exemption of ambient globals is gone: task A-3a accounted for
 * the ambient and builtin callees (removing `builtin_module_callee`, VT-305)
 * and narrowed the rest to `module_scope_callee`, the CommonJS module-scope
 * roots, which task A-3b removed (AUD-02: an own-export call is an
 * `own_export_call` unknown edge; any other call through `module` or
 * `require` a `loader_capability_escape` one).
 *
 * - `static_require_by_text` (P1-B3b): `require("x")` recognised by its
 *   spelling, not by proving `require` is the ambient one; a local
 *   `function require` is never seen. `AmbientStaticRequire` needs that
 *   lexical proof.
 * - `constant_folded_branch` (VT-211): a site in the branch an `if` whose
 *   condition `evaluateConstantBoolean` folds never takes. Strict equality
 *   of same-type literals is a proof; the loose `==`/`!=` folding it also
 *   performs is not, so the account as a whole is unproven until the two
 *   are separated.
 */
export type UnprovenNoEdgeReason =
  "static_require_by_text" | "constant_folded_branch";

/**
 * Who owns each {@link UnprovenNoEdgeReason}: the open findings it is the
 * mechanism of, and the lane-A task (ADR 0008 § 8) that removes it.
 * `call-graph.invocation-account.test.ts` requires every finding named
 * here to still be OPEN, so closing one without deleting its reason --
 * or deleting a reason while its finding stays open -- fails a test.
 */
export const UNPROVEN_NO_EDGE_LEDGER: Readonly<
  Record<
    UnprovenNoEdgeReason,
    {
      readonly closedBy: "A-5";
      readonly findings: readonly [string, ...string[]];
    }
  >
> = {
  static_require_by_text: { closedBy: "A-5", findings: ["PRM-15"] },
  constant_folded_branch: { closedBy: "A-5", findings: ["PRM-14"] },
};

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
      /**
       * Present exactly when the search reached the target, but only
       * through at least one `possible` edge: no all-resolved path exists
       * in the searched region. A witness path from source to target, one
       * or more of whose hops is a `possible` edge. It is NEVER an AFFECTED
       * path (SOUNDNESS-CONTRACT § 1); it is why this result is `unknown`,
       * and the uncertainty it carries is `possible_invocation` (ADR 0008
       * § 3). `unresolvedEdges` may be empty when this is present.
       */
      readonly possibleOnlyPath?: readonly GraphNodeId[];
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
