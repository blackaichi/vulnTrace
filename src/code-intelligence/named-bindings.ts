import ts from "typescript";

/**
 * P1-B3 -- SCOPE-AWARE NAMED BINDING RESOLUTION.
 *
 * Answers one question, and refuses to answer it on anything less than
 * proof: *given this particular reference to a name, which declaration
 * does it bind to, and does that declaration hold exactly one value for
 * the whole of the reference's lifetime?*
 *
 * WHY THIS EXISTS RATHER THAN `resolveSingleAssignmentValue`. The older
 * helper in local-aliases.ts answers a different, weaker question: "is
 * there a `const <name> = ...` ANYWHERE in this file?" It is whole-file,
 * name-only and first-match-wins, which is sound enough for the loader
 * constructs it was written for, but is NOT a binding resolution: it
 * cannot see that an inner `const fn = safe` shadows an outer
 * `const fn = danger`, and it cannot see that a reference sits before the
 * initializer it would read. Both mistakes FABRICATE a call edge, which
 * is the one direction this engine may never fail in. This module is the
 * scope-correct replacement for the call graph's named-binding paths.
 *
 * THE SOUNDNESS RULE (P1-B3 § 6), stated once and enforced in one place:
 * a name resolves ONLY when a unique declaration owns it in the innermost
 * scope that declares it, that declaration carries exactly one value,
 * nothing ever assigns to the name again, and the reference is evaluated
 * after that value exists. Anything else -- two declarations in the same
 * scope, a parameter, an import, a destructuring, a missing initializer,
 * any reassignment anywhere, a use before the initializer, an alias
 * cycle -- returns {@link NamedBindingUnresolved} with the cause that
 * explains it. Missing a resolution is a cost; inventing one is a defect.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not resolve imports
 * (symbol-binder.ts owns module boundaries, and P1-B3 § 11 forbids a
 * second resolver), it does not model `this`, class instances or
 * prototypes (P1-B3 § 14), it does not evaluate call results (P1-B3
 * § 13), and it does not propagate values through parameters (P1-B3
 * § 12). Each of those is reported as its own cause so the caller can
 * fall through to the machinery that does own it -- or leave the call
 * UNKNOWN under the precise reason it already had.
 */

/** Why a name could not be resolved to a single authoritative value. */
export type NamedBindingUnresolvedCause =
  /** No declaration of the name in any enclosing scope: an ambient global, a host builtin, or a name declared in a file this pass never read. */
  | "no_declaration"
  /** The innermost declaring scope declares the name more than once -- a branch-split `var`, a redeclaration, a duplicated parameter. Which one is live is not decidable here. */
  | "ambiguous_declarations"
  /** The name is a parameter: its value comes from every call site, which is higher-order propagation and out of B3's scope (P1-B3 § 12). */
  | "parameter"
  /** The name is an import binding: symbol-binder.ts owns it, and B3 must not build a second module resolver (P1-B3 § 11). */
  | "import_binding"
  /** The name came out of a destructuring pattern; the call graph's own `findDestructuredBindingSource` owns that shape. */
  | "destructuring"
  /** `var x;` / `let x;` -- declared, but never given a value here. */
  | "no_initializer"
  /** Something assigns to the name after (or before) its declaration, so no single value is authoritative. */
  | "reassigned"
  /** The reference is evaluated before the initializer that would give the name its value (P1-B3 § 9). */
  | "used_before_initialized"
  /** An alias chain returned to a name it had already visited (`a = b; b = a;`). Fails closed (P1-B3 § 10). */
  | "alias_cycle"
  /** The alias chain ran longer than {@link MAX_ALIAS_CHAIN_HOPS}. */
  | "alias_chain_too_long";

/** The name binds to a declaration holding exactly one authoritative value. */
export interface NamedBindingValue {
  readonly kind: "value";
  /** The initializer expression that value came from, after any alias hops. */
  readonly value: ts.Expression;
  /** The declaration the reference ultimately bound to. */
  readonly declaration: ts.VariableDeclaration;
  /**
   * The scope that owns that declaration -- the region a caller must
   * search to decide whether anything else could still change what the
   * value holds. Needed by the object-literal member check, which has to
   * ask about writes to a PROPERTY (`obj.m = ...`), a question this
   * module's own stability rule (writes to the NAME) does not answer.
   */
  readonly scope: ts.Node;
}

