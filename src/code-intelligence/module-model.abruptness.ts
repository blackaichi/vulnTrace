/**
 * Abrupt completion: whether an expression, a statement header, a class
 * element or a call of a local callable definitely cannot complete normally,
 * and the callee summaries that answer it.
 *
 * Split out of `module-model.ts` by concern, as a pure move (task BL-121):
 * the declarations below are those of that file, unchanged and in its order.
 * `module-model.ts` re-exports the public ones.
 */
import ts from "typescript";
import { unwrapParentheses } from "./commonjs-reexports.js";
import {
  mayContainNestedStatements,
  isAssignmentOperatorToken,
} from "./module-model.syntax.js";
import { topLevelCallableCandidates } from "./module-model.module-scope.js";
import {
  isAsyncOrGeneratorCallable,
  ownStatementsOf,
  resolveExactLocalCallable,
  resolveInvocationTargetIdentity,
} from "./module-model.local-callables.js";
import type { LocalCallable } from "./module-model.local-callables.js";

/**
 * The three-way answer to "how does executing this ONE statement, in
 * isolation, end" (RWF-016) — the primitive
 * {@link cannotCompleteNormally} is built out of:
 *
 * - `"throws"` — every path through this statement ends in an uncaught
 *   `throw`; the statement never returns and never falls through.
 * - `"returns"` — at least one path reaches a `return`, which is a NORMAL
 *   completion for the function's caller (see RWF-016's case D/E in
 *   tests/validation/FINDINGS.md): a definitely-abrupt determination must
 *   refuse the instant one of these is reachable, regardless of what else
 *   the body contains.
 * - `"normal"` — neither of the above is proven: the statement may fall
 *   through to whatever follows it. This is also the conservative default
 *   for every construct this relation does not model (loops, `switch`,
 *   plain expressions/declarations) — see {@link cannotCompleteNormally}'s
 *   doc comment for why looping constructs in particular are deliberately
 *   never classified any other way.
 */
type AbruptOutcome = "throws" | "returns" | "normal";

/**
 * Merges the two outcomes of an `if`/`else` pair (RWF-016). A `"returns"`
 * on EITHER side wins outright — a reachable `return` is a normal
 * completion for the caller no matter which branch it is in. Otherwise the
 * statement is `"throws"` only if BOTH sides are, and `"normal"`
 * otherwise (at least one side may fall through).
 */
function mergeAbruptOutcomes(
  a: AbruptOutcome,
  b: AbruptOutcome,
): AbruptOutcome {
  if (a === "returns" || b === "returns") {
    return "returns";
  }
  if (a === "throws" && b === "throws") {
    return "throws";
  }
  return "normal";
}

/**
 * {@link AbruptOutcome} for one statement (RWF-016). Recurses only through
 * the handful of constructs this relation actually models — `throw`,
 * `return`, a block, an `if`/`else`, a `try`/`catch` with no `finally`,
 * and a labeled statement (unwrapped to the statement it labels, since a
 * label alone changes nothing about how the statement itself completes).
 *
 * Before any of that, the positions the statement NECESSARILY evaluates
 * are asked (BL-066, RWF-097): an expression statement's expression, a
 * declarator's initializer, an `if`/`switch`/`while` header, a `for`
 * initializer and test, a `for`-`of`/`in` right-hand side — the module
 * scope's own MUST relation ({@link statementHeaderCannotCompleteNormally}),
 * asked at this body's depth — and a `return`'s expression. A
 * definitely-abrupt call in any of them means the statement throws before
 * it can complete or transfer control: `ok(bail());`, `const v = bail();`,
 * `if (bail()) {}` and `return bail();` are each `"throws"`, exactly as a
 * literal `throw` written in their place. RWF-028 had read only the bare
 * invocation statement (`bail();`).
 *
 * Everything else — loops, `switch`, plain expression/variable statements
 * whose required positions prove nothing, `debugger`, an empty statement,
 * a `try` WITH a `finally` — answers `"normal"` by construction: "this
 * relation proves nothing about how it completes, so the next statement
 * decides". That is NOT neutral when the construct contains a `return`
 * (`for (;;) { return 1; } ok(bail());` completes under real Node, yet a
 * later throw decides `"throws"`): it over-claims abruptness. An earlier
 * version of this comment called it "the safe default either way". It is
 * the fail-closed direction — an over-claimed throw withdraws a later
 * write's authority, toward `UNKNOWN` — and it is deliberately kept:
 * answering `"returns"` for every construct that MIGHT return would also
 * drop proofs real Node confirms (`for (const x of []) { return 1; }
 * bail();` throws). A precision cost, RWF-099 (BL-066).
 *
 * `depth` is the number of callable bodies entered; it is what keeps the
 * recursion bounded — see {@link callableAlwaysThrows}.
 */
function classifyAbruptOutcome(
  statement: ts.Statement,
  depth: number,
): AbruptOutcome {
  if (ts.isThrowStatement(statement)) {
    return "throws";
  }
  if (statementHeaderCannotCompleteNormally(statement, depth)) {
    return "throws";
  }
  if (ts.isReturnStatement(statement)) {
    // The expression is evaluated BEFORE control returns: `return bail();`
    // never returns.
    return statement.expression !== undefined &&
      expressionCannotCompleteNormally(statement.expression, 0, depth)
      ? "throws"
      : "returns";
  }
  if (ts.isBlock(statement)) {
    return classifyAbruptSequence(statement.statements, depth);
  }
  if (ts.isIfStatement(statement)) {
    const thenOutcome = classifyAbruptOutcome(statement.thenStatement, depth);
    const elseOutcome = statement.elseStatement
      ? classifyAbruptOutcome(statement.elseStatement, depth)
      : "normal";
    return mergeAbruptOutcomes(thenOutcome, elseOutcome);
  }
  if (ts.isTryStatement(statement)) {
    // A `finally` can override any completion inside the `try`/`catch`
    // (a `return`/absence of a throw in `finally` swallows an exception
    // entirely) — reasoning about that safely is more control-flow work
    // than RWF-016 is scoped to build, so a `finally` refuses outright.
    if (statement.finallyBlock !== undefined) {
      return "normal";
    }
    const tryOutcome = classifyAbruptSequence(
      statement.tryBlock.statements,
      depth,
    );
    if (statement.catchClause === undefined) {
      return tryOutcome;
    }
    // When the `try` block is not proven to throw on every path
    // (`"returns"` or `"normal"`), its outcome is taken as the statement's.
    // The `catch` can still run on a path that throws, and may return
    // there (`try { maybe(); } catch { return 1; } bail();` completes when
    // `maybe` throws): an over-claim in the fail-closed direction, kept for
    // the reason the doc comment above gives. An earlier version of this
    // comment said the `catch` "only ever runs when the try block throws
    // on every path", which is false; RWF-099 (BL-066).
    if (tryOutcome !== "throws") {
      return tryOutcome;
    }
    return classifyAbruptSequence(
      statement.catchClause.block.statements,
      depth,
    );
  }
  if (ts.isLabeledStatement(statement)) {
    return classifyAbruptOutcome(statement.statement, depth);
  }
  return "normal";
}

/**
 * {@link AbruptOutcome} for a LIST of statements executed in order
 * (RWF-016) — a function body, a block, a `try`/`catch` arm. Walks the
 * list once: the first statement that forces `"throws"` or `"returns"`
 * decides the whole sequence (nothing after it can change that a path
 * through the sequence reaches it), and a statement that answers
 * `"normal"` simply means execution may continue to the next one. Reaching
 * the end of the list without either means the sequence may fall off the
 * end — an implicit `return undefined` — so the sequence itself is
 * `"normal"`.
 */
function classifyAbruptSequence(
  statements: readonly ts.Statement[],
  depth: number,
): AbruptOutcome {
  for (const statement of statements) {
    const outcome = classifyAbruptOutcome(statement, depth);
    if (outcome !== "normal") {
      return outcome;
    }
  }
  return "normal";
}

