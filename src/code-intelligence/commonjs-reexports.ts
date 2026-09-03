import ts from "typescript";
import type { SourceIndex } from "./source-index.js";

/**
 * The origin of a statically-resolvable CommonJS re-export (RWF-004a; see
 * docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 5's R-5a).
 *
 * `specifier` is the literal argument of the `require()` call the exported
 * value came from — never a computed/dynamic one, which produces no origin
 * at all (see {@link staticRequireSpecifier}).
 *
 * `importedName` is the property selected off that required module
 * (`require("./lib").vulnerable` -> `"vulnerable"`); `undefined` means the
 * WHOLE required module object was re-exported
 * (`module.exports = require("./lib")`), which forwards the entire export
 * namespace rather than one name.
 *
 * This is a *binding* fact about one file's export table, deliberately
 * carrying no resolved file path and no package identity: resolving the
 * specifier, enforcing the same-canonical-PackageInstance rule and turning
 * the result into graph nodes are the call graph's job (see
 * call-graph.ts's `resolveReExportChain`), exactly as they already are for
 * the ESM `export { x } from "./y"` form. Keeping the two responsibilities
 * apart is what stops this from becoming a second, parallel resolution
 * source of truth (SDD-v0.2.md § 5).
 */
export interface CommonJsReExportOrigin {
  readonly specifier: string;
  readonly importedName?: string;
}

/** One same-file `const` binding, as far as this module models values. */
type ConstBinding =
  | { readonly kind: "value"; readonly initializer: ts.Expression }
  | {
      readonly kind: "destructured";
      readonly propertyName: string;
      readonly initializer: ts.Expression;
    };

interface CommonJsFacts {
  /**
   * The LAST `module.exports = X` / `export = X` assignment's right-hand
   * side — Node's real semantics for `module.exports` reassignment are
   * last-write-wins, mirroring module-model.ts's own
   * `findLastModuleExportsAssignment`.
   */
  readonly moduleExportsRhs?: ts.Expression;
  /**
   * The LAST right-hand side assigned to each `exports.X` /
   * `module.exports.X` property, same last-write-wins reasoning.
   */
  readonly propertyRhsByName: ReadonlyMap<string, ts.Expression>;
  /**
   * Every same-file local binding this relation is willing to look
   * through, keyed by the local name it introduces.
   *
   * A name qualifies only when ALL of the following hold, which together
   * make "the value of this name" a fact rather than a guess:
   *
   * - it is declared EXACTLY ONCE in the whole file, counting every
   *   declaration form (a second `var`, a function parameter, a nested
   *   binding, a function declaration — anything that could shadow it in
   *   some scope this relation does not model);
   * - that declaration is a variable declaration WITH an initializer at
   *   the file's own top level, so it is genuinely the module-scope
   *   binding the module-scope export assignment refers to;
   * - it is never assigned to again anywhere in the file (`x = ...`,
   *   `x += ...`, `++x`, a destructuring assignment target, a `for..of`
   *   loop variable), unless it is `const`, which the language already
   *   guarantees.
   *
   * `var` (not just `const`) is accepted under those conditions because
   * `var x = require("./y")` is the dominant real-world CommonJS spelling
   * — qs, semver and debug all use it — and a top-level `var` that is
   * declared once and never reassigned is single-assignment in fact, which
   * is the property this relation actually needs. The check is a real
   * single-assignment proof over the file, not an assumption that `var`
   * behaves like `const`.
   *
   * Deliberately stricter than local-aliases.ts's shipped
   * `resolveSingleAssignmentValue`, whose documented whole-file,
   * first-match-wins imprecision is acceptable for the higher-order-call
   * heuristic it backs but not for an export-identity binding, where an
   * arbitrary pick manufactures a confident-but-wrong target (see
   * call-graph.ts's `resolvesToUnrelatedConstructor` for the same
   * reasoning applied to a different shape).
   */
  readonly localBindings: ReadonlyMap<string, ConstBinding>;
  /**
   * Every name this file binds with a `var`/`let`/`const` declaration,
   * in ANY scope and through any binding pattern — the exact set of names
   * {@link localBindings}'s single-assignment proof has an OPINION about.
   *
   * One of the two things that separate "the proof refused this name"
   * from "the proof was never asked about this name at all" (RWF-013).
   * A name in here but NOT in {@link localBindings} was examined and
   * found wanting: declared more than once, declared outside module
   * scope, or declared with no initializer.
   *
   * Absence from this set does NOT mean the name is unexamined — see
   * {@link reassignedNames}, which is the other, declaration-form-blind
   * half of that question (RWF-013b). A name absent from BOTH was never
   * modeled at all: an un-reassigned `function`/`class` declaration, an
   * import, or a free/global reference.
   *
   * Deliberately excludes parameters: `function f(fn) {}` says nothing
   * about a module-scope `function fn() {}` that an export elsewhere in
   * the file legitimately names, and treating it as a refusal would cost
   * real attribution for no soundness gain.
   */
  readonly variableDeclaredNames: ReadonlySet<string>;
  /**
   * Every name this file demonstrably WRITES TO after binding it —
   * `x = ...`, `x += ...`, `x ||= ...`, `++x`, `x--`, a destructuring
   * assignment target, a `for..of`/`for..in` loop variable (see
   * `markAssigned`). Property mutation (`x.y = ...`) is excluded: it
   * changes the object, not the binding.
   *
   * This is the authoritative NEGATIVE provenance fact, and RWF-013b's
   * whole point is that it is **independent of how the name was
   * originally declared**. A reassignment is direct evidence that the
   * name's original declaration is not what the name holds later in the
   * file — equally true whether that declaration was a `var`, a `let`, a
   * `const`, a `function` declaration or a `class` declaration. JavaScript
   * lets all of them be reassigned, and a reader of the file can see it
   * happen in every case.
   *
   * RWF-013 collected this set but consumed it only when filtering
   * {@link localBindings}, which is built exclusively from VARIABLE
   * declarations. A reassigned `function`/`class` declaration therefore
   * left no trace in {@link variableDeclaredNames}, was classified
   * "unmodeled", and fell through to the legacy name search — which found
   * the stale declaration under exactly the exported name and bound it.
   * Exposing the set here is what lets {@link classifyLocalBinding} act
   * on evidence the file model already had.
   */
  readonly reassignedNames: ReadonlySet<string>;
  /**
   * Whether this file declares a binding of its own named `exports`,
   * `module` or `require` anywhere in it — a user object that merely
   * *looks* like CommonJS (`const exports = {}; exports.foo = ...`), or a
   * locally-defined `require`, so that `exports.X = require("./y").z` is
   * not the CommonJS construct it resembles.
   *
   * When true, this module refuses to derive ANY re-export origin from the
   * file (see {@link resolveCommonJsReExportExpression}). Refusing costs
   * only precision — the export falls through to exactly the unresolved
   * target/UNKNOWN it produced before RWF-004a — whereas accepting it on
   * the strength of a name match alone is exactly the provenance-free
   * binding RWF-011/R-6 identified as unsafe.
   */
  readonly shadowsCommonJsNames: boolean;
}

