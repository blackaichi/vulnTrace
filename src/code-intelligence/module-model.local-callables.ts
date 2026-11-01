/**
 * Local reassignment and local callables: which module-reachable names a
 * file reassigns, and the bounded resolution of an invocation to the exact
 * local callable it calls (RWF-028).
 *
 * Split out of `module-model.ts` by concern, as a pure move (task BL-121):
 * the declarations below are those of that file, unchanged and in its order.
 * `module-model.ts` re-exports the public ones.
 */
import ts from "typescript";
import { unwrapParentheses } from "./commonjs-reexports.js";
import {
  mayContainNestedStatements,
  mayContainClassStaticEvaluation,
  isAssignmentOperatorToken,
  isWriteTargetPosition,
} from "./module-model.syntax.js";
import { topLevelCallableCandidates } from "./module-model.module-scope.js";

/** Every identifier a binding name introduces, however nested (`{ a, b: [c] }`). */
function bindingNameIncludes(name: ts.BindingName, target: string): boolean {
  if (ts.isIdentifier(name)) {
    return name.text === target;
  }
  for (const element of name.elements) {
    if (
      ts.isBindingElement(element) &&
      bindingNameIncludes(element.name, target)
    ) {
      return true;
    }
  }
  return false;
}

/** Whether `list` declares `name`, through any binding pattern. */
function declarationListDeclares(
  list: ts.VariableDeclarationList,
  name: string,
): boolean {
  for (const decl of list.declarations) {
    if (bindingNameIncludes(decl.name, name)) {
      return true;
    }
  }
  return false;
}

/**
 * Strips the wrappers that may sit between an assignment target and the
 * target itself without changing WHICH storage location is written —
 * parentheses (`(x) = 1`, `({ a: (x) } = o)`) and TypeScript's own
 * type-only wrappers (`x! = 1`, `(x as T) = 1`). Deliberately a
 * SYNTACTIC unwrap of one node's `.expression`, never a walk of children:
 * chasing children is exactly the defect {@link markLocallyReassigned}
 * exists to avoid (RWF-025).
 */
