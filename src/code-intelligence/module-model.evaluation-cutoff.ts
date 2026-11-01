/**
 * The module-evaluation cutoff: the first position past which a file's
 * module-scope evaluation may have ended, and the evaluation-time forms that
 * move it.
 *
 * Split out of `module-model.ts` by concern, as a pure move (task BL-121):
 * the declarations below are those of that file, unchanged and in its order.
 * `module-model.ts` re-exports the public ones.
 */
import ts from "typescript";
import { mayContainNestedStatements } from "./module-model.syntax.js";
import {
  isDefinitelyAbruptCall,
  fileHasDefinitelyAbruptCallable,
  isDefinitelyAbruptStaticFieldInitializer,
  isDefinitelyAbruptComputedClassElementKey,
  isDefinitelyAbruptComputedObjectLiteralKey,
  isDefinitelyAbruptCallStatement,
} from "./module-model.abruptness.js";
import { isDefinitelyAbruptClassHeritage } from "./module-model.class-heritage.js";

/**
 * Memoizes {@link firstModuleEvaluationCutoff} per source file. Keyed on
 * the `ts.SourceFile` node itself and weakly held, so the entry dies with
 * the AST it describes and a re-parse of the same path never reads a stale
 * answer. The wrapper object distinguishes "computed, and the answer is
 * `undefined`" (the common case — most files contain no top-level abrupt
 * completion at all) from "not yet computed".
 */
const moduleEvaluationCutoffs = new WeakMap<
  ts.SourceFile,
  { readonly start: number | undefined }
>();

/**
 * The start position of the FIRST top-level statement of `sourceFile` that
 * can end module evaluation before the statement after it begins, or
 * `undefined` when no top-level statement can (RWF-015).
 *
 * Only the first one is needed. Module evaluation runs top-level
 * statements in order, so this position partitions the file: a top-level
 * statement starting before it is reached on every load, and one starting
 * at or after it is reached only on the loads where nothing above it
 * completed abruptly. That is exactly the question
 * {@link isDefinitelyReachedModuleScopeStatement} asks, and answering it
 * with one number rather than a per-statement predicate is what keeps the
 * whole model a single comparison.
 *
 * Deliberately NOT computed over the whole file: it walks each top-level
 * statement's subtree only until it finds an abrupt completion, and stops
 * at the first statement that has one — so it is linear in the file at
 * worst and usually reads much less.
 */
function firstModuleEvaluationCutoff(
  sourceFile: ts.SourceFile,
): number | undefined {
  const cached = moduleEvaluationCutoffs.get(sourceFile);
  if (cached !== undefined) {
    return cached.start;
  }

  // BL-063: a definitely-abrupt call can sit in ANY module-time expression,
  // so a file that has a callable it could reach needs the expression walk.
  // A file with none provably has no such call anywhere (see
  // {@link fileHasDefinitelyAbruptCallable}), which keeps the walk off the
  // hot path exactly as before.
  const abruptCalls = fileHasDefinitelyAbruptCallable(sourceFile);
  const scanExpressions =
    abruptCalls ||
    mayContainClassDefinitionTimeEvaluation(sourceFile) ||
    mayContainObjectLiteralComputedKeyEvaluation(sourceFile);
  let start: number | undefined;
  for (const statement of sourceFile.statements) {
    if (mayEndModuleEvaluation(statement, scanExpressions, abruptCalls)) {
      start = statement.getStart(sourceFile);
      break;
    }
  }

  moduleEvaluationCutoffs.set(sourceFile, { start });
  return start;
}