/**
 * Whether `fn`'s body, on EVERY modeled execution path, propagates an
 * abrupt completion (a `throw`) to its caller — never returns, never falls
 * off its own end (RWF-016). This is the callee-side half of RWF-016's
 * proof obligation; {@link resolveExactLocalCallable} is the call-site
 * half establishing exact identity, and {@link isDefinitelyAbruptCallStatement}
 * is where the two meet.
 *
 * `false` — never `true` by omission — for every function this relation
 * does not have a definite proof for, including:
 *
 * - a conditional throw with no matching abrupt `else`/rethrow (`if
 *   (flag) throw err;` with nothing after, or with normal code after);
 * - any `return`, reachable on any path, anywhere in the body — a
 *   `return` is what the CALLER experiences as a normal completion, so a
 *   `bail` that sometimes returns can never poison a later export
 *   (`if (flag) return; throw err;` is NOT abrupt — see
 *   {@link classifyAbruptOutcome}'s `"returns"` handling);
 * - a `try`/`catch` whose `catch` does not itself always rethrow, or that
 *   has a `finally`;
 * - a `while (true) {}` or any other loop that never returns for an
 *   entirely different reason (never terminating) — deliberately NOT
 *   inferred as abrupt. This relation proves abrupt completion from
 *   SYNTAX (an uncaught `throw` reachable on every path), never from
 *   nontermination, which would require reasoning this relation
 *   deliberately does not attempt (see RWF-016's remaining-limitations
 *   note in tests/validation/FINDINGS.md);
 * - an `async`/generator function ({@link isAsyncOrGeneratorCallable}).
 *
 * An arrow with a CONCISE body is read like any other (BL-066): its body
 * is an expression the call must evaluate, so it is asked RWF-026's
 * required-position question. An earlier version of this comment said
 * `() => expr` is "trivially never abrupt" and the body was never read;
 * that was false (`() => bail()` always throws), and a live false
 * `NOT_AFFECTED`, RWF-096.
 *
 * Asked with NO arguments supplied, so every default parameter
 * initializer counts as evaluated: this is the per-file gate's question
 * ({@link fileHasDefinitelyAbruptCallable}), "can SOME invocation of `fn`
 * be proven abrupt?", and the call that supplies nothing is the one under
 * which the most is evaluated. An invocation asks with its own count
 * ({@link isDefinitelyAbruptInvocation}).
 */
function cannotCompleteNormally(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): boolean {
  return callableAlwaysThrows(fn, 0, 0);
}

/**
 * How many CALLABLE BODIES deep {@link callableAlwaysThrows} will chase a
 * definitely-abrupt call before refusing (RWF-028).
 *
 * The number counts bodies entered, not calls written, and the budget is
 * spent as follows:
 *
 * ```text
 * bail();                    -- 1 body  (bail)                RWF-016, unchanged
 * viaHelper(); { bail(); }   -- 2 bodies (viaHelper -> bail)   one wrapper hop
 * h2(); { helper(); }        -- 3 bodies (h2 -> helper -> bail) two wrapper hops
 * h3(); { h2(); }            -- 4 bodies                        REFUSED
 * ```
 *
 * Two wrapper hops is a deliberate, documented bound rather than a
 * judgement about real code: each hop's proof is literally the same proof
 * (an exactly-resolved local callable whose every modeled path throws),
 * so admitting the second costs nothing in reasoning and the third buys
 * nothing that a bound has to be drawn somewhere anyway. What this is NOT
 * is an interprocedural summary fixpoint: there is no worklist, no
 * iteration to convergence, and no cross-file propagation — just a
 * counter that runs out, plus {@link callablesInProgress} to stop a
 * self- or mutually-recursive body from being chased at all.
 *
 * The bound is not free: `h3();` above really does throw under real Node,
 * so the refusal is a live false `NOT_AFFECTED`, RWF-098 (backlog
 * `BL-068`), measured by BL-066. The bound still carries the cost where
 * the memo cannot ({@link callableAlwaysThrows}): an answer computed
 * inside a recursion is never stored, and without the bound a recursive
 * call graph is re-read exponentially (BL-066's mutation test of the
 * depth threading never finished).
 */
const MAX_CALLABLE_ABRUPT_SUMMARY_DEPTH = 3;

/**
 * The callable bodies {@link callableAlwaysThrows} is CURRENTLY inside.
 *
 * Re-entering a body already on this set answers `false` outright, so a
 * recursive or mutually-recursive callable is refused rather than
 * summarized, and the summary terminates.
 *
 * An earlier version of this comment justified the refusal by saying
 * `function helper() { helper(); }` "never throws either — it exhausts the
 * stack". That premise is false: V8 throws
 * `RangeError: Maximum call stack size exceeded`, a catchable throw
 * (measured by BL-066), so the module stops there exactly as at a `throw`.
 * The refusal is therefore a live false `NOT_AFFECTED`, RWF-098 (backlog
 * `BL-068`), not a deliberate nontermination boundary.
 */
const callablesInProgress = new Set<ts.Node>();

/**
 * {@link cannotCompleteNormally}'s bounded recursive core (RWF-028).
 *
 * `depth` is the number of callable bodies already entered on the way
 * here; `0` is a call written at module scope. `async`/generator callables
 * are refused before anything is read. Then, in the order the language
 * evaluates them (BL-066):
 *
 * 1. the default parameter initializers the invocation runs
 *    ({@link evaluatedDefaultParameterCannotCompleteNormally}), given the
 *    number of arguments it supplies (`suppliedArguments`; `undefined`
 *    when a spread makes it unknowable);
 * 2. the body: a block through {@link classifyAbruptSequence}, a concise
 *    body as an expression through RWF-026's required-position walk.
 *
 * Either one proven abrupt is enough: a default that throws ends the call
 * before the body runs, and a default that completes lets the body run.
 *
 * **Memoized where no recursion was refused (BL-066).** Without a memo
 * the summary is recomputed along every call path, so a file whose
 * callables call K others costs on the order of K³ body reads per
 * callable, and the per-file gate asks it of every callable in the file —
 * measured by BL-066 on its base at 5 s (standalone) for a 42 KB file of
 * bare call statements, and far worse once every required position is
 * read. An answer is cached, per callable, depth and effective argument
 * count, only when its computation met NO {@link callablesInProgress}
 * refusal anywhere inside (an answer computed inside a recursion that did
 * meet one depends on what was in progress, and is not stored). The
 * in-progress check still comes first, so a callable is never answered
 * from the cache while its own body is being read.
 *
 * What a stored answer is: a SOUND one, built only from proof steps on the
 * source text — every `true` is a valid proof that the invocation cannot
 * complete normally. It is not always the answer a fresh query would give:
 * a sub-answer served from the cache can hide a cycle a fresh query would
 * refuse, and a truer sub-answer can turn a `try`/`catch` from `"throws"`
 * into the catch's `"returns"` ({@link classifyAbruptOutcome} is not
 * monotone there), so an answer can depend on the order queries were made
 * in. That order is fixed for a given file, so a scan is deterministic.
 *
 * Inside a recursion nothing is stored, so there the cost is bounded only
 * by {@link MAX_CALLABLE_ABRUPT_SUMMARY_DEPTH} (polynomial in the fan-out,
 * not linear); call-site resolution is memoized separately
 * ({@link resolveInvocationTargetIdentity}), so no call site is resolved
 * twice. {@link calleeSummaryEvaluationCount} counts the reads that are not
 * answered from the cache, for the structural performance test.
 */
function callableAlwaysThrows(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  depth: number,
  suppliedArguments: number | undefined,
): boolean {
  if (depth >= MAX_CALLABLE_ABRUPT_SUMMARY_DEPTH) {
    return false;
  }
  if (isAsyncOrGeneratorCallable(fn)) {
    return false;
  }
  const body = fn.body;
  if (body === undefined) {
    return false;
  }
  if (callablesInProgress.has(fn)) {
    calleeSummaryRecursionRefusals += 1;
    return false;
  }

  // Supplying at least as many arguments as there are parameters, and an
  // unknowable count, both run no default: one answer.
  const effectiveArguments = Math.min(
    suppliedArguments ?? fn.parameters.length,
    fn.parameters.length,
  );
  const key = `${depth}:${effectiveArguments}`;
  let cache = calleeSummaryCache.get(fn);
  const cached = cache?.get(key);
  if (cached !== undefined) {
    return cached;
  }

  calleeSummaryEvaluations += 1;
  const refusalsBefore = calleeSummaryRecursionRefusals;
  let result: boolean;
  callablesInProgress.add(fn);
  try {
    const bodyDepth = depth + 1;
    result =
      evaluatedDefaultParameterCannotCompleteNormally(
        fn,
        effectiveArguments,
        bodyDepth,
      ) ||
      (ts.isBlock(body)
        ? classifyAbruptSequence(body.statements, bodyDepth) === "throws"
        : expressionCannotCompleteNormally(body, 0, bodyDepth));
  } finally {
    callablesInProgress.delete(fn);
  }

  if (calleeSummaryRecursionRefusals === refusalsBefore) {
    if (cache === undefined) {
      cache = new Map();
      calleeSummaryCache.set(fn, cache);
    }
    cache.set(key, result);
  }
  return result;
}

/** {@link callableAlwaysThrows}'s exact answers, per callable; see its doc comment. */
const calleeSummaryCache = new WeakMap<ts.Node, Map<string, boolean>>();