function unwrapAssignmentTarget(target: ts.Node): ts.Node {
  let current = target;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * Marks every LOCAL BINDING `target` — an assignment/update expression's
 * left-hand side, or a `for..in`/`for..of` non-declaration initializer —
 * rebinds, however nested (`[a] = ...`, `({ b: { c } } = ...)`,
 * `({ ...rest } = ...)`).
 *
 * RWF-025. The recursion descends through ASSIGNMENT-TARGET STRUCTURE
 * ONLY, never through arbitrary children, because an assignment target's
 * AST also contains expressions that are merely EVALUATED while the
 * target is resolved, and those bind nothing:
 *
 * ```js
 * ({ [bail()]: x } = source);   // `x` is rebound; `bail` is CALLED
 * ({ x = fallback() } = source); // `x` is rebound; `fallback` is CALLED
 * [holder[bail()]] = values;     // NOTHING local is rebound
 * obj[bail()] = value;           // NOTHING local is rebound
 * obj.bail = value;              // NOTHING local is rebound
 * ```
 *
 * A previous `ts.forEachChild` fallback here recorded EVERY identifier
 * under the target, so a computed key's callee (`bail`) was recorded as
 * locally reassigned. Because {@link reassignedModuleReachableNames}
 * caches its result per SOURCE FILE, one such unrelated destructuring
 * statement anywhere in a file made
 * {@link resolveExactLocalCallable} refuse that name FILE-WIDE, silently
 * withdrawing RWF-016/017/019/020/022/024's abrupt-completion cutoffs and
 * turning a sound UNKNOWN back into a false NOT_AFFECTED.
 *
 * The roles are distinguished, not suppressed wholesale: in
 * `({ [bail()]: bail } = source)` the computed KEY does not rebind
 * `bail`, but the property VALUE target does, so `bail` is still marked.
 *
 * Property MUTATION (`x.y = ...`, `x[k] = ...`) is excluded for the
 * reason it always was: it changes the object, not the binding — and
 * neither the object expression nor the index expression is a local
 * binding this relation may claim was reassigned.
 *
 * Those evaluated-only positions are not ignored, though — they are handed
 * to {@link markAssignmentsInsideEvaluatedExpression}, which records the
 * assignments they PERFORM without recording the names they merely READ.
 * The two traversals answer two different questions and are deliberately
 * separate; collapsing them in either direction is a defect (see that
 * function's own doc comment).
 */
function markLocallyReassigned(target: ts.Node, into: Set<string>): void {
  const unwrapped = unwrapAssignmentTarget(target);

  if (ts.isIdentifier(unwrapped)) {
    into.add(unwrapped.text);
    return;
  }

  if (ts.isObjectLiteralExpression(unwrapped)) {
    for (const property of unwrapped.properties) {
      if (ts.isPropertyAssignment(property)) {
        // `property.name` SELECTS which source property is read. A
        // computed one is an expression evaluated to produce that key —
        // never an assignment destination. Only the initializer is one.
        if (ts.isComputedPropertyName(property.name)) {
          markAssignmentsInsideEvaluatedExpression(
            property.name.expression,
            into,
          );
        }
        markLocallyReassigned(property.initializer, into);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        // `({ x } = o)` and `({ x = fallback() } = o)`: the NAME is the
        // target; `objectAssignmentInitializer` is a default VALUE.
        into.add(property.name.text);
        if (property.objectAssignmentInitializer) {
          markAssignmentsInsideEvaluatedExpression(
            property.objectAssignmentInitializer,
            into,
          );
        }
      } else if (ts.isSpreadAssignment(property)) {
        markLocallyReassigned(property.expression, into);
      }
    }
    return;
  }

  if (ts.isArrayLiteralExpression(unwrapped)) {
    for (const element of unwrapped.elements) {
      if (ts.isOmittedExpression(element)) {
        continue;
      }
      if (ts.isSpreadElement(element)) {
        markLocallyReassigned(element.expression, into);
        continue;
      }
      markLocallyReassigned(element, into);
    }
    return;
  }

  // A defaulted element of a destructuring target — `[x = d] = ...`,
  // `({ a: x = d } = ...)`. Only the left side is rebound; `d` is a value
  // the language may evaluate, exactly like a computed key's expression.
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    markLocallyReassigned(unwrapped.left, into);
    markAssignmentsInsideEvaluatedExpression(unwrapped.right, into);
    return;
  }

  // Property MUTATION. Neither the object expression nor the index is a
  // local binding this assignment rebinds — but both are EVALUATED, so an
  // assignment written inside either one really does run.
  if (ts.isElementAccessExpression(unwrapped)) {
    markAssignmentsInsideEvaluatedExpression(unwrapped.expression, into);
    markAssignmentsInsideEvaluatedExpression(
      unwrapped.argumentExpression,
      into,
    );
    return;
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    markAssignmentsInsideEvaluatedExpression(unwrapped.expression, into);
    return;
  }

  // Everything else — any shape that is not an assignment target at all —
  // rebinds no local binding, so it contributes no name.
}

/**
 * Records the assignments an EVALUATED-ONLY expression PERFORMS, and
 * nothing else.
 *
 * {@link markLocallyReassigned} answers "which local bindings does this
 * assignment TARGET rebind?" and must therefore never look at a computed
 * key, a default initializer or an element-access index. But those
 * expressions still RUN, and one of them may itself contain an
 * assignment:
 *
 * ```js
 * ({ [(bail = safe)]: x } = source);   // `x` AND `bail` are rebound
 * ({ x = (bail = safe) } = source);    // `x` AND `bail` are rebound
 * holder[(bail = safe)] = value;       // `bail` is rebound
 * ```
 *
 * so this second traversal exists to catch exactly those. The two are
 * separate on purpose, and collapsing them in EITHER direction is a
 * defect:
 *
 * - walking every child and recording every identifier is RWF-025's
 *   original defect — it made `({ [bail()]: x } = source)` record `bail`;
 * - not walking the evaluated expression at all misses a genuine
 *   reassignment and lets a stale throwing declaration be trusted.
 *
 * The rule that separates them: this walk descends through children only
 * to FIND assignment and update OPERATIONS, and collects names only from
 * their targets, via {@link markLocallyReassigned}. A bare identifier is
 * never collected — `bail = safe` records `bail` and not `safe`, and
 * `bail()` records nothing at all. A right-hand side is re-entered only to
 * find further nested assignments (`a = (b = safe)` records `a` and `b`).
 *
 * Function bodies are not descended into, exactly as
 * {@link reassignedModuleReachableNames}'s own walk does not: an
 * assignment that only runs when some function is CALLED is outside
 * RWF-016's module-evaluation reach model, and this relation does not
 * widen that model.
 */
function markAssignmentsInsideEvaluatedExpression(
  node: ts.Node,
  into: Set<string>,
): void {
  if (ts.isFunctionLike(node)) {
    return;
  }

  if (
    ts.isBinaryExpression(node) &&
    isAssignmentOperatorToken(node.operatorToken.kind)
  ) {
    // `=`, `+=`, `||=`, `??=`, ... — the same operator relation the
    // statement-level check uses, by SyntaxKind and never by text.
    markLocallyReassigned(node.left, into);
    markAssignmentsInsideEvaluatedExpression(node.right, into);
    return;
  }

  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    markLocallyReassigned(node.operand, into);
    return;
  }

  ts.forEachChild(node, (child) =>
    markAssignmentsInsideEvaluatedExpression(child, into),
  );
}

/**
 * Every name reassigned (`name = ...`, `name += ...`, `++name`, a
 * destructuring assignment target, a `for..of`/`for..in` loop variable)
 * ANYWHERE within the region module evaluation can reach WITHOUT calling
 * into a function (RWF-016) — the exact same reach model
 * {@link mayEndModuleEvaluation} already uses (a `return`/`throw`
 * anywhere in this same region ends module evaluation; a reassignment
 * anywhere in it can run before a later call), for the identical reason:
 * a reassignment that only runs if some OTHER function is called first is
 * not something this relation reasons about, exactly as it does not
 * reason about a THROW inside one (see {@link mayEndModuleEvaluation}'s
 * own doc comment) or about a transitive call chain (RWF-016's own
 * remaining-limitations note in tests/validation/FINDINGS.md). Missing
 * such a reassignment only ever makes this relation MORE conservative —
 * it may still treat a callee as definitely abrupt when a deferred
 * reassignment would in fact have changed what the name holds by the time
 * the call runs — never less sound: the worst case is an UNKNOWN this
 * relation could have avoided attributing away from, never a wrongly
 * attributed later export.
 *
 * Restricting the walk to this reach model (rather than the whole file,
 * any scope, the way {@link classifyLocalBinding}'s single-assignment
 * proof does for a completely different question) is also what keeps it
 * cheap: like {@link mayEndModuleEvaluation}, it never descends into a
 * function body or an expression tree, so a file dominated by
 * call-expression statements and object literals (real modules, and the
 * scan-performance suite's own synthetic worst case) costs one
 * statement-kind check per top-level statement, never a walk of the whole
 * expression forest underneath them.
 */