/** The names whose local (re)declaration invalidates a file's CommonJS provenance. */
const COMMONJS_AMBIENT_NAMES: ReadonlySet<string> = new Set([
  "exports",
  "module",
  "require",
]);

/**
 * Facts are derived once per `ts.SourceFile` and cached on the file object
 * itself, the same discipline (and for the same measured reason) as
 * local-aliases.ts's `constDeclarationsBySourceFile`: the chase below runs
 * per resolution attempt, and re-walking a whole file on each one is
 * quadratic in file size. Keyed on the `SourceFile` object, so it never
 * leaks across files or scans and needs no invalidation.
 */
const factsBySourceFile = new WeakMap<ts.SourceFile, CommonJsFacts>();

/** `require("<string literal>")`'s specifier, or `undefined` for anything else — a computed/dynamic argument included. */
function staticRequireSpecifier(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
    return undefined;
  }
  if (node.expression.text !== "require" || node.arguments.length !== 1) {
    return undefined;
  }
  const [firstArgument] = node.arguments;
  return firstArgument && ts.isStringLiteral(firstArgument)
    ? firstArgument.text
    : undefined;
}

/** `exports.X = ` / `module.exports.X = `'s property name, or `undefined`. Mirrors source-index.ts's `describeCommonJsExportTarget` for the property form only. */
function commonJsExportPropertyName(left: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(left)) {
    return undefined;
  }
  // exports.foo = ...
  if (ts.isIdentifier(left.expression) && left.expression.text === "exports") {
    return left.name.text;
  }
  // module.exports.foo = ...
  if (
    ts.isPropertyAccessExpression(left.expression) &&
    ts.isIdentifier(left.expression.expression) &&
    left.expression.expression.text === "module" &&
    left.expression.name.text === "exports"
  ) {
    return left.name.text;
  }
  return undefined;
}

/** `module.exports = ...` (the whole-module reassignment), never `module.exports.foo = ...`. */
function isModuleExportsAssignmentTarget(left: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(left) &&
    ts.isIdentifier(left.expression) &&
    left.expression.text === "module" &&
    left.name.text === "exports"
  );
}

function isConstDeclaration(decl: ts.VariableDeclaration): boolean {
  const list = decl.parent;
  return (
    ts.isVariableDeclarationList(list) &&
    (list.flags & ts.NodeFlags.Const) !== 0
  );
}

