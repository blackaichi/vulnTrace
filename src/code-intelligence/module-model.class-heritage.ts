/**
 * Class heritage: whether a class's `extends` value is definitely invalid,
 * or definitely evaluates abruptly, through the exits of an exactly resolved
 * call.
 *
 * Split out of `module-model.ts` by concern, as a pure move (task BL-121):
 * the declarations below are those of that file, unchanged and in its order.
 * `module-model.ts` re-exports the public ones.
 */
import ts from "typescript";
import { unwrapParentheses } from "./commonjs-reexports.js";
import {
  isAsyncOrGeneratorCallable,
  resolveExactLocalCallableIdentity,
} from "./module-model.local-callables.js";
import { necessarilyEvaluatesAbruptly } from "./module-model.abruptness.js";

/**
 * Whether `node` is a class's `extends` HERITAGE clause whose expression
 * necessarily invokes a definitely-abrupt local callee, so that evaluating
 * the enclosing class ends module evaluation rather than completing
 * (RWF-020).
 *
 * ```js
 * class C extends bail() {}            // qualifies
 * const C = class extends bail() {};   // qualifies -- same evaluation
 * class C extends (bail()) {}          // qualifies -- parentheses are transparent
 * class C extends baseFactory() {}     // does NOT qualify: the call returns
 * class C extends null {}              // does NOT qualify: no call at all
 * class C extends Base {}              // does NOT qualify: no call at all
 * ```
 *
 * **Why the heritage expression is class-DEFINITION time, and the FIRST
 * thing that runs.** ClassDefinitionEvaluation evaluates the heritage
 * expression before it does anything else with the class: the superclass
 * value has to exist before the prototype chain can be built, before any
 * element can be installed on it, and therefore before any computed key
 * (RWF-019), static field initializer (RWF-018) or static block (RWF-015)
 * runs. So a `class` sitting at module scope evaluates its `extends`
 * expression during module evaluation, and a throw out of that expression
 * propagates out of the class definition and out of the `require()` that
 * started the load. The class binding is never created and nothing below
 * the class runs — including a later `module.exports = safeOp`, which a
 * cyclic importer therefore never sees. Measured, in order, under real
 * `node` in
 * fixtures/commonjs-circular-import-class-heritage-throw-ground-truth/:
 * a throwing heritage leaves the element list entirely unevaluated, while
 * a harmless one lets every element run.
 *
 * **Why this is a third rule rather than a widening of RWF-018/019.** Both
 * of those read an expression written on a class ELEMENT — a
 * `PropertyDeclaration`'s initializer, a `ClassElement`'s
 * `ComputedPropertyName`. A heritage expression is on no element at all;
 * it hangs off the class's `heritageClauses`, is evaluated strictly before
 * every element, and is the only class-definition-time expression that
 * still runs when the class body is completely EMPTY — which is exactly
 * the shape (`class C extends bail() {}`) that neither predecessor could
 * see.
 *
 * **The heritage VALUE is a SECOND, separate reason the class definition
 * can fail — RWF-022.** RWF-020 asks only whether evaluating the heritage
 * CALL itself completes. Whether the resulting value is a valid superclass
 * is a different semantic question, and three real cases turn on it — all
 * three measured, all three throwing a `TypeError` for a reason RWF-020
 * does not and must not claim:
 *
 * ```js
 * async function bail() { throw x; }
 * class C extends bail() {}   // the CALL returns a Promise; the class
 *                             // definition then fails on "not a constructor"
 * function* bail() { throw x; }
 * class C extends bail() {}   // the CALL returns a generator object without
 *                             // running the body at all; same TypeError
 * function n() { return 1; }
 * class C extends n() {}      // the CALL returns 1; same TypeError
 * ```
 *
 * RWF-020 left all three unanswered and recorded them as an open finding.
 * RWF-022 answers them, through
 * {@link isDefinitelyInvalidClassHeritageValue} — a SEPARATE disjunct
 * below, never a widening of {@link isDefinitelyAbruptCall}. The two
 * mechanisms are disjoint by construction and must stay that way: RWF-020
 * needs {@link cannotCompleteNormally} (a body that always throws), RWF-022
 * needs a body that always RETURNS, and no function is both. The
 * `async`/generator exclusion in {@link isAsyncOrGeneratorCallable} is
 * likewise read for opposite purposes by the two — see
 * {@link resolveExactLocalCallableIdentity} — which is why it stays in
 * `isDefinitelyAbruptCall`'s path and not in the shared identity proof.
 *
 * Everything about the CALL is RWF-016/017's, reused verbatim through
 * {@link isDefinitelyAbruptCall}: the exact non-reassigned local callee
 * ({@link resolveExactLocalCallable}), the always-throws body proof
 * ({@link cannotCompleteNormally}), the `async`/generator exclusions, and
 * the parentheses normalization that makes `extends (bail())` work.
 * `extends foo(bail())`, `extends (bail(), Base)`,
 * `extends (bail() || Base)`, `extends (flag && bail())`,
 * `extends (flag ? bail() : Base)` and `extends new Bail()` are all left
 * unrecognised at that same arbitrary-expression boundary. The first THREE
 * really do always evaluate `bail` — an argument is evaluated before the
 * call, a comma sequence evaluates its left operand, and so does `||`,
 * whose short-circuit decides only whether the RIGHT operand runs — so
 * those three are remaining soundness gaps. `flag && bail()` and
 * `flag ? bail() : Base` genuinely may not call it at all. Telling the two
 * groups apart needs the evaluation-order model
 * {@link isDefinitelyAbruptCall} deliberately does not have.
 *
 * Scope is narrow in two further directions:
 *
 * - only an `extends` clause counts. A TypeScript `implements` clause is
 *   erased and evaluates nothing, and an INTERFACE's `extends` clause is a
 *   list of types, not expressions — hence the `ts.isClassLike` check on
 *   the parent, which admits a `ClassDeclaration` and a `ClassExpression`
 *   and nothing else;
 * - a class defined inside a function, method, arrow or accessor body is
 *   never offered to this predicate at all, because
 *   {@link mayEndModuleEvaluation}'s walk stops at function-like nodes
 *   first. `function configure() { class C extends bail() {} }` defers the
 *   whole class definition, heritage included, so it must not poison
 *   module evaluation — confirmed in the same fixture.
 *
 * A caught class-evaluation throw is handled by the existing
 * {@link isCaughtWithin} at the call site in {@link mayEndModuleEvaluation},
 * exactly as for RWF-018 and RWF-019:
 * `try { class C extends bail() {} } catch {}` keeps a later export's
 * authority, and a rethrowing `catch` withdraws it.
 */