const reassignedModuleReachableNamesBySourceFile = new WeakMap<
  ts.SourceFile,
  ReadonlySet<string>
>();

function reassignedModuleReachableNames(
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const cached = reassignedModuleReachableNamesBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }

  const scanExpressions = mayContainClassStaticEvaluation(sourceFile);
  const reassigned = new Set<string>();

  /**
   * Checks a bare EXPRESSION-statement's own top-level shape for an
   * assignment/increment/decrement — `bail = other;`, `bail += 1;`,
   * `bail++;`. This is deliberately the ONLY place an expression is
   * inspected: an `ExpressionStatement` is not itself a container
   * {@link mayContainNestedStatements} descends into (by design — see its
   * own doc comment), so without this direct check a top-level
   * reassignment would never be seen at all. An assignment BURIED inside a
   * larger expression (`foo(bail = other)`) is deliberately not chased
   * further than this — missing one only makes this relation treat a
   * callee as definitely abrupt when a reassignment would in fact have
   * changed it, which costs precision, never soundness (see this
   * function's own doc comment).
   */
  function checkAssignmentLike(expr: ts.Expression): void {
    const unwrapped = unwrapParentheses(expr);
    if (
      ts.isBinaryExpression(unwrapped) &&
      isAssignmentOperatorToken(unwrapped.operatorToken.kind)
    ) {
      markLocallyReassigned(unwrapped.left, reassigned);
    } else if (
      (ts.isPrefixUnaryExpression(unwrapped) ||
        ts.isPostfixUnaryExpression(unwrapped)) &&
      (unwrapped.operator === ts.SyntaxKind.PlusPlusToken ||
        unwrapped.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      markLocallyReassigned(unwrapped.operand, reassigned);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isExpressionStatement(node)) {
      checkAssignmentLike(node.expression);
    } else if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      markLocallyReassigned(node.initializer, reassigned);
    }
    if (
      scanExpressions ||
      mayContainNestedStatements(node) ||
      ts.isSourceFile(node)
    ) {
      ts.forEachChild(node, visit);
    }
  }

  visit(sourceFile);
  reassignedModuleReachableNamesBySourceFile.set(sourceFile, reassigned);
  return reassigned;
}

/**
 * Whether `fn` is `async` or a generator (RWF-016) — either one means
 * calling it can never itself be the abrupt completion this relation
 * models:
 *
 * - an `async` function's body runs synchronously only up to its first
 *   `await`/return/throw, but a synchronous `throw` inside one is caught
 *   by the implicit promise wrapper and turned into a REJECTED PROMISE,
 *   not a synchronous exception. The call `bail()` returns normally (with
 *   a promise) and module evaluation continues; only an unawaited
 *   rejection surfaces later, asynchronously, which cannot invalidate a
 *   synchronous later export write.
 * - a generator function's body does not run AT ALL when called — calling
 *   `bail()` only constructs a generator object; the body (and any throw
 *   in it) executes on `.next()`, if ever.
 *
 * Treating either as definitely abrupt would be exactly the unsound
 * over-inference RWF-016 exists to avoid.
 */
function isAsyncOrGeneratorCallable(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): boolean {
  const isGenerator =
    (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) &&
    fn.asteriskToken !== undefined;
  const isAsync =
    ts.canHaveModifiers(fn) &&
    (ts
      .getModifiers(fn)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ??
      false);
  return isGenerator || isAsync;
}

/** The statement list `node` directly, LEXICALLY owns as its own scope's body — never a NESTED block's statements. `undefined` for anything that owns no such list. */
function ownStatementsOf(node: ts.Node): readonly ts.Statement[] | undefined {
  if (ts.isBlock(node) || ts.isSourceFile(node)) {
    return node.statements;
  }
  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    return node.statements;
  }
  return undefined;
}