/**
 * Whether `decl` is a MODULE-SCOPE variable declaration — its owning
 * `VariableStatement` is a direct child of the source file. Required
 * because this relation resolves a name referenced from a module-scope
 * export assignment: a declaration nested inside a function is a
 * different binding entirely, and matching it would bind the export to a
 * value the export statement never sees.
 */
function isTopLevelDeclaration(decl: ts.VariableDeclaration): boolean {
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list)) {
    return false;
  }
  const statement = list.parent;
  return (
    ts.isVariableStatement(statement) &&
    ts.isSourceFile(statement.parent as ts.Node)
  );
}

/** Whether an operator token assigns to its left-hand side (`=`, `+=`, `??=`, ...). */
function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

/**
 * Every identifier this node introduces as a *declaration* name — used
 * only to detect a local (re)declaration of `exports`/`module`/`require`.
 * Covers the declaration forms that can actually shadow an ambient
 * CommonJS name in real code; anything not listed simply doesn't
 * contribute, which can only ever make the guard permit a file it should
 * have refused, so the list stays conservative by erring toward listing
 * more rather than fewer forms.
 */
function declaredName(node: ts.Node): string | undefined {
  if (
    (ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isBindingElement(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassExpression(node) ||
      ts.isImportClause(node) ||
      ts.isNamespaceImport(node) ||
      ts.isImportSpecifier(node) ||
      ts.isImportEqualsDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }
  return undefined;
}

/**
 * Every identifier a variable declaration's name position binds, however
 * nested (`var a`, `let { b, c: [d] } = ...`, `const { e = 1 } = ...`).
 * Feeds {@link CommonJsFacts.variableDeclaredNames}.
 */
function collectBoundNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      collectBoundNames(element.name, into);
    }
  }
}

function collectFacts(sourceFile: ts.SourceFile): CommonJsFacts {
  const propertyRhsByName = new Map<string, ts.Expression>();
  /** Candidate module-scope bindings, before the single-assignment proof below. */
  const candidates = new Map<string, ConstBinding>();
  /** Every declaration of a name anywhere in the file, in any form. */
  const declarationCounts = new Map<string, number>();
  /** Names `const` already proves single-assignment for. */
  const constNames = new Set<string>();
  /** Every `var`/`let`/`const`-bound name anywhere in the file (RWF-013). */
  const variableDeclaredNames = new Set<string>();
  /** Names written to somewhere in the file after their declaration. */
  const reassignedNames = new Set<string>();
  let moduleExportsRhs: ts.Expression | undefined;
  let shadowsCommonJsNames = false;

  function countDeclaration(name: string): void {
    declarationCounts.set(name, (declarationCounts.get(name) ?? 0) + 1);
    if (COMMONJS_AMBIENT_NAMES.has(name)) {
      shadowsCommonJsNames = true;
    }
  }

  /** Marks every identifier in an assignment target as written to, however nested (`[a] = ...`, `({ b } = ...)`). */
  function markAssigned(target: ts.Node): void {
    if (ts.isIdentifier(target)) {
      reassignedNames.add(target.text);
      return;
    }
    if (ts.isPropertyAccessExpression(target)) {
      // `x.y = ...` mutates the object, it does not rebind `x`.
      return;
    }
    ts.forEachChild(target, markAssigned);
  }

  function visit(node: ts.Node): void {
    const declared = declaredName(node);
    if (declared !== undefined) {
      countDeclaration(declared);
    }

    if (ts.isVariableDeclaration(node)) {
      collectBoundNames(node.name, variableDeclaredNames);
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name) && isConstDeclaration(node)) {
            constNames.add(element.name.text);
          }
        }
      } else if (ts.isIdentifier(node.name) && isConstDeclaration(node)) {
        constNames.add(node.name.text);
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isTopLevelDeclaration(node)
    ) {
      if (ts.isIdentifier(node.name)) {
        candidates.set(node.name.text, {
          kind: "value",
          initializer: node.initializer,
        });
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name) || element.dotDotDotToken) {
            continue;
          }
          const propertyName =
            element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : element.name.text;
          candidates.set(element.name.text, {
            kind: "destructured",
            propertyName,
            initializer: node.initializer,
          });
        }
      }
    }

    if (ts.isBinaryExpression(node)) {
      if (isAssignmentOperator(node.operatorToken.kind)) {
        markAssigned(node.left);
      }
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const propertyName = commonJsExportPropertyName(node.left);
        if (propertyName !== undefined) {
          propertyRhsByName.set(propertyName, node.right);
        } else if (isModuleExportsAssignmentTarget(node.left)) {
          moduleExportsRhs = node.right;
        }
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      markAssigned(node.operand);
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      // `for (x of ...)` (no declaration list) rebinds an outer `x`.
      if (!ts.isVariableDeclarationList(node.initializer)) {
        markAssigned(node.initializer);
      }
    } else if (ts.isExportAssignment(node) && node.isExportEquals) {
      moduleExportsRhs = node.expression;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const localBindings = new Map<string, ConstBinding>();
  for (const [name, binding] of candidates) {
    const declaredOnce = declarationCounts.get(name) === 1;
    const singleAssignment = constNames.has(name) || !reassignedNames.has(name);
    if (declaredOnce && singleAssignment) {
      localBindings.set(name, binding);
    }
  }

  return {
    moduleExportsRhs,
    propertyRhsByName,
    localBindings,
    variableDeclaredNames,
    reassignedNames,
    shadowsCommonJsNames,
  };
}