/**
 * What a class's `extends` value is, as far as ClassDefinitionEvaluation's
 * own validity check is concerned (RWF-022).
 *
 * The check the language performs is exactly three-way, and this domain
 * mirrors it rather than trying to describe the value in general:
 *
 * - `"valid-null"` — `extends null` is LEGAL and is its own case in the
 *   spec, not a degenerate constructor. It builds a class whose prototype
 *   chain terminates. Folding it in with "not a constructor" is the single
 *   most dangerous mistake available here, so it gets its own state;
 * - `"constructable"` — the value has a `[[Construct]]` internal method, so
 *   the class definition completes;
 * - `"non-constructable"` — the value is neither `null` nor a constructor,
 *   so ClassDefinitionEvaluation throws a `TypeError` and the class
 *   definition never completes;
 * - `"unknown"` — this model declines to say. The conservative default for
 *   everything not proven by node kind alone.
 *
 * Only `"non-constructable"` is actionable, and only as an input to
 * {@link isDefinitelyAbruptClassHeritage}. Nothing downstream may read a
 * VERDICT off this domain: it answers "does the class definition
 * complete?", never "is the package affected?".
 */
type HeritageValueClass =
  "unknown" | "valid-null" | "constructable" | "non-constructable";

/**
 * {@link HeritageValueClass} for a syntactic VALUE expression — the thing a
 * heritage position would receive (RWF-022).
 *
 * This is a flat table over node KINDS and nothing else. It performs no
 * name resolution, reads no binding, and evaluates no subexpression, which
 * is what keeps it from being the general value interpreter this task is
 * scoped not to build. Every row was executed under real `node` v26 in
 * fixtures/commonjs-circular-import-invalid-class-heritage-ground-truth/:
 *
 * ```text
 * 1  0  1n  "x"  `x`  true  false     -- non-constructable (TypeError)
 * {}  []                              -- non-constructable (TypeError)
 * () => {}                            -- non-constructable: an arrow has no
 *                                        [[Construct]], by construction
 * async function B() {}               -- non-constructable
 * function* B() {}                    -- non-constructable
 * async function* B() {}              -- non-constructable
 * null                                -- VALID: `class C extends null {}`
 * class B {}                          -- constructable
 * function B() {}                     -- constructable
 * Base   alias   obj.B   f()   -1     -- unknown: needs a binding, a member
 *                                        lookup, a call, or an operator
 * ```
 *
 * **Why an object/array literal is safe to call non-constructable even
 * though it can contain arbitrary subexpressions.** `{ a: foo() }` might
 * throw while being built. If it does, the enclosing CALL completes
 * abruptly, so the class definition does not complete either — which is
 * the same conclusion this classification feeds. Both readings agree, so
 * the classifier does not have to know which one holds. This is the
 * argument {@link declarationListCannotCompleteNormally} already makes for
 * its left-to-right declarator scan, reused. The same argument is what
 * admits a `TemplateExpression` with substitutions: it either produces a
 * string or throws.
 *
 * **Why `__proto__` in an object literal changes nothing.**
 * `{ __proto__: Function.prototype }` sets the object's PROTOTYPE, and
 * `[[Construct]]` is an internal method, not an inherited property — the
 * result is still not a constructor. Measured, because it is the one
 * object-literal shape that looks like it might not be.
 *
 * **Why the identifier `undefined` is NOT a row.** It is an ordinary
 * global reference and can be shadowed by a parameter, a `catch` binding
 * or a local declaration, and this classifier resolves no bindings. The
 * undefined VALUE is still reachable here, but only through shapes that
 * need no name at all — an empty body and a bare `return;` — which
 * {@link classifyExactCallReturnValue} handles directly.
 */