/**
 * The name binds to a hoisted `function` declaration. Kept apart from
 * {@link NamedBindingValue} because a function declaration needs no
 * order check: hoisting is complete before any statement in the scope
 * runs, so a call textually above it still reaches it.
 */
export interface NamedBindingFunction {
  readonly kind: "function";
  readonly declaration: ts.FunctionDeclaration;
}

/**
 * The name binds to a named function EXPRESSION's own self-binding, seen
 * from inside that expression's body (P1-B3b § 13).
 *
 * `const outer = function inner(n) { return inner(n - 1); };` binds
 * `inner` inside the expression and NOWHERE else -- not in the enclosing
 * scope, not in a sibling function, not after the expression. That is a
 * real, exactly-locatable declaration, so refusing it costs a resolution
 * the language guarantees; but it is also the one binding a whole-file
 * name index gets *backwards*, since the index sees a function literally
 * named `inner` and happily hands it to any reference to `inner`
 * anywhere in the file.
 *
 * Kept apart from {@link NamedBindingFunction} because the node is a
 * `FunctionExpression`, not a `FunctionDeclaration`, and coercing one
 * into the other would let consumers make claims about hoisting that do
 * not hold. Like a function declaration it needs no order check: the
 * self-binding exists from the moment the expression is evaluated, which
 * is necessarily before its own body can run.
 */
export interface NamedBindingFunctionExpression {
  readonly kind: "function-expression";
  readonly declaration: ts.FunctionExpression;
}

/**
 * The name binds to a `class` declaration, or to a named class
 * EXPRESSION's own self-binding (P1-B3b § 11).
 *
 * This is the one authority the same-name matcher held that was
 * legitimate: `new LocalClass()` really does construct the class
 * lexically in scope, and nothing else in this module could say so.
 * Admitting it here rather than in the call graph is the whole point --
 * a class binding shadows, is reassignable and has a temporal dead zone
 * exactly as other lexical bindings do, and those rules must be enforced
 * by the one model that owns them, not re-hand-coded next to the graph
 * (P1-B3b § 29).
 *
 * Deliberately NOT instance or `this`-receiver modeling, which Block C
 * owns: this says only *which class declaration this name denotes*.
 */
export interface NamedBindingClass {
  readonly kind: "class";
  readonly declaration: ts.ClassDeclaration | ts.ClassExpression;
}

export interface NamedBindingUnresolved {
  readonly kind: "unresolved";
  readonly cause: NamedBindingUnresolvedCause;
}

export type NamedBinding =
  | NamedBindingValue
  | NamedBindingFunction
  | NamedBindingFunctionExpression
  | NamedBindingClass
  | NamedBindingUnresolved;

/**
 * How many `a = b; b = c; ...` hops a chain may take. Not a soundness
 * bound -- {@link NamedBindingUnresolved}'s `alias_cycle` already makes
 * cycles terminate -- but a cost bound, so a pathological generated file
 * cannot turn one call site into an unbounded walk. Exceeding it fails
 * closed, exactly as a cycle does.
 */
const MAX_ALIAS_CHAIN_HOPS = 8;

const unresolved = (
  cause: NamedBindingUnresolvedCause,
): NamedBindingUnresolved => ({ kind: "unresolved", cause });

/**
 * A member name no source file can spell, used to record "a write with a
 * key this analyzer cannot read happened here, so NO member of anything in
 * this scope is stable any more".
 */
const ANY_MEMBER = "\u0000any-member";

type DeclarationIndex = ReadonlyMap<string, ScopeDeclaration[]>;

/**
 * PER-SCOPE INDEXES, and why they are indexes rather than searches.
 *
 * Each of the three questions this module asks about a scope -- which
 * declarations it owns, which names it assigns to, which members it writes
 * -- was originally answered by walking the scope's subtree once PER
 * QUERY. That is correct and it is also quadratic in the shape that
 * matters: one failed call site asks about one name, and a file like
 * `lodash.js` has ~1,700 failed call sites inside a single ~16,000-line
 * function expression, so the same subtree was re-walked ~1,700 times.
 * Measured on the real fixture, that cost about 45% of scan wall time
 * (13.6s -> 20.2s), which the P1-B3 audit caught and the first
 * implementation's record wrongly denied.
 *
 * Each index is now built by ONE walk and answered by hash lookup.
 *
 * SOUNDNESS OF THE KEY. All three answers depend only on (scope subtree,
 * name) -- never on the position of the reference asking, which is why
 * caching them by name alone is safe. The two order-sensitive rules in
 * this module, the temporal-dead-zone check and the alias-chain visited
 * set, are computed per reference OUTSIDE these indexes and are
 * deliberately not cached.
 *
 * LIFETIME. Keyed on the scope NODE itself in a `WeakMap`, so an entry
 * lives exactly as long as the AST it describes and dies with it. Nothing
 * is keyed by name, path or content, so nothing can survive a file being
 * re-parsed, and there is no cross-scan state to invalidate. This mirrors
 * `local-aliases.ts`'s own per-`SourceFile` cache, for the same reason.
 */
