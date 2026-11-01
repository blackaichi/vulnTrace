/**
 * Normal completion: whether a statement, an expression, a class definition
 * or a call of a local callable completes normally at module scope, and
 * whether an export write's target does.
 *
 * Split out of `module-model.ts` by concern, as a pure move (task BL-121):
 * the declarations below are those of that file, unchanged and in its order.
 * `module-model.ts` re-exports the public ones.
 */
import ts from "typescript";
import {
  commonJsExportPropertyName,
  isModuleExportsAssignmentTarget,
  unwrapParentheses,
} from "./commonjs-reexports.js";
import { isNameAssignedWithin } from "./named-bindings.js";
import { exactCommonJsExportPropertyName } from "./source-index.js";
import {
  isStaticClassElement,
  assignmentChainOf,
} from "./module-model.syntax.js";
import {
  moduleScopeBindings,
  hasDeclareModifier,
  COMMONJS_WRAPPER_PARAMETERS,
  moduleScopeReadCompletes,
  topLevelCallableCandidates,
} from "./module-model.module-scope.js";
import {
  competingWriteSites,
  FUNCTION_INTRINSIC_NAMES,
  isUnreassignedModuleFunction,
} from "./module-model.competing-write-sites.js";
import type { LocalCallable } from "./module-model.local-callables.js";

/**
 * Whether a statement that is an assignment chain completes normally:
 * its innermost value does, and every link writes a target whose write
 * cannot throw here ({@link isCompletingWriteTarget}).
 */
function chainCompletesNormally(
  statement: ts.Statement,
  statementIndex: number,
): boolean {
  if (ts.isExportAssignment(statement)) {
    return (
      statement.isExportEquals === true &&
      expressionCompletesNormally(
        statement.expression,
        moduleCompletionScope(statement.getSourceFile(), statementIndex),
      )
    );
  }
  const links = assignmentChainOf(statement);
  if (links.length === 0) {
    return false;
  }
  for (const link of links) {
    if (
      !ts.isBinaryExpression(link) ||
      !isCompletingWriteTarget(link.left, statementIndex)
    ) {
      return false;
    }
  }
  const innermost = links.at(-1) as ts.BinaryExpression;
  return expressionCompletesNormally(
    innermost.right,
    moduleCompletionScope(statement.getSourceFile(), statementIndex),
  );
}

/**
 * Whether writing `target` cannot throw at module time: an export
 * property (`exports.x`, `module.exports.x`, their bracket forms),
 * `module.exports` itself, or a module-scope `var`/`let` binding already
 * declared. An export property write can throw on an export object made
 * non-extensible, given an accessor or replaced by a primitive, or on a
 * setter inherited from a prototype: code that can do any of that is
 * what {@link exportWritesMayFail} looks for, and when the file has any,
 * every window withdraws before this is asked. A stale export object is
 * E-1's.
 */