function classifyHeritageValueExpression(
  expression: ts.Expression,
): HeritageValueClass {
  const value = unwrapParentheses(expression);

  if (value.kind === ts.SyntaxKind.NullKeyword) {
    return "valid-null";
  }
  if (ts.isClassExpression(value)) {
    return "constructable";
  }
  if (ts.isFunctionExpression(value)) {
    // An `async` and/or generator function EXPRESSION has no
    // [[Construct]]; a plain one does.
    return isAsyncOrGeneratorCallable(value)
      ? "non-constructable"
      : "constructable";
  }
  if (ts.isArrowFunction(value)) {
    return "non-constructable";
  }
  if (
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    ts.isStringLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value) ||
    ts.isTemplateExpression(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isObjectLiteralExpression(value) ||
    ts.isArrayLiteralExpression(value)
  ) {
    return "non-constructable";
  }
  return "unknown";
}

/**
 * {@link HeritageValueClass} for the value CALLING `fn` produces (RWF-022)
 * — where `fn` is a function node {@link resolveExactLocalCallableIdentity}
 * has already proven a given call site invokes.
 *
 * Two independent routes reach a decision, and they are deliberately
 * separate mechanisms rather than one widened rule:
 *
 * 1. **Callee IDENTITY decides it outright, with no body analysis at all.**
 *    Calling an `async` function returns a `Promise`; calling a generator
 *    function returns a generator object without running the body; an
 *    async generator returns an async generator object. None of the three
 *    is a constructor, and none of them depends on what the body says — so
 *    an `async`/generator callee is answered before the body is looked at.
 *
 *    This is the same syntactic fact RWF-016's
 *    {@link isAsyncOrGeneratorCallable} already establishes, used for a
 *    DIFFERENT question, and the distinction matters: RWF-016 reads it as
 *    "calling this cannot throw synchronously, so refuse"; RWF-022 reads
 *    it as "calling this returns a known non-constructor object, so
 *    decide". RWF-020's doc comment records exactly this split and
 *    declines to make it; this is where it is made.
 *
 * 2. **A single unconditional return of a value the node kind alone
 *    classifies** ({@link classifyHeritageValueExpression}). The supported
 *    body shapes are the ones that need no control-flow reasoning
 *    whatsoever:
 *
 * ```text
 * function f() { return 1; }   -- one statement, a `return` with a value
 * function f() { return; }     -- one statement, a bare `return` -> undefined
 * function f() {}              -- EMPTY body -> undefined
 * const f = () => 1;           -- concise arrow body IS the returned value
 *
 * function f(flag) {           -- refused: two statements, and the model
 *   if (flag) return 1;           has no reason to believe either path
 *   return Base;                  wins. `maybeBase()` is not definitely
 * }                                invalid, and must not be treated as such
 * function f() {               -- refused: one statement, but not a return
 *   doSomething();
 * }
 * function f() { "use strict"; return 1; }  -- refused: two statements
 * ```
 *
 * The refusals are the point. This is not a return-value ANALYSIS with a
 * narrow implementation; it is a narrow pattern that is either matched
 * exactly or declined, so there is no path by which a function with more
 * than one reachable ending is ever classified. In particular a body
 * containing a conditional, a loop, a `try`, or any second statement is
 * `"unknown"`, full stop — which is what keeps the "multiple returns"
 * family (test 12) and the RWF-020 "throwing callee" family off this
 * mechanism entirely.
 *
 * An overload signature or ambient declaration (no body) is `"unknown"`.
 */