const declarationIndexByScope = new WeakMap<ts.Node, DeclarationIndex>();
const assignedNamesByScope = new WeakMap<ts.Node, ReadonlySet<string>>();
const assignedMembersByScope = new WeakMap<ts.Node, ReadonlySet<string>>();

/**
 * How many scope subtrees have been walked to build an index, ever.
 *
 * INSTRUMENTATION ONLY. Nothing in this module or any caller reads it to
 * decide anything; it exists so the structural guarantee above can be
 * TESTED as a structure rather than as a stopwatch. The invariant it makes
 * checkable is the one that matters: the number of walks is a function of
 * how many SCOPES were asked about, never of how many QUERIES were asked
 * -- so a thousand call sites in one function cost one walk, not a
 * thousand. `named-bindings.performance.test.ts` asserts exactly that, and
 * deleting the caches above makes it fail.
 *
 * It is monotonic and never reset, so a test reads it twice and compares
 * rather than depending on any starting value.
 */
let scopeIndexBuilds = 0;

/** See {@link scopeIndexBuilds}. Instrumentation for tests; never an input to analysis. */
export function namedBindingScopeIndexBuilds(): number {
  return scopeIndexBuilds;
}

/** Every declaration of `name` owned by `scope` (see {@link buildDeclarationIndex}). */
function declarationsOwnedBy(scope: ts.Node, name: string): ScopeDeclaration[] {
  let index = declarationIndexByScope.get(scope);
  if (!index) {
    index = buildDeclarationIndex(scope);
    declarationIndexByScope.set(scope, index);
  }
  return index.get(name) ?? [];
}

/** Whether anything anywhere in `scope` assigns to `name` (see {@link buildAssignedNames}). */
function isAssignedWithin(scope: ts.Node, name: string): boolean {
  let names = assignedNamesByScope.get(scope);
  if (!names) {
    names = buildAssignedNames(scope);
    assignedNamesByScope.set(scope, names);
  }
  return names.has(name);
}

/**
 * Whether anything anywhere in `scope` writes the PROPERTY `member` on any
 * object -- `x.m = v`, `x["m"] = v`, `x.m += v`, `x.m++`, `delete x.m`, or
 * a write through a key this analyzer cannot read.
 *
 * THE RECEIVER IS DELIBERATELY NOT MATCHED. This asks "is this member name
 * written at all here?", not "is it written on this object?", because the
 * second question needs object identity and this engine has none: a write
 * reaches an object through the binding, through any alias of it, through
 * a parameter it was passed to, or through a property of something else
 * entirely. Matching the receiver by NAME would be the same
 * resolve-by-spelling mistake the rest of this module exists to avoid, and
 * it would miss `const alias = obj; alias.m = safe;` outright.
 *
 * So the check is over-approximate in exactly the safe direction: an
 * unrelated `other.m = v` in the same scope costs a resolution it did not
 * need to, and no write that could reach the object is ever missed. It is
 * also ORDER-INSENSITIVE -- a write below the call refuses the call too --
 * which is the same trade for the same reason: deciding that a later write
 * cannot affect an earlier call needs execution order across function
 * boundaries, and a closure makes "later in the text" mean nothing. Both
 * costs are precision; the alternative costs soundness (RWF-042
 * remediation § 11-§ 14).
 */
export function isMemberAssignedWithin(
  scope: ts.Node,
  member: string,
): boolean {
  let members = assignedMembersByScope.get(scope);
  if (!members) {
    members = buildAssignedMembers(scope);
    assignedMembersByScope.set(scope, members);
  }
  return members.has(member) || members.has(ANY_MEMBER);
}

/**
 * A scope that `var` and `function` declarations hoist to. `ts.SourceFile`
 * is included: a module's or script's top level is a function scope for
 * this purpose.
 */
function isFunctionScope(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isModuleDeclaration(node)
  );
}

