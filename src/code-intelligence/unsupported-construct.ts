import ts from "typescript";
import type { DynamicCallReason } from "../domain/graph.js";

/**
 * P1-B1 -- decomposes the call graph's `unsupported_construct` catch-all
 * into the SPECIFIC frontend modeling gap that produced it.
 *
 * WHAT THIS IS NOT. It is not a verdict input, not a proof input, and not
 * a soundness boundary. Every token this file produces is classified
 * `unmodeled_construct` by `domain/uncertainty.ts` and NON-widening by
 * `isClosureWideningReason` -- exactly as the single `unsupported_construct`
 * token it replaces was. Nothing here may ever authorize `AFFECTED`,
 * `NOT_AFFECTED`, or any negative proof: swapping one subtype for another
 * must change the `unknownReasons` detail of a scan and NOTHING else (the
 * observational-only contract, proven by
 * `unsupported-construct.test.ts`).
 *
 * WHY. Before P1-B1, `docs/SCORECARD.md` § 7 could say only that the
 * real-world corpus contained "42 x unsupported_construct". That is a
 * number nobody can act on: it names no syntax, no mechanism and no owner,
 * so the one question P1-B exists to answer -- "which frontend capability
 * should be built first?" -- could only be answered from intuition (see
 * `docs/OPEN-DEBTS.md` D-07). The subtypes below were not invented: they
 * are the measured shapes of every occurrence in the real-world and
 * adversarial corpora (2,362 raw occurrences, instrumented at the two
 * emitters in `call-graph.ts`; see `tests/validation/FINDINGS.md` RWF-041 § 3).
 *
 * THE ORGANIZING QUESTION is always the same one: **where did the value
 * being called come from?** Not "what SyntaxKind is the callee", which
 * would split one gap across many tokens and merge several gaps into one.
 * `stack.delete()` and `stack['delete']()` are the same gap spelled two
 * ways and share one subtype; `x.m()` and `this.m()` are two different
 * gaps that happen to share a SyntaxKind and do not.
 *
 * EVERY SUBTYPE IS A GAP, NOT A PROMISE. A token here says the analyzer
 * did not model something. It does NOT say the construct is relevant to
 * any vulnerable target, that it is exploitable, or that it will ever be
 * implemented.
 */

/**
 * The frontend gap subtypes, and the generic floor they fall back to.
 *
 * Every member is also a {@link DynamicCallReason} and an
 * `UncertaintyReason` categorized `unmodeled_construct`; the type-level
 * assertion at the bottom of this file makes that structural rather than a
 * convention.
 */
export const UNSUPPORTED_CONSTRUCT_REASONS = [
  "unsupported_callee_binding",
  "unsupported_receiver_binding",
  "unsupported_this_receiver",
  "unsupported_indexed_receiver",
  "unsupported_call_result_receiver",
  "unsupported_literal_receiver",
  "unsupported_expression_receiver",
  "unsupported_computed_callee",
  "unsupported_construct",
] as const;

export type UnsupportedConstructReason =
  (typeof UNSUPPORTED_CONSTRUCT_REASONS)[number];

/**
 * Strips the spellings that carry no semantics.
 *
 * `(f)()`, `f!()`, `(f as any)()` and `(f satisfies F)()` are the same
 * call as `f()`. Design principle D (P1-B1 § 3): a trivial syntax
 * difference must not become a separate reason, so every classification
 * below sees through these wrappers. TypeScript-only forms are included
 * deliberately -- a `.ts` frontend that reported a different gap for
 * `obj!.m()` than for `obj.m()` would be describing its own parser rather
 * than the modeling gap.
 */
function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isExpressionWithTypeArguments(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * Whether `node` is a member access whose PROPERTY NAME the binder can
 * read statically -- `a.b`, or `a["b"]` with a literal string key.
 *
 * Mirrors `analyzeCalleeShape` in `symbol-binder.ts` EXACTLY, including
 * its choice to accept only string-literal-like keys. That is what makes
 * `stack['delete']()` share a subtype with `stack.delete()` (the binder
 * treats them identically and fails on both for the same reason), while
 * `stack[key]()` never reaches this file at all -- the binder classifies
 * it `dynamic_member_access` before the fallback is ever considered (see
 * § 34 of P1-B1: an occurrence that already has a precise reason keeps
 * it).
 */
function isStaticallyNamedMemberAccess(
  node: ts.Expression,
): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  return (
    ts.isPropertyAccessExpression(node) ||
    (ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression))
  );
}