function classifyExactCallReturnValue(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): HeritageValueClass {
  if (isAsyncOrGeneratorCallable(fn)) {
    return "non-constructable";
  }

  const body = fn.body;
  if (body === undefined) {
    return "unknown";
  }
  if (!ts.isBlock(body)) {
    return classifyHeritageValueExpression(body);
  }
  if (body.statements.length === 0) {
    return "non-constructable";
  }
  if (body.statements.length !== 1) {
    return "unknown";
  }
  const only = body.statements[0];
  if (only === undefined || !ts.isReturnStatement(only)) {
    return "unknown";
  }
  return only.expression === undefined
    ? "non-constructable"
    : classifyHeritageValueExpression(only.expression);
}

/**
 * One possible ending of an exact local callable used as a class's
 * `extends` heritage, in the RWF-027 sense: {@link HeritageValueClass}
 * widened with the one ending that produces no value at all.
 *
 * `"abrupt-throw"` means that path leaves the callable by `throw`, so the
 * heritage expression completes abruptly and the class definition never
 * begins. Every other member is the classification of the value that path
 * hands back to the `extends` position.
 */
type HeritageCompletionOutcome = HeritageValueClass | "abrupt-throw";

/**
 * The outcomes that stop a class definition from completing NORMALLY.
 *
 * These are the only two, and they fail the class definition for two
 * genuinely different reasons — which is precisely why RWF-020 and RWF-022
 * could not see the family RWF-027 addresses:
 *
 * - `"abrupt-throw"` — the heritage EXPRESSION completes abruptly, so
 *   ClassDefinitionEvaluation is never entered (RWF-020's reason);
 * - `"non-constructable"` — the heritage expression completes normally with
 *   a value that is neither `null` nor a constructor, so
 *   ClassDefinitionEvaluation itself throws a `TypeError` (RWF-022's).
 */
const CLASS_DEFINITION_FATAL_OUTCOMES: ReadonlySet<HeritageCompletionOutcome> =
  new Set<HeritageCompletionOutcome>(["abrupt-throw", "non-constructable"]);