/**
 * A scope that `let`/`const`/`class` declarations are confined to. Every
 * function scope is also a block scope; the additional forms are the ones
 * that introduce a lexical environment without introducing a call frame.
 */
function isBlockScope(node: ts.Node): boolean {
  return (
    isFunctionScope(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

/** The innermost block scope containing `node`, not counting `node` itself. */
function enclosingBlockScope(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isBlockScope(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/** The innermost function scope containing `node`, not counting `node` itself. */
function enclosingFunctionScope(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isFunctionScope(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/** The chain of block scopes enclosing a reference, innermost first. */
function scopeChainOf(reference: ts.Node): ts.Node[] {
  const chain: ts.Node[] = [];
  let current: ts.Node | undefined = reference.parent;
  while (current) {
    if (isBlockScope(current)) {
      chain.push(current);
    }
    current = current.parent;
  }
  return chain;
}

type DeclarationKind =
  | "const"
  | "let"
  | "var"
  | "function"
  | "class"
  | "parameter"
  | "import"
  | "destructuring";

interface ScopeDeclaration {
  readonly kind: DeclarationKind;
  readonly node: ts.Node;
  readonly variable?: ts.VariableDeclaration;
}

function variableKind(
  declaration: ts.VariableDeclaration,
): "const" | "let" | "var" {
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list)) {
    return "var";
  }
  if ((list.flags & ts.NodeFlags.Const) !== 0) {
    return "const";
  }
  return (list.flags & ts.NodeFlags.Let) !== 0 ? "let" : "var";
}

/**
 * Every declaration of `name` that BELONGS TO `scope` -- the heart of
 * shadowing (P1-B3 § 7). Belonging is decided per declaration form, not
 * by proximity:
 *
 * - `var` and `function` hoist, so they belong to the nearest enclosing
 *   FUNCTION scope, however deeply nested in blocks they are written.
 * - `let`, `const`, `class` and catch parameters are lexical, so they
 *   belong to the nearest enclosing BLOCK scope.
 * - parameters belong to their own function.
 * - imports belong to the source file.
 * - a named function/class EXPRESSION binds its own name inside its own
 *   body, and nowhere else.
 *
 * The traversal stops at nested function scopes for the hoisting forms
 * (their `var`s are their own) but must still descend through blocks,
 * which is why the two questions are asked separately rather than by
 * counting depth.
 */
function buildDeclarationIndex(scope: ts.Node): DeclarationIndex {
  scopeIndexBuilds += 1;
  const index = new Map<string, ScopeDeclaration[]>();
  const found = {
    push(declaration: ScopeDeclaration & { readonly boundName: string }): void {
      const existing = index.get(declaration.boundName);
      if (existing) {
        existing.push(declaration);
      } else {
        index.set(declaration.boundName, [declaration]);
      }
    },
  };

  // A named function/class expression binds its own name within itself.
  if (
    (ts.isFunctionExpression(scope) || ts.isClassExpression(scope)) &&
    scope.name
  ) {
    found.push({
      kind: ts.isFunctionExpression(scope) ? "function" : "class",
      node: scope,
      boundName: scope.name.text,
    });
  }

  const ownsHoisted = (declaration: ts.Node): boolean =>
    enclosingFunctionScope(declaration) === scope;
  const ownsLexical = (declaration: ts.Node): boolean =>
    enclosingBlockScope(declaration) === scope;

  /**
   * Every identifier a binding pattern BINDS, matched against `name`.
   *
   * A pattern's bindings are its LOCAL names, never its property names:
   * `{ source: local }` binds `local` and says nothing about `source`.
   * Getting that backwards would shadow a name the function never declares
   * while leaving the one it does declare open to an outer value.
   *
   * Rest elements bind (`[first, ...rest]` binds `rest`) and array holes
   * (`[, a]`) are not binding elements at all, so both are handled by the
   * same two branches. Nested patterns recurse.
   */
  function collectFromBindingPattern(
    pattern: ts.BindingPattern,
    kind: DeclarationKind,
    owned: boolean,
  ): void {
    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) {
        continue;
      }
      if (ts.isIdentifier(element.name)) {
        if (owned) {
          found.push({ kind, node: element, boundName: element.name.text });
        }
      } else {
        collectFromBindingPattern(element.name, kind, owned);
      }
    }
  }

  /**
   * A parameter or catch binding, whether it is a plain name or a pattern.
   *
   * THE PATTERN CASE IS WHY THIS EXISTS. Before the P1-B3 soundness audit,
   * only `ts.isIdentifier` parameter names were recorded, so
   * `function main({ a }) { a(); }` introduced NO declaration, the scope
   * walk continued outward, and an outer `const a = danger` answered for a
   * binding that shadows it -- a fabricated call edge (RWF-042
   * remediation). The binding's VALUE is still not resolved here: it comes
   * from the caller, so `parameter` is the right refusal. Owning the NAME
   * is the whole job.
   */
  function recordBindingTarget(
    target: ts.BindingName,
    kind: DeclarationKind,
    node: ts.Node,
  ): void {
    if (ts.isIdentifier(target)) {
      found.push({ kind, node, boundName: target.text });
      return;
    }
    collectFromBindingPattern(target, kind, true);
  }

  function visit(node: ts.Node): void {
    record(node);
    // A nested function scope owns everything INSIDE it, so the walk stops
    // here -- but only after `record` has run, because the nested
    // function's OWN NAME is a declaration in THIS scope, not in its own
    // body. Bailing first made `function danger() {}` invisible to a
    // reference that binds to it, which is the whole point of the lookup.
    if (node !== scope && isFunctionScope(node)) {
      return;
    }
    ts.forEachChild(node, visit);
  }

  function record(node: ts.Node): void {
    if (ts.isVariableDeclaration(node)) {
      // A catch clause's binding is a `VariableDeclaration` too, but it is
      // NOT a `var`/`let`/`const` and belongs to the catch clause alone.
      // Letting this branch see it would hoist it to the enclosing
      // function, which is the wrong scope entirely -- the catch branch
      // below owns it.
      if (ts.isCatchClause(node.parent)) {
        return;
      }
      const kind = variableKind(node);
      const owned = kind === "var" ? ownsHoisted(node) : ownsLexical(node);
      if (ts.isIdentifier(node.name)) {
        if (owned) {
          found.push({
            kind,
            node,
            variable: node,
            boundName: node.name.text,
          });
        }
      } else {
        collectFromBindingPattern(node.name, "destructuring", owned);
      }
    } else if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      ownsHoisted(node)
    ) {
      found.push({ kind: "function", node, boundName: node.name.text });
    } else if (ts.isClassDeclaration(node) && node.name && ownsLexical(node)) {
      found.push({ kind: "class", node, boundName: node.name.text });
    } else if (ts.isParameter(node) && node.parent === scope) {
      recordBindingTarget(node.name, "parameter", node);
    } else if (
      ts.isCatchClause(node) &&
      node === scope &&
      node.variableDeclaration
    ) {
      recordBindingTarget(node.variableDeclaration.name, "parameter", node);
    } else if (
      ts.isSourceFile(scope) &&
      (ts.isImportSpecifier(node) ||
        ts.isImportClause(node) ||
        ts.isNamespaceImport(node) ||
        ts.isImportEqualsDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      found.push({ kind: "import", node, boundName: node.name.text });
    }
  }

  visit(scope);
  return index;
}

/**
 * Whether anything anywhere in `scope` assigns to `name`.
 *
 * DELIBERATELY OVER-APPROXIMATE. This counts an assignment to the NAME,
 * including one made to a same-named binding that shadows this one in a
 * nested scope. That over-counts, which costs resolutions and can never
 * invent one: a name this reports as reassigned is simply left UNKNOWN.
 * The opposite bias -- resolving scope precisely here and missing a real
 * write -- would fabricate a value, so the asymmetry is the whole point
 * (P1-B3 § 8, and the class of stale-attribution defect RWF-013/013b
 * already cost this engine once).
 *
 * Covered: `x = v`, every compound assignment, `++x`/`x++`/`--x`/`x--`,
 * `for (x of ...)`/`for (x in ...)`, and destructuring assignment targets
 * (`({ x } = v)`, `[x] = v`).
 */
function buildAssignedNames(scope: ts.Node): ReadonlySet<string> {
  scopeIndexBuilds += 1;
  const assigned = new Set<string>();

  function scanAssignmentTarget(target: ts.Node): void {
    if (ts.isIdentifier(target)) {
      assigned.add(target.text);
      return;
    }
    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          assigned.add(property.name.text);
        } else if (ts.isPropertyAssignment(property)) {
          scanAssignmentTarget(property.initializer);
        } else if (ts.isSpreadAssignment(property)) {
          scanAssignmentTarget(property.expression);
        }
      }
      return;
    }
    if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) {
        if (ts.isOmittedExpression(element)) {
          continue;
        }
        scanAssignmentTarget(
          ts.isSpreadElement(element) ? element.expression : element,
        );
      }
      return;
    }
    if (ts.isBinaryExpression(target)) {
      // A default in a destructuring target: `({ x = 1 } = v)`.
      scanAssignmentTarget(target.left);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (
        operator >= ts.SyntaxKind.FirstAssignment &&
        operator <= ts.SyntaxKind.LastAssignment
      ) {
        scanAssignmentTarget(node.left);
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand)
    ) {
      assigned.add(node.operand.text);
    } else if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      scanAssignmentTarget(node.initializer);
    }
    ts.forEachChild(node, visit);
  }

  visit(scope);
  return assigned;
}

