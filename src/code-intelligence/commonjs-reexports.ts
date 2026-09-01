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
   * This is what separates "the proof refused this name" from "the proof
   * was never asked about this name at all" (RWF-013). A name in here but
   * NOT in {@link localBindings} was examined and found wanting:
   * reassigned, declared more than once, declared outside module scope,
   * or declared with no initializer. A name absent from here was never a
   * variable at all — a `function` declaration, a class declaration, an
   * import, or a free/global reference — and this model therefore has
   * nothing to say about it, sound or otherwise.
   *
   * Deliberately excludes parameters: `function f(fn) {}` says nothing
   * about a module-scope `function fn() {}` that an export elsewhere in
   * the file legitimately names, and treating it as a refusal would cost
   * real attribution for no soundness gain.
   */
  readonly variableDeclaredNames: ReadonlySet<string>;
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
 *   answer, and exactly ONE hop: it is the declaration's own initializer
 *   expression, never resolved further, so
 *   `const a = f; const b = a; module.exports = b` stops here with `a` —
 *   an identifier, not a function — rather than becoming the arbitrary
 *   chained-alias resolution RWF-012 scopes separately.
 * - `"refused"` means this file DOES bind `name` with a
 *   `var`/`let`/`const`, and the proof above rejected it: reassigned,
 *   declared more than once, declared outside module scope, declared with
 *   no initializer, or destructured (whose value is a property of some
 *   other object, which this relation models nothing about). The refusal
 *   is a fact in its own right — it says the file's own text contradicts
 *   any claim about what `name` holds — and callers must not discard it
 *   in favour of a weaker mechanism (RWF-013).
 * - `"unmodeled"` means this file binds no variable called `name` at all,
 *   so the single-assignment proof was never applicable: a `function`
 *   declaration, a class declaration, an import, or a free reference.
 *   This is silence, NOT a refusal, and callers may fall back to whatever
 *   older mechanism they used before this relation existed.
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
  const binding = facts.localBindings.get(name);
  if (binding?.kind === "value") {
    return { kind: "single-assignment", value: binding.initializer };
  }
  return facts.variableDeclaredNames.has(name)
    ? { kind: "refused" }
    : { kind: "unmodeled" };
}

/**
 * Whether `expr` is a bare identifier whose local binding
 * {@link classifyLocalBinding} examined and REFUSED — the one condition
 * under which an export's name-only function attribution must be
 * suppressed rather than attempted (RWF-013; see module-model.ts's
 * `ExportBinding.localIdentifierProvenanceRefused`).
 *
 * Asked WITHOUT {@link usableFactsOf}'s "has at least one `require()`"
 * short-circuit and without the ambient-shadow guard, for the same reason
 * {@link declaresCommonJsAmbientShadow} is: the unsound shape this
 * suppresses (`let fn = function () {}; fn = other; module.exports = fn`)
 * needs no `require()` anywhere, and a file that shadows the CommonJS
 * ambient names has strictly less provenance, not more.
 *
 * Anything that is not a bare identifier answers `false`: a function
 * expression, an arrow, a class, a `require()` call, a member access — an
 * export over any of those was never resolved by looking a name up, so
 * there is nothing here to suppress.
 */
export function refusesLocalIdentifierProvenance(
  index: SourceIndex,
  expr: ts.Expression,
): boolean {
  const node = unwrapParentheses(expr);
  return (
    ts.isIdentifier(node) &&
    classifyLocalBinding(index, node.text).kind === "refused"
  );
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
 * `allowAliasHop` bounds the local indirection to EXACTLY ONE hop through
 * a same-file, module-scope, provably single-assignment binding (see
 * {@link CommonJsFacts.localBindings}) — the audit's R-5: "directly, or
 * through one level of local-variable indirection". A second hop
 * (`const a = require("./lib"); const b = a; exports.foo = b.foo`) is
 * arbitrary chained-alias resolution — a separate, deliberately
 * unimplemented task (RWF-012) — and resolves to `undefined` here, leaving
 * the export exactly as unresolved as it was before RWF-004a.
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
  allowAliasHop: boolean,
): CommonJsReExportOrigin | undefined {
  const node = unwrapParentheses(expr);

  const specifier = staticRequireSpecifier(node);
  if (specifier !== undefined) {
    return { specifier };
  }

  if (ts.isPropertyAccessExpression(node)) {
    return selectProperty(
      resolveOrigin(facts, node.expression, allowAliasHop),
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
      resolveOrigin(facts, node.expression, allowAliasHop),
      node.argumentExpression.text,
    );
  }

  if (ts.isIdentifier(node) && allowAliasHop) {
    const binding = facts.localBindings.get(node.text);
    if (binding === undefined) {
      return undefined;
    }
    const inner = resolveOrigin(facts, binding.initializer, false);
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
  return facts ? resolveOrigin(facts, expr, true) : undefined;
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
  return facts && rhs ? resolveOrigin(facts, rhs, true) : undefined;
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
    ? resolveOrigin(facts, facts.moduleExportsRhs, true)
    : undefined;
}