/**
 * Whether evaluating this one top-level statement can end module
 * evaluation rather than falling through to the next statement (RWF-015;
 * widened by RWF-016, RWF-017, RWF-018, RWF-019, RWF-020 and RWF-024).
 *
 * Three constructs qualify — all of them ABRUPT COMPLETIONS, and the third
 * only when {@link isDefinitelyAbruptCallStatement},
 * {@link isDefinitelyAbruptStaticFieldInitializer},
 * {@link isDefinitelyAbruptComputedClassElementKey},
 * {@link isDefinitelyAbruptComputedObjectLiteralKey} or
 * {@link isDefinitelyAbruptClassHeritage} has PROVEN it is one,
 * never merely suspected it might be:
 *
 * - **`return`** — legal at CommonJS module scope because Node evaluates
 *   the module inside a wrapper function, and ends module evaluation
 *   wherever it appears. A `return` reached by this walk is necessarily a
 *   module-scope one: `return` is a syntax error anywhere but a function
 *   body, and function bodies are not walked into.
 * - **`throw`** whose exception is not caught inside this same statement.
 *   An uncaught module-scope throw propagates out of the `require()` that
 *   started the load, so nothing below it runs either.
 * - **a call to `bail()`** whose callee this file's own text proves is
 *   an exact, non-reassigned local function/arrow that can only ever
 *   itself throw (RWF-016; see {@link isDefinitelyAbruptCallStatement}) —
 *   written either as a bare statement (`bail();`, RWF-016), as a
 *   variable declaration's initializer (`const x = bail();`, RWF-017,
 *   which the language evaluates when the declaration executes), or as a
 *   class STATIC FIELD's initializer (`class C { static x = bail(); }`,
 *   RWF-018, which the language evaluates when the class DEFINITION
 *   executes — see {@link isDefinitelyAbruptStaticFieldInitializer}), or
 *   as any class element's COMPUTED KEY (`class C { [bail()] = 1; }`,
 *   `class C { [bail()]() {} }`, RWF-019, which the language likewise
 *   evaluates when the class DEFINITION executes, for static and instance
 *   elements alike — see
 *   {@link isDefinitelyAbruptComputedClassElementKey}), or as an OBJECT
 *   LITERAL element's COMPUTED KEY (`{ [bail()]: 1 }`, `{ [bail()]() {} }`,
 *   RWF-024, which the language evaluates when the object literal is
 *   constructed, for every element form alike — see
 *   {@link isDefinitelyAbruptComputedObjectLiteralKey}), or as a class's
 *   `extends` HERITAGE expression (`class C extends bail() {}`, RWF-020,
 *   which ClassDefinitionEvaluation evaluates FIRST, before any element
 *   exists — see {@link isDefinitelyAbruptClassHeritage}). Such
 *   a call is exactly as terminal as the literal `throw` inside `bail`'s
 *   body would be if inlined at the call site, and is caught by an
 *   enclosing `try`/`catch` under the identical rule
 *   {@link isCaughtWithin} already applies to a literal `throw`.
 *
 * **The relation is MAY, for expressions as for statements (BL-063,
 * RWF-050).** The named positions above are where RWF-016 … RWF-026 proved
 * the call NECESSARILY runs; they still answer, but they are no longer
 * the limit. Any call, tagged template (BL-065, RWF-095) or construction
 * {@link isDefinitelyAbruptCall} proves can only throw, anywhere this walk
 * reaches at module time, is a
 * cutoff: `FLAG && bail();` is the same program as `if (FLAG) bail();`,
 * and on every load that evaluates `bail()` nothing below it runs. The
 * MUST relation ({@link necessarilyEvaluatesAbruptly}) answered "does this
 * statement necessarily end evaluation?", which is the wrong question for
 * a cutoff; a conditional arm, a short-circuit operand, a logical
 * assignment's right-hand side, an optional-chain-guarded argument, a
 * `do`/`while` condition and a `for` incrementor were each a live false
 * `NOT_AFFECTED` under it. The positions module evaluation never
 * evaluates are excluded by {@link isNeverEvaluatedAtModuleTime}.
 *
 * What is deliberately NOT modeled, because the answer would need
 * semantics this relation does not have:
 *
 * - **`process.exit()`, `assert(...)`, or any other call whose callee is
 *   not an exact local definitely-abrupt function.** Whether a call
 *   returns is a property of the function it reaches, not of the call
 *   syntax in general. Treating an arbitrary call as a possible terminator
 *   would make almost every real module's exports unattributable and would
 *   still be a guess; RWF-016's exception is narrow by construction
 *   because it is not a guess — see {@link cannotCompleteNormally}.
 * - **`break` / `continue`.** These transfer control WITHIN the enclosing
 *   loop, switch or labeled statement — which, for a top-level `break`,
 *   is inside this same statement. Execution continues with the next
 *   top-level statement either way, so they are not module-terminating and
 *   are not treated as such. (Outside a loop/switch/label they are a
 *   syntax error, so there is no third case.)
 *
 * The walk stops at every function-like node — function and method bodies,
 * arrow bodies, accessors — because a `return`/`throw` inside one belongs
 * to THAT function's execution, which may be an importer calling it long
 * after this module finished loading, or may never happen at all:
 *
 * ```js
 * function configure() { throw new Error("not configured"); }
 * module.exports = b;   // still definitely reached; `configure` has not run
 * ```
 *
 * Class bodies are NOT skipped, for the symmetric reason: a
 * `static { ... }` block, a `static x = ...` FIELD INITIALIZER, any
 * element's COMPUTED KEY and the class's own `extends` HERITAGE
 * expression all run at class-definition time, i.e. during
 * module evaluation, so an abrupt completion in any of them really can
 * abort the load (RWF-018, RWF-019, RWF-020). Method and accessor BODIES inside
 * that same class body are skipped by the function-like test, as they
 * should be — but their computed KEYS are not, which is why
 * {@link isDefinitelyAbruptComputedClassElementKey} is asked before that
 * test rather than after it. And so — for the opposite reason — the
 * per-instance execution of an INSTANCE field initializer is skipped,
 * which {@link isDefinitelyAbruptStaticFieldInitializer} declines to act
 * on even though that same element's computed key is acted on.
 *
 * OBJECT LITERALS are not a statement-container form at all — they are
 * ordinary expressions, reached only once {@code scanExpressions} is true
 * — but once reached, the same asymmetry holds for the same reason: a
 * `PropertyAssignment`/`MethodDeclaration`/`GetAccessorDeclaration`/
 * `SetAccessorDeclaration`'s computed KEY runs while the object literal is
 * being constructed, so {@link isDefinitelyAbruptComputedObjectLiteralKey}
 * is likewise asked before the function-like stop, while a method/getter/
 * setter's BODY is skipped by that same stop (RWF-024).
 *
 * An IIFE is skipped along with every other function expression. That is
 * the conservative direction here rather than the risky one: skipping it
 * can only make this relation report FEWER cutoffs, so the worst case is
 * a bypassable write treated as definitely reached — which is precisely
 * the unsound direction. It is accepted deliberately and narrowly: a
 * `throw` inside an IIFE does abort module evaluation, but an IIFE's
 * `return` does not, and telling the two apart means proving the function
 * expression is invoked immediately — call-graph work, and the same line
 * {@link classifyWholeModuleExportAuthority} already draws by classifying
 * an IIFE-nested write as `"deferred"`. A module that guards its exports
 * with a throwing IIFE and then rewrites `module.exports` below it is not
 * a shape this analyzer claims to model; see RWF-015's remaining-limitations
 * note in tests/validation/FINDINGS.md.
 */