/** How many times {@link callablesInProgress} has refused a re-entry. */
let calleeSummaryRecursionRefusals = 0;

let calleeSummaryEvaluations = 0;

/**
 * How many callee summaries have been computed rather than answered from
 * the cache (BL-066). Exposed so a test can assert the cost grows with the
 * number of callables, not with the number of call paths — see
 * {@link callableAlwaysThrows}.
 */
export function calleeSummaryEvaluationCount(): number {
  return calleeSummaryEvaluations;
}

/**
 * Whether invoking `fn` with `suppliedArguments` arguments necessarily
 * evaluates a default parameter initializer that cannot complete normally
 * (BL-066, RWF-097).
 *
 * A parameter's initializer runs when its argument is `undefined`, which
 * is certain for every parameter at or beyond the number of arguments
 * supplied — measured under real Node v22 for
 * `function dp(a, b = bail())`: `dp()`, `dp(1)` and `` dp`x` `` (one
 * argument, the strings array) throw; `dp(1, 2)` completes. An argument
 * that is supplied but evaluates to `undefined` runs the default too; this
 * relation does not claim it (no value semantics), which only costs
 * precision. A spread argument (`dp(...xs)`) makes the count unknowable,
 * and nothing is claimed.
 *
 * Positions are counted over RUNTIME parameters: a TypeScript `this`
 * parameter is erased by compilation and shifts nothing
 * (`function f(this: T, b = bail())` compiles to `function f(b = bail())`).
 * A rest parameter has no initializer and ends the list. A destructuring
 * PATTERN's own nested defaults depend on the value destructured and are
 * not read; only a parameter's own initializer is.
 *
 * The initializer is asked RWF-026's required-position question at the
 * callee's body depth, from its own position, so a name in it resolves
 * through the parameter scope ({@link scopeDeclares} sees the callee's
 * parameters; its body's declarations are not ancestors of a parameter):
 * in `function sh(bail, b = bail())`, `bail` is the parameter and nothing
 * is proven.
 */
function evaluatedDefaultParameterCannotCompleteNormally(
  fn: LocalCallable,
  suppliedArguments: number | undefined,
  depth: number,
): boolean {
  if (suppliedArguments === undefined) {
    return false;
  }
  let position = 0;
  for (const parameter of fn.parameters) {
    if (isTypeScriptThisParameter(parameter)) {
      continue;
    }
    if (parameter.dotDotDotToken !== undefined) {
      return false;
    }
    if (
      position >= suppliedArguments &&
      parameter.initializer !== undefined &&
      expressionCannotCompleteNormally(parameter.initializer, 0, depth)
    ) {
      return true;
    }
    position += 1;
  }
  return false;
}

/** A TypeScript `this` parameter: a type annotation only, erased at runtime. */
function isTypeScriptThisParameter(
  parameter: ts.ParameterDeclaration,
): boolean {
  return ts.isIdentifier(parameter.name) && parameter.name.text === "this";
}

/**
 * How many arguments `invocation` supplies to its callee (BL-066):
 * `undefined` when a spread argument makes the count unknowable.
 *
 * ```text
 * f(a, b)        -- 2
 * f(...xs)       -- unknowable
 * tag`a${x}b`    -- 2: the strings array, then one per substitution
 * new C          -- 0: no argument list at all
 * ```
 */
function suppliedArgumentCount(
  invocation:
    ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression,
): number | undefined {
  if (ts.isTaggedTemplateExpression(invocation)) {
    return (
      1 +
      (ts.isTemplateExpression(invocation.template)
        ? invocation.template.templateSpans.length
        : 0)
    );
  }
  const args = invocation.arguments ?? [];
  return args.some(ts.isSpreadElement) ? undefined : args.length;
}

/**
 * Whether evaluating `expression` — exactly as written, with no
 * surrounding operator or branch to get in the way — necessarily invokes a
 * callee this file's own text proves can only ever throw (RWF-016's
 * proof, factored out by RWF-017 so both call POSITIONS can share it).
 *
 * As RWF-016 wrote it, only a directly-written `CallExpression` with a
 * plain identifier callee qualified; RWF-028 widened the callee to the
 * shapes {@link resolveInvocationTargetIdentity} resolves and added a
 * construction, and BL-065 a tagged template (see
 * {@link isDefinitelyAbruptInvocation}). The table below is RWF-016's
 * original one. `unwrapParentheses` is applied first because parentheses
 * change nothing about evaluation:
 *
 * ```text
 * bail()                   -- qualifies, when resolveExactLocalCallable +
 *                             cannotCompleteNormally both prove out
 * (bail())                 -- qualifies: parentheses are transparent
 * obj.bail()               -- refused: not a plain identifier callee
 * registry[name]()         -- refused: not a plain identifier callee
 * flag && bail()           -- refused: the call may not be evaluated
 * flag ? bail() : other    -- refused: the call may not be evaluated
 * foo(bail())              -- refused: see the note below
 * (bail(), value)          -- refused: see the note below
 * ```
 *
 * The last two ARE evaluated under ordinary JS evaluation order, but
 * recognising them means walking arbitrary expression trees with a real
 * evaluation-order model rather than a shape test, and getting that
 * subtly wrong in the permissive direction is exactly the failure this
 * relation exists to prevent. They are deliberately left unmodeled and
 * recorded as precision limitations in tests/validation/FINDINGS.md.
 *
 * `bail?.()` is NOT special-cased, and needs no special case: the optional
 * call short-circuits only on a nullish callee, and
 * {@link resolveExactLocalCallable} only ever returns a hoisted local
 * function declaration or a never-reassigned `const`-bound function
 * expression — neither of which can be nullish at the call site. The call
 * therefore always happens, exactly as the plain form does.
 */
function isDefinitelyAbruptCall(expression: ts.Expression): boolean {
  return isDefinitelyAbruptInvocation(expression, 0);
}

/**
 * {@link isDefinitelyAbruptCall}'s depth-carrying form, and the ONE place
 * RWF-028 widens what counts as a definitely-abrupt invocation.
 *
 * Two invocation kinds are recognised, and each asks
 * {@link resolveInvocationTargetIdentity} the same question — "which
 * exact local function node does this syntax provably invoke?" — before
 * asking anything at all about what invoking it does:
 *
 * ```text
 * bail()        alias()      h.bail()       -- a CALL
 * bail`x`       alias`x`     h.bail`x`      -- a CALL, by a tagged template (BL-065)
 * new bail()    new alias()  new h.bail()   -- a CONSTRUCT
 * ```
 *
 * The two differ in exactly one way, and it is the reason they are not
 * collapsed: `[[Call]]` runs the body of anything callable, while
 * `[[Construct]]` exists only on a CONSTRUCTABLE function. An arrow,
 * an `async` function and a generator each have no `[[Construct]]` at
 * all, so `new` on one throws a `TypeError` WITHOUT EVER ENTERING THE
 * BODY — verified under real `node` v22 for all three. That is still a
 * non-completing module evaluation, but for a reason that has nothing to
 * do with the body this relation reads, so claiming it here would be
 * claiming a proof this relation did not perform. It is refused instead,
 * and recorded as a characterised limitation in
 * tests/validation/FINDINGS.md.
 *
 * `async`/generator are refused on the CALL side too, for RWF-016's own
 * reason ({@link isAsyncOrGeneratorCallable}): calling one returns a
 * rejected promise or an unstarted generator, never a synchronous throw.
 * That refusal is now reached through a resolver that also resolves
 * aliases and object members, so `const alias = asyncBail; alias();` is
 * refused by the same single test rather than by three separate ones.
 */
function isDefinitelyAbruptInvocation(
  expression: ts.Expression,
  depth: number,
): boolean {
  const unwrapped = unwrapParentheses(expression);

  if (ts.isCallExpression(unwrapped)) {
    const target = resolveExactLocalCallable(unwrapped.expression);
    if (target === undefined) {
      return false;
    }
    return callableAlwaysThrows(
      target,
      depth,
      suppliedArgumentCount(unwrapped),
    );
  }

  // BL-065 (RWF-095): a tagged template CALLS its tag -- the tag, then
  // every substitution, is evaluated, and then the tag is invoked with
  // `[[Call]]` exactly as `bail(["x"])` would be. Same identity proof,
  // same `async`/generator refusal, same body proof as a call.
  if (ts.isTaggedTemplateExpression(unwrapped)) {
    const target = resolveExactLocalCallable(unwrapped.tag);
    if (target === undefined) {
      return false;
    }
    return callableAlwaysThrows(
      target,
      depth,
      suppliedArgumentCount(unwrapped),
    );
  }

  if (ts.isNewExpression(unwrapped)) {
    const target = resolveInvocationTargetIdentity(unwrapped.expression);
    if (target === undefined || !isConstructableCallable(target)) {
      return false;
    }
    return callableAlwaysThrows(
      target,
      depth,
      suppliedArgumentCount(unwrapped),
    );
  }

  return false;
}