/**
 * Whether `ancestor` — one node on the walk from a call site up toward the
 * module's own top level — itself directly declares a binding named
 * `name` (RWF-016), shadowing anything declared further out. Checked
 * against a `catch` clause's own parameter, a FUNCTION-LIKE scope's own
 * parameters and self-name, a `for`/`for..of`/`for..in` loop's own
 * declaration, and — for every other scope-bearing ancestor — that
 * scope's OWN statement list (never a further-nested block's, which the
 * walk will visit on its own next iteration).
 *
 * The function-like case was added by RWF-028's remediation, and the
 * reason it was not needed before is worth recording: until RWF-028 this
 * walk only ever started at a MODULE-SCOPE call site, so a function-like
 * node could never be one of the ancestors it visited. RWF-028's wrapper
 * analysis is the first consumer that resolves an identifier from INSIDE
 * a function body, and without this case the walk stepped straight over
 * the function boundary out to module scope:
 *
 * ```js
 * function bail() { throw new Error("boom"); }
 * function w(bail) { bail(); }   // the PARAMETER, not the outer callable
 * w(safeFn);                     // ...so this completes
 * ```
 *
 * Resolving that body's `bail()` to the outer, throwing `bail` withdrew a
 * later export's authority from a module that runs to completion — a
 * false AFFECTED. The fix belongs here, at the shared lexical-declaration
 * boundary, rather than in the wrapper resolver: every consumer of this
 * walk asks the same question, and a wrapper-specific name check would
 * leave the abstraction wrong for the next one.
 *
 * Note what this case does and does NOT do. It makes a parameter a
 * SHADOWING BARRIER — ancestor lookup stops, and the answer is
 * `undefined` — and nothing more. A parameter is never itself an exact
 * callable: this relation does not map call-site arguments onto
 * parameters, so `function w(bail) { bail(); } w(realThrower);` is
 * refused rather than proven, which is the same answer base gives and the
 * only sound one without interprocedural value flow.
 */