function mayEndModuleEvaluation(
  statement: ts.Statement,
  scanExpressions: boolean,
  abruptCalls: boolean,
): boolean {
  let found = false;

  function visit(node: ts.Node): void {
    if (found) {
      return;
    }
    // BL-063 (RWF-050): the MAY relation, for expressions as for
    // statements. A call or construction {@link isDefinitelyAbruptCall}
    // proves can only throw ends module evaluation on every load that
    // evaluates it, so wherever this walk reaches one -- a `&&`'s right
    // operand, a conditional arm, a logical assignment's right-hand side,
    // an optional-chain-guarded argument, a `do`/`while` condition, a
    // `for` incrementor -- it is a cutoff, exactly as `if (flag) bail();`
    // already is. Whether the position is NECESSARILY evaluated is
    // RWF-026's MUST question and is not asked here: "may end" needs only
    // "may be evaluated at module time", which is what reaching it in this
    // walk means. A function-like node's body and parameters are never
    // reached (the stop below); the two other positions this walk does
    // reach but module evaluation never evaluates are excluded by
    // {@link isNeverEvaluatedAtModuleTime}. A tagged template calls its
    // tag, so it is an invocation here too (BL-065, RWF-095).
    if (
      abruptCalls &&
      (ts.isCallExpression(node) ||
        ts.isTaggedTemplateExpression(node) ||
        ts.isNewExpression(node)) &&
      isDefinitelyAbruptCall(node) &&
      !isCaughtWithin(node, statement) &&
      !isNeverEvaluatedAtModuleTime(node, statement)
    ) {
      found = true;
      return;
    }
    // Asked BEFORE the function-like stop below, and that order is the
    // whole point: a computed METHOD/ACCESSOR key (`[bail()]() {}`) hangs
    // off a node that IS function-like, so testing it after the stop would
    // never see it. The stop still applies to the element's BODY, which is
    // what it is for — see {@link isDefinitelyAbruptComputedClassElementKey}.
    if (
      isDefinitelyAbruptComputedClassElementKey(node) &&
      !isCaughtWithin(node, statement)
    ) {
      found = true;
      return;
    }
    // Same reasoning, same ordering requirement, for an OBJECT LITERAL's
    // computed key (`{ [bail()]: 1 }`, `{ [bail()]() {} }`) — see
    // {@link isDefinitelyAbruptComputedObjectLiteralKey} (RWF-024).
    if (
      isDefinitelyAbruptComputedObjectLiteralKey(node) &&
      !isCaughtWithin(node, statement)
    ) {
      found = true;
      return;
    }
    if (ts.isFunctionLike(node)) {
      // BL-063: a method's or accessor's computed KEY runs when the class
      // or object literal is defined, whatever the body does later; for
      // the MAY relation it is walked like any other module-time
      // expression (`[flag && bail()]() {}`). The body is not.
      if (node.name !== undefined && ts.isComputedPropertyName(node.name)) {
        visit(node.name);
      }
      return;
    }
    if (
      ts.isReturnStatement(node) ||
      (ts.isThrowStatement(node) && !isCaughtWithin(node, statement)) ||
      ((isDefinitelyAbruptCallStatement(node, abruptCalls) ||
        isDefinitelyAbruptStaticFieldInitializer(node) ||
        isDefinitelyAbruptClassHeritage(node)) &&
        !isCaughtWithin(node, statement))
    ) {
      found = true;
      return;
    }
    if (scanExpressions || mayContainNestedStatements(node)) {
      ts.forEachChild(node, visit);
    }
  }

  visit(statement);
  return found;
}