/**
 * An expression whose value is computed by an OPERATOR the analyzer does
 * not evaluate -- `(a || b)`, `(c ? x : y)`, `(s + "e")`, `(t = f())`.
 *
 * Deliberately distinct from a call result: closing this gap needs local
 * expression evaluation (constant folding, a two-valued `||`/`?:` join),
 * which is bounded and intraprocedural, where a call result needs
 * interprocedural return modeling. Grouping them would merge two different
 * pieces of work under one token, which is the one thing a prioritization
 * taxonomy must not do.
 */
function isOperatorExpression(node: ts.Expression): boolean {
  return (
    ts.isBinaryExpression(node) ||
    ts.isConditionalExpression(node) ||
    ts.isPrefixUnaryExpression(node) ||
    ts.isPostfixUnaryExpression(node) ||
    ts.isVoidExpression(node) ||
    ts.isTypeOfExpression(node) ||
    ts.isYieldExpression(node) ||
    ts.isCommaListExpression(node)
  );
}

/**
 * An expression that CONSTRUCTS its value inline, so the value is
 * statically known and only its members are not -- `/re/.test(x)`,
 * `[a, b].join("|")`, `"s".slice(1)`, `new X().m()`, `(function () {}).call()`.
 *
 * The gap is knowledge of the constructed value's own members (builtin
 * prototypes, an object literal's own properties), never provenance: there
 * is nothing to trace. That makes it different work from every other
 * receiver subtype, all of which are provenance problems.
 */