function scopeDeclares(ancestor: ts.Node, name: string): boolean {
  if (ts.isFunctionLike(ancestor)) {
    for (const parameter of ancestor.parameters) {
      if (bindingNameIncludes(parameter.name, name)) {
        return true;
      }
    }
    // A named function EXPRESSION binds its own name inside its own body
    // and nowhere else: in `const w = function bail() { bail(); }` the
    // inner `bail` is the function expression itself. This is reached
    // only for an ancestor of the call site, so the name cannot leak to
    // surrounding code — `const w = function f() {}; f();` never visits
    // the expression at all and still resolves nothing.
    //
    // A function DECLARATION is deliberately absent: its name belongs to
    // the ENCLOSING scope's statement list, which the generic path below
    // already reads, and claiming it here too would change nothing except
    // to blur where the binding actually lives.
    if (ts.isFunctionExpression(ancestor) && ancestor.name?.text === name) {
      return true;
    }
  }
  if (ts.isCatchClause(ancestor)) {
    return (
      ancestor.variableDeclaration !== undefined &&
      bindingNameIncludes(ancestor.variableDeclaration.name, name)
    );
  }
  if (
    (ts.isForOfStatement(ancestor) || ts.isForInStatement(ancestor)) &&
    ts.isVariableDeclarationList(ancestor.initializer)
  ) {
    return declarationListDeclares(ancestor.initializer, name);
  }
  if (
    ts.isForStatement(ancestor) &&
    ancestor.initializer !== undefined &&
    ts.isVariableDeclarationList(ancestor.initializer)
  ) {
    return declarationListDeclares(ancestor.initializer, name);
  }

  const statements = ownStatementsOf(ancestor);
  if (statements === undefined) {
    return false;
  }
  for (const statement of statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return true;
    }
    if (
      ts.isVariableStatement(statement) &&
      declarationListDeclares(statement.declarationList, name)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The exact function/arrow node a module-scope call `name()`, made from
 * `callee`'s position, proves it invokes (RWF-016) — `undefined` for
 * every case this relation is not willing to guess about.
 *
 * Three independent proofs must all hold:
 *
 * 1. **No real lexical shadow.** Walking from `callee` up to (but not
 *    including) the source file, no intervening scope may declare `name`
 *    — a `catch` parameter, a `for` loop variable, or a block/case-clause
 *    declaration ({@link scopeDeclares}). This is genuine JS lexical
 *    scoping, not a whole-file guess: it is bounded by `callee`'s own
 *    nesting depth, which {@link mayEndModuleEvaluation}'s own reach model
 *    already keeps shallow (a call site inside a function body is never
 *    even offered to this relation — see its call site in
 *    `isDefinitelyAbruptCallStatement`).
 * 2. **Never reassigned** within the reach {@link mayEndModuleEvaluation}
 *    already models ({@link reassignedModuleReachableNames}) — a
 *    `function bail() {}` declaration can be reassigned too, and a `const`
 *    candidate is exempted by construction (see
 *    {@link topLevelCallableCandidates}'s own doc comment).
 * 3. **A supported module-TOP-LEVEL callable shape actually exists**
 *    ({@link topLevelCallableCandidates}), and is neither `async` nor a
 *    generator ({@link isAsyncOrGeneratorCallable}).
 *
 * RWF-016 accepted only a plain identifier callee bound DIRECTLY to a
 * function/arrow. RWF-028 widens the IDENTITY half — and only that half —
 * to the bounded alias, object-member and lexical-shadow provenance forms
 * {@link resolveInvocationTargetIdentity} documents. The `async`/generator
 * exclusion below, and every caller's proof obligation above it, are
 * unchanged.
 */
function resolveExactLocalCallable(
  callee: ts.Expression,
):
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | undefined {
  const candidate = resolveInvocationTargetIdentity(callee);
  if (candidate === undefined || isAsyncOrGeneratorCallable(candidate)) {
    return undefined;
  }
  return candidate;
}

/**
 * The IDENTITY half of {@link resolveExactLocalCallable}'s proof, without
 * its `async`/generator exclusion — factored out by RWF-022, which needs
 * the same "this call site provably invokes exactly THIS function node"
 * answer for a callee that RWF-016 has to refuse.
 *
 * The three identity proofs are unchanged and shared verbatim: no real
 * lexical shadow between the call site and the file ({@link scopeDeclares}),
 * never reassigned within the modeled reach
 * ({@link reassignedModuleReachableNames}), and a supported module-top-level
 * callable shape actually exists ({@link topLevelCallableCandidates}).
 *
 * The `async`/generator exclusion is NOT part of identity — it is a
 * statement about what CALLING the resolved function does, and the two
 * callers want opposite answers to it:
 *
 * - RWF-016's {@link cannotCompleteNormally} asks "can this call itself
 *   throw?", and for `async`/generator the answer is provably NO (a
 *   rejected promise, an unstarted generator), so it must refuse;
 * - RWF-022's {@link classifyExactCallReturnValue} asks "what does this
 *   call RETURN?", and for `async`/generator the answer is provably a
 *   `Promise` / generator object — neither of which is a constructor —
 *   so it is exactly the case it can decide most cheaply.
 *
 * Keeping the exclusion in the wrapper rather than here is what stops the
 * two questions from being conflated: {@link resolveExactLocalCallable}'s
 * behavior, and therefore every RWF-016/017/018/019/020 answer, is
 * bit-for-bit what it was.
 */
function resolveExactLocalCallableIdentity(
  callee: ts.Identifier,
):
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | undefined {
  const name = callee.text;

  for (
    let ancestor: ts.Node | undefined = callee.parent as ts.Node | undefined;
    ancestor !== undefined && !ts.isSourceFile(ancestor);
    ancestor = ancestor.parent as ts.Node | undefined
  ) {
    if (scopeDeclares(ancestor, name)) {
      return undefined;
    }
  }

  const sourceFile = callee.getSourceFile();
  if (reassignedModuleReachableNames(sourceFile).has(name)) {
    return undefined;
  }

  return topLevelCallableCandidates(sourceFile).get(name);
}

/* ------------------------------------------------------------------ *
 * RWF-028: bounded invocation / provenance resolution                  *
 * ------------------------------------------------------------------ */

/** The three callable node shapes this whole file is willing to read a body out of. */
type LocalCallable =
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

/**
 * How many PROVENANCE hops RWF-028 will follow from a call site to the
 * callable it invokes.
 *
 * One. `const alias = bail; alias()` is one hop; `const h = { bail };
 * h.bail()` is one hop through the literal's property. A second hop
 * (`const a2 = alias; a2()`, `const h = { bail: alias }`) is refused.
 *
 * The bound is not arithmetic caution — it is what keeps every supported
 * form a SHAPE this relation can name and invalidate (see
 * {@link resolveInvocationTargetIdentity}'s invalidation table). Chains
 * are where alias analysis turns into points-to analysis, and this task
 * is explicitly scoped not to build one.
 */
const MAX_PROVENANCE_HOPS = 1;

/**
 * The exact local function node an invocation `callee(...)` or
 * `new callee(...)` provably enters (RWF-028) — `undefined` for
 * everything this relation will not commit to.
 *
 * RWF-016 answered this for exactly one shape: a plain identifier bound
 * at module top level directly to a function. The P0 closure inventory
 * found five confirmed false `NOT_AFFECTED`s where the analyzer ALREADY
 * had the callee-side proof (a callable whose every path throws) and
 * dropped it purely because the invocation SHAPE was not that one. The
 * shapes added here are exactly those, and no more:
 *
 * ```text
 * bail()        direct           RWF-016, unchanged
 * alias()       C07  one-hop immutable local alias
 * viaHelper()   C08  a wrapper — resolved here as a plain call; the
 *                    wrapper reasoning lives in callableAlwaysThrows
 * h.bail()      C09  exact local object-literal member
 * { bail() }    C10  nearest-lexical-binding resolution, incl. shadows
 * new bail()    E01  construct — see isDefinitelyAbruptInvocation
 * ```
 *
 * Every form carries its own invalidation story, and a form whose story
 * cannot be discharged is refused rather than guessed:
 *
 * | form   | invalidated by                                              |
 * |--------|-------------------------------------------------------------|
 * | direct | reassignment of the name ({@link reassignedModuleReachableNames}) |
 * | alias  | reassignment of the ALIAS name, or of the SOURCE name        |
 * | member | reassignment of the object binding, ANY non-call use of it (which could mutate the property), a spread, a computed key, a duplicate key, or a non-data property |
 * | shadow | ordinary lexical scoping — the nearest binding wins, and an unsupported nearest binding refuses outright |
 *
 * What is deliberately NOT resolved, because none of it has a bounded
 * invalidation story this relation can state: multi-hop chains,
 * `obj.a.b()`, computed members (`h[key]()`), `bail.bind(...)`,
 * conditional initializers (`cond ? bail : safe`), destructured bindings,
 * imports, class constructors, prototypes, and anything reached through a
 * parameter or a closure.
 */
function resolveInvocationTargetIdentity(
  callee: ts.Expression,
): LocalCallable | undefined {
  // BL-066: memoized per callee node. The answer is a fact of the source
  // text and of per-file facts that are themselves cached (reassignments,
  // candidates, confined object bindings), so it never changes; the callee
  // summary re-reads a body inside every recursion it cannot store, and
  // must not re-resolve the body's call sites each time.
  const cached = invocationTargetIdentityByCallee.get(callee);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  invocationTargetResolutions += 1;
  const resolved = computeInvocationTargetIdentity(callee);
  invocationTargetIdentityByCallee.set(callee, resolved ?? null);
  return resolved;
}

/** {@link resolveInvocationTargetIdentity}'s answers; `null` records "resolves to nothing". */
const invocationTargetIdentityByCallee = new WeakMap<
  ts.Expression,
  LocalCallable | null
>();

let invocationTargetResolutions = 0;

/**
 * How many callee expressions {@link resolveInvocationTargetIdentity} has
 * resolved rather than answered from its memo (BL-066). Exposed so a test
 * can assert that a call site is resolved once, however often the callee
 * summary re-reads the body it is in.
 */
export function invocationTargetResolutionCount(): number {
  return invocationTargetResolutions;
}

function computeInvocationTargetIdentity(
  callee: ts.Expression,
): LocalCallable | undefined {
  const unwrapped = unwrapParentheses(callee);

  if (ts.isIdentifier(unwrapped)) {
    return resolveIdentifierCallable(
      unwrapped,
      unwrapped.text,
      MAX_PROVENANCE_HOPS,
    );
  }

  if (
    ts.isPropertyAccessExpression(unwrapped) &&
    !ts.isOptionalChain(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    ts.isIdentifier(unwrapped.name)
  ) {
    return resolveObjectMemberCallable(
      unwrapped.expression,
      unwrapped.name.text,
      MAX_PROVENANCE_HOPS,
    );
  }

  return undefined;
}

/**
 * The callable an identifier `name`, READ FROM `from`'s position,
 * provably denotes (RWF-028).
 *
 * Resolution is ordinary JavaScript lexical scoping, walking outward from
 * `from`: the NEAREST scope that declares `name` decides, and if what it
 * declares is not a shape this relation supports, the answer is
 * `undefined` — never "keep looking further out". That last clause is the
 * whole point of C10's safe-shadow control:
 *
 * ```js
 * function bail() { throw new Error("boom"); }   // outer, throwing
 * { const bail = () => "safe"; bail(); }         // inner, SAFE -- wins
 * ```
 *
 * Resolving that call to the outer, throwing `bail` would be a false
 * AFFECTED invented out of a name collision. RWF-016 avoided it by
 * refusing any shadowed name outright ({@link scopeDeclares}); this
 * resolves the shadow properly instead, which is what lets the mirrored
 * case — an inner THROWING shadow, C10 itself — be proven at all.
 */
function resolveIdentifierCallable(
  from: ts.Node,
  name: string,
  hops: number,
): LocalCallable | undefined {
  const sourceFile = from.getSourceFile();

  // RWF-025's reassignment facts, consulted first and for every hop: a
  // name assigned anywhere module-reachable has no single value this
  // relation may speak about, whatever its declaration says.
  if (reassignedModuleReachableNames(sourceFile).has(name)) {
    return undefined;
  }

  for (
    let ancestor: ts.Node | undefined = from.parent as ts.Node | undefined;
    ancestor !== undefined && !ts.isSourceFile(ancestor);
    ancestor = ancestor.parent as ts.Node | undefined
  ) {
    if (scopeDeclares(ancestor, name)) {
      const statements = ownStatementsOf(ancestor);
      if (statements === undefined) {
        // A `catch` parameter or a `for` loop binding: declared here, and
        // bound to something this relation cannot read a body out of.
        return undefined;
      }
      return callableFromStatements(statements, name, hops);
    }
  }

  // Module top level. The RWF-016 candidate map answers first and is
  // untouched, so every pre-RWF-028 answer is bit-for-bit what it was;
  // alias provenance is consulted only where that map had nothing.
  const direct = topLevelCallableCandidates(sourceFile).get(name);
  if (direct !== undefined) {
    return direct;
  }
  return callableFromStatements(sourceFile.statements, name, hops, true);
}

/**
 * The callable `name` is bound to by ONE statement list — a block, a
 * `case` clause, or the module's own top level (RWF-028).
 *
 * `aliasOnly` is set for the module top level, where
 * {@link topLevelCallableCandidates} has already answered the direct-
 * callable question and only alias provenance is still open.
 *
 * Any ambiguity refuses: two statements binding the same name, a
 * `let`/`var`/destructured binding, a class, an import, or an initializer
 * that is neither a function nor a bare identifier. A `const` bound to a
 * bare identifier is the alias hop, and it is spent here.
 */
function callableFromStatements(
  statements: readonly ts.Statement[],
  name: string,
  hops: number,
  aliasOnly = false,
): LocalCallable | undefined {
  let found: LocalCallable | ts.Identifier | undefined;

  for (const statement of statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === name &&
      statement.body !== undefined
    ) {
      if (found !== undefined || aliasOnly) {
        return undefined;
      }
      found = statement;
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
      return undefined;
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    if (!declarationListDeclares(statement.declarationList, name)) {
      continue;
    }
    // A `let`/`var` binding can be rebound by a later `=` this relation
    // may not have modeled at all (only module-reachable assignments are
    // collected), so only `const` is ever readable here.
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      return undefined;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== name
      ) {
        // A destructured binding that mentions `name`: bound to something
        // no shape test here can read.
        return undefined;
      }
      if (declaration.initializer === undefined || found !== undefined) {
        return undefined;
      }
      const initializer = unwrapParentheses(declaration.initializer);
      if (
        ts.isFunctionExpression(initializer) ||
        ts.isArrowFunction(initializer)
      ) {
        if (aliasOnly) {
          return undefined;
        }
        found = initializer;
      } else if (ts.isIdentifier(initializer)) {
        found = initializer;
      } else {
        return undefined;
      }
    }
  }

  if (found === undefined) {
    return undefined;
  }
  if (!ts.isIdentifier(found)) {
    return found;
  }
  // The alias hop. `const alias = bail;` — resolved from the INITIALIZER's
  // own position, so the source name is looked up in the scope the alias
  // declaration actually sees, not in the caller's.
  if (hops <= 0) {
    return undefined;
  }
  return resolveIdentifierCallable(found, found.text, hops - 1);
}

/**
 * The callable `receiver.property(...)` provably invokes, when `receiver`
 * is an exact local `const` bound to an OBJECT LITERAL this file's own
 * text can read the property out of (RWF-028's C09) — `undefined`
 * otherwise.
 *
 * This is emphatically NOT member resolution in general: there is no
 * heap, no points-to set, no prototype chain and no property-type
 * reasoning. It is one literal, read literally, under four conditions
 * that between them make the property's value a fact rather than a guess:
 *
 * 1. the receiver is a plain identifier that resolves — by ordinary
 *    lexical scoping — to a `const` whose initializer IS an object
 *    literal, and that name is not reassigned module-reachably;
 * 2. the literal has no spread and no computed key, either of which could
 *    contribute or overwrite the property without naming it
 *    ({@link objectLiteralIsReadable});
 * 3. the receiver binding is CONFINED ({@link confinedObjectBindings}) —
 *    every occurrence of the name in the whole file is either its own
 *    declaration or a plain `h.x` read, so nothing in the file can mutate
 *    the property or hand the object to something that would;
 * 4. the property resolves to exactly one data value in SOURCE ORDER,
 *    last write winning, exactly as the language builds the object.
 *
 * Condition 3 is the one worth dwelling on, because it is what a
 * "bounded" member rule usually gets wrong. `const h = { bail };
 * mutate(h); h.bail();` really can complete normally — `mutate` is free
 * to install a safe function — and no amount of reading the literal will
 * show it. Rather than model mutation, this refuses the instant the
 * binding is used in any way that could lead to mutation, including
 * merely being passed somewhere.
 */
function resolveObjectMemberCallable(
  receiver: ts.Identifier,
  property: string,
  hops: number,
): LocalCallable | undefined {
  const sourceFile = receiver.getSourceFile();
  if (reassignedModuleReachableNames(sourceFile).has(receiver.text)) {
    return undefined;
  }
  if (!confinedObjectBindings(sourceFile).has(receiver.text)) {
    return undefined;
  }

  const literal = resolveObjectLiteralBinding(receiver, receiver.text);
  if (literal === undefined || !objectLiteralIsReadable(literal)) {
    return undefined;
  }

  return objectLiteralPropertyCallable(literal, property, hops);
}

/**
 * The object literal an identifier is `const`-bound to, by the same
 * nearest-scope-wins walk {@link resolveIdentifierCallable} uses
 * (RWF-028). Deliberately a separate, smaller walk rather than a
 * generalised binding resolver: this asks only about one initializer
 * shape, and an unsupported nearest binding refuses instead of looking
 * further out.
 */
function resolveObjectLiteralBinding(
  from: ts.Node,
  name: string,
): ts.ObjectLiteralExpression | undefined {
  const statementsFor = (scope: ts.Node): readonly ts.Statement[] | undefined =>
    ownStatementsOf(scope);

  let statements: readonly ts.Statement[] | undefined;
  for (
    let ancestor: ts.Node | undefined = from.parent as ts.Node | undefined;
    ancestor !== undefined && !ts.isSourceFile(ancestor);
    ancestor = ancestor.parent as ts.Node | undefined
  ) {
    if (scopeDeclares(ancestor, name)) {
      statements = statementsFor(ancestor);
      if (statements === undefined) {
        return undefined;
      }
      break;
    }
  }
  statements ??= from.getSourceFile().statements;

  let found: ts.ObjectLiteralExpression | undefined;
  for (const statement of statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return undefined;
    }
    if (
      !ts.isVariableStatement(statement) ||
      !declarationListDeclares(statement.declarationList, name)
    ) {
      continue;
    }
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      return undefined;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== name
      ) {
        return undefined;
      }
      if (declaration.initializer === undefined || found !== undefined) {
        return undefined;
      }
      const initializer = unwrapParentheses(declaration.initializer);
      if (!ts.isObjectLiteralExpression(initializer)) {
        return undefined;
      }
      found = initializer;
    }
  }
  return found;
}