/**
 * Strips the wrappers that have no runtime effect -- `expr as T`,
 * `expr satisfies T`, `expr!`, `(expr)`. `const fns = lib as X;` makes
 * `fns` *be* `lib`, not an extra hop, so these must be peeled before an
 * alias hop is counted or a value shape is judged.
 */
/**
 * Whether anything anywhere in `scope` writes the PROPERTY `member` on any
 * object -- `x.m = v`, `x["m"] = v`, `x.m += v`, `x.m++`, `delete x.m`.
 *
 * THE RECEIVER IS DELIBERATELY NOT MATCHED. This asks "is this member name
 * written at all here?", not "is it written on this object?", because the
 * second question needs object identity and this engine has none: a write
 * reaches an object through the binding, through any alias of it, through
 * a parameter it was passed to, or through a property of something else
 * entirely. Matching the receiver by NAME would be the same
 * resolve-by-spelling mistake the rest of this module exists to avoid, and
 * it would miss `const alias = obj; alias.m = safe;` outright.
 *
 * So the check is over-approximate in exactly the safe direction: an
 * unrelated `other.m = v` in the same scope costs a resolution it did not
 * need to, and no write that could reach the object is ever missed. It is
 * also ORDER-INSENSITIVE -- a write below the call refuses the call too --
 * which is the same trade for the same reason: deciding that a later write
 * cannot affect an earlier call needs execution order across function
 * boundaries, and a closure makes "later in the text" mean nothing. Both
 * costs are precision; the alternative costs soundness (RWF-042
 * remediation § 11-§ 14).
 */