function factsOf(sourceFile: ts.SourceFile): CommonJsFacts {
  const cached = factsBySourceFile.get(sourceFile);
  if (cached) {
    return cached;
  }
  const facts = collectFacts(sourceFile);
  factsBySourceFile.set(sourceFile, facts);
  return facts;
}

/**
 * Strips redundant parentheses (`module.exports = (function () {})`) so
 * every relation in this file — and module-model.ts's RWF-003 function
 * binding, which shares it — sees the same value expression whether or not
 * the author wrapped it.
 */
export function unwrapParentheses(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

/**
 * Strips redundant parentheses AND chained plain-assignment expressions
 * from a value expression, so every relation in this file — and
 * module-model.ts's RWF-003 function binding, which shares it — sees the
 * VALUE the expression evaluates to rather than the syntax the author
 * happened to wrap it in.
 *
 * ```text
 * (function () {})                 -> that FunctionExpression
 * exports.decode = decode          -> `decode`
 * exports.a = (exports.b = fn)     -> `fn`
 * ```
 *
 * The assignment step is RWF-012's second half, and it is exact JavaScript
 * semantics rather than a dataflow approximation: the value of `x = v` IS
 * the value of `v`, unconditionally, for every left-hand side (a plain
 * name, a property access, even a setter — a setter's return value is
 * discarded and the assignment still evaluates to `v`). Real
 * `ini@1.3.5`'s whole export table is spelled this way
 * (`exports.parse = exports.decode = decode`), and it is a staple CommonJS
 * idiom for publishing one function under two names.
 *
 * ONLY the plain `=` operator is unwrapped. A compound assignment
 * (`x += v`, `x ||= v`) evaluates to the RESULT of the operation, not to
 * `v`, so unwrapping one would assert an identity that does not hold.
 *
 * Unwrapping an assignment is safe here without any control-flow test of
 * its own because every caller is already gated on
 * {@link module-model.ts}'s `isDefinitelyReachedExportAssignment` (or
 * `ModuleExportsAssignment.isModuleScope`), which climbs out through
 * exactly these chained assignment links before asking whether the whole
 * statement is an unconditional module-scope one. A branch-local
 * `if (cond) { exports.a = exports.b = fn; }` is refused there, before
 * this ever runs.
 */
export function unwrapValue(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      current = current.right;
      continue;
    }
    return current;
  }
}

/**
 * Whether this file declares its own binding named `exports`, `module` or
 * `require` anywhere in it — see
 * {@link CommonJsFacts.shadowsCommonJsNames} for what that means and why
 * it disqualifies the file's CommonJS provenance entirely.
 *
 * Asked here directly, WITHOUT {@link usableFactsOf}'s
 * "has at least one `require()`" short-circuit: that short-circuit is
 * sound for a re-export ORIGIN (every origin bottoms out at a literal
 * `require()`, so a require-free file provably has none), but a
 * `module.exports = function () {}` binding needs no `require()` at all,
 * so the same short-circuit would wave through exactly the shadowed file
 * (`const module = { exports: null }; module.exports = function () {}`)
 * this guard exists to refuse (RWF-003, preserving RWF-004a's
 * ambient-provenance protection).
 *
 * Backed by the same per-`SourceFile` {@link factsOf} cache, so a file
 * that already derived facts for a re-export origin pays nothing extra
 * here.
 */
export function declaresCommonJsAmbientShadow(index: SourceIndex): boolean {
  return factsOf(index.sourceFile).shadowsCommonJsNames;
}