/**
 * Whether an object literal's own text determines its property set
 * (RWF-028).
 *
 * A spread (`{ ...other, bail }`) can contribute or be overwritten by
 * properties named nowhere in this literal, and a computed key
 * (`{ [k]: safe }`) can name one at runtime. Either makes "which value
 * does `.bail` hold" a question about something other than this literal,
 * so the whole literal is refused rather than a safe subset of it being
 * carved out by source-order reasoning that would have to be exactly
 * right to be worth anything.
 */
function objectLiteralIsReadable(literal: ts.ObjectLiteralExpression): boolean {
  return !literal.properties.some(
    (property) =>
      ts.isSpreadAssignment(property) ||
      (property.name !== undefined && ts.isComputedPropertyName(property.name)),
  );
}

/**
 * The callable an object literal's `property` holds, reading the literal
 * in SOURCE ORDER with the last write winning (RWF-028) — which is
 * exactly how the language builds the object, and is therefore the
 * behaviour of both duplicate-key controls:
 *
 * ```js
 * const h = { bail, bail: safe };   // .bail is SAFE      -- must refuse
 * const h = { bail: safe, bail };   // .bail is THROWING  -- may prove
 * ```
 *
 * Only a data property — shorthand, or `name: <function|identifier>` —
 * is readable. A getter, setter or method named the target REFUSES the
 * whole answer rather than being skipped over: an accessor runs code on
 * property READ, and a method is a node shape the rest of this file's
 * callable machinery does not take.
 */