/**
 * Whether `new fn()` would actually ENTER `fn`'s body (RWF-028).
 *
 * Only an ordinary, non-`async`, non-generator `function` — declaration
 * or expression — has a `[[Construct]]` internal method. Arrows, `async`
 * functions and generators do not, and `new` on one of them throws
 * `TypeError: X is not a constructor` before the body runs. Since
 * {@link resolveInvocationTargetIdentity} only ever returns one of those
 * three node kinds, this test is exact rather than approximate.
 */
function isConstructableCallable(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): boolean {
  return (
    (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) &&
    !isAsyncOrGeneratorCallable(fn)
  );
}

/**
 * Whether this file declares ANY module-top-level callable that
 * {@link cannotCompleteNormally} proves can only ever throw (RWF-026) —
 * the cheap per-file gate {@link necessarilyEvaluatesAbruptly} opens with.
 *
 * {@link isDefinitelyAbruptCall} can only ever answer `true` for a call
 * whose callee resolves to one of {@link topLevelCallableCandidates}'
 * entries, so a file with no always-throwing candidate provably has no
 * definitely-abrupt call ANYWHERE in it, in any expression position. That
 * makes this test exactly complete rather than merely close, and it is
 * what keeps RWF-026's recursion off the hot path: the expression walk
 * below is only ever entered for a file that has something for it to
 * find. On the scan-performance suite's worst case (9,001 top-level
 * statements of object literals and call expressions, none of them
 * throwing callables) it is one cached pass over `sourceFile.statements`
 * and an `O(1)` answer per expression thereafter.
 *
 * Cached per source file, like every other module-model fact.
 */
const hasDefinitelyAbruptCallableBySourceFile = new WeakMap<
  ts.SourceFile,
  boolean
>();

function fileHasDefinitelyAbruptCallable(sourceFile: ts.SourceFile): boolean {
  const cached = hasDefinitelyAbruptCallableBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }

  let found = false;
  for (const candidate of topLevelCallableCandidates(sourceFile).values()) {
    if (cannotCompleteNormally(candidate)) {
      found = true;
      break;
    }
  }
  if (!found) {
    found = moduleReachableCallableCandidates(sourceFile).some((candidate) =>
      cannotCompleteNormally(candidate),
    );
  }

  hasDefinitelyAbruptCallableBySourceFile.set(sourceFile, found);
  return found;
}

/**
 * Every callable RWF-028 can RESOLVE that lives in a module-reachable
 * statement scope — the top level included, and crucially the scopes
 * below it, which is where C10's block-scoped bindings live:
 *
 * ```js
 * { const bail = () => { throw new Error("boom"); }; bail(); }
 * ```
 *
 * {@link fileHasDefinitelyAbruptCallable}'s completeness argument is that
 * a file with no always-throwing candidate provably has no
 * definitely-abrupt call in it. RWF-028 made a second place a candidate
 * can live, so the gate has to look there too or it would short-circuit
 * C10 to `false` before any of the new resolution ran.
 *
 * The walk is the same cheap statement-position walk
 * {@link reassignedModuleReachableNames} uses, and stops at function
 * bodies for the same reason: a callable declared inside one is not a
 * module-reachable binding, and RWF-028 does not resolve into one.
 */
const moduleReachableCallableCandidatesBySourceFile = new WeakMap<
  ts.SourceFile,
  readonly LocalCallable[]
>();

function moduleReachableCallableCandidates(
  sourceFile: ts.SourceFile,
): readonly LocalCallable[] {
  const cached = moduleReachableCallableCandidatesBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }

  const found: LocalCallable[] = [];

  function collect(statements: readonly ts.Statement[]): void {
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && statement.body !== undefined) {
        found.push(statement);
      } else if (
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
      ) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            !ts.isIdentifier(declaration.name) ||
            declaration.initializer === undefined
          ) {
            continue;
          }
          const initializer = unwrapParentheses(declaration.initializer);
          if (
            ts.isFunctionExpression(initializer) ||
            ts.isArrowFunction(initializer)
          ) {
            found.push(initializer);
            continue;
          }
          // A callable written INLINE as an object-literal property value
          // is a shape {@link objectLiteralPropertyCallable} can return,
          // so the gate has to be able to see it too — otherwise whether
          // `h.run()` is provable would depend on some UNRELATED throwing
          // callable existing elsewhere in the file, which is precisely
          // the file-level inference this task must not make.
          if (ts.isObjectLiteralExpression(initializer)) {
            for (const property of initializer.properties) {
              if (!ts.isPropertyAssignment(property)) {
                continue;
              }
              const value = unwrapParentheses(property.initializer);
              if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) {
                found.push(value);
              }
            }
          }
        }
      }
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isFunctionLike(node)) {
      return;
    }
    const statements = ownStatementsOf(node);
    if (statements !== undefined) {
      collect(statements);
    }
    if (mayContainNestedStatements(node) || ts.isSourceFile(node)) {
      ts.forEachChild(node, visit);
    }
  }
  visit(sourceFile);

  moduleReachableCallableCandidatesBySourceFile.set(sourceFile, found);
  return found;
}

/**
 * How deep {@link necessarilyEvaluatesAbruptly} will recurse through
 * nested expression operands before REFUSING (RWF-026). Real source never
 * comes close — the TypeScript parser itself recurses over the same
 * nesting — and refusing is the sound direction, so this is a boundedness
 * guarantee rather than a semantic rule.
 */
const MAX_EXPRESSION_EVALUATION_DEPTH = 100;