function buildAssignedMembers(scope: ts.Node): ReadonlySet<string> {
  scopeIndexBuilds += 1;
  const assigned = new Set<string>();

  function addMember(expression: ts.Expression): void {
    if (ts.isPropertyAccessExpression(expression)) {
      assigned.add(expression.name.text);
      return;
    }
    if (ts.isElementAccessExpression(expression)) {
      const argument = expression.argumentExpression;
      if (ts.isStringLiteralLike(argument)) {
        assigned.add(argument.text);
      } else {
        // A dynamic key could name ANY member, so nothing in this scope
        // can be called member-stable any more.
        assigned.add(ANY_MEMBER);
      }
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (
        operator >= ts.SyntaxKind.FirstAssignment &&
        operator <= ts.SyntaxKind.LastAssignment
      ) {
        addMember(node.left);
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      addMember(node.operand);
    } else if (ts.isDeleteExpression(node)) {
      addMember(node.expression);
    }
    ts.forEachChild(node, visit);
  }

  visit(scope);
  return assigned;
}

export function unwrapTypeOnly(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * The one declaration in the innermost scope that declares `name`, or the
 * cause that made the question unanswerable. Shadowing is decided here
 * and nowhere else: the FIRST scope walking outward that owns any
 * declaration of the name is the binding scope, full stop -- an outer
 * declaration is never consulted once an inner one exists, and two
 * declarations in that one scope are an ambiguity, not a tie to break.
 */
function findBindingDeclaration(
  reference: ts.Node,
  name: string,
): { declaration: ScopeDeclaration; scope: ts.Node } | NamedBindingUnresolved {
  for (const scope of scopeChainOf(reference)) {
    const owned = declarationsOwnedBy(scope, name);
    if (owned.length === 0) {
      continue;
    }
    if (owned.length > 1) {
      return unresolved("ambiguous_declarations");
    }
    const [declaration] = owned;
    if (!declaration) {
      return unresolved("ambiguous_declarations");
    }
    return { declaration, scope };
  }
  return unresolved("no_declaration");
}

/**
 * Resolves one reference to a name into the single authoritative value or
 * function it denotes, or the reason it cannot be resolved.
 *
 * `reference` must be the actual identifier NODE at the use site, never
 * just its text: everything this module guarantees -- shadowing,
 * evaluation order, which scope's reassignments matter -- is a property
 * of *where* the name is written, and a string cannot carry that.
 */
export function resolveNamedBinding(
  reference: ts.Identifier,
  options: { readonly followAliases?: boolean } = {},
): NamedBinding {
  return resolveFrom(reference, reference.text, new Set(), 0, options);
}

function resolveFrom(
  reference: ts.Node,
  name: string,
  visited: Set<ts.Node>,
  hops: number,
  options: { readonly followAliases?: boolean },
): NamedBinding {
  const found = findBindingDeclaration(reference, name);
  if ("kind" in found) {
    return found;
  }
  const { declaration, scope } = found;

  switch (declaration.kind) {
    case "parameter":
      return unresolved("parameter");
    case "import":
      return unresolved("import_binding");
    case "destructuring":
      return unresolved("destructuring");
    case "class": {
      // P1-B3b § 11. P1-B3 left this refusing, because the only consumer
      // then would have been instance modeling (Block C). The consumer
      // that exists now asks a strictly smaller question -- `new Name()`,
      // which class declaration is that? -- and answering it here is what
      // lets the call graph stop answering it by name.
      const node = declaration.node;
      if (!ts.isClassDeclaration(node) && !ts.isClassExpression(node)) {
        return unresolved("no_declaration");
      }

      // A class binding is MUTABLE, unlike a function declaration:
      // `class Thing {}` followed anywhere in the owning scope by
      // `Thing = other` rebinds the name, and every later `new Thing()`
      // constructs something this module cannot see. Same stability rule
      // a `let` gets, for the same reason.
      if (isAssignedWithin(scope, name)) {
        return unresolved("reassigned");
      }

      // A class DECLARATION does not hoist its value: the binding sits in
      // the temporal dead zone until the definition is evaluated, so a
      // reference above it throws rather than reading the class. Same
      // order rule a `const` gets (P1-B3 § 9), and it carries the same
      // known precision debt for deferred execution (RWF-044).
      //
      // A class EXPRESSION's self-name is exempt for the same reason a
      // function expression's is: the binding exists from the moment the
      // expression is evaluated, which precedes anything inside it
      // running.
      if (ts.isClassDeclaration(node)) {
        if (reference.getStart(node.getSourceFile()) < node.getEnd()) {
          return unresolved("used_before_initialized");
        }
      }
      return { kind: "class", declaration: node };
    }
    case "function": {
      if (ts.isFunctionDeclaration(declaration.node)) {
        return { kind: "function", declaration: declaration.node };
      }
      // P1-B3b § 13: a named function EXPRESSION referring to itself from
      // inside its own body. There is no variable declaration to read and
      // the node is not a `FunctionDeclaration`, so it gets its own kind
      // rather than being coerced into one that promises hoisting.
      if (ts.isFunctionExpression(declaration.node)) {
        // The self-binding is immutable in strict mode and silently
        // unassignable outside it, so an assignment to the name inside
        // the body cannot actually rebind it -- but a file that tries is
        // a file whose intent this module has misread, and refusing
        // costs nothing real.
        if (isAssignedWithin(scope, name)) {
          return unresolved("reassigned");
        }
        return {
          kind: "function-expression",
          declaration: declaration.node,
        };
      }
      return unresolved("no_declaration");
    }
    default:
      break;
  }

  const variable = declaration.variable;
  if (!variable) {
    return unresolved("no_initializer");
  }
  if (visited.has(variable)) {
    return unresolved("alias_cycle");
  }
  const initializer = variable.initializer;
  if (!initializer) {
    return unresolved("no_initializer");
  }

  // ASSIGNMENT STABILITY (P1-B3 § 8). A `const` cannot be rebound, but a
  // `let`/`var` can, from anywhere inside the scope that owns it --
  // including from a closure that runs later. The whole owning scope is
  // searched, not the statements between declaration and use.
  if (variableKind(variable) !== "const" && isAssignedWithin(scope, name)) {
    return unresolved("reassigned");
  }

  // EVALUATION ORDER (P1-B3 § 9). The value exists only once its
  // initializer has been evaluated, so a reference written before the
  // initializer ends cannot read it -- `let`/`const` would throw on the
  // temporal dead zone, and a `var` would read `undefined`. Resolving
  // such a reference means attributing a later assignment to an earlier
  // use, which is precisely the stale attribution this must not do.
  // Function DECLARATIONS are exempt and never reach here: they hoist
  // complete, and are returned above.
  const sourceFile = variable.getSourceFile();
  if (reference.getStart(sourceFile) < initializer.getEnd()) {
    return unresolved("used_before_initialized");
  }

  const value = unwrapTypeOnly(initializer);

  // ALIAS CHAINS (P1-B3 § 10). `a = b; b = fn;` is followed one hop at a
  // time through the same resolution -- so every hop gets the same
  // shadowing, stability and order guarantees the first one did -- with
  // the declarations already seen recorded, so `a = b; b = a;` fails
  // closed instead of recursing.
  if (options.followAliases !== false && ts.isIdentifier(value)) {
    if (hops + 1 > MAX_ALIAS_CHAIN_HOPS) {
      return unresolved("alias_chain_too_long");
    }
    const nextVisited = new Set(visited);
    nextVisited.add(variable);
    const hop = resolveFrom(value, value.text, nextVisited, hops + 1, options);

    // A cycle or an over-long chain is a REFUSAL about the chain itself
    // and must never be reported as though the first hop's value stood.
    if (
      hop.kind === "unresolved" &&
      (hop.cause === "alias_cycle" || hop.cause === "alias_chain_too_long")
    ) {
      return hop;
    }

    // Follow the hop only when it lands somewhere a consumer can actually
    // use. THE CHAIN MUST NOT UNWRAP PAST THE LAST USEFUL NAME: for
    // `const dep = require("pkg"); const alias = dep;`, resolving `alias`
    // all the way to the `require(...)` CALL discards the one thing that
    // identifies which install it is -- the name `dep`, which the module
    // model binds to an exact PackageInstance. Keeping the name is not
    // less sound (`alias` genuinely IS `dep`), it is simply the
    // representation that still carries identity, and handing it back lets
    // symbol-binder.ts answer the module question it owns (P1-B3 § 11,
    // § 18).
    // A hop that lands on a DECLARATION -- a function declaration, a
    // named function expression, a class -- is already the exact node the
    // chain was chasing; there is nothing further to unwrap and no name
    // left to preserve. (`const Alias = Thing;` genuinely is `Thing`, and
    // every hop on the way here passed the same shadowing, stability and
    // order checks the first one did.)
    if (
      hop.kind === "function" ||
      hop.kind === "function-expression" ||
      hop.kind === "class"
    ) {
      return hop;
    }
    if (hop.kind === "value") {
      return isUsableValue(hop.value)
        ? hop
        : { kind: "value", value, declaration: variable, scope };
    }

    // The hop REFUSED. Handing the name onward anyway is only safe when
    // the refusal means "a different resolver owns this name" -- an
    // import or a destructuring, both of which the call graph resolves
    // through machinery that binds the name properly.
    //
    // Every other refusal must propagate. The case that proves it is
    // `lodash`'s `var freeParseInt = parseInt;` at module scope: `parseInt`
    // has no declaration in that file because it is the AMBIENT GLOBAL,
    // and lodash separately defines its own `function parseInt` deep
    // inside `runInContext`. Returning the bare name let a downstream
    // name-only match pair the two and attribute a call to the wrong
    // function entirely -- a fabricated edge, caught by the corpus
    // differential and excluded here at the source (P1-B3 § 7: a name is
    // never resolved by spelling alone).
    if (hop.cause !== "import_binding" && hop.cause !== "destructuring") {
      return hop;
    }
  }

  return { kind: "value", value, declaration: variable, scope };
}

/**
 * Whether a resolved value is a shape some consumer of this module can do
 * something with: a reference that still names something
 * (identifier/member chain), a callable written inline, or an object
 * literal whose members can be read directly.
 *
 * Everything else -- a call result, a `new`, a literal, an operator
 * expression, an element access -- is a value whose CONTENT this module
 * does not model, and unwrapping an alias onto one throws away the name
 * that might still have been resolvable.
 */
function isUsableValue(value: ts.Expression): boolean {
  return (
    ts.isIdentifier(value) ||
    ts.isPropertyAccessExpression(value) ||
    ts.isObjectLiteralExpression(value) ||
    ts.isFunctionExpression(value) ||
    ts.isArrowFunction(value)
  );
}