function objectLiteralPropertyCallable(
  literal: ts.ObjectLiteralExpression,
  property: string,
  hops: number,
): LocalCallable | undefined {
  let resolved: LocalCallable | ts.Identifier | "unsupported" | undefined;

  for (const member of literal.properties) {
    const name = member.name;
    if (name === undefined) {
      continue;
    }
    const memberName =
      ts.isIdentifier(name) || ts.isStringLiteral(name)
        ? name.text
        : ts.isNumericLiteral(name)
          ? name.text
          : undefined;
    if (memberName !== property) {
      continue;
    }

    if (ts.isShorthandPropertyAssignment(member)) {
      resolved = member.name;
      continue;
    }
    if (ts.isPropertyAssignment(member)) {
      const value = unwrapParentheses(member.initializer);
      if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) {
        resolved = value;
      } else if (ts.isIdentifier(value)) {
        resolved = value;
      } else {
        resolved = "unsupported";
      }
      continue;
    }
    // A method, getter or setter carrying this name.
    resolved = "unsupported";
  }

  if (resolved === undefined || resolved === "unsupported") {
    return undefined;
  }
  if (!ts.isIdentifier(resolved)) {
    return resolved;
  }
  if (hops <= 0) {
    return undefined;
  }
  return resolveIdentifierCallable(resolved, resolved.text, hops - 1);
}