/**
 * Whether NORMAL COMPLETION of `expression` — evaluated exactly where it
 * is written — REQUIRES first performing a call
 * {@link isDefinitelyAbruptCall} has already proven can only ever throw
 * (RWF-026).
 *
 * This is the one semantic addition RWF-026 makes, and it is deliberately
 * narrow: it does not widen WHICH calls can be proven abrupt (that stays
 * {@link isDefinitelyAbruptCall}'s exact-local-callee proof, RWF-016's,
 * shared verbatim and never re-derived here) — it widens only WHERE such
 * an already-proven call is necessarily evaluated.
 *
 * **The soundness rule, stated once.** An expression completes normally
 * only if every operand position the language REQUIRES it to evaluate
 * completes normally first. So if any REQUIRED operand cannot complete
 * normally, neither can the enclosing expression — and, crucially, that
 * conclusion needs no evaluation-ORDER model at all:
 *
 * ```js
 * safe() + bail()   // to complete, `safe()` AND `bail()` must both
 *                   // complete; `bail()` cannot; so the `+` cannot.
 * ```
 *
 * Either the earlier operand completed normally (so the abrupt one is
 * reached and throws) or it did not (so the expression never completes
 * either way). Both readings agree, which is why this predicate can be a
 * simple recursion over REQUIRED positions rather than an interpreter.
 * The same argument RWF-017's {@link declarationListCannotCompleteNormally}
 * already makes for a declarator list, generalised to operands.
 *
 * **"Required" is the entire content of this relation.** A position is
 * required only when the enclosing expression cannot complete normally
 * WITHOUT evaluating it. A `&&`'s right operand is not required (the
 * expression completes fine on a falsy left); a conditional's arms are not
 * required; a function or method BODY is not required (nothing here
 * invokes it). Every kind below is listed with which of its children are
 * required and which are refused, and an unlisted kind is refused
 * wholesale by the final `return false` — this relation is `true` only
 * where it has a proof, never `true` by omission.
 *
 * **Supported kinds, with the required positions for each:**
 *
 * ```text
 * (e)                        -- e                     (parentheses are transparent)
 * e as T | e satisfies T     -- e                     (TS type-only wrappers, erased at runtime)
 * e! | <T>e                  -- e
 * { k: e }                   -- every computed KEY, every property VALUE,
 *                               every SPREAD operand; NOT a method/accessor body
 * [e, , f]                   -- every element and spread operand; holes evaluate nothing
 * f(a, b)                    -- the CALLEE expression, then every ARGUMENT
 * new C(a)                   -- the constructor expression, then every ARGUMENT
 * `${e}`                     -- every substitution
 * tag`${e}`                  -- the TAG expression, then every substitution
 * e.x                        -- e            (the receiver; never the property name)
 * e[i]                       -- e, then i    (`i` refused inside an optional chain)
 * ...e                       -- e
 * a, b                       -- a and b      (a comma needs both to complete)
 * a + b, a === b, a in b ...  -- a and b     (every non-short-circuiting binary operator)
 * a && b | a || b | a ?? b   -- a ONLY       (b is not required -- see below)
 * c ? a : b                  -- c ONLY       (neither arm is required)
 * !e, -e, typeof e, void e,  -- e
 *   delete e, e++, ++e, await e
 * x = e                      -- the LHS REFERENCE's own sub-expressions, then e
 * x += e (and every other     -- the LHS REFERENCE's own sub-expressions, then e
 *   arithmetic/bitwise form)
 * x ||= e | x &&= e | x ??= e -- the LHS REFERENCE only; `e` is NOT required
 * ```
 *
 * **Explicitly refused, each for a stated reason.** Refused means "not
 * NECESSARILY evaluated", never "not a cutoff": every refused position that
 * is still evaluated at module time is a cutoff through
 * {@link mayEndModuleEvaluation}'s MAY check (BL-063, RWF-050). An earlier
 * version of this comment said the refused positions keep a later
 * export's authority; for a module-time position that was false, and it
 * was a live false `NOT_AFFECTED`.
 *
 * - **A logical operator's RIGHT operand** (`flag && bail()`). It runs
 *   only for some values of the left operand, and this relation has no
 *   value semantics to decide which — so the expression CAN complete
 *   normally and no MUST claim may be made.
 * - **A conditional expression's ARMS** (`flag ? bail() : safe()`, and
 *   `flag ? bail() : other()` alike). Neither arm is required. Joining two
 *   independently-abrupt arms into one proof is multi-path completion
 *   reasoning, deliberately out of scope here.
 * - **A logical ASSIGNMENT's right-hand side** (`z ||= bail()`). Same
 *   short-circuit as the logical operators: `||=`/`&&=`/`??=` evaluate the
 *   RHS only for some current values of the target.
 * - **Anything inside a FUNCTION** — a function expression, an arrow
 *   (concise body included), a method/getter/setter body, a default
 *   parameter. Writing one evaluates nothing; calling it is a decision
 *   made later, possibly by an importer, possibly never. This is the same
 *   line {@link mayEndModuleEvaluation} draws by stopping at every
 *   function-like node, and the reason `const f = () => bail();` and
 *   `function f(x = bail()) {}` keep a later export's authority.
 * - **A `class` expression's body.** Class-definition-time evaluation is
 *   RWF-018/019/020/022's, reached through
 *   {@link mayEndModuleEvaluation}'s own walk with their own predicates;
 *   folding it in here would duplicate those proofs with different
 *   semantics. In particular an INSTANCE field initializer
 *   (`class C { f = bail(); }`) is per-CONSTRUCTION, not module time, and
 *   is not reachable from this relation at all.
 * - **Positions guarded by an OPTIONAL CHAIN.** In `a?.b(bail())` and
 *   `a?.[bail()]` the argument and index are skipped entirely when `a` is
 *   nullish, so neither is required. The receiver of every link IS
 *   required and is still descended into. (`bail?.()` itself is a
 *   different matter and is already handled by
 *   {@link isDefinitelyAbruptCall}: the optional call short-circuits only
 *   on a nullish CALLEE, and {@link resolveExactLocalCallable} only ever
 *   resolves a hoisted function declaration or a never-reassigned
 *   `const`-bound function expression, neither of which can be nullish.)
 * - **A destructuring ASSIGNMENT TARGET** (`({ [k()]: x } = src)`). The
 *   pattern's own evaluation has semantics this relation does not model,
 *   and refusing it also keeps RWF-025's reassignment-provenance question
 *   — a different question about the same syntax — untouched.
 * - **Every other kind**, by the closing `return false`.
 *
 * Note what is NOT here: no constant folding, no value symbolisation, no
 * alias resolution, no member-callee resolution, no transitive call
 * summaries, no `new` -expression callee abruptness, no `ts.forEachChild`
 * "contains a call somewhere" shortcut. A generic child traversal would
 * happily walk into a `&&`'s right operand or an arrow's body and is
 * precisely the class of mistake this switch exists to make impossible.
 */
function necessarilyEvaluatesAbruptly(expression: ts.Expression): boolean {
  if (!fileHasDefinitelyAbruptCallable(expression.getSourceFile())) {
    return false;
  }
  return expressionCannotCompleteNormally(expression, 0, 0);
}

/**
 * {@link necessarilyEvaluatesAbruptly}'s walk, without the per-file gate.
 * `depth` bounds the expression nesting; `callableDepth` is the number of
 * callable bodies entered on the way here (`0` at module scope), which
 * every invocation the walk reaches is asked at — so the callee summary
 * ({@link callableAlwaysThrows}) can ask this same question of a body, a
 * concise body or a default parameter, inside the depth bound it already
 * spends (BL-066). The summary must not go through the gate: the gate is
 * computed BY the summary.
 */
function expressionCannotCompleteNormally(
  expression: ts.Expression,
  depth: number,
  callableDepth: number,
): boolean {
  if (depth > MAX_EXPRESSION_EVALUATION_DEPTH) {
    return false;
  }
  // The one place a proof is ESTABLISHED; everything below only decides
  // whether a child position is required. Handles its own parentheses.
  if (isDefinitelyAbruptInvocation(expression, callableDepth)) {
    return true;
  }

  const required = (child: ts.Expression): boolean =>
    expressionCannotCompleteNormally(child, depth + 1, callableDepth);

  // Evaluation-transparent wrappers: parentheses and TS's type-only forms,
  // none of which exist at runtime.
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isExpressionWithTypeArguments(expression)
  ) {
    return required(expression.expression);
  }

  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.some((property) => {
      if (ts.isSpreadAssignment(property)) {
        return required(property.expression);
      }
      // The computed KEY of ANY element form runs while the literal is
      // built, methods and accessors included — RWF-024's rule, reached
      // here for a literal nested inside a larger expression.
      if (
        property.name !== undefined &&
        ts.isComputedPropertyName(property.name) &&
        required(property.name.expression)
      ) {
        return true;
      }
      // The VALUE, and only for a property assignment: a method's,
      // getter's or setter's body is a function body and runs nothing
      // now. A shorthand (`{ x }`) is an identifier read.
      return (
        ts.isPropertyAssignment(property) && required(property.initializer)
      );
    });
  }

  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.some(
      (element) => !ts.isOmittedExpression(element) && required(element),
    );
  }

  if (ts.isSpreadElement(expression)) {
    return required(expression.expression);
  }

  if (ts.isCallExpression(expression)) {
    // The callee expression is evaluated before any argument is, whether
    // or not the call short-circuits.
    if (required(expression.expression)) {
      return true;
    }
    if (ts.isOptionalChain(expression)) {
      return false;
    }
    return expression.arguments.some(required);
  }

  if (ts.isNewExpression(expression)) {
    // ARGUMENTS are evaluated before construction begins, so an abrupt one
    // means the `new` never completes. Whether calling the CONSTRUCTOR
    // itself is abrupt is a different question this relation does not ask:
    // `new bail()` reaches only the identifier `bail` here, never a
    // `CallExpression`, and is correctly refused.
    if (required(expression.expression)) {
      return true;
    }
    return expression.arguments?.some(required) ?? false;
  }

  if (ts.isTemplateExpression(expression)) {
    return expression.templateSpans.some((span) => required(span.expression));
  }

  if (ts.isTaggedTemplateExpression(expression)) {
    // The tag is evaluated first, then every substitution — and all of
    // them before the tag is ever CALLED, which is why nothing needs to be
    // known about the tag function itself HERE. Whether CALLING the tag is
    // abrupt is {@link isDefinitelyAbruptCall}'s question, asked above
    // (BL-065, RWF-095).
    if (required(expression.tag)) {
      return true;
    }
    return (
      ts.isTemplateExpression(expression.template) &&
      expression.template.templateSpans.some((span) =>
        required(span.expression),
      )
    );
  }

  if (ts.isPropertyAccessExpression(expression)) {
    // Only the RECEIVER; the property NAME is not an evaluated expression.
    // Sound inside an optional chain too: every link's receiver is
    // evaluated before that link can short-circuit.
    return required(expression.expression);
  }

  if (ts.isElementAccessExpression(expression)) {
    if (required(expression.expression)) {
      return true;
    }
    if (ts.isOptionalChain(expression)) {
      return false;
    }
    return required(expression.argumentExpression);
  }

  if (
    ts.isPrefixUnaryExpression(expression) ||
    ts.isPostfixUnaryExpression(expression)
  ) {
    return required(expression.operand);
  }

  if (
    ts.isTypeOfExpression(expression) ||
    ts.isVoidExpression(expression) ||
    ts.isDeleteExpression(expression) ||
    ts.isAwaitExpression(expression)
  ) {
    return required(expression.expression);
  }

  if (ts.isConditionalExpression(expression)) {
    // The CONDITION only. Neither arm is required — see this relation's
    // doc comment.
    return required(expression.condition);
  }

  if (ts.isBinaryExpression(expression)) {
    return binaryCannotCompleteNormally(expression, depth, callableDepth);
  }

  return false;
}