/**
 * What this file's single-assignment model has to say about the local
 * name `name` — the three-way answer RWF-013 needs, where a bare
 * `Expression | undefined` gave only two.
 *
 * - `"single-assignment"` carries the initializer of the module-scope,
 *   provably single-assignment binding (see
 *   {@link CommonJsFacts.localBindings} for the full proof obligation:
 *   declared exactly once in the whole file, at the file's own top level,
 *   with an initializer, and never reassigned). This is the authoritative
 *   answer for exactly ONE hop: it is the declaration's own initializer
 *   expression, never resolved further, so
 *   `const a = f; const b = a; module.exports = b` stops here with `a` —
 *   an identifier, not a function. Callers that need the whole chain
 *   walked ask {@link resolveLocalValue} instead (RWF-012), which is this
 *   same classification iterated under a cycle guard; this one-hop form
 *   is kept because it is the exact primitive that relation is built out
 *   of, and because a caller that wants to inspect one declaration's own
 *   initializer should not be handed a chain's terminal value.
 * - `"refused"` means the file's own text contradicts any claim about
 *   what `name` holds. Two independent grounds produce it:
 *
 *   1. **Reassignment, whatever the declaration form** (RWF-013b) — the
 *      file writes to `name` somewhere (`=`, `+=`, `||=`, `++`, a
 *      destructuring target, a `for..of` variable). This is checked FIRST
 *      and applies to a `var`/`let`/`const`, a `function` declaration and
 *      a `class` declaration alike, because JavaScript lets every one of
 *      them be reassigned and the export carries the CURRENT value, not
 *      the declared one.
 *   2. **A variable binding the single-assignment proof rejected**
 *      (RWF-013) — declared more than once, outside module scope, with no
 *      initializer, or destructured (whose value is a property of some
 *      other object, which this relation models nothing about).
 *
 *   Either way the refusal is a fact in its own right, and callers must
 *   not discard it in favour of a weaker mechanism.
 * - `"unmodeled"` means this file neither binds a variable called `name`
 *   nor ever writes to it, so nothing here has an opinion: an
 *   un-reassigned `function` declaration, an un-reassigned class
 *   declaration, an import, or a free reference. This is silence, NOT a
 *   refusal, and callers may fall back to whatever older mechanism they
 *   used before this relation existed.
 *
 * Collapsing the last two is precisely the RWF-013 defect: both used to
 * surface as `undefined`, so a caller could not tell "I proved this name
 * is not what you think" from "I have never heard of this name."
 */
export type LocalBindingProvenance =
  | { readonly kind: "single-assignment"; readonly value: ts.Expression }
  | { readonly kind: "refused" }
  | { readonly kind: "unmodeled" };

export function classifyLocalBinding(
  index: SourceIndex,
  name: string,
): LocalBindingProvenance {
  const facts = factsOf(index.sourceFile);

  // RWF-013b: reassignment is authoritative negative provenance, and it is
  // asked FIRST — before anything that depends on how the name was
  // declared. A name this file writes to is not a stable alias for
  // whatever it was bound to originally, and that is equally true of a
  // `function`/`class` declaration as of a `var`/`let`/`const`. Asking
  // about the declaration form first is exactly what let a reassigned
  // function declaration escape as "unmodeled" (see
  // {@link CommonJsFacts.reassignedNames}).
  if (facts.reassignedNames.has(name)) {
    return { kind: "refused" };
  }

  const binding = facts.localBindings.get(name);
  if (binding?.kind === "value") {
    return { kind: "single-assignment", value: binding.initializer };
  }
  return facts.variableDeclaredNames.has(name)
    ? { kind: "refused" }
    : { kind: "unmodeled" };
}