/**
 * Whether `node`, reached by {@link mayEndModuleEvaluation}'s walk inside
 * the top-level statement `boundary`, sits in a position module
 * evaluation never evaluates (BL-063). The walk does not enter
 * function-like nodes; these are the two positions outside one that it
 * does enter:
 *
 * - **an instance field's initializer** (`class C { f = bail(); }`). It
 *   runs per construction, not when the class is defined (RWF-018's line),
 *   so defining the class runs nothing there. A `static` field's runs at
 *   definition time and is not excluded.
 * - **a `for` incrementor or a `do`/`while` condition whose loop body
 *   always leaves by `break` first** (`for (;; bail()) { break; }`,
 *   `do { break; } while (bail());`). Both run only after the body
 *   completes normally or `continue`s (ForBodyEvaluation and
 *   DoWhileStatement's evaluation: a `break` completion ends the loop
 *   before either is evaluated); see {@link bodyAlwaysBreaks}.
 *
 * Asked only for the MAY call check, never for `return`/`throw` or the
 * MUST predicates: those keep the walk's earlier reach unchanged.
 */
function isNeverEvaluatedAtModuleTime(
  node: ts.Node,
  boundary: ts.Statement,
): boolean {
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent as ts.Node | undefined;

  while (parent !== undefined && child !== boundary) {
    if (
      ts.isPropertyDeclaration(parent) &&
      parent.initializer === child &&
      ts
        .getModifiers(parent)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) !==
        true
    ) {
      return true;
    }
    if (
      ts.isForStatement(parent) &&
      parent.incrementor === child &&
      bodyAlwaysBreaks(parent.statement)
    ) {
      return true;
    }
    if (
      ts.isDoStatement(parent) &&
      parent.expression === child &&
      bodyAlwaysBreaks(parent.statement)
    ) {
      return true;
    }
    child = parent;
    parent = parent.parent as ts.Node | undefined;
  }

  return false;
}