/**
 * {@link expressionCannotCompleteNormally} for a `BinaryExpression`, split
 * out because its three operator families have three different answers to
 * "which operand is required" (RWF-026).
 */
function binaryCannotCompleteNormally(
  expression: ts.BinaryExpression,
  depth: number,
  callableDepth: number,
): boolean {
  const required = (child: ts.Expression): boolean =>
    expressionCannotCompleteNormally(child, depth + 1, callableDepth);
  const operator = expression.operatorToken.kind;

  // Short-circuiting operators: the LEFT operand always runs, the right
  // one only for some left values this relation cannot know.
  if (
    operator === ts.SyntaxKind.AmpersandAmpersandToken ||
    operator === ts.SyntaxKind.BarBarToken ||
    operator === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return required(expression.left);
  }

  if (isAssignmentOperatorToken(operator)) {
    // The TARGET REFERENCE is resolved before the right-hand side is
    // evaluated — `obj[bail()] = v` and `bail().x = v` both throw without
    // ever reaching the RHS — so its own sub-expressions are required for
    // every assignment form alike.
    if (
      assignmentReferenceCannotCompleteNormally(
        expression.left,
        depth,
        callableDepth,
      )
    ) {
      return true;
    }
    // LOGICAL assignment reads the target first and evaluates the RHS only
    // when that read says to: `z ||= bail()` never calls `bail` for a
    // truthy `z`. Not required, and not knowable here.
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      operator === ts.SyntaxKind.BarBarEqualsToken ||
      operator === ts.SyntaxKind.QuestionQuestionEqualsToken
    ) {
      return false;
    }
    return required(expression.right);
  }

  // Everything else — arithmetic, comparison, bitwise, `instanceof`, `in`,
  // and the comma operator — evaluates BOTH operands unconditionally, so
  // either one being abrupt is enough (see the ordering note in
  // {@link necessarilyEvaluatesAbruptly}).
  return required(expression.left) || required(expression.right);
}

/**
 * The sub-expressions an ASSIGNMENT TARGET must itself evaluate in order
 * to produce a reference, and whether any of them is definitely abrupt
 * (RWF-026).
 *
 * ```text
 * z = v            -- an identifier target evaluates nothing
 * obj[bail()] = v  -- the index expression is required
 * bail().x = v     -- the receiver is required
 * ({ x } = src)    -- a destructuring PATTERN: refused wholesale
 * ```
 *
 * Refusing patterns is deliberate on both counts: their evaluation has
 * semantics this relation does not model, and RWF-025 asks a DIFFERENT
 * question about that same syntax (which names a destructuring assignment
 * genuinely reassigns) whose answer must not be perturbed from here.
 */
function assignmentReferenceCannotCompleteNormally(
  target: ts.Expression,
  depth: number,
  callableDepth: number,
): boolean {
  const unwrapped = unwrapParentheses(target);
  const required = (child: ts.Expression): boolean =>
    expressionCannotCompleteNormally(child, depth + 1, callableDepth);

  if (ts.isPropertyAccessExpression(unwrapped)) {
    return required(unwrapped.expression);
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    return (
      required(unwrapped.expression) ||
      (!ts.isOptionalChain(unwrapped) && required(unwrapped.argumentExpression))
    );
  }
  return false;
}

/**
 * Whether executing `list` — the declaration list of a `const`/`let`/`var`
 * statement — necessarily invokes a definitely-abrupt local callee before
 * the declaration can complete (RWF-017).
 *
 * A declarator's INITIALIZER is evaluated as part of executing the
 * declaration, so the call in `const x = bail();` happens whenever the
 * statement is reached — the same execution fact RWF-016 already relies on
 * for `bail();`, in a different syntactic position. Which is the whole
 * point: abrupt module-evaluation behavior is a property of execution
 * semantics, not of whether the `CallExpression` happens to be wrapped in
 * an `ExpressionStatement`.
 *
 * Declarators are scanned LEFT TO RIGHT, which is the order the language
 * evaluates them in, and the FIRST one whose initializer is proven
 * definitely abrupt answers the whole statement:
 *
 * ```text
 * const a = bail(), b = safe();          -- abrupt: `a`'s initializer throws
 * const a = safe(), b = bail(), c = x();  -- abrupt: `b` is reached only if
 *                                            `a` completed normally, and
 *                                            then `b` throws, so `c` never
 *                                            runs either way
 * let x;                                  -- no initializer: nothing is
 *                                            evaluated, keep scanning
 * const a = safe();                       -- not PROVEN abrupt: may fall
 *                                            through, keep scanning
 * ```
 *
 * The middle case is the one worth stating explicitly, because it is why
 * scanning left to right needs no expression evaluator: every declarator
 * before the abrupt one either completed normally (so the abrupt one is
 * reached and throws) or was itself abrupt (so the statement never
 * completes either way). Both readings agree, so the statement cannot
 * complete normally without needing to know which one holds.
 *
 * A binding PATTERN is fine too — `const { x } = bail();` and
 * `const [x] = bail();` both evaluate the right-hand side before any
 * destructuring happens, and only the right-hand side is inspected here.
 * Nothing about destructuring semantics is modeled beyond that guaranteed
 * RHS evaluation.
 */