/**
 * {@link classifyLocalBinding} followed along a CHAIN of local aliases
 * rather than stopping after one hop — RWF-012's core relation, and the
 * one place the multi-hop walk over {@link CommonJsFacts.localBindings}
 * lives for the function-identity consumers (module-model.ts's
 * RWF-003/RWF-011 attribution). The re-export consumers get the same walk
 * from {@link resolveOrigin}, which has to thread a
 * `specifier`/`importedName` pair through the same hops and so cannot
 * share this signature.
 *
 * ```text
 * fn        (const fn = function () {})           -> that FunctionExpression
 * b         (const b = a; const a = function(){}) -> that FunctionExpression
 * b         (const b = a; a = other)              -> refused
 * b         (const b = a; const a = b)            -> refused (cycle)
 * b         (const b = a; const a = getIt())      -> that CallExpression
 * fn        (function fn() {})                    -> unmodeled
 * ```
 *
 * The three answers mean exactly what {@link classifyLocalBinding}'s do,
 * and this agrees with it hop for hop — it IS that classification,
 * iterated:
 *
 * - `"value"` carries the first expression on the chain that is not a
 *   bare identifier. Every identifier hop that got there was a
 *   module-scope, single-assignment binding of this file's own
 *   ({@link CommonJsFacts.localBindings}), so the chain is a proof that
 *   this expression is what the original name holds — NOT a guess about
 *   it. The value is returned as-is; deciding whether it is an
 *   attributable function node, a `require()` origin, or something this
 *   analyzer models nothing about is the caller's job, unchanged. A
 *   non-identifier input is trivially its own chain of length zero, so
 *   `module.exports = function () {}` answers exactly as it did before.
 * - `"refused"` means some hop's own file text contradicts any claim
 *   about the chain's value. Four grounds produce it, and each one is
 *   checked at EVERY hop, not just the first:
 *
 *   1. **Reassignment, whatever the declaration form** (RWF-013b) — the
 *      file writes to the name somewhere. Checked first, as it is in
 *      {@link classifyLocalBinding}, and it invalidates a chain from any
 *      position: first hop, middle hop or terminal hop alike.
 *   2. **A cycle** — the name is already on the chain being walked
 *      (`const a = b; const b = a`). Both bindings can be individually
 *      impeccable (`const`, declared once, never written to), so the
 *      per-hop proof cannot catch this and the walk would not terminate.
 *      Refusing is the only answer that is not an arbitrary pick from the
 *      cycle.
 *   3. **A variable binding the single-assignment proof rejected**
 *      (RWF-013) — declared more than once anywhere in the file (which is
 *      also what makes a nested same-named `const` refuse rather than
 *      silently resolve against the wrong scope's binding), declared
 *      outside module scope, or declared with no initializer (which is
 *      what a conditionally-initialized `let a; if (c) { a = ... }` looks
 *      like here, on top of its reassignment).
 *   4. **A destructured binding** — `const { parse } = dep` makes the
 *      name a PROPERTY of another object, and this relation models no
 *      object properties. (The re-export relation models exactly one case
 *      of this, `const { parse } = require("pkg")`, because there the
 *      property selection is part of the origin it returns.)
 * - `"unmodeled"` means the chain ran into a name this file neither
 *   variable-binds nor ever writes to — an un-reassigned
 *   `function`/`class` declaration, an import, or a free reference. This
 *   is silence, not a refusal, exactly as in
 *   {@link classifyLocalBinding}, and callers may fall back to whatever
 *   older mechanism they used before.
 *
 * Termination: every iteration either returns, or adds a name to
 * `visited` and continues. `visited` only grows, and the names it can add
 * are drawn from {@link CommonJsFacts.localBindings}, which is finite — so
 * the loop runs at most once per binding in the file. No recursion, hence
 * no stack to overflow, however long or however cyclic the chain.
 */
export type LocalValueProvenance =
  | { readonly kind: "value"; readonly value: ts.Expression }
  | { readonly kind: "refused" }
  | { readonly kind: "unmodeled" };

export function resolveLocalValue(
  index: SourceIndex,
  expr: ts.Expression,
): LocalValueProvenance {
  const visited = new Set<string>();
  let node = unwrapValue(expr);

  while (ts.isIdentifier(node)) {
    // The cycle guard, asked before the hop is classified: `const a = b;
    // const b = a` gives two individually impeccable bindings, so no
    // per-hop proof can catch it and the walk would not terminate.
    if (visited.has(node.text)) {
      return { kind: "refused" };
    }
    visited.add(node.text);

    // The per-hop proof is {@link classifyLocalBinding}, unchanged and
    // undiluted — this relation adds hops, never permissiveness. Building
    // on it rather than re-deriving its facts is deliberate: RWF-013's
    // and RWF-013b's refusal grounds cannot drift out of sync with the
    // chain walker if there is only one implementation of them, and
    // `"refused"`/`"unmodeled"` propagate out of the chain carrying
    // exactly the meaning they carry for a single binding.
    const hop = classifyLocalBinding(index, node.text);
    if (hop.kind !== "single-assignment") {
      return hop;
    }
    node = unwrapValue(hop.value);
  }

  return { kind: "value", value: node };
}

/**
 * Whether `expr` resolves, along the alias chain
 * {@link resolveLocalValue} walks, to a binding this file's own text
 * REFUSES — the one condition under which an export's name-only function
 * attribution must be suppressed rather than attempted (RWF-013; see
 * module-model.ts's `ExportBinding.localIdentifierProvenanceRefused`).
 *
 * RWF-012 widened this from "is a bare identifier the one-hop
 * classification refused" to "reaches a refused binding anywhere along
 * the chain", which can only ever ADD refusals. That is the conservative
 * direction by construction: a refusal never binds anything, it only
 * stops the same-file name search from binding something the analyzer has
 * just proved it cannot determine. It closes a real gap in the process —
 *
 * ```js
 * let stale = function () {};   // indexed under the name "stale"
 * stale = somethingElse;
 * const alias = stale;
 * exports.stale = alias;        // RWF-013 saw only `alias`, which is clean
 * ```
 *
 * — where the chain, not the first hop, is what touches the reassigned
 * binding.
 *
 * Asked WITHOUT {@link usableFactsOf}'s "has at least one `require()`"
 * short-circuit and without the ambient-shadow guard, for the same reason
 * {@link declaresCommonJsAmbientShadow} is: the unsound shape this
 * suppresses (`let fn = function () {}; fn = other; module.exports = fn`)
 * needs no `require()` anywhere, and a file that shadows the CommonJS
 * ambient names has strictly less provenance, not more.
 *
 * Anything whose chain bottoms out in a non-identifier answers `false`: a
 * function expression, an arrow, a class, a `require()` call, a member
 * access — an export over any of those was never resolved by looking a
 * name up, so there is nothing here to suppress.
 */