/**
 * What executing a statement LIST to its end can do, in the bounded model
 * {@link collectHeritageExitOutcomes} implements (RWF-027).
 *
 * - `exits` — every ending that leaves the enclosing CALLABLE from inside
 *   this list: one entry per `return` reached and one `"abrupt-throw"` per
 *   `throw` reached. Duplicates are irrelevant; only membership is read.
 * - `fallsThrough` — whether control can reach the end of the list without
 *   having left the callable, so that whatever FOLLOWS the list runs. At
 *   the top level of a function body this is exactly the implicit
 *   `return undefined`, and it is represented explicitly rather than as an
 *   absent path — see {@link summarizeExactCallHeritageOutcomes}.
 */
type HeritageExitSet = {
  readonly exits: readonly HeritageCompletionOutcome[];
  readonly fallsThrough: boolean;
};

/**
 * How deep {@link collectHeritageExitOutcomes} will follow nested
 * `if`/block structure before refusing, and how many exits it will record
 * before refusing.
 *
 * Both are hard bounds, not heuristics: this task is scoped explicitly NOT
 * to build a general CFG or an interprocedural fixpoint, and a fixed
 * ceiling is what makes "bounded" checkable rather than asserted. Exceeding
 * either yields `undefined` — UNKNOWN — which can only ever cost precision.
 * Four levels covers `if` / `else if` / nested `if` shapes that occur in
 * real heritage factories; anything deeper is refused rather than
 * approximated.
 */
const HERITAGE_PATH_DEPTH_LIMIT = 4;
const HERITAGE_PATH_EXIT_LIMIT = 32;

/**
 * Every way executing `statements` can end, or `undefined` — UNKNOWN — the
 * instant any construct this bounded model does not fully understand is
 * reached (RWF-027).
 *
 * **The refusal is the mechanism, not an edge case.** A path this collector
 * silently dropped would be a path the caller then proves nothing about
 * while believing it has proved something about all of them, and dropping a
 * `return Base;` is exactly how an analyzer withdraws a CORRECT export.
 * So the statement kinds below are an allow-list, and everything absent
 * from it — every loop, `switch`, `try`/`catch`/`finally`, labeled
 * statement, `break`, `continue`, `with` — poisons the whole summary rather
 * than being skipped. Sound refusal is always available; a lost path is
 * not recoverable.
 *
 * ```text
 * return <expr>;   -- one exit, classified by node kind alone
 * return;          -- one exit: undefined, non-constructable
 * throw <expr>;    -- one exit: "abrupt-throw"
 * if (c) A else B  -- the union of both arms; a missing `else` is an arm
 *                     that falls through
 * { ... }          -- recursed into, at one more level of depth
 * foo();  x = 1;   -- neither exits nor is descended into (see below)
 * let x = ...;
 * function g() {}  -- SKIPPED, deliberately: see the boundary note
 * class K {}
 * ;                -- empty statement
 * debugger;
 * for/while/switch -- UNKNOWN, whole summary poisoned
 * try/label/break
 * ```
 *
 * **Why a plain expression or declaration statement is passed over rather
 * than analyzed.** It cannot leave the callable by `return`, and the only
 * other way it can end is by THROWING — which is already a
 * class-definition-fatal outcome. Ignoring it can therefore only ever omit
 * a fatal ending from a set the caller requires to be entirely fatal, which
 * cannot turn a completable heritage into a non-completing one. The same
 * argument covers the `if` CONDITION, the `return` operand and the `throw`
 * operand, none of which are examined either.
 *
 * **The function-scope boundary.** Nested `FunctionDeclaration`s and
 * `ClassDeclaration`s are skipped, and no expression is ever descended
 * into, so a `return` inside a nested function, method, accessor, class
 * static block or IIFE is structurally unable to be counted as an exit of
 * the OUTER callable. This is not a filter applied after the fact — the
 * collector walks statements only, and a nested body is only ever reachable
 * through an expression or a declaration it does not enter.
 */