function isCompletingWriteTarget(
  target: ts.Expression,
  statementIndex: number,
): boolean {
  const left = unwrapParentheses(target);
  const sourceFile = left.getSourceFile();
  const bindings = moduleScopeBindings(sourceFile);
  if (isModuleExportsAssignmentTarget(left)) {
    return !bindings.has("exports") && !bindings.has("module");
  }
  if (commonJsExportPropertyName(left) !== undefined) {
    // After a whole-module write of a value this file does not shape (a
    // `require` result, a call, a literal with an accessor), the export
    // object is another module's or runs code on a write: a setter or a
    // read-only property there makes this write throw.
    return (
      !bindings.has("exports") &&
      !bindings.has("module") &&
      !competingWriteSites(sourceFile).wholeModule.some(
        (site) =>
          !site.primitive &&
          site.carries === "all" &&
          (site.deferred || site.statementIndex < statementIndex),
      )
    );
  }
  const member = ts.isPropertyAccessExpression(left)
    ? left.name.text
    : ts.isElementAccessExpression(left)
      ? exactCommonJsExportPropertyName(left.argumentExpression)
      : undefined;
  if (
    member !== undefined &&
    (ts.isPropertyAccessExpression(left) ||
      ts.isElementAccessExpression(left)) &&
    ts.isIdentifier(left.expression) &&
    !FUNCTION_INTRINSIC_NAMES.includes(member)
  ) {
    // `fn.P = v` on a function object: extensible, and `P` none of the
    // non-writable intrinsics (`name`, `length`, `prototype`, ...), so the
    // write defines or overwrites an ordinary data property. The binding
    // must be readable here and always hold that function.
    return (
      isUnreassignedModuleFunction(sourceFile, left.expression.text) &&
      moduleScopeReadCompletes(sourceFile, left.expression.text, statementIndex)
    );
  }
  if (ts.isIdentifier(left)) {
    const binding = bindings.get(left.text);
    if (binding === undefined) {
      // `exports = module.exports = fn`: the wrapper's own parameter.
      return COMMONJS_WRAPPER_PARAMETERS.has(left.text);
    }
    return (
      binding.count === 1 &&
      (binding.kind === "var" ||
        (binding.kind === "let" && binding.statementIndex < statementIndex))
    );
  }
  return false;
}

/**
 * Where a completion proof is evaluated (BL-064): the top-level statement
 * whose evaluation is being proven (it decides which module-scope
 * `let`/`const`/`class` bindings are out of their temporal dead zone),
 * the bindings of the blocks and function bodies entered on the way, and
 * the callee summary's bound.
 */
interface CompletionScope {
  readonly sourceFile: ts.SourceFile;
  readonly statementIndex: number;
  /** Every name a block or function body entered here declares. */
  readonly declared: ReadonlySet<string>;
  /** The subset of {@link declared} provably initialized at this point. */
  readonly initialized: ReadonlySet<string>;
  /** Whether this is inside a function body being proven (`arguments` and `return` are its own). */
  readonly inFunction: boolean;
  /** How many calls deep the proof is; a recursion always reaches the bound, so it is never proven (V8 throws a `RangeError`, RWF-098). */
  readonly depth: number;
}

/** How many nested calls the completion proof follows, as {@link MAX_CALLABLE_ABRUPT_SUMMARY_DEPTH} bounds the abrupt one. */
const MAX_COMPLETION_CALL_DEPTH = 3;

function moduleCompletionScope(
  sourceFile: ts.SourceFile,
  statementIndex: number,
): CompletionScope {
  return {
    sourceFile,
    statementIndex,
    declared: new Set(),
    initialized: new Set(),
    inFunction: false,
    depth: 0,
  };
}

/** Whether reading `name` here cannot throw (a `ReferenceError`, a temporal dead zone). */
function readCompletes(name: string, scope: CompletionScope): boolean {
  if (scope.initialized.has(name)) {
    return true;
  }
  if (scope.declared.has(name)) {
    return false;
  }
  if (name === "arguments") {
    // The function's own, or the CommonJS wrapper's: never unresolvable.
    return moduleScopeBindings(scope.sourceFile).get(name) === undefined;
  }
  return moduleScopeReadCompletes(scope.sourceFile, name, scope.statementIndex);
}

/** Whether `typeof name` cannot throw: only a binding in its temporal dead zone can. */
function typeofCompletes(name: string, scope: CompletionScope): boolean {
  if (scope.initialized.has(name)) {
    return true;
  }
  if (scope.declared.has(name)) {
    return false;
  }
  const binding = moduleScopeBindings(scope.sourceFile).get(name);
  return binding === undefined || readCompletes(name, scope);
}