export function refusesLocalIdentifierProvenance(
  index: SourceIndex,
  expr: ts.Expression,
): boolean {
  return resolveLocalValue(index, expr).kind === "refused";
}

/**
 * The right-hand side of this file's last `exports.<exportedName> = ...` /
 * `module.exports.<exportedName> = ...` assignment, or `undefined` when it
 * has none.
 *
 * Exposed so module-model.ts can ask {@link refusesLocalIdentifierProvenance}
 * about the property form too: `exports.parse = parse` binds an export to
 * an identifier exactly as `module.exports = parse` does, and is the shape
 * the RWF-013 reproducer actually hits (see
 * fixtures/commonjs-stale-alias-export/). Uses the same last-write-wins
 * map {@link commonJsPropertyReExportOrigin} does, so both relations see
 * the same assignment.
 */
export function commonJsPropertyExportRhs(
  index: SourceIndex,
  exportedName: string,
): ts.Expression | undefined {
  return factsOf(index.sourceFile).propertyRhsByName.get(exportedName);
}

/**
 * The core relation, applied to one expression:
 *
 * ```text
 * require("./lib")            -> { specifier: "./lib" }
 * require("./lib").foo        -> { specifier: "./lib", importedName: "foo" }
 * require("./lib")["foo"]     -> { specifier: "./lib", importedName: "foo" }
 * lib.foo   (const lib = require("./lib"))        -> { "./lib", "foo" }
 * foo       (const { foo } = require("./lib"))    -> { "./lib", "foo" }
 * foo       (const foo = require("./lib").foo)    -> { "./lib", "foo" }
 * ```
 *
 * `visitedAliases` bounds the local indirection. RWF-004a admitted EXACTLY
 * ONE hop through a same-file, module-scope, provably single-assignment
 * binding (see {@link CommonJsFacts.localBindings}) — the audit's R-5:
 * "directly, or through one level of local-variable indirection". RWF-012
 * lifts that to an arbitrary number of hops, WITHOUT weakening what a hop
 * has to prove: every identifier on the chain must still be a
 * {@link CommonJsFacts.localBindings} member, which is a per-hop proof
 * (declared exactly once in the whole file, at the file's own top level,
 * with an initializer, and never assigned to again). A chain is resolved
 * only when EVERY hop clears that bar, so
 *
 * ```js
 * const target = require("pkg").parse;
 * const a = target;
 * const b = a;
 * exports.parse = b;          // -> { specifier: "pkg", importedName: "parse" }
 * ```
 *
 * resolves, while a single unproven hop anywhere along it stops the whole
 * chase at `undefined` — exactly as unresolved as before RWF-004a.
 *
 * `visitedAliases` is what makes the traversal terminate. `const a = b;
 * const b = a;` is a perfectly well-formed pair of module-scope,
 * single-assignment bindings (each is `const`, each is declared once,
 * neither is ever written to), so the per-hop proof alone would recurse
 * forever. A name already on the current chain is refused instead, which
 * ends the chase at `undefined` rather than at an arbitrary member of the
 * cycle.
 *
 * The set is keyed by identifier TEXT, and within one file's facts that IS
 * binding identity: {@link CommonJsFacts.localBindings} admits a name only
 * when the whole file declares it exactly once, in any form and any scope
 * (`declarationCounts.get(name) === 1`), so a name in the map denotes one
 * and only one binding. There is no cross-file traversal to confuse here
 * either — this relation never leaves the file it was given, and yields a
 * `specifier` for call-graph.ts to resolve instead.
 *
 * Every other shape yields `undefined`, which is the whole point: a
 * dynamic specifier (`require(name)`), a conditional
 * (`cond ? require("./a") : require("./b")`), a deep member access
 * (`require("./lib").a.b`), a call result, a spread — none of these have a
 * single statically-known origin, and this function never guesses one.
 */