function declarationListCannotCompleteNormally(
  list: ts.VariableDeclarationList,
  callableDepth: number,
): boolean {
  for (const declaration of list.declarations) {
    if (
      declaration.initializer !== undefined &&
      expressionCannotCompleteNormally(
        declaration.initializer,
        0,
        callableDepth,
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `node` is a class STATIC FIELD whose initializer necessarily
 * invokes a definitely-abrupt local callee, so that evaluating the
 * enclosing class ends module evaluation rather than completing (RWF-018).
 *
 * ```js
 * class C { static x = bail(); }   // qualifies
 * const C = class { static x = bail(); };  // qualifies -- same evaluation
 * class C { x = bail(); }          // does NOT qualify: instance field
 * class C { static x; }            // does NOT qualify: no initializer
 * ```
 *
 * **Why a static field is module-evaluation time.** Evaluating a class
 * DEFINITION — a declaration or an expression alike — runs each static
 * element in declaration order as part of that evaluation, static blocks
 * and static field initializers together. So a `class` sitting at module
 * scope executes its static field initializers during module evaluation,
 * exactly as a `static { ... }` block does, and a throw out of one
 * propagates out of the class definition and out of the `require()` that
 * started the load. Nothing below the class runs — including a later
 * `module.exports = safeOp`, which a cyclic importer therefore never sees.
 *
 * **Why an INSTANCE field is not.** An instance field initializer is
 * installed on the class and evaluated per-INSTANCE, during construction.
 * Evaluating `class C { x = bail(); }` defines `C` and runs nothing;
 * `bail()` executes only if someone later writes `new C()`, which is a
 * caller's decision made after this module finished loading — the same
 * reason {@link mayEndModuleEvaluation} skips function bodies. Conflating
 * the two would withdraw authority from exports that really are reached.
 *
 * **Ordering needs no model.** {@link firstModuleEvaluationCutoff} records
 * the enclosing top-level STATEMENT's start, so which static field throws
 * — first, middle or last — cannot change the answer: static elements run
 * in declaration order, every one of them during this same class
 * definition, and any abrupt one means the class definition does not
 * complete. `static a = safe(); static b = bail(); static c = later();`
 * and `static a = bail(); static b = safe();` therefore agree, with no
 * intra-class control-flow graph.
 *
 * Everything about the CALL is RWF-016/017's, reused verbatim through
 * {@link isDefinitelyAbruptCall}: the exact non-reassigned local callee
 * ({@link resolveExactLocalCallable}), the always-throws body proof
 * ({@link cannotCompleteNormally}), the `async`/generator exclusions, and
 * the parentheses normalization that makes `static x = (bail());` work.
 * A caught class-evaluation throw is likewise handled by the existing
 * {@link isCaughtWithin} at the call site in {@link mayEndModuleEvaluation}
 * — `try { class C { static x = bail(); } } catch {}` keeps a later
 * export's authority, and a rethrowing `catch` withdraws it.
 *
 * Only the field's INITIALIZER is inspected, and only when it is that call
 * written directly. A COMPUTED KEY (`static [bail()] = 1`) is deliberately
 * NOT recognised here even though it is also evaluated at class-definition
 * time: computed keys evaluate for instance members and methods too, which
 * makes them a different rule with a different scope — RWF-019's
 * {@link isDefinitelyAbruptComputedClassElementKey}, which covers every
 * class element rather than being folded in behind a static-field name.
 * Nor is an initializer the call merely
 * appears somewhere inside (`static x = foo(bail())`, `[bail()]`,
 * `` `${bail()}` ``) — that is the same arbitrary-expression-evaluation
 * boundary {@link isDefinitelyAbruptCall} already draws and documents.
 */
function isDefinitelyAbruptStaticFieldInitializer(node: ts.Node): boolean {
  return (
    ts.isPropertyDeclaration(node) &&
    node.initializer !== undefined &&
    ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ===
      true &&
    necessarilyEvaluatesAbruptly(node.initializer)
  );
}

/**
 * Whether `node` is a class element whose COMPUTED PROPERTY NAME
 * necessarily invokes a definitely-abrupt local callee, so that evaluating
 * the enclosing class ends module evaluation rather than completing
 * (RWF-019).
 *
 * ```js
 * class C { static [bail()] = 1; }     // qualifies
 * class C { [bail()] = 1; }            // qualifies -- NOT static, and that is the point
 * class C { [bail()]() {} }            // qualifies
 * class C { static [bail()]() {} }     // qualifies
 * class C { get [bail()]() {} }        // qualifies
 * class C { set [bail()](v) {} }       // qualifies
 * const C = class { [bail()] = 1; };   // qualifies -- same evaluation
 * class C { x = bail(); }              // does NOT qualify: instance field VALUE (RWF-018's line)
 * class C { m() { bail(); } }          // does NOT qualify: method BODY
 * class C { bail() {} }                // does NOT qualify: not a computed key
 * ```
 *
 * **Why a computed key is class-DEFINITION time, whatever the element is.**
 * A computed property name is evaluated by ClassDefinitionEvaluation, in
 * declaration order, as each element is defined — the key has to exist
 * before the element can be installed on the class or its prototype. That
 * is true for every element form, because installing ANY of them needs a
 * property key: a static field, an instance field, a method, a getter, a
 * setter, an `async` method, a generator method. So a class sitting at
 * module scope evaluates every computed key it writes during module
 * evaluation, and a throw out of one propagates out of the class
 * definition and out of the `require()` that started the load. Nothing
 * below the class runs — including a later `module.exports = safeOp`,
 * which a cyclic importer therefore never sees.
 *
 * **This is exactly what makes RWF-019 a different rule from RWF-018, not
 * a widening of it.** RWF-018's static/instance distinction is about WHEN
 * the VALUE runs, and it is real:
 * `class C { x = bail(); }` defines `C` and runs nothing, because an
 * instance field initializer is stored and executed per-INSTANCE during
 * construction. The KEY of that very same element is a separate
 * expression in a separate position, and it runs immediately either way:
 * `class C { [bail()] = 1; }` throws at definition time even though
 * `class C { x = bail(); }` does not. Requiring `static` here — the shape
 * test {@link isDefinitelyAbruptStaticFieldInitializer} correctly
 * applies to INITIALIZERS — would therefore miss the majority of the
 * family. Both facts are proven in one real `node` process in
 * fixtures/commonjs-circular-import-computed-class-key-throw-ground-truth/.
 *
 * The same reasoning is why a METHOD's or ACCESSOR's deferred body is
 * untouched by this: `[bail()]() { ... }` executes `bail()` when the class
 * is defined and the BODY only when someone calls the method, and this
 * predicate reads the name node alone. {@link mayEndModuleEvaluation}'s
 * function-like stop still skips the body; this test is simply asked
 * before that stop, since a `MethodDeclaration` IS function-like.
 *
 * **Ordering needs no model**, for the same reason RWF-018 needed none:
 * {@link firstModuleEvaluationCutoff} records the enclosing top-level
 * STATEMENT's start, so which computed key throws — first, middle or last
 * — cannot change the answer. Keys evaluate in declaration order, every
 * one of them during this same class definition, so
 * `[safe()] = 1; [bail()] = 2; [later()] = 3;` needs no intra-class
 * control-flow graph: the class definition does not complete either way.
 *
 * Scope is deliberately narrow in three directions:
 *
 * - only a genuine `ts.ComputedPropertyName` counts, read off the AST.
 *   `class C { bail() {} }` and `class C { "bail()" = 1; }` are ordinary
 *   names and are not computed keys, whatever their text looks like;
 * - only class elements count. The parent must be a `ClassDeclaration` or
 *   `ClassExpression`, which is what excludes an OBJECT LITERAL's computed
 *   key (`{ [bail()]: 1 }`) and its methods — `MethodDeclaration` is the
 *   same node KIND in both. An object literal's computed key is now its
 *   own rule, {@link isDefinitelyAbruptComputedObjectLiteralKey} (RWF-024),
 *   evaluated by a different ECMAScript abstract operation (constructing an
 *   object, not defining a class) and kept structurally separate rather
 *   than merged into this one;
 * - only the key expression written DIRECTLY as that call qualifies, via
 *   {@link isDefinitelyAbruptCall} — which also gives RWF-019 the
 *   parentheses normalization that makes `[(bail())]` work, the exact
 *   non-reassigned local callee ({@link resolveExactLocalCallable}), the
 *   always-throws body proof ({@link cannotCompleteNormally}) and the
 *   `async`/generator exclusions, all reused verbatim. `[foo(bail())]`,
 *   `` [`${bail()}`] `` and `[(bail(), "x")]` are all evaluated at
 *   runtime and all deliberately unrecognised: that is the same
 *   arbitrary-expression-evaluation boundary RWF-017 recorded, and
 *   `[flag && bail()]` / `[flag ? bail() : "x"]` show why it is not safe
 *   to guess past it — those genuinely may not call `bail` at all.
 *
 * A caught class-evaluation throw is handled by the existing
 * {@link isCaughtWithin} at the call site in {@link mayEndModuleEvaluation},
 * exactly as for RWF-018: `try { class C { [bail()] = 1; } } catch {}`
 * keeps a later export's authority, and a rethrowing `catch` withdraws it.
 * A class DEFINED inside a function/method/arrow body is never offered to
 * this predicate at all, because that walk stops at function-like nodes
 * before reaching it — the class definition is deferred until the enclosing
 * function runs, so it must not poison module evaluation.
 */
function isDefinitelyAbruptComputedClassElementKey(node: ts.Node): boolean {
  return (
    ts.isClassElement(node) &&
    node.name !== undefined &&
    ts.isComputedPropertyName(node.name) &&
    node.parent !== undefined &&
    ts.isClassLike(node.parent) &&
    necessarilyEvaluatesAbruptly(node.name.expression)
  );
}

/**
 * Whether `node` is an OBJECT LITERAL element whose COMPUTED PROPERTY NAME
 * necessarily invokes a definitely-abrupt local callee, so that evaluating
 * the enclosing object literal ends module evaluation rather than
 * completing (RWF-024).
 *
 * ```js
 * const o = { [bail()]: 1 };        // qualifies
 * const o = { [bail()]() {} };      // qualifies
 * const o = { get [bail()]() {} };  // qualifies
 * const o = { set [bail()](v) {} }; // qualifies
 * const o = { bail: 1 };            // does NOT qualify: not a computed key
 * const o = { [KEY]: 1 };           // does NOT qualify: not a call
 * ```
 *
 * **Why this is a different rule from RWF-019, not a widening of it.**
 * RWF-019's {@link isDefinitelyAbruptComputedClassElementKey} reads a
 * `ClassElement`'s computed name, evaluated by ClassDefinitionEvaluation as
 * part of defining a CLASS. This predicate reads the identically-shaped
 * `ObjectLiteralElementLike`'s computed name — `MethodDeclaration`,
 * `GetAccessorDeclaration` and `SetAccessorDeclaration` are the same node
 * KINDS whether they sit in a class body or an object literal, exactly the
 * fact RWF-019's own docs record — evaluated as part of the completely
 * different ECMAScript abstract operation that constructs an OBJECT: for
 * every property in an `ObjectLiteral`'s `PropertyDefinitionList`, in
 * source order, the computed key expression is evaluated and converted to a
 * property key BEFORE that property's value (or the method/getter/setter it
 * names) is defined on the new object. There is no class here at all, no
 * prototype chain, and no static/instance distinction to draw — an object
 * literal has exactly one "instance", the object being built right now, so
 * every computed key it writes runs immediately, unconditionally, every
 * time the literal is evaluated. A throw out of one propagates out of the
 * object literal, out of whatever statement is evaluating it, and — if
 * nothing catches it — out of the `require()` that started the load, exactly as a
 * class's computed-key throw does.
 *
 * Only the KEY is read here, deliberately mirroring RWF-019's own
 * static/instance-VALUE line: a `PropertyAssignment`'s VALUE
 * (`{ [safeKey()]: bail() }`) and a method/getter/setter's BODY are
 * evaluated in different positions and by different rules (a method/getter/
 * setter's body is deferred until called, exactly as a class method's is;
 * an ordinary property's value is a value-position gap this rule does not
 * claim to close — see the RWF-024 FINDINGS entry). `mayEndModuleEvaluation`'s
 * function-like stop still skips a method/getter/setter's BODY; this test is
 * asked before that stop for the same reason RWF-019's is, since a
 * `MethodDeclaration`/`GetAccessorDeclaration`/`SetAccessorDeclaration` IS
 * function-like.
 *
 * **Ordering needs no model**, for the same reason RWF-019 needed none:
 * {@link firstModuleEvaluationCutoff} records the enclosing top-level
 * STATEMENT's start, so which computed key throws — first, middle or last —
 * cannot change the answer. Keys evaluate in source order, every one of
 * them during this same object-literal construction, so
 * `{ [safe()]: 1, [bail()]: 2, [later()]: 3 }` needs no intra-literal
 * control-flow graph: the object literal does not complete either way, and
 * neither `later`'s key nor any property's VALUE after the abrupt key ever
 * runs.
 *
 * Scope is deliberately narrow, in the same three directions RWF-019 drew:
 *
 * - only a genuine `ts.ComputedPropertyName` counts, read off the AST.
 *   `{ "[bail()]": 1 }` is a string key and is not evaluated as code;
 * - only the element's parent being a genuine `ObjectLiteralExpression`
 *   counts — which is what excludes a class element's identically-kinded
 *   computed key (RWF-019's own shape) from this rule, and vice versa;
 * - only the key expression written DIRECTLY as that call qualifies, via
 *   {@link isDefinitelyAbruptCall} — the exact non-reassigned local callee
 *   ({@link resolveExactLocalCallable}), the always-throws body proof
 *   ({@link cannotCompleteNormally}), the `async`/generator exclusions and
 *   the parentheses normalization, all reused verbatim. `[foo(bail())]`,
 *   `` [`${bail()}`] `` and `[(bail(), "x")]` stay unrecognised, for the
 *   identical arbitrary-expression-evaluation reason RWF-017 recorded, and
 *   `[flag && bail()]` / `[flag ? bail() : "x"]` genuinely may not call
 *   `bail` at all.
 *
 * A caught object-literal-evaluation throw is handled by the existing
 * {@link isCaughtWithin} at the call site in {@link mayEndModuleEvaluation}:
 * `try { const o = { [bail()]: 1 }; } catch {}` keeps a later export's
 * authority, and a rethrowing `catch` withdraws it. An object literal built
 * inside a function/method/arrow body — including a deferred INSTANCE field
 * initializer's own nested object literal — is offered to this predicate
 * only if {@link mayEndModuleEvaluation}'s walk reaches it; the walk stops
 * at every function-like node before descending into a body, but does not
 * stop at a non-static `PropertyDeclaration`, which is the identical,
 * already-accepted over-approximation RWF-019 documents for a class nested
 * inside an instance field initializer (see this file's RWF-019 tests and
 * the RWF-024 FINDINGS entry) — erring toward UNKNOWN, never toward a false
 * negative proof.
 */
function isDefinitelyAbruptComputedObjectLiteralKey(node: ts.Node): boolean {
  return (
    ts.isObjectLiteralElementLike(node) &&
    node.name !== undefined &&
    ts.isComputedPropertyName(node.name) &&
    node.parent !== undefined &&
    ts.isObjectLiteralExpression(node.parent) &&
    necessarilyEvaluatesAbruptly(node.name.expression)
  );
}

/**
 * Whether executing `node` — one statement at module scope — necessarily
 * invokes a local callee that RWF-016 proves can only ever throw, so that
 * the statement cannot complete normally and module evaluation ends there
 * (uncaught).
 *
 * Every position qualifies that evaluating the statement necessarily
 * evaluates, before any body or clause of it can run
 * ({@link statementHeaderCannotCompleteNormally}):
 *
 * ```text
 * bail();                    -- RWF-016: a bare expression statement
 * foo(bail());               -- RWF-026: any required operand of it
 * const x = bail();          -- RWF-017: a declarator's initializer
 *                               (`const`/`let`/`var` alike -- this is about
 *                               the CALL SITE's enclosing declaration, not
 *                               about how `bail` itself was declared)
 * if (bail()) { ... }        -- RWF-026: an `if`/`switch`/`while` header
 * for (let x = bail();;) {}  -- RWF-026: a `for` initializer and test
 * for (const x of bail()) {} -- RWF-026: a `for`-`of`/`in` right-hand side
 * ```
 *
 * (An earlier version of this table listed the `if` and `for` rows as
 * refused; RWF-026 had already made them required.)
 *
 * This is the MUST half of {@link mayEndModuleEvaluation}'s answer. Since
 * BL-063 it is no longer the only way a call ends module evaluation there:
 * a proven-abrupt call in any module-time position, required or not, is a
 * cutoff through that walk's MAY check, so the `do`/`while` condition and
 * the `for` incrementor (not asked here) are cutoffs too, for that reason
 * rather than this one.
 *
 * `fileHasAbruptCallable` is the per-file gate
 * ({@link fileHasDefinitelyAbruptCallable}), which the caller has already
 * computed for the file this statement is in: this is asked of every node
 * the walk visits, and a file with no always-throwing callable provably
 * has no such call anywhere.
 */
function isDefinitelyAbruptCallStatement(
  node: ts.Node,
  fileHasAbruptCallable: boolean,
): boolean {
  return (
    fileHasAbruptCallable && statementHeaderCannotCompleteNormally(node, 0)
  );
}

/**
 * {@link isDefinitelyAbruptCallStatement}'s relation at any callable depth,
 * without the per-file gate: whether a position `node` necessarily
 * evaluates, before any body or clause of it runs, cannot complete
 * normally. The callee summary asks it of every statement of a body
 * ({@link classifyAbruptOutcome}, BL-066), where the gate must not be
 * consulted: the gate is computed by the summary.
 */
function statementHeaderCannotCompleteNormally(
  node: ts.Node,
  callableDepth: number,
): boolean {
  const required = (expression: ts.Expression): boolean =>
    expressionCannotCompleteNormally(expression, 0, callableDepth);
  if (ts.isExpressionStatement(node)) {
    return required(node.expression);
  }
  if (ts.isVariableStatement(node)) {
    return declarationListCannotCompleteNormally(
      node.declarationList,
      callableDepth,
    );
  }
  // RWF-026's statement-HEADER positions. Each of these expressions is
  // evaluated by the act of reaching the statement, before any body or
  // clause of it can run, so an abrupt one ends module evaluation exactly
  // as a bare `bail();` would — and none of them needs any reasoning about
  // the statement's BODY, which is why no control-flow graph appears here.
  if (ts.isIfStatement(node) || ts.isSwitchStatement(node)) {
    return required(node.expression);
  }
  if (ts.isWhileStatement(node)) {
    // The condition is evaluated BEFORE the first iteration, so reaching
    // the `while` is enough. A `do`/`while`'s condition is NOT: it runs
    // only after the body has completed, which would need body-completion
    // reasoning this relation does not have — so `ts.isDoStatement` is
    // deliberately absent here.
    return required(node.expression);
  }
  if (ts.isForStatement(node)) {
    const initializer = node.initializer;
    if (initializer !== undefined) {
      const abruptInitializer = ts.isVariableDeclarationList(initializer)
        ? declarationListCannotCompleteNormally(initializer, callableDepth)
        : required(initializer);
      if (abruptInitializer) {
        return true;
      }
    }
    // The test runs once before the first iteration; the INCREMENTOR does
    // not run until an iteration has completed, and a body that `break`s,
    // `throw`s or `return`s means it may never run at all. It is
    // deliberately not consulted.
    return node.condition !== undefined && required(node.condition);
  }
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    // The right-hand side is evaluated before iteration begins — before
    // any iterator is obtained, and whether or not the loop ever runs a
    // body. Nothing about iterator protocol is modeled beyond that.
    return required(node.expression);
  }
  return false;
}

export {
  isDefinitelyAbruptCall,
  fileHasDefinitelyAbruptCallable,
  necessarilyEvaluatesAbruptly,
  isDefinitelyAbruptStaticFieldInitializer,
  isDefinitelyAbruptComputedClassElementKey,
  isDefinitelyAbruptComputedObjectLiteralKey,
  isDefinitelyAbruptCallStatement,
};