/** The block-scoped names a statement list declares directly. */
function blockScopedNamesOf(statements: readonly ts.Statement[]): string[] {
  const names: string[] = [];
  function addName(name: ts.BindingName): void {
    if (ts.isIdentifier(name)) {
      names.push(name.text);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        addName(element.name);
      }
    }
  }
  for (const statement of statements) {
    if (
      ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0
    ) {
      for (const declaration of statement.declarationList.declarations) {
        addName(declaration.name);
      }
    } else if (
      (ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      names.push(statement.name.text);
    }
  }
  return names;
}

/**
 * The scope inside a nested block: its own block-scoped names are
 * declared and, until their statement runs, NOT initialized (they shadow
 * whatever outer binding shares the name).
 */
function enterBlock(
  statements: readonly ts.Statement[],
  scope: CompletionScope,
): CompletionScope {
  const own = blockScopedNamesOf(statements);
  if (own.length === 0) {
    return scope;
  }
  const initialized = new Set(scope.initialized);
  for (const name of own) {
    initialized.delete(name);
  }
  return {
    ...scope,
    declared: new Set([...scope.declared, ...own]),
    initialized,
  };
}

/**
 * Whether a statement list completes normally, or by a `return` inside a
 * function body being proven. Evaluated in order: a `let`/`const`/`class`
 * is initialized for the statements after its own.
 */
function statementListCompletes(
  statements: readonly ts.Statement[],
  outer: CompletionScope,
): boolean {
  const scope = enterBlock(statements, outer);
  const initialized = new Set(scope.initialized);
  for (const statement of statements) {
    const here: CompletionScope = { ...scope, initialized };
    if (ts.isReturnStatement(statement) && scope.inFunction) {
      return (
        statement.expression === undefined ||
        expressionCompletesNormally(statement.expression, here)
      );
    }
    if (!statementCompletes(statement, here)) {
      return false;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          initialized.add(declaration.name.text);
        }
      }
    } else if (
      ts.isClassDeclaration(statement) &&
      statement.name !== undefined
    ) {
      initialized.add(statement.name.text);
    }
  }
  return true;
}

/** A statement in a nested position: a block's list, or a lone `if` branch. */
function nestedStatementCompletes(
  statement: ts.Statement,
  scope: CompletionScope,
): boolean {
  return ts.isBlock(statement)
    ? statementListCompletes(statement.statements, scope)
    : statementListCompletes([statement], scope);
}

const statementCompletionByNode = new WeakMap<ts.Statement, boolean>();

/**
 * Whether evaluating the top-level statement `statement` (index
 * `statementIndex`) provably completes normally (BL-064), by
 * {@link statementCompletes}' closed grammar. Memoized per statement: the
 * answer depends only on the statement and its own index.
 */
function statementCompletesNormally(
  statement: ts.Statement,
  statementIndex: number,
): boolean {
  const cached = statementCompletionByNode.get(statement);
  if (cached !== undefined) {
    return cached;
  }
  const result = statementCompletes(
    statement,
    moduleCompletionScope(statement.getSourceFile(), statementIndex),
  );
  statementCompletionByNode.set(statement, result);
  return result;
}

/**
 * Whether evaluating `statement` provably completes normally (BL-064). A
 * CLOSED grammar; everything outside it answers `false`, which withdraws
 * authority, never grants it:
 *
 * - a function declaration, an empty statement, a type-only or `declare`
 *   declaration;
 * - an expression statement whose expression completes
 *   ({@link expressionCompletesNormally}), or, at module scope, an export
 *   write chain that does ({@link chainCompletesNormally});
 * - a variable statement whose every declarator binds a plain identifier
 *   (a destructuring pattern can throw) to nothing or to an expression
 *   that completes;
 * - a class declaration that completes ({@link classCompletesNormally});
 * - a block, or an `if` whose condition and branches complete;
 * - a `try` with a `catch` (whatever the `try` block does, the `catch`
 *   receives it) whose binding is a plain identifier or absent, whose
 *   `catch` block completes and whose `finally` block, if any, completes;
 *   a `try`/`finally` whose two blocks complete.
 *
 * A `throw`, a loop, a `switch`, a label and a module-scope `return` (the
 * reachability gate's) are outside it.
 */