function isInlineConstructedValue(node: ts.Expression): boolean {
  return (
    ts.isNewExpression(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isClassExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isRegularExpressionLiteral(node) ||
    ts.isTemplateExpression(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

/**
 * An expression whose value is the RESULT OF A CALL -- `f().m()`,
 * `require("path").join(...)`, `(await f()).m()`, `` tag`x`.m() ``.
 *
 * `await` belongs here rather than with the operator expressions: the
 * value is still whatever a call produced, and the work that closes it is
 * the same interprocedural return modeling.
 */
function isCallResultValue(node: ts.Expression): boolean {
  return (
    ts.isCallExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isTaggedTemplateExpression(node)
  );
}

/**
 * Classifies ONE call/construction that every resolution path in
 * `call-graph.ts` has already failed on, into the specific frontend gap
 * that explains it.
 *
 * TOTAL AND FAIL-SAFE (P1-B1 § 32/§ 33). Every input returns a token; no
 * input throws. A shape nobody has classified -- including a construct a
 * future TypeScript release invents -- returns the generic
 * `unsupported_construct` floor, which is exactly the token the whole
 * family used before this decomposition and is classified identically.
 * A new syntax must degrade to UNKNOWN, never to a crash and never to a
 * negative proof, so exhaustiveness here is deliberately NOT compiler
 * enforced: a `never` check would turn tomorrow's parser addition into a
 * build break, and there is no version of that trade worth making for a
 * value that only ever explains an UNKNOWN.
 *
 * DETERMINISTIC. The result depends only on the shape of `callee` -- never
 * on file order, graph state, resolver caches, target identity or any
 * advisory. The same expression classifies the same way in every scan.
 *
 * PRECEDENCE, when a callee has more than one unmodeled step: the step
 * NEAREST THE CALL wins. `this[key].m()` is an
 * `unsupported_indexed_receiver`, not an `unsupported_this_receiver`,
 * because the value whose member is being called came out of the index --
 * modeling `this` alone would not attribute it. The rule is stated as one
 * sentence so that two constructs can never be ordered differently by two
 * readers.
 */
export function classifyUnsupportedConstruct(
  callee: ts.Expression,
): UnsupportedConstructReason {
  const expression = unwrapExpression(callee);

  // The callee is a bare name the binder could not attribute to an
  // import, a local declaration, a parameter, a builtin or a known global
  // -- `isArray()`, `func()`, `new Ctor()`. The gap is binding
  // attribution, and it is the same gap at a `new` site as at a call site,
  // so the two deliberately share one token: the edge's own `type`
  // ("constructor" vs "direct") already records which site it was, and
  // splitting the reason as well would describe the syntax twice and the
  // modeling gap not at all.
  if (ts.isIdentifier(expression)) {
    return "unsupported_callee_binding";
  }

  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    // Peel every member step whose name is statically readable. What
    // remains is the RECEIVER: the value whose member is being called, and
    // the thing whose provenance the analyzer actually failed to
    // establish. `a.b.c()` peels to `a`; `a.b['c']()` peels to `a`.
    let receiver: ts.Expression = expression;
    while (isStaticallyNamedMemberAccess(receiver)) {
      receiver = unwrapExpression(receiver.expression);
    }

    // Peeling stopped at an element access, so the receiver itself came
    // out of an index the binder cannot read -- `funcs[index].apply()`,
    // `re[TOKEN].exec()`, `m[5].split()`.
    //
    // NOT a duplicate of `dynamic_member_access` (P1-B1 § 34), which names
    // a different construct: there the DYNAMIC PROPERTY IS THE CALLEE
    // (`obj[key]()`), the binder produces it before this fallback is
    // reached, and it stays `value_uncertainty`. Here the dynamic index
    // produced the RECEIVER and the call itself is an ordinary named
    // member access. This file deliberately does not re-route such an
    // occurrence onto the existing token: re-routing would move it to
    // another uncertainty CATEGORY and stop the before/after totals
    // reconciling, which is a semantic change and not the observability
    // change this task is scoped to.
    if (ts.isElementAccessExpression(receiver)) {
      return "unsupported_indexed_receiver";
    }

    // `this.m()`, `super.m()`, `this.options.tagValueProcessor()`. The gap
    // is that no class-instance/receiver model exists, which is different
    // work from attributing a name in scope -- there is no binding to look
    // up.
    if (
      receiver.kind === ts.SyntaxKind.ThisKeyword ||
      receiver.kind === ts.SyntaxKind.SuperKeyword
    ) {
      return "unsupported_this_receiver";
    }

    // `stack.set()`, `func.call()`, `options.decoder()` -- the receiver is
    // a name whose value the analyzer could not trace. The single largest
    // gap in both corpora.
    if (ts.isIdentifier(receiver)) {
      return "unsupported_receiver_binding";
    }

    if (isCallResultValue(receiver)) {
      return "unsupported_call_result_receiver";
    }

    if (isInlineConstructedValue(receiver)) {
      return "unsupported_literal_receiver";
    }

    if (isOperatorExpression(receiver)) {
      return "unsupported_expression_receiver";
    }

    return "unsupported_construct";
  }

  // The callee is not a name and not a member access at all: an
  // immediately-invoked function, a returned function invoked directly
  // (`f()()`), or a function chosen by an operator (`(Map || ListCache)()`).
  if (
    ts.isFunctionExpression(expression) ||
    ts.isArrowFunction(expression) ||
    ts.isClassExpression(expression) ||
    isCallResultValue(expression) ||
    isOperatorExpression(expression)
  ) {
    return "unsupported_computed_callee";
  }

  // The floor. Reached today only by shapes nobody has measured -- in the
  // measured corpora its count is zero (RWF-041 § 6) -- and kept
  // deliberately so that an unmeasured or future construct has somewhere
  // safe to land.
  return "unsupported_construct";
}

/**
 * Structural proof that every subtype this file can return is a real
 * {@link DynamicCallReason}.
 *
 * Renaming or removing one in `domain/graph.ts` without updating this file
 * makes THIS declaration the compile error, naming the token.
 */
const everySubtypeIsADynamicCallReason: readonly DynamicCallReason[] =
  UNSUPPORTED_CONSTRUCT_REASONS;
void everySubtypeIsADynamicCallReason;