function collectHeritageExitOutcomes(
  statements: readonly ts.Statement[],
  depth: number,
): HeritageExitSet | undefined {
  if (depth > HERITAGE_PATH_DEPTH_LIMIT) {
    return undefined;
  }

  const exits: HeritageCompletionOutcome[] = [];

  for (const statement of statements) {
    if (exits.length > HERITAGE_PATH_EXIT_LIMIT) {
      return undefined;
    }

    if (ts.isReturnStatement(statement)) {
      exits.push(
        statement.expression === undefined
          ? // `return;` hands back `undefined`, which is neither `null` nor
            // a constructor.
            "non-constructable"
          : classifyHeritageValueExpression(statement.expression),
      );
      return { exits, fallsThrough: false };
    }

    if (ts.isThrowStatement(statement)) {
      exits.push("abrupt-throw");
      return { exits, fallsThrough: false };
    }

    if (ts.isIfStatement(statement)) {
      const thenArm = collectHeritageExitOutcomes(
        ts.isBlock(statement.thenStatement)
          ? statement.thenStatement.statements
          : [statement.thenStatement],
        depth + 1,
      );
      if (thenArm === undefined) {
        return undefined;
      }

      let elseArm: HeritageExitSet = { exits: [], fallsThrough: true };
      if (statement.elseStatement !== undefined) {
        const collected = collectHeritageExitOutcomes(
          ts.isBlock(statement.elseStatement)
            ? statement.elseStatement.statements
            : [statement.elseStatement],
          depth + 1,
        );
        if (collected === undefined) {
          return undefined;
        }
        elseArm = collected;
      }

      exits.push(...thenArm.exits, ...elseArm.exits);
      if (!thenArm.fallsThrough && !elseArm.fallsThrough) {
        // Neither arm can reach the statement after the `if`, so the list
        // ends here and nothing following it is reachable.
        return { exits, fallsThrough: false };
      }
      continue;
    }

    if (ts.isBlock(statement)) {
      const nested = collectHeritageExitOutcomes(
        statement.statements,
        depth + 1,
      );
      if (nested === undefined) {
        return undefined;
      }
      exits.push(...nested.exits);
      if (!nested.fallsThrough) {
        return { exits, fallsThrough: false };
      }
      continue;
    }

    if (
      ts.isExpressionStatement(statement) ||
      ts.isVariableStatement(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEmptyStatement(statement) ||
      statement.kind === ts.SyntaxKind.DebuggerStatement
    ) {
      // Cannot leave the callable by `return`; may only throw, which is
      // already fatal for the class definition. Not descended into, which
      // is what keeps nested function/class bodies out of this summary.
      continue;
    }

    return undefined;
  }

  return { exits, fallsThrough: true };
}

/**
 * Every outcome calling `fn` can produce for a class's `extends` position,
 * or `undefined` — UNKNOWN (RWF-027).
 *
 * The returned array is never empty: a callable always ends somehow, and a
 * body that can run off its end ends by returning `undefined`. That
 * implicit ending is APPENDED EXPLICITLY here rather than being left as an
 * absent path, which is the whole reason `function f(flag) { if (flag)
 * return 1; }` can be answered at all — its two endings are `1` and
 * `undefined`, both non-constructable, and a model that recorded only the
 * written `return` would have seen one path where there are two.
 *
 * Two callee shapes are handed back to RWF-022 untouched rather than
 * summarized here, because RWF-022 already answers them exactly and this
 * mechanism must not compete for what an existing rule owns:
 *
 * - an `async` and/or generator callable, whose RESULT is decided by the
 *   callee's identity and never by its body — see
 *   {@link classifyExactCallReturnValue}'s route 1;
 * - a concise-bodied arrow (`const f = () => 1;`), which has no statement
 *   list to walk. RWF-027 adds no conditional-expression path model, so
 *   `flag => flag ? 1 : 2` stays exactly as unknown as it was.
 */
function summarizeExactCallHeritageOutcomes(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): readonly HeritageCompletionOutcome[] | undefined {
  if (isAsyncOrGeneratorCallable(fn)) {
    return undefined;
  }

  const body = fn.body;
  if (body === undefined || !ts.isBlock(body)) {
    return undefined;
  }

  const collected = collectHeritageExitOutcomes(body.statements, 0);
  if (collected === undefined) {
    return undefined;
  }

  return collected.fallsThrough
    ? // Running off the end of a function body IS `return undefined`.
      [...collected.exits, "non-constructable"]
    : collected.exits;
}

/**
 * Whether evaluating `expression` in a class's `extends` position cannot
 * lead to a class definition that completes NORMALLY, because EVERY
 * analyzable ending of the exact local callable it invokes is
 * class-definition-fatal — some by throwing, some by handing back a value
 * that is not a valid base (RWF-027).
 *
 * **This is deliberately not "the call cannot complete normally".** Read
 * the canonical case:
 *
 * ```js
 * function maybe(flag) {
 *   if (flag) { throw new Error("boom"); }
 *   return 1;
 * }
 * class C extends maybe(FLAG) {}
 * ```
 *
 * With a falsy `FLAG` the CALL completes perfectly normally and returns
 * `1`. Nothing about `maybe` is abrupt, and asserting that it were would be
 * wrong — which is why `maybe(FLAG);` as a plain statement is untouched by
 * this rule and stays exactly as unknown as RWF-016 leaves it. What is
 * proven here is narrower and about the CLASS: evaluating this HERITAGE
 * cannot lead to a normally completed class definition, because the truthy
 * path throws before ClassDefinitionEvaluation begins and the falsy path
 * reaches it with `1`, which is neither `null` nor a constructor. Measured
 * under real `node`: both flag values abort the class definition, one with
 * `Error: boom` and one with
 * `TypeError: Class extends value 1 is not a constructor or null`.
 *
 * **Why RWF-020 and RWF-022 cannot see this between them.** RWF-020 needs
 * {@link cannotCompleteNormally} — a body that ALWAYS throws — and `maybe`
 * does not. RWF-022 needs {@link classifyExactCallReturnValue} — a body
 * with ONE unconditional ending — and `maybe` has two. Each rule inspects a
 * property no single path of `maybe` has, while the class-definition
 * failure is a property of the path set as a WHOLE. RWF-027 composes their
 * two fatality reasons across that set; it does not widen, weaken or
 * duplicate either rule, both of which remain exactly as they were and are
 * still consulted first as separate disjuncts of
 * {@link isDefinitelyAbruptClassHeritage}.
 *
 * **The decision.** Non-completion is proven only when the summary is
 * known, non-empty, and EVERY outcome in it is in
 * {@link CLASS_DEFINITION_FATAL_OUTCOMES}. One `"unknown"` refuses. One
 * `"valid-null"` refuses — `class C extends null {}` is legal and completes.
 * One `"constructable"` refuses. The asymmetry is the point: a single
 * surviving good path means the class definition CAN complete, the later
 * export CAN run, and withdrawing its authority would be an overreach that
 * this rule must never commit.
 *
 * ```text
 * throw + 1          -- proven: both endings fatal
 * 1 + 2              -- proven
 * 1 + implicit undefined -- proven
 * throw + throw      -- proven (RWF-020 already had it; unchanged answer)
 * 1 + null           -- REFUSED: `null` is a valid base
 * 1 + Base           -- REFUSED: `Base` is unknown, and may be a class
 * throw + Base       -- REFUSED: a completable path exists
 * 1 + helper()       -- REFUSED: a call operand is unknown
 * alias(FLAG)        -- REFUSED: not an exact local callable (RWF-028's)
 * ```
 */
function isDefinitelyNonCompletingClassHeritageCall(
  expression: ts.Expression,
): boolean {
  const unwrapped = unwrapParentheses(expression);
  if (
    !ts.isCallExpression(unwrapped) ||
    !ts.isIdentifier(unwrapped.expression)
  ) {
    return false;
  }

  const target = resolveExactLocalCallableIdentity(unwrapped.expression);
  if (target === undefined) {
    return false;
  }

  const outcomes = summarizeExactCallHeritageOutcomes(target);
  if (outcomes === undefined || outcomes.length === 0) {
    return false;
  }

  return outcomes.every((outcome) =>
    CLASS_DEFINITION_FATAL_OUTCOMES.has(outcome),
  );
}

/**
 * Whether evaluating `expression` in a class's `extends` position
 * necessarily produces a value that is neither `null` nor a constructor,
 * so that ClassDefinitionEvaluation throws a `TypeError` and the class
 * definition does not complete (RWF-022).
 *
 * Two heritage shapes are recognised, and they share one classifier:
 *
 * ```text
 * class C extends notAConstructor() {}   -- an exact local callable whose
 *                                           RETURN VALUE is classified
 * class C extends (notAConstructor()) {} -- parentheses are transparent
 * class C extends notAConstructor?.() {} -- see the optional-call note
 * class C extends 1 {}                   -- the heritage value is written
 * class C extends (() => {}) {}             DIRECTLY; same classifier,
 *                                           no call involved
 * class C extends alias() {}             -- refused: not an exact local
 * class C extends obj.make() {}             callable (no alias/member
 *                                           resolution is added here)
 * class C extends Base {}                -- refused: `unknown`, a binding
 * class C extends null {}                -- refused: VALID
 * class C extends makeBase() {}          -- refused: returns a class
 * ```
 *
 * **Why this is not RWF-020 with a wider net.** RWF-020 asks whether the
 * heritage CALL completes; this asks what the heritage VALUE is when the
 * call completes NORMALLY. The two are disjoint by construction —
 * `isDefinitelyAbruptCall` requires {@link cannotCompleteNormally}, which
 * requires the body to always throw, and every body shape accepted here
 * ends in a `return` or is empty. `function f() { throw e; }` is RWF-020's
 * and stays RWF-020's; this mechanism classifies it `"unknown"` and never
 * competes for it.
 *
 * **Optional call.** `notAConstructor?.()` needs no special case, for the
 * same reason RWF-020 records: the optional call short-circuits only on a
 * nullish CALLEE, and {@link resolveExactLocalCallableIdentity} only ever
 * returns a hoisted function declaration or a never-reassigned
 * `const`-bound function/arrow — neither can be nullish at the call site,
 * so the call always happens and its value is always the classified one.
 *
 * **Callee identity is RWF-016's, unchanged.** The lexical-shadow walk,
 * the reassignment refusal (RWF-013/013b) and the top-level-candidate
 * shape test are shared verbatim through
 * {@link resolveExactLocalCallableIdentity}, so
 * `notAConstructor = () => Base;` anywhere in the modeled reach, or a
 * shadowing inner `function notAConstructor() { return Base; }`, refuses
 * here exactly as it refuses for RWF-016.
 */
function isDefinitelyInvalidClassHeritageValue(
  expression: ts.Expression,
): boolean {
  const unwrapped = unwrapParentheses(expression);

  if (ts.isCallExpression(unwrapped) && ts.isIdentifier(unwrapped.expression)) {
    const target = resolveExactLocalCallableIdentity(unwrapped.expression);
    return (
      target !== undefined &&
      classifyExactCallReturnValue(target) === "non-constructable"
    );
  }

  return classifyHeritageValueExpression(unwrapped) === "non-constructable";
}

function isDefinitelyAbruptClassHeritage(node: ts.Node): boolean {
  return (
    ts.isHeritageClause(node) &&
    node.token === ts.SyntaxKind.ExtendsKeyword &&
    node.parent !== undefined &&
    ts.isClassLike(node.parent) &&
    node.types.some(
      (type) =>
        necessarilyEvaluatesAbruptly(type.expression) ||
        isDefinitelyInvalidClassHeritageValue(type.expression) ||
        isDefinitelyNonCompletingClassHeritageCall(type.expression),
    )
  );
}

export { isDefinitelyAbruptClassHeritage };