function statementCompletes(
  statement: ts.Statement,
  scope: CompletionScope,
): boolean {
  if (ts.isFunctionDeclaration(statement)) {
    // Hoisted, and runs nothing, at the top of a file or a function body;
    // in a nested block (Annex B) it writes a binding when the block runs.
    const parent = statement.parent as ts.Node;
    return (
      ts.isSourceFile(parent) ||
      (ts.isBlock(parent) &&
        parent.parent !== undefined &&
        ts.isFunctionLike(parent.parent))
    );
  }
  if (
    ts.isEmptyStatement(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    hasDeclareModifier(statement)
  ) {
    return true;
  }
  if (ts.isExpressionStatement(statement)) {
    if (assignmentChainOf(statement).length > 0) {
      return (
        !scope.inFunction &&
        scope.declared.size === 0 &&
        chainCompletesNormally(statement, scope.statementIndex)
      );
    }
    return expressionCompletesNormally(statement.expression, scope);
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.every(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        (declaration.initializer === undefined ||
          expressionCompletesNormally(declaration.initializer, scope)),
    );
  }
  if (ts.isClassDeclaration(statement)) {
    return classCompletesNormally(statement, scope);
  }
  if (ts.isBlock(statement)) {
    return statementListCompletes(statement.statements, scope);
  }
  if (ts.isIfStatement(statement)) {
    return (
      expressionCompletesNormally(statement.expression, scope) &&
      nestedStatementCompletes(statement.thenStatement, scope) &&
      (statement.elseStatement === undefined ||
        nestedStatementCompletes(statement.elseStatement, scope))
    );
  }
  if (ts.isTryStatement(statement)) {
    const handler = statement.catchClause;
    const finallyCompletes =
      statement.finallyBlock === undefined ||
      statementListCompletes(statement.finallyBlock.statements, scope);
    if (handler === undefined) {
      return (
        statementListCompletes(statement.tryBlock.statements, scope) &&
        finallyCompletes
      );
    }
    const binding = handler.variableDeclaration?.name;
    if (binding !== undefined && !ts.isIdentifier(binding)) {
      return false;
    }
    const catchScope: CompletionScope =
      binding === undefined
        ? scope
        : {
            ...scope,
            declared: new Set([...scope.declared, binding.text]),
            initialized: new Set([...scope.initialized, binding.text]),
          };
    return (
      // A `return` in the `try` block of a module-scope statement ends
      // module evaluation: the reachability gate's question, refused here.
      (scope.inFunction || !containsModuleReturn(statement.tryBlock)) &&
      statementListCompletes(handler.block.statements, catchScope) &&
      finallyCompletes
    );
  }
  return false;
}

/** Whether a module-scope block holds a `return` outside any function. */
function containsModuleReturn(block: ts.Block): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found || ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isReturnStatement(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(block);
  return found;
}

/**
 * Whether defining this class provably completes: no `extends` (it
 * evaluates an expression and checks it), no decorator, no computed key,
 * no static block, and every static field initializer completes. Instance
 * field initializers and method bodies do not run at definition.
 */
function classCompletesNormally(
  node: ts.ClassLikeDeclaration,
  scope: CompletionScope,
): boolean {
  if (
    (node.heritageClauses?.some(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    ) ??
      false) ||
    ts.getDecorators(node) !== undefined
  ) {
    return false;
  }
  for (const member of node.members) {
    if (
      ts.isClassStaticBlockDeclaration(member) ||
      (ts.canHaveDecorators(member) &&
        ts.getDecorators(member) !== undefined) ||
      (member.name !== undefined && ts.isComputedPropertyName(member.name))
    ) {
      return false;
    }
    if (
      ts.isPropertyDeclaration(member) &&
      isStaticClassElement(member) &&
      member.initializer !== undefined &&
      !expressionCompletesNormally(member.initializer, scope)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Whether evaluating `expression` provably completes normally (BL-064). A
 * CLOSED grammar:
 *
 * - a literal, a template without substitutions, `this`;
 * - a function, arrow or completing class value (creating a closure runs
 *   nothing);
 * - a read {@link readCompletes} proves, and `typeof` of any identifier
 *   not in its temporal dead zone;
 * - `void`, `typeof` and `!` of one that completes (none converts its
 *   operand by user code), and `,`, `&&`, `||`, `??`, `===`, `!==` and
 *   `?:` of ones that complete (`false && e` and `true || e` never
 *   evaluate `e`);
 * - an object literal of non-computed keys whose values complete, with
 *   methods and accessors (their bodies do not run), and no spread;
 *   an array literal of completing elements, no spread;
 * - a call or tagged template {@link invocationCompletes} proves.
 *
 * Everything else -- a property read (a getter, `undefined.x`), any other
 * operator (a `valueOf`), `new`, a template with substitutions (a
 * `toString`), a spread (an iterator), any other call -- may throw.
 */
function expressionCompletesNormally(
  expression: ts.Expression,
  scope: CompletionScope,
): boolean {
  const node = unwrapParentheses(expression);
  switch (node.kind) {
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.RegularExpressionLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.ThisKeyword:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
      return true;
    default:
      break;
  }
  const recurse = (inner: ts.Expression): boolean =>
    expressionCompletesNormally(inner, scope);
  if (ts.isIdentifier(node)) {
    return readCompletes(node.text, scope);
  }
  if (ts.isClassExpression(node)) {
    return classCompletesNormally(node, scope);
  }
  if (ts.isTypeOfExpression(node)) {
    const operand = unwrapParentheses(node.expression);
    return ts.isIdentifier(operand)
      ? typeofCompletes(operand.text, scope)
      : recurse(operand);
  }
  if (ts.isVoidExpression(node)) {
    return recurse(node.expression);
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return recurse(node.operand);
  }
  if (ts.isBinaryExpression(node)) {
    const left = unwrapParentheses(node.left);
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return (
          left.kind === ts.SyntaxKind.FalseKeyword ||
          (recurse(left) && recurse(node.right))
        );
      case ts.SyntaxKind.BarBarToken:
        return (
          left.kind === ts.SyntaxKind.TrueKeyword ||
          (recurse(left) && recurse(node.right))
        );
      case ts.SyntaxKind.CommaToken:
      case ts.SyntaxKind.QuestionQuestionToken:
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return recurse(left) && recurse(node.right);
      default:
        return false;
    }
  }
  if (ts.isConditionalExpression(node)) {
    return (
      recurse(node.condition) &&
      recurse(node.whenTrue) &&
      recurse(node.whenFalse)
    );
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((property) => {
      if (
        property.name !== undefined &&
        ts.isComputedPropertyName(property.name)
      ) {
        return false;
      }
      if (ts.isPropertyAssignment(property)) {
        return recurse(property.initializer);
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return (
          property.objectAssignmentInitializer === undefined &&
          recurse(property.name)
        );
      }
      return (
        ts.isMethodDeclaration(property) ||
        ts.isGetAccessorDeclaration(property) ||
        ts.isSetAccessorDeclaration(property)
      );
    });
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every(
      (element) =>
        ts.isOmittedExpression(element) ||
        (!ts.isSpreadElement(element) && recurse(element)),
    );
  }
  if (ts.isCallExpression(node)) {
    return (
      node.questionDotToken === undefined &&
      node.arguments.every(
        (argument) => !ts.isSpreadElement(argument) && recurse(argument),
      ) &&
      invocationCompletes(node.expression, scope, node.arguments)
    );
  }
  if (ts.isTaggedTemplateExpression(node)) {
    // The template object itself is created without user code; the
    // substitutions are evaluated, then the tag is called.
    return (
      (ts.isNoSubstitutionTemplateLiteral(node.template) ||
        node.template.templateSpans.every((span) =>
          recurse(span.expression),
        )) &&
      invocationCompletes(node.tag, scope, undefined)
    );
  }
  return false;
}

/**
 * Whether calling `callee` provably completes normally (BL-064), its
 * arguments already proven: `callee` is an identifier naming exactly one
 * module-scope function declaration, or `const` function or arrow, that
 * nothing anywhere in the file reassigns and no inner scope here shadows,
 * readable here; and {@link calleeCompletes} proves its body.
 */
function invocationCompletes(
  calleeExpression: ts.Expression,
  scope: CompletionScope,
  supplied: readonly ts.Expression[] | undefined,
): boolean {
  const callee = unwrapParentheses(calleeExpression);
  if (
    !ts.isIdentifier(callee) ||
    scope.declared.has(callee.text) ||
    !readCompletes(callee.text, scope)
  ) {
    return false;
  }
  const sourceFile = scope.sourceFile;
  const binding = moduleScopeBindings(sourceFile).get(callee.text);
  if (
    binding === undefined ||
    binding.count !== 1 ||
    (binding.kind !== "function" && binding.kind !== "const") ||
    isNameAssignedWithin(sourceFile, callee.text)
  ) {
    return false;
  }
  const fn = topLevelCallableCandidates(sourceFile).get(callee.text);
  return fn !== undefined && calleeCompletes(fn, scope, supplied);
}

/**
 * Whether one call of `fn`, with arguments that completed, completes
 * normally (BL-064), within {@link MAX_COMPLETION_CALL_DEPTH} nested calls
 * (a recursion always reaches the bound, so it is never proven: unbounded
 * recursion throws a `RangeError`, RWF-098):
 *
 * - an `async` function: a throw anywhere in it, its parameters included,
 *   rejects the promise it returns instead (RWF-016's reason);
 * - a generator: its parameters are initialized at the call (each must
 *   complete), and its body does not run;
 * - any other: each parameter is a plain identifier (a pattern can throw)
 *   whose default, if any, completes, and its body completes
 *   ({@link statementListCompletes}), reading its own parameters and
 *   declarations once initialized, and module-scope bindings readable at
 *   the calling statement.
 */
const calleeCompletionByCallable = new WeakMap<
  LocalCallable,
  Map<string, boolean>
>();

/** The number of callee bodies {@link calleeCompletes} has evaluated (not answered from its memo), for the operation-count gate. */
let calleeCompletionEvaluations = 0;

export function calleeCompletionEvaluationCount(): number {
  return calleeCompletionEvaluations;
}

function calleeCompletes(
  fn: LocalCallable,
  outer: CompletionScope,
  supplied: readonly ts.Expression[] | undefined,
): boolean {
  if (outer.depth >= MAX_COMPLETION_CALL_DEPTH) {
    return false;
  }
  // The answer depends only on the callee, the calling top-level
  // statement (which module bindings are initialized), the depth reached
  // and which defaults the arguments skip (BL-064's audit, finding 8).
  const mask = fn.parameters
    .map((_parameter, position) =>
      suppliesDefinedValue(supplied?.[position]) ? "1" : "0",
    )
    .join("");
  const key = `${outer.statementIndex}|${outer.depth}|${mask}`;
  let memo = calleeCompletionByCallable.get(fn);
  if (memo === undefined) {
    memo = new Map();
    calleeCompletionByCallable.set(fn, memo);
  }
  const known = memo.get(key);
  if (known !== undefined) {
    return known;
  }
  calleeCompletionEvaluations += 1;
  const answer = computeCalleeCompletes(fn, outer, supplied);
  memo.set(key, answer);
  return answer;
}

function computeCalleeCompletes(
  fn: LocalCallable,
  outer: CompletionScope,
  supplied: readonly ts.Expression[] | undefined,
): boolean {
  if (isAsyncCallable(fn) && !isGeneratorCallable(fn)) {
    // An `async function*` initializes its parameters synchronously, like
    // any generator (BL-064's independent audit, finding 3); only a plain
    // `async` function turns every throw into a rejection.
    return true;
  }
  const body = fn.body;
  if (body === undefined) {
    return false;
  }
  const declared = new Set<string>(ts.isArrowFunction(fn) ? [] : ["arguments"]);
  const initialized = new Set<string>(declared);
  for (const parameter of fn.parameters) {
    if (!ts.isIdentifier(parameter.name)) {
      return false;
    }
    declared.add(parameter.name.text);
  }
  const hoisted = ts.isBlock(body) ? functionHoistedNames(body) : [];
  for (const name of hoisted) {
    declared.add(name);
    initialized.add(name);
  }
  if (ts.isBlock(body)) {
    // Annex B block functions: declared, never proven initialized.
    for (const name of blockFunctionNames(body)) {
      declared.add(name);
      initialized.delete(name);
    }
  }
  const scope: CompletionScope = {
    sourceFile: outer.sourceFile,
    statementIndex: outer.statementIndex,
    declared,
    initialized,
    inFunction: true,
    depth: outer.depth + 1,
  };
  for (const [position, parameter] of fn.parameters.entries()) {
    const name = (parameter.name as ts.Identifier).text;
    if (
      parameter.initializer !== undefined &&
      !suppliesDefinedValue(supplied?.[position]) &&
      !expressionCompletesNormally(parameter.initializer, {
        ...scope,
        initialized: new Set(initialized),
      })
    ) {
      return false;
    }
    initialized.add(name);
  }
  if (isGeneratorCallable(fn)) {
    return true;
  }
  return ts.isBlock(body)
    ? statementListCompletes(body.statements, {
        ...scope,
        initialized: new Set(initialized),
      })
    : expressionCompletesNormally(body, {
        ...scope,
        initialized: new Set(initialized),
      });
}

/**
 * Whether an argument provably supplies a value other than `undefined`,
 * so the parameter's default is never evaluated: a literal other than
 * `undefined`, a function, class, object or array value. Passed in an
 * argument list, never through a spread (refused before this is asked).
 */
function suppliesDefinedValue(argument: ts.Expression | undefined): boolean {
  if (argument === undefined) {
    return false;
  }
  const node = unwrapParentheses(argument);
  return (
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isRegularExpressionLiteral(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isClassExpression(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

/**
 * The names a function body binds before its first statement runs: its
 * top-level function declarations and every `var`, outside nested
 * functions (both are hoisted; a `var` starts as `undefined`).
 */
function functionHoistedNames(body: ts.Block): string[] {
  const names: string[] = [];
  for (const statement of body.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      names.push(statement.name.text);
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
      return;
    }
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.BlockScoped) === 0
    ) {
      for (const declaration of node.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.push(declaration.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  body.statements.forEach(visit);
  return names;
}

/** The names function declarations in nested blocks of `body` bind (Annex B), outside nested functions. */
function blockFunctionNames(body: ts.Block): string[] {
  const names: string[] = [];
  function visit(node: ts.Node, nested: boolean): void {
    if (ts.isFunctionDeclaration(node)) {
      if (nested && node.name !== undefined) {
        names.push(node.name.text);
      }
      return;
    }
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
      return;
    }
    ts.forEachChild(node, (child) => visit(child, true));
  }
  body.statements.forEach((statement) => visit(statement, false));
  return names;
}

function isAsyncCallable(fn: LocalCallable): boolean {
  return (
    ts.canHaveModifiers(fn) &&
    (ts
      .getModifiers(fn)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ??
      false)
  );
}

function isGeneratorCallable(fn: LocalCallable): boolean {
  return (
    (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) &&
    fn.asteriskToken !== undefined
  );
}

export {
  chainCompletesNormally,
  isCompletingWriteTarget,
  statementCompletesNormally,
  isAsyncCallable,
};