/**
 * Whether a loop body always ends its iteration with a `break` before it
 * can complete normally or `continue` (BL-063), so that a `for`
 * incrementor or a `do`/`while` condition after it is never evaluated.
 *
 * Narrow by construction: the body is a `break`, or a block with a `break`
 * among its own statements and no `continue` anywhere in the statements
 * before it (outside function bodies, and whatever loop the `continue`
 * targets). The statements before the `break` either complete normally
 * (so the `break` runs and leaves the loop), or complete abruptly by
 * `break` (the loop is left), `return` or `throw` (the module is left).
 * Only a `continue` can reach the incrementor or condition, and any one
 * refuses. A labeled `break` is fine: every label that can enclose it
 * labels this loop or a statement around it, and leaving either leaves
 * the loop.
 */
function bodyAlwaysBreaks(body: ts.Statement): boolean {
  if (ts.isBreakStatement(body)) {
    return true;
  }
  if (!ts.isBlock(body)) {
    return false;
  }
  for (const statement of body.statements) {
    if (ts.isBreakStatement(statement)) {
      return true;
    }
    if (containsContinue(statement)) {
      return false;
    }
  }
  return false;
}

function containsContinue(node: ts.Node): boolean {
  if (ts.isContinueStatement(node)) {
    return true;
  }
  if (ts.isFunctionLike(node)) {
    return false;
  }
  return ts.forEachChild(node, containsContinue) === true;
}

/**
 * Whether this file could contain ANY construct that executes at
 * class-definition time — the gate {@link firstModuleEvaluationCutoff}
 * uses, widened from {@link mayContainClassStaticEvaluation} by RWF-019.
 *
 * RWF-015/018's `static` test was complete for the two constructs known
 * then (a `static { ... }` block and a `static x = ...` field
 * initializer), because neither can be written without that token.
 * RWF-019 adds a third, and it has no `static` in it at all:
 *
 * ```js
 * class C { [bail()] = 1; }   // computed KEY -- runs at class-definition time
 * ```
 *
 * RWF-020 adds a fourth, the class's own `extends` expression, which has
 * no `static` in it either:
 *
 * ```js
 * class C extends bail() {}   // heritage -- runs at class-definition time
 * ```
 *
 * All four do share the `class` keyword, though — there is no other way
 * to write a class in the language — so one token still gates all of them,
 * and `class` is the token that actually names the construct doing the
 * executing. It stays a sound over-approximation in the same way the
 * narrower test was: a `class` in a comment or a string costs that one
 * file the full expression walk and changes no answer, while a file
 * containing no `class` at all provably has no class-definition-time
 * evaluation to find, which keeps the cheap statement-position walk
 * exactly complete rather than merely close.
 *
 * Deliberately NOT shared with {@link reassignedModuleReachableNames},
 * which keeps the narrower `static` gate. Widening a walk that looks for
 * ABRUPT COMPLETIONS can only find more cutoffs, i.e. refuse more exports
 * — the safe direction. Widening the walk that looks for REASSIGNMENTS
 * runs the other way: a name it newly marks as reassigned makes
 * {@link resolveExactLocalCallable} refuse a callee and REMOVES a cutoff,
 * which would turn a refused export into an attributed one. RWF-019 is a
 * soundness fix and takes no movement in that direction, so the two gates
 * are separate on purpose.
 */