function resolveOrigin(
  facts: CommonJsFacts,
  expr: ts.Expression,
  visitedAliases: Set<string>,
): CommonJsReExportOrigin | undefined {
  const node = unwrapValue(expr);

  const specifier = staticRequireSpecifier(node);
  if (specifier !== undefined) {
    return { specifier };
  }

  if (ts.isPropertyAccessExpression(node)) {
    return selectProperty(
      resolveOrigin(facts, node.expression, visitedAliases),
      node.name.text,
    );
  }

  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    // `require("./lib")["vulnerable"]` — statically known despite the
    // bracket syntax, exactly as symbol-binder.ts's `analyzeCalleeShape`
    // already treats `foo["vulnerable"]()` on the call side. A non-literal
    // key falls through to `undefined` below, never to a guess.
    return selectProperty(
      resolveOrigin(facts, node.expression, visitedAliases),
      node.argumentExpression.text,
    );
  }

  if (ts.isIdentifier(node)) {
    // The per-hop proof: only a module-scope, single-assignment binding
    // this file itself established may be looked through. A name the
    // proof rejected, a name declared more than once anywhere in the
    // file, a parameter, an import, a free/global reference — all of them
    // are absent from the map and stop the chase here.
    const binding = facts.localBindings.get(node.text);
    if (binding === undefined) {
      return undefined;
    }
    // The cycle guard. A name already on this chain cannot be resolved by
    // continuing along it, and refusing is the only answer that is not an
    // arbitrary pick from the cycle. Every path through this function
    // chases at most ONE sub-expression (a property access has exactly
    // one base), so the chase is a single walk and one shared set is
    // exactly the set of names on the current chain.
    if (visitedAliases.has(node.text)) {
      return undefined;
    }
    visitedAliases.add(node.text);
    const inner = resolveOrigin(facts, binding.initializer, visitedAliases);
    if (!inner) {
      return undefined;
    }
    return binding.kind === "value"
      ? inner
      : selectProperty(inner, binding.propertyName);
  }

  return undefined;
}

/**
 * Selects `propertyName` off an origin. Only a WHOLE-module origin has a
 * namespace to select from: selecting off an origin that already names one
 * export (`require("./lib").a.b`) would be a property of that export's own
 * value, which this relation models nothing about.
 */
function selectProperty(
  base: CommonJsReExportOrigin | undefined,
  propertyName: string,
): CommonJsReExportOrigin | undefined {
  if (!base || base.importedName !== undefined) {
    return undefined;
  }
  return { specifier: base.specifier, importedName: propertyName };
}

/**
 * The facts for a file that could possibly have a CommonJS re-export, or
 * `undefined` when it provably cannot.
 *
 * Every origin this module can ever produce bottoms out at a literal
 * `require("...")` call, and source-index.ts records EVERY such call as a
 * `bindingKind: "commonjs"` import (see its `isRequireCall` /
 * `extractRequireBindings` — even an inline
 * `exports.foo = require("./lib").foo`, which it records as a
 * side-effect-shaped entry carrying the specifier). So a file with no
 * CommonJS import at all can have no re-export origin, exactly, not
 * approximately.
 *
 * That makes this an exact short-circuit rather than a heuristic, and it
 * matters for cost: without it every indexed file pays a whole extra AST
 * walk for {@link collectFacts}, including the overwhelming majority
 * (pure-ESM modules, and any file that requires nothing) that provably
 * cannot benefit. Measured on scan-performance.test.ts's 9,000-declaration
 * single-file fixture, which requires nothing at all, the unguarded walk
 * cost ~260ms per `buildModuleModel` call.
 *
 * Also refuses outright for any file that declares its own
 * `exports`/`module`/`require` binding — see
 * {@link CommonJsFacts.shadowsCommonJsNames}.
 */
function usableFactsOf(index: SourceIndex): CommonJsFacts | undefined {
  if (!index.imports.some((imp) => imp.bindingKind === "commonjs")) {
    return undefined;
  }
  const facts = factsOf(index.sourceFile);
  return facts.shadowsCommonJsNames ? undefined : facts;
}

/**
 * The CommonJS re-export origin of an arbitrary expression appearing in a
 * file's export position (an object-literal property's initializer, a
 * `module.exports = X` right-hand side), or `undefined` when it has none.
 */
export function resolveCommonJsReExportExpression(
  index: SourceIndex,
  expr: ts.Expression,
): CommonJsReExportOrigin | undefined {
  const facts = usableFactsOf(index);
  return facts ? resolveOrigin(facts, expr, new Set()) : undefined;
}

/**
 * The CommonJS re-export origin of `exports.<exportedName> = ...` /
 * `module.exports.<exportedName> = ...`, or `undefined` when the file has
 * no such assignment or its right-hand side has no static origin.
 */
export function commonJsPropertyReExportOrigin(
  index: SourceIndex,
  exportedName: string,
): CommonJsReExportOrigin | undefined {
  const facts = usableFactsOf(index);
  const rhs = facts?.propertyRhsByName.get(exportedName);
  return facts && rhs ? resolveOrigin(facts, rhs, new Set()) : undefined;
}

/**
 * The CommonJS re-export origin of the file's final `module.exports = X` /
 * `export = X` assignment, or `undefined`.
 */
export function commonJsModuleReExportOrigin(
  index: SourceIndex,
): CommonJsReExportOrigin | undefined {
  const facts = usableFactsOf(index);
  return facts?.moduleExportsRhs
    ? resolveOrigin(facts, facts.moduleExportsRhs, new Set())
    : undefined;
}