/**
 * The local object-binding names whose every occurrence in the file is a
 * use this relation can account for (RWF-028's condition 3 — see
 * {@link resolveObjectMemberCallable}).
 *
 * An occurrence is accounted for when it is:
 *
 * - the `name` of its own `const` declaration, or
 * - the RECEIVER of a plain `h.x` property access that is not itself
 *   being assigned to, deleted, or incremented.
 *
 * Everything else — being passed as an argument, returned, exported,
 * spread, closed over, assigned from, indexed with `h[k]`, or written
 * through with `h.x = ...` — disqualifies the name. The walk covers the
 * WHOLE file, function bodies included, because a closure that mutates
 * the object is exactly the case a module-reachable-only walk would miss:
 *
 * ```js
 * const h = { bail };
 * function patch() { h.bail = safe; }
 * patch();
 * h.bail();            // completes normally -- `h` must be disqualified
 * ```
 *
 * Names are compared as TEXT, so an unrelated binding spelled the same in
 * another scope disqualifies the object too. That is the conservative
 * direction and it costs only precision, which is why this does not need
 * the symbol table a real scope-accurate answer would.
 *
 * Cached per source file, and computed only when an object-member
 * invocation is actually being decided — which
 * {@link fileHasDefinitelyAbruptCallable} has already gated.
 */
const confinedObjectBindingsBySourceFile = new WeakMap<
  ts.SourceFile,
  ReadonlySet<string>
>();

function confinedObjectBindings(
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const cached = confinedObjectBindingsBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }

  const declared = new Set<string>();
  const disqualified = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const parent = node.parent as ts.Node | undefined;
      if (parent !== undefined && !isAccountedObjectBindingUse(node, parent)) {
        disqualified.add(node.text);
      }
      if (
        parent !== undefined &&
        ts.isVariableDeclaration(parent) &&
        parent.name === node
      ) {
        declared.add(node.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const confined = new Set<string>();
  for (const name of declared) {
    if (!disqualified.has(name)) {
      confined.add(name);
    }
  }

  confinedObjectBindingsBySourceFile.set(sourceFile, confined);
  return confined;
}

/** One occurrence's role, for {@link confinedObjectBindings}. */
function isAccountedObjectBindingUse(
  node: ts.Identifier,
  parent: ts.Node,
): boolean {
  if (ts.isVariableDeclaration(parent) && parent.name === node) {
    return true;
  }
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node) {
    return false;
  }
  // `h.x` — accounted for only as a READ. A write, delete or update
  // through it changes the very property this relation wants to read.
  return !isWriteTargetPosition(parent);
}

export {
  isAsyncOrGeneratorCallable,
  ownStatementsOf,
  resolveExactLocalCallable,
  resolveExactLocalCallableIdentity,
  resolveInvocationTargetIdentity,
};
export type { LocalCallable };