function mayContainClassDefinitionTimeEvaluation(
  sourceFile: ts.SourceFile,
): boolean {
  return /\bclass\b/.test(sourceFile.text);
}

/**
 * Whether this file could contain an OBJECT LITERAL's computed property
 * name — the gate {@link firstModuleEvaluationCutoff} widens with, in
 * addition to {@link mayContainClassDefinitionTimeEvaluation}, for RWF-024.
 *
 * A class needs the literal token `class` to exist at all, which is what
 * makes that gate a sound, cheap text test. An object literal's computed
 * key has no comparable keyword: `{ [bail()]: 1 }` is written with nothing
 * but a `[` — the same token an array literal or an index expression uses.
 * So this test cannot be as tight as the `class` one; it is a coarser sound
 * over-approximation, exactly like the file that widened from `static` to
 * `class` before it (RWF-019's {@link mayContainClassDefinitionTimeEvaluation}
 * docs). A `[` used only for an array or an ordinary index access costs
 * that one file the full expression walk in {@link mayEndModuleEvaluation}
 * and changes no answer, while a file containing no `[` at all provably has
 * no object-literal computed key to find. Correctness never depends on this
 * test alone — {@link isDefinitelyAbruptComputedObjectLiteralKey} still
 * re-checks the exact AST shape on every node this walk actually reaches —
 * so a wider net here can only cost time, never soundness.
 */
function mayContainObjectLiteralComputedKeyEvaluation(
  sourceFile: ts.SourceFile,
): boolean {
  return sourceFile.text.includes("[");
}

/**
 * Whether `node`'s abrupt completion is caught by a `try`/`catch` lying
 * between it and `boundary` (RWF-015; widened by RWF-016) — the one piece
 * of real control-flow semantics this model needs, and the reason a file
 * that merely CONTAINS a `throw` does not lose its exports:
 *
 * ```js
 * try { if (flag) { throw err; } } catch { }
 * module.exports = b;   // still definitely reached -- the throw is handled
 * ```
 *
 * A `throw` counts as caught only when an enclosing `try` has a `catch`
 * clause AND the throw is inside that `try`'s own block. Both halves
 * matter and both are the conservative reading:
 *
 * - a `try { ... } finally { ... }` with no `catch` does not stop the
 *   exception, so a throw inside it still ends module evaluation;
 * - a throw inside a CATCH or FINALLY clause is not caught by its own
 *   `try` — `catch (e) { throw e; }` rethrows, and the rethrow ends module
 *   evaluation exactly as the original would have.
 *
 * Both of those keep working when nested, because the walk continues
 * outward: a rethrow inside an inner `catch` that itself sits in an outer
 * `try`'s block is caught by the outer one, and reported as caught.
 *
 * `boundary` is the top-level statement being classified. There is never a
 * `try` above it — a `try` spanning several statements IS a single
 * top-level `TryStatement`, and its contents are walked as part of it — so
 * the boundary is a stop condition rather than a semantic limit.
 *
 * `node` was a `ts.ThrowStatement` for every RWF-015 call site; RWF-016
 * widens the parameter to `ts.Node` so the exact same ancestry walk can
 * also answer the question for a definitely-abrupt CALL statement (e.g.
 * `bail();`), which propagates its callee's abrupt completion out to
 * whichever `try` (if any) encloses the call, exactly as a literal `throw`
 * would. The walk itself only ever inspects `node.parent`, so it is
 * correct for either input unchanged.
 */
function isCaughtWithin(node: ts.Node, boundary: ts.Statement): boolean {
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent as ts.Node | undefined;

  while (parent !== undefined) {
    if (
      ts.isTryStatement(parent) &&
      parent.catchClause !== undefined &&
      parent.tryBlock === child
    ) {
      return true;
    }
    if (parent === boundary) {
      return false;
    }
    child = parent;
    parent = parent.parent as ts.Node | undefined;
  }

  return false;
}

export { firstModuleEvaluationCutoff };
