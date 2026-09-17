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

export interface NamedBindingUnresolved {
  readonly kind: "unresolved";
  readonly cause: NamedBindingUnresolvedCause;
}

export type NamedBinding =
  NamedBindingValue | NamedBindingFunction | NamedBindingUnresolved;

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
function declarationsOwnedBy(scope: ts.Node, name: string): ScopeDeclaration[] {
  const found: ScopeDeclaration[] = [];

  // A named function/class expression binds its own name within itself.
  if (
    (ts.isFunctionExpression(scope) || ts.isClassExpression(scope)) &&
    scope.name?.text === name
  ) {
    found.push({
      kind: ts.isFunctionExpression(scope) ? "function" : "class",
      node: scope,
    });
  }

  const ownsHoisted = (declaration: ts.Node): boolean =>
    enclosingFunctionScope(declaration) === scope;
  const ownsLexical = (declaration: ts.Node): boolean =>
    enclosingBlockScope(declaration) === scope;

  function collectFromBindingPattern(
    declaration: ts.VariableDeclaration,
    pattern: ts.BindingPattern,
  ): void {
    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) {
        continue;
      }
      if (ts.isIdentifier(element.name)) {
        if (element.name.text === name) {
          const kind = variableKind(declaration);
          const owned =
            kind === "var"
              ? ownsHoisted(declaration)
              : ownsLexical(declaration);
          if (owned) {
            found.push({ kind: "destructuring", node: element });
          }
        }
      } else {
        collectFromBindingPattern(declaration, element.name);
      }
    }
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
      const kind = variableKind(node);
      const owned = kind === "var" ? ownsHoisted(node) : ownsLexical(node);
      if (ts.isIdentifier(node.name)) {
        if (node.name.text === name && owned) {
          found.push({ kind, node, variable: node });
        }
      } else {
        collectFromBindingPattern(node, node.name);
      }
    } else if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === name &&
      ownsHoisted(node)
    ) {
      found.push({ kind: "function", node });
    } else if (
      ts.isClassDeclaration(node) &&
      node.name?.text === name &&
      ownsLexical(node)
    ) {
      found.push({ kind: "class", node });
    } else if (
      ts.isParameter(node) &&
      node.parent === scope &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found.push({ kind: "parameter", node });
    } else if (
      ts.isCatchClause(node) &&
      node === scope &&
      node.variableDeclaration &&
      ts.isIdentifier(node.variableDeclaration.name) &&
      node.variableDeclaration.name.text === name
    ) {
      found.push({ kind: "parameter", node });
    } else if (
      ts.isSourceFile(scope) &&
      (ts.isImportSpecifier(node) ||
        ts.isImportClause(node) ||
        ts.isNamespaceImport(node) ||
        ts.isImportEqualsDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found.push({ kind: "import", node });
    }
  }

  visit(scope);
  return found;
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
function isAssignedWithin(scope: ts.Node, name: string): boolean {
  let assigned = false;

  function isTargetName(expression: ts.Expression): boolean {
    return ts.isIdentifier(expression) && expression.text === name;
  }

  function scanAssignmentTarget(target: ts.Node): void {
    if (ts.isIdentifier(target)) {
      if (target.text === name) {
        assigned = true;
      }
      return;
    }
    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          if (property.name.text === name) {
            assigned = true;
          }
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
    if (assigned) {
      return;
    }
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
      isTargetName(node.operand)
    ) {
      assigned = true;
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
    case "class":
      // A class binding is constructor/instance modeling, which P1-B3
      // § 14 holds outside this block deliberately.
      return unresolved("no_declaration");
    case "function": {
      if (ts.isFunctionDeclaration(declaration.node)) {
        return { kind: "function", declaration: declaration.node };
      }
      // A named function EXPRESSION referring to itself from inside its
      // own body. There is no variable declaration to read, and the
      // expression node is not a `FunctionDeclaration`, so this stays
      // out of the resolved vocabulary rather than being coerced into it.
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
    if (hop.kind === "function") {
      return hop;
    }
    if (hop.kind === "value") {
      return isUsableValue(hop.value)
        ? hop
        : { kind: "value", value, declaration: variable };
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

  return { kind: "value", value, declaration: variable };
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
