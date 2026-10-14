import ts from "typescript";
import type { SourceLocation } from "../domain/graph.js";
import {
  commonJsExportPropertyName,
  commonJsModuleReExportOrigin,
  commonJsPropertyExportRhs,
  commonJsPropertyReExportOrigin,
  declaresCommonJsAmbientShadow,
  isModuleExportsAssignmentTarget,
  refusesLocalIdentifierProvenance,
  resolveCommonJsReExportExpression,
  resolveLocalValue,
  resolveLocalValueByName,
  unwrapParentheses,
  unwrapValue,
  type CommonJsReExportOrigin,
  type LocalValueProvenance,
} from "./commonjs-reexports.js";
import {
  isNameAssignedWithin,
  lexicalDeclarationOf,
} from "./named-bindings.js";
import {
  exactCommonJsExportPropertyName,
  type IndexedExport,
  type IndexedFunction,
  type SourceIndex,
  toSourceLocation,
} from "./source-index.js";

export type ModuleSyntax = "esm" | "commonjs";

/**
 * A binding's semantic shape, unified across ESM and CommonJS so downstream
 * consumers (TASK-016 Module Resolution, TASK-017 Symbol Binding) can treat
 * `import foo from "x"` and `const foo = require("x")` identically — both
 * bind the whole module to one local name — while still knowing which
 * syntax produced it via {@link ModuleSyntax} (see docs/SDD.md § 17's
 * convergence examples).
 */
export type BindingKind = "default" | "named" | "namespace" | "side-effect";

export interface ImportBinding {
  readonly specifier: string;
  readonly kind: BindingKind;
  readonly syntax: ModuleSyntax;
  readonly localName?: string;
  /** The original exported name, when it differs from `localName` (aliasing). */
  readonly importedName?: string;
  readonly location: SourceLocation;
}

export type ExportKind = "named" | "default" | "namespace" | "re-export";

export interface ExportBinding {
  readonly kind: ExportKind;
  readonly syntax: ModuleSyntax;
  readonly exportedName?: string;
  readonly localName?: string;
  /** The source module, for re-exports (`export { a } from "./x"`). */
  readonly specifier?: string;
  /**
   * For a CommonJS export whose value came from a `require()` of another
   * module (RWF-004a/RWF-004b): where that value originates. `undefined`
   * for every export defined locally, and for every CommonJS export whose
   * right-hand side has no single statically-known origin (a dynamic
   * specifier, a chained alias) — see {@link CommonJsReExportOrigin} and
   * commonjs-reexports.ts.
   *
   * Also `undefined` for an export assignment this file cannot prove runs
   * unconditionally, once, at module scope — see
   * {@link isDefinitelyReachedExportAssignment}, whose doc comment carries the
   * reasoning and the false NOT_AFFECTED it prevents. Every provenance
   * field on this interface is gated on that same test, for the same
   * reason: they all read a last-write-wins map.
   *
   * Deliberately separate from {@link specifier}, which carries the ESM
   * `export { a } from "./x"` form: the two are different syntaxes read
   * out of different AST shapes, and each is resolved by its own relation
   * in call-graph.ts's `resolveReExportChain`. Both now reach across
   * package boundaries (RWF-004b), each landing on whatever installed
   * instance Node's own resolution of its specifier reaches from the file
   * that spells it.
   */
  readonly commonJsReExport?: CommonJsReExportOrigin;
  /**
   * The exact source position of the function-like expression this binding's
   * exported value IS, when the export assignment structurally *references*
   * one (RWF-003; see docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 5's R-3,
   * tests/validation/FINDINGS.md RWF-003).
   *
   * This is the export's CONCRETE FUNCTION IDENTITY, deliberately kept
   * separate from {@link localName}, which is a *name* the export can be
   * looked up by. The two answer different questions and neither implies
   * the other:
   *
   * - `module.exports = function () {}` has an identity but NO name — the
   *   whole point of RWF-003. Before this field existed the export was
   *   simply unattributable, because the only mechanism available was a
   *   name lookup and there was no name to look up.
   * - `module.exports = function internalName() {}` has both, and they
   *   disagree about what they mean: `internalName` is the function's own
   *   INTERNAL name, not the public binding an importer sees (which is the
   *   canonical `"default"`). Matching on it happens to work, but only
   *   because no other function in the file shares that text.
   *
   * A position is not a guess and cannot collide: exactly one AST node
   * begins at a given offset in a file, and source-index.ts records every
   * function-like node under that same position (see `extractFunction`'s
   * `toSourceLocation`). So `mapExportsToFunctions` resolving through this
   * field is an identity, where resolving through {@link localName} is a
   * same-file name search that can land on a different function that
   * merely shares the text.
   *
   * `undefined` whenever the exported value is not a directly-referenced
   * function — including every shape this deliberately refuses to guess at:
   * a conditionally-assigned export, a file that shadows the CommonJS
   * ambient names, an alias chain longer than one hop, and any value that
   * is not statically a function at all. See
   * {@link directExportedFunctionLocation}.
   */
  readonly localFunctionLocation?: SourceLocation;
  /**
   * Whether this export's value is an identifier whose same-file binding
   * the local-provenance model EXAMINED AND REFUSED (RWF-013, widened by
   * RWF-013b; see `classifyLocalBinding` in commonjs-reexports.ts).
   *
   * Purely internal analysis state: never serialized, never surfaced in
   * evidence, and read by exactly one consumer —
   * {@link mapExportsToFunctions}, which must not fall back to a
   * name-only function search for such an export.
   *
   * This exists because {@link localFunctionLocation} being `undefined`
   * is NOT sufficient to decide that question, and treating it as if it
   * were is what made the defect look fixable without a new field.
   * `undefined` there is the answer for every export RWF-003's identity
   * relation does not model at all, most of which the older name-based
   * attribution handles perfectly well and soundly:
   *
   * ```text
   * function fn() {}          module.exports = fn   -- an un-reassigned function
   *                                                    DECLARATION, still bound by name
   * const C = class {};       module.exports = C    -- a class, attributed by
   *                                                    name via its constructor
   * exports.foo = function () {}                    -- a property export, which
   *                                                    this relation never covered
   * ```
   *
   * Suppressing the fallback on `undefined` alone would silently drop all
   * of those. So the two facts are carried separately: a *location* says
   * "the export IS this function node", and this flag says "the file's own
   * text contradicts any claim about what this name holds". Only the
   * second one is grounds for refusing to guess.
   *
   * The refused shapes, and what each one taught:
   *
   * ```js
   * let fn = function () {};   // RWF-013: indexed under the name "fn"
   * fn = other;                // ...and immediately stale
   * module.exports = fn;       // binds "fn" -> the STALE node, by name
   *
   * function fn() {}           // RWF-013b: the SAME defect, and the
   * fn = other;                // declaration form is irrelevant to it --
   * module.exports = fn;       // JavaScript reassigns this just as freely
   * ```
   *
   * The second shape is why the underlying question is "does this file
   * write to this name?", asked before and independently of "how was this
   * name declared?". Restricting the refusal to variable bindings left
   * reassigned `function`/`class` declarations attributing their stale
   * node, which reproduced a false NOT_AFFECTED carrying a complete
   * Family C proof.
   *
   * Deliberately independent of the module-scope and ambient-shadow
   * guards that gate {@link localFunctionLocation}: a conditional
   * assignment or a file that shadows `module`/`exports`/`require` has
   * strictly LESS provenance for the same identifier, never more.
   */
  readonly localIdentifierProvenanceRefused?: boolean;
  /**
   * Whether this binding is the placeholder for a whole-module export
   * whose value {@link selectAuthoritativeWholeModuleExport} REFUSED to
   * name (RWF-014/015/016/017/018/019), rather than one it attributed
   * (RWF-021).
   *
   * Purely internal analysis state: never serialized, never surfaced in
   * evidence, and read by exactly one consumer —
   * {@link entrypointRootCandidates}, which must WIDEN rather than
   * narrow when it sees it.
   *
   * This exists because the ABSENCE of {@link localName} is not sufficient
   * to tell the two situations apart, and treating it as if it were is
   * precisely the defect RWF-021 fixes. Both of these produce a binding
   * with no `localName` and no {@link localFunctionLocation}:
   *
   * ```js
   * module.exports = 42;                 // attributed: exports no callable
   * if (flag) { bail(); }                // WITHDRAWN: exports `main`, or
   * module.exports = main;               //   nothing, and we cannot say which
   * ```
   *
   * The first genuinely has no callable export and needs no root. The
   * second has one this analyzer declined to name, and dropping its root
   * makes the exported function's body invisible to reachability — which
   * reproduced a false NOT_AFFECTED carrying a complete Family C proof for
   * every one of the RWF-016/017/018/019 cutoff families. See
   * {@link entrypointRootCandidates}.
   */
  readonly exportAttributionWithdrawn?: boolean;
  /**
   * On a CommonJS whole-module export whose value is another module's
   * ({@link commonJsReExport}, `module.exports = require("./lib")`): the
   * names this file's export write set records it may write onto that object
   * (task E-2; ADR 0009 § 1's "the same determination gates the
   * forwarding hop"). The object is the other module's own exports, so
   * such a write replaces what the forwarded name holds:
   *
   * ```js
   * module.exports = require("./safe");
   * [module.exports.run] = [require("./danger").run];  // run is danger's
   * ```
   *
   * A plain `=` write leaves a named binding the hop already refuses on;
   * a write E-1's census can only withdraw ({@link ExportWriteSet.withdrawn})
   * leaves none, and forwarding `run` to `./safe` was RWF-105's false
   * NOT_AFFECTED. Every name withdrawn is here, and every `=` write not
   * provably on a stale object.
   *
   * Bounded by the census: a write reaching the forwarded object through a
   * load result's dataflow the census does not follow
   * (`patch(require("./safe"))`, `[require("./safe")][0].run = …`) is not
   * here, and the hop still forwards its name -- RWF-106, open, which
   * shares RWF-103's undecided fix.
   *
   * Set by {@link applyExportWriteSet} on every whole-module re-export it
   * keeps. Purely internal analysis state, read by exactly one consumer,
   * export-forwarding.ts's `commonJsExportForwardingHop`, which refuses to
   * forward a name listed here -- and refuses every name when it is
   * absent, since an absent record is a write set nobody consulted.
   */
  readonly forwardingShadowedNames?: ReadonlySet<string>;
  readonly location: SourceLocation;
}

/**
 * The unified import/export model for one module (see docs/SDD.md § 15-17).
 * Built from a {@link SourceIndex} (TASK-014) rather than re-parsing:
 * TASK-014 extracts per-syntax-construct facts; this normalizes them into
 * one shape regardless of which syntax was used.
 */
export interface ModuleModel {
  readonly filePath: string;
  readonly imports: readonly ImportBinding[];
  readonly exports: readonly ExportBinding[];
}

function toImportBinding(imp: SourceIndex["imports"][number]): ImportBinding {
  if (imp.bindingKind === "commonjs") {
    const kind: BindingKind = imp.importedName
      ? "named"
      : imp.localName
        ? "default"
        : "side-effect";
    return {
      specifier: imp.specifier,
      kind,
      syntax: "commonjs",
      localName: imp.localName,
      importedName: imp.importedName,
      location: imp.location,
    };
  }

  return {
    specifier: imp.specifier,
    kind: imp.bindingKind,
    syntax: "esm",
    localName: imp.localName,
    importedName: imp.importedName,
    location: imp.location,
  };
}

/**
 * How much a single `module.exports = X` / `export = X` write can be
 * trusted to describe the module's exported value, judged purely
 * syntactically (RWF-014). The three cases differ in WHEN the write runs,
 * which is the only thing that decides whether a later write overwrites
 * it:
 *
 * - `"unconditional"` — the write's own statement is a direct child of the
 *   source file (modulo a chained-assignment climb; see
 *   {@link isDefinitelyReachedExportAssignment}). Module evaluation runs every
 *   such statement, exactly once, in source order. This write DEFINITELY
 *   happens, and definitely happens before every later top-level one.
 * - `"conditional"` — nested inside an `if`/`else`/`try`/`catch`/`finally`/
 *   `switch`/loop/bare block, but still inside the module's own top-level
 *   statement list. It MAY not run; if it does run, it runs at the point
 *   its enclosing top-level statement is reached, so source order still
 *   orders it against the unconditional writes around it.
 * - `"deferred"` — nested inside a function, class body, or class static
 *   block. Source position says NOTHING about when it runs: a
 *   `function configure() { module.exports = fn; }` can be called by an
 *   IMPORTER, long after module evaluation finished, and overwrite an
 *   assignment that appears later in the file. An IIFE is classified here
 *   too — proving that a function expression is invoked immediately is
 *   call-graph work this relation deliberately does not do.
 * - `"bypassable"` — a direct child of the source file exactly as
 *   `"unconditional"` is, but with an earlier top-level statement that can
 *   end module evaluation before it (a module-scope `return`, or an
 *   uncaught `throw`) — so it runs on SOME loads and not others (RWF-015).
 *   Being written at top level is what makes this distinct from
 *   `"conditional"`, and being skippable is what stops it being
 *   `"unconditional"`; see {@link isDefinitelyReachedModuleScopeStatement}.
 */
type WholeModuleExportAuthority =
  "unconditional" | "bypassable" | "conditional" | "deferred";

interface ModuleExportsAssignment {
  readonly rhs: ts.Expression;
  readonly location: SourceLocation;
  /**
   * Whether the assignment is an UNCONDITIONAL module-scope statement —
   * its own statement is a direct child of the source file, not nested
   * inside an `if`/`try`/loop/function body (RWF-003).
   *
   * Deliberately NOT the same test as {@link authority}, which climbs out
   * through chained assignments first: the two differ for exactly one
   * real shape, `exports = module.exports = require("./debug")` (real
   * `debug@2.0.0`), where the inner `module.exports` write is
   * unconditional by execution but its enclosing node is the outer
   * assignment rather than a statement. The re-export relation accepts
   * that shape and the function-identity relation does not — see
   * {@link wholeModuleDefaultExport}'s two gates.
   */
  readonly isModuleScope: boolean;
  /** This write's execution-time authority — see {@link WholeModuleExportAuthority}. */
  readonly authority: WholeModuleExportAuthority;
}

/** Whether a node is a function-like *expression* — the only value shape a `module.exports = X` assignment can directly make callable. */
function isDirectFunctionValue(
  node: ts.Expression,
): node is ts.FunctionExpression | ts.ArrowFunction {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

/**
 * The exact source position of the function-like node a *property*
 * export's right-hand side IS, when the right-hand side is one
 * structurally (RWF-011). The property-export counterpart of
 * {@link directExportedFunctionLocation}, and the same kind of fact: a
 * position identifies exactly one AST node, so this is an identity, never
 * a same-file text match.
 *
 * ```text
 * exports.foo = function () {}      -> that FunctionExpression
 * exports.foo = function bar() {}   -> that FunctionExpression
 * exports.foo = async function () {}-> that FunctionExpression
 * exports.foo = () => {}            -> that ArrowFunction
 * exports.Foo = class { m() {} }    -> that class's constructor
 * module.exports = { foo() {} }     -> that MethodDeclaration
 * ```
 *
 * A class expression IS matched here, unlike in
 * {@link directExportedFunctionLocation}: the callable node a class
 * exports is its constructor, and source-index.ts indexes one for every
 * class — the explicit `constructor() {}` member when the class declares
 * it, and otherwise a synthesized entry positioned at the class's own name
 * (or, for an anonymous class, at the class node itself; see
 * `extractImplicitConstructor`). {@link classConstructorNode} reproduces
 * that choice exactly, so the position resolves to the very entry source
 * indexing recorded. This is what keeps `exports.Foo = class { ... }`
 * attributable — and therefore keeps
 * {@link findExportedClassMembers}'s exported-class set populated — once
 * the coincidental name fallback is gone.
 *
 * `undefined` for every other right-hand side, which is the whole point:
 * `exports.foo = registry.impl`, `exports.foo = makeFoo()`,
 * `exports.foo = obj.foo` and `exports.foo = cond ? a : b` name no
 * function node at all, and this relation says so rather than letting the
 * export's public NAME go looking for one.
 */
function directValueFunctionLocation(
  sourceFile: ts.SourceFile,
  value: ts.Expression,
): SourceLocation | undefined {
  const node = unwrapParentheses(value);
  if (isDirectFunctionValue(node)) {
    return toSourceLocation(sourceFile, node);
  }
  if (ts.isClassExpression(node)) {
    return toSourceLocation(sourceFile, classConstructorNode(node));
  }
  return undefined;
}

/**
 * The node source-index.ts positions a class's constructor entry at — the
 * explicit `constructor() {}` member when there is one, and otherwise the
 * class's own name identifier, or the class node itself when it is
 * anonymous. Mirrors `extractConstructor`/`extractImplicitConstructor`
 * there; the two must agree, because {@link mapExportsToFunctions}
 * resolves this position against the index's own entries.
 */
function classConstructorNode(
  node: ts.ClassExpression | ts.ClassDeclaration,
): ts.Node {
  const explicit = node.members.find((member) =>
    ts.isConstructorDeclaration(member),
  );
  return explicit ?? node.name ?? node;
}

/**
 * The position of the callable a DECLARATION denotes, as source-index.ts
 * positions its entry, or `undefined` when the declaration denotes no
 * callable this file defines (a parameter, an import, a destructured
 * element, a variable whose initializer is not a function or class value).
 * Task V-3 (ADR 0011 predicate 4): an entrypoint root is materialized by
 * this position, never by a name.
 */
function declaredCallableLocation(
  sourceFile: ts.SourceFile,
  declaration: ts.Node | undefined,
): SourceLocation | undefined {
  if (declaration === undefined) {
    return undefined;
  }
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isFunctionExpression(declaration)
  ) {
    return toSourceLocation(sourceFile, declaration);
  }
  if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
    return toSourceLocation(sourceFile, classConstructorNode(declaration));
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    return directValueFunctionLocation(sourceFile, declaration.initializer);
  }
  return undefined;
}

/**
 * What `name` denotes at `reference`, as a root (task V-3): the position of
 * the callable its declaration defines (`callable`), a declaration that
 * provably defines none (`none`: a variable initialized to a literal), or
 * `unknown` -- no single declaration, a name the file assigns anywhere, a
 * parameter, an import, a destructured element, an alias, or a variable
 * whose initializer has not run yet where the reference reads it (`exports.main = run; var run =
 * function () {}` publishes `undefined`). Only module-scope references are
 * asked, so source order is evaluation order.
 */
type DeclaredRoot =
  | { readonly kind: "callable"; readonly location: SourceLocation }
  | { readonly kind: "none" }
  | { readonly kind: "unknown" };

function declaredRootAt(
  sourceFile: ts.SourceFile,
  reference: ts.Node,
  name: string,
): DeclaredRoot {
  const declaration = lexicalDeclarationOf(reference, name);
  if (declaration === undefined) {
    return { kind: "unknown" };
  }
  // A name the file assigns anywhere -- `run = other`, in a loop, in a
  // closure -- does not hold its declaration's value: the declaration is
  // the stale one, and may neither root nor witness (task V-3's second
  // independent audit, finding 1). Over-approximate: a same-named binding
  // assigned in another scope also refuses, which costs precision only.
  if (isNameAssignedWithin(sourceFile, name)) {
    return { kind: "unknown" };
  }
  if (ts.isVariableDeclaration(declaration)) {
    if (
      declaration.getEnd() > reference.getStart(sourceFile) ||
      declaration.initializer === undefined
    ) {
      return { kind: "unknown" };
    }
    const value = unwrapParentheses(declaration.initializer);
    if (!mayBeCallableValue(value)) {
      return { kind: "none" };
    }
  }
  const location = declaredCallableLocation(sourceFile, declaration);
  return location === undefined
    ? { kind: "unknown" }
    : { kind: "callable", location };
}

/**
 * Whether `value` -- the end of an export's alias chain -- is evaluated
 * before the export reads it: written earlier in the file than an export
 * at module scope, or inside the export's own statement (task V-3). An export inside a function body is asked
 * nothing here; its names resolve to nothing anyway.
 */
function evaluatedBeforeExport(
  index: SourceIndex,
  value: ts.Node,
  exp: ExportBinding,
): boolean {
  if (ts.isFunctionDeclaration(value)) {
    // Hoisted: initialized before any statement of its scope runs.
    return true;
  }
  const site = nodeAtLocation(index.sourceFile, exp.location);
  return (
    site !== undefined &&
    value.getSourceFile() === index.sourceFile &&
    // Inside the export's own statement, or before it.
    value.getStart(index.sourceFile) < site.getEnd()
  );
}

/**
 * The OUTERMOST node that begins at `location` -- the export statement,
 * declaration or specifier a binding's location names, never a token
 * inside it (whose scope chain would begin inside a declaration's own
 * function scope). `undefined` when no node begins there.
 */
function nodeAtLocation(
  sourceFile: ts.SourceFile,
  location: SourceLocation,
): ts.Node | undefined {
  if (location.line === undefined || location.column === undefined) {
    return undefined;
  }
  const position = sourceFile.getPositionOfLineAndCharacter(
    location.line - 1,
    location.column - 1,
  );
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) {
      return;
    }
    const start = node.getStart(sourceFile);
    if (start === position) {
      found = node;
    } else if (start < position && position < node.getEnd()) {
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/**
 * Whether `node` runs inside a function's body or parameters, or a class
 * element's initializer -- code whose bindings are not the module's, and
 * that may run later or never. A function DECLARATION's own header (its
 * `export` modifier, its name) is not inside it.
 */
function isInsideFunctionBody(node: ts.Node): boolean {
  let child: ts.Node = node;
  for (
    let current = node.parent as ts.Node | undefined;
    current;
    child = current, current = current.parent
  ) {
    if (ts.isFunctionLike(current)) {
      const inBody =
        "body" in current && (current as { body?: ts.Node }).body === child;
      const inParameters = current.parameters.some(
        (parameter) => parameter === child,
      );
      if (inBody || inParameters) {
        return true;
      }
    } else if (
      ts.isClassStaticBlockDeclaration(current) ||
      (ts.isPropertyDeclaration(current) && current.initializer === child)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The name an importer binds `exp` by: `"default"` for a default or
 * whole-module export, the exported name otherwise; `undefined` for an
 * `export *` (task V-3, a `{file, symbol}` entrypoint's selector).
 */
export function canonicalExportName(exp: ExportBinding): string | undefined {
  return exp.kind === "default" ? "default" : exp.exportedName;
}

/**
 * The callable positions an export binding's PROVENANCE names declare at
 * the export's own site (task V-3; PRM-25, PRM-31).
 *
 * Each name is resolved lexically from the site -- the declaration the
 * site's scope chain owns -- so a nested function, a class method or a
 * property function that merely shares the spelling is never one. An
 * export written inside a function body resolves nothing: its names are
 * collected by a whole-file, name-keyed walk that need not agree with the
 * scope the write runs in, so no position is claimed for them and the
 * requirement they would satisfy fails closed.
 */
function provenanceNameLocations(
  index: SourceIndex,
  exp: ExportBinding,
  provenanceNames: readonly string[],
): SourceLocation[] {
  const site = nodeAtLocation(index.sourceFile, exp.location);
  if (site === undefined || isInsideFunctionBody(site)) {
    return [];
  }
  const found: SourceLocation[] = [];
  for (const name of new Set(provenanceNames)) {
    const declared = declaredRootAt(index.sourceFile, site, name);
    const location =
      declared.kind === "callable" ? declared.location : undefined;
    if (
      location !== undefined &&
      !found.some(
        (known) =>
          known.line === location.line && known.column === location.column,
      )
    ) {
      found.push(location);
    }
  }
  return found;
}

/**
 * The positive provenance a CommonJS *property* export
 * (`exports.X = RHS` / `module.exports.X = RHS`) establishes for its own
 * value (RWF-011).
 *
 * Before this, a property export carried NEITHER of these facts, and
 * {@link mapExportsToFunctions} fell back to searching the file for a
 * function whose own name equalled the EXPORTED name. That fallback is
 * unsound in exactly the way this whole relation exists to prevent: the
 * public property name an export is published under is not provenance for
 * any local symbol, so
 *
 * ```js
 * function parse(input) { return "safe:" + input; }   // unrelated decoy
 * const registry = { impl: require("./lib/parse") };
 * exports.parse = registry.impl;                      // the REAL value
 * ```
 *
 * bound `exports.parse` to the decoy, and proving the decoy unreachable
 * produced a complete, correct — and completely wrong-target — Family C
 * NOT_AFFECTED for a vulnerability that is reachable at runtime.
 *
 * Two shapes, both of which the right-hand side itself establishes:
 *
 * - **A bare identifier** (`exports.foo = foo`,
 *   `exports.publicName = internal`, `exports.Klass = Klass`) names a
 *   local symbol explicitly, so it becomes {@link ExportBinding.localName}
 *   — the RHS's OWN text, never the exported name. `exports.publicName =
 *   internal` therefore looks up `internal`, which is both correct and
 *   something the exported-name fallback could never do. RWF-013's
 *   refusal is unaffected and still consulted first, so a reassigned
 *   identifier stays refused rather than becoming newly attributable.
 *
 *   The identifier is read off {@link unwrapValue}'s result rather than
 *   the raw right-hand side (RWF-012), so real `ini@1.3.5`'s
 *   `exports.parse = exports.decode = decode` publishes `parse` under the
 *   local name `decode` — the same name, from the same expression, that
 *   `exports.decode` itself already resolved through. This is still the
 *   RHS's own text: the value of `exports.decode = decode` IS `decode`,
 *   by the language's own rules, so no new name-coincidence surface is
 *   created. The chained assignment is otherwise invisible here — it is
 *   neither an identifier nor a function node, which is exactly why
 *   `parse` carried no provenance at all before.
 * - **A directly-referenced function/class value** becomes
 *   {@link ExportBinding.localFunctionLocation} via
 *   {@link directValueFunctionLocation}, an exact identity. This also
 *   repairs a wrong-target case the name search got silently wrong:
 *   `function foo() {}` alongside `exports.foo = function () {}` indexes
 *   TWO functions named `foo` (source-index.ts names the anonymous one
 *   after the property it is assigned to), and the name search returned
 *   whichever came first in the file — the decoy.
 *
 *   RWF-012 additionally lets that value be reached through a chain of
 *   local aliases (`exports.foo = b`, `const b = a`,
 *   `const a = function () {}`) via
 *   {@link chasedValueFunctionLocation}. Every hop carries the same
 *   module-scope single-assignment proof the one-hop form always did, and
 *   the result is still an exact function-node position — never a name
 *   match.
 *
 * Gated on the assignment being an unconditional module-scope statement,
 * for the same reason {@link directExportedFunctionLocation} is: this
 * module has no control-flow semantics, and
 * `commonJsPropertyExportRhs`'s last-write-wins map picks the last
 * assignment in SOURCE order. Binding a right-hand side that sits inside
 * an `if`/`try`/loop/function body would be choosing a branch
 * arbitrarily, which is the same manufactured certainty in a different
 * shape.
 */
function propertyExportProvenance(
  index: SourceIndex,
  rhs: ts.Expression | undefined,
): Pick<
  ExportBinding,
  "localName" | "localFunctionLocation" | "exportAttributionWithdrawn"
> {
  if (rhs === undefined) {
    return {};
  }
  if (!isDefinitelyReachedExportAssignment(rhs)) {
    // A right-hand side EXISTS but this file cannot prove the write runs,
    // so no provenance is published — the same refusal
    // {@link ambiguousWholeModuleExport} makes for the whole-module form,
    // and it must be marked for the same reason (RWF-021). Without the
    // marker, root selection cannot tell this apart from a property export
    // that genuinely names no callable, and dropping the root reproduces
    // the false NOT_AFFECTED for `exports.run = main` exactly as it did
    // for `module.exports = main`.
    return { exportAttributionWithdrawn: true };
  }
  const value = unwrapValue(rhs);
  return {
    localName: ts.isIdentifier(value) ? value.text : undefined,
    localFunctionLocation:
      directValueFunctionLocation(index.sourceFile, value) ??
      chasedValueFunctionLocation(index, value),
  };
}

/**
 * {@link directValueFunctionLocation} applied to the far end of an alias
 * chain rather than to the expression itself — RWF-012's function-identity
 * half.
 *
 * ```js
 * const impl = function () {};
 * const a = impl;
 * const b = a;
 * exports.parse = b;   // -> that FunctionExpression's own position
 * ```
 *
 * Only a `"value"` chain answers: `"refused"` (a reassigned hop, a cycle,
 * a rejected binding) and `"unmodeled"` (a `function` declaration, an
 * import, a free name) both leave the export exactly as unattributed as
 * before, which is an unresolved target and therefore UNKNOWN — never a
 * verdict. See {@link resolveLocalValue} for the per-hop obligation.
 *
 * Gated on {@link declaresCommonJsAmbientShadow} because it is the chase
 * over LOCAL bindings that this guard protects (RWF-004a): in a file that
 * declares its own `module`/`exports`/`require`, a module-scope binding is
 * not the ambient-CommonJS fact the chase assumes it is. The guard is
 * applied only to the chased path — a directly-referenced function value
 * needs no chase and keeps the behaviour it had before RWF-012.
 */
function chasedValueFunctionLocation(
  index: SourceIndex,
  value: ts.Expression,
): SourceLocation | undefined {
  if (!ts.isIdentifier(value) || declaresCommonJsAmbientShadow(index)) {
    return undefined;
  }
  const resolved = resolveLocalValue(index, value);
  return resolved.kind === "value"
    ? directValueFunctionLocation(index.sourceFile, resolved.value)
    : undefined;
}

/**
 * {@link isDefinitelyReachedModuleScopeStatement} for an export
 * assignment's right-hand side — `exports.X = rhs`, `module.exports = rhs`
 * — climbing out through CHAINED assignments first.
 *
 * `exports.parse = exports.decode = decode` (real ini, and a staple
 * CommonJS idiom for publishing one function under two names) parses as
 * `exports.parse = (exports.decode = decode)`, so the inner assignment's
 * enclosing node is the outer ASSIGNMENT, not the statement. Asking about
 * it directly reports "not module scope" and refuses a binding whose
 * provenance is in fact perfect: the whole chain is one unconditional
 * top-level statement, and `decode` is a bare identifier naming a local
 * function. Real `debug@2.0.0`'s `node.js` opens with the same idiom for
 * the whole-module form (`exports = module.exports = require('./debug')`).
 *
 * Only assignment links are climbed, and only from the right-hand side —
 * exactly the positions whose value IS the value being assigned. Anything
 * else between the assignment and the source file (an `if`, a `try`, a
 * function body, a comma expression) still means the assignment may not
 * run, and still refuses.
 *
 * This is the ONE test every export-provenance fact is gated on, because
 * every one of them reads a LAST-WRITE-WINS map keyed by source order
 * (`commonJsPropertyExportRhs`, `findLastModuleExportsAssignment`,
 * commonjs-reexports.ts's own `propertyRhsByName`). Last-write-wins is
 * Node's real semantics for straight-line module-scope code and nothing
 * else: for
 *
 * ```js
 * if (cond) { exports.parse = require("pkg-a").parse; }
 * else      { exports.parse = require("pkg-b").parse; }
 * ```
 *
 * the map keeps only `pkg-b`, so a fact derived from it silently asserts
 * that `pkg-a`'s function is NOT what this export holds — a branch chosen
 * arbitrarily, presented as certainty. That is a false NOT_AFFECTED
 * whenever `pkg-a` is the finding's own package: its target resolves to a
 * real node that nothing then points at, and Family C proves it
 * unreachable with `reachableSubgraphComplete: true` (reproduced directly;
 * see the RWF-004b conditional-branch regressions). This module has no
 * control-flow semantics and must not pretend to.
 *
 * Note this deliberately does NOT make `exports.parse` itself
 * attributable: its own right-hand side is the inner assignment
 * expression, not an identifier or a function node, so
 * {@link propertyExportProvenance} finds nothing to bind and the export
 * stays unresolved. Resolving THROUGH an assignment expression's value is
 * a separate relation and is not attempted here.
 */
function isDefinitelyReachedExportAssignment(rhs: ts.Expression): boolean {
  const node = exportAssignmentStatementNode(rhs);
  return (
    node !== undefined &&
    isDefinitelyReachedModuleScopeStatement(node) &&
    competingWritesCannotBeObservedApart(rhs)
  );
}

/**
 * {@link isDefinitelyReachedExportAssignment} minus its reachability half
 * (RWF-015): whether the assignment is written as a top-level statement at
 * all, regardless of whether module evaluation can still be running by the
 * time that statement is reached.
 *
 * The two differ for exactly the shape RWF-015 exists for, and the
 * difference is what {@link WholeModuleExportAuthority} reports as
 * `"bypassable"` rather than silently folding into `"conditional"` —
 * "written at top level, but an earlier top-level statement can end module
 * evaluation first" is a different fact about the file than "written
 * inside an `if`", and an analyzer whose refusals are read by humans
 * should say which one it saw.
 */
function isTopLevelExportAssignment(rhs: ts.Expression): boolean {
  const node = exportAssignmentStatementNode(rhs);
  return node !== undefined && isUnconditionalModuleScopeStatement(node);
}

/**
 * The node whose STATEMENT position decides when an export assignment
 * runs: the assignment itself, or — for a chained
 * `exports.a = exports.b = value` — the outermost assignment it is the
 * right-hand side of. See {@link isDefinitelyReachedExportAssignment}'s
 * doc comment for why the climb exists and why only assignment links are
 * climbed.
 */
function exportAssignmentStatementNode(
  rhs: ts.Expression,
): ts.Node | undefined {
  let node: ts.Node | undefined = rhs.parent;
  if (node === undefined) {
    return undefined;
  }
  let parent = node.parent as ts.Node | undefined;
  while (
    parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node
  ) {
    node = parent;
    parent = node.parent as ts.Node | undefined;
  }
  return node;
}

/** Whether `node`'s own statement is a direct child of the source file (module scope, unconditional). */
function isUnconditionalModuleScopeStatement(node: ts.Node): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) {
    return false;
  }
  if (ts.isSourceFile(parent)) {
    // `export = X;` — an ExportAssignment is itself a statement.
    return true;
  }
  return (
    ts.isExpressionStatement(parent) &&
    parent.parent !== undefined &&
    ts.isSourceFile(parent.parent)
  );
}

/**
 * {@link isUnconditionalModuleScopeStatement} PLUS the thing being a
 * top-level statement does not by itself establish (RWF-015): that module
 * evaluation actually gets this far.
 *
 * Node wraps every CommonJS module in a function, so a module-scope
 * `return` is legal and ends module evaluation on the spot; an uncaught
 * module-scope `throw` ends it too, propagating out of the `require()`
 * that triggered the load. Either one leaves whatever `module.exports`
 * already held as the module's exported value, and leaves every top-level
 * statement below it unexecuted:
 *
 * ```js
 * if (flag) {
 *   module.exports = dangerousOp;
 *   return;
 * }
 * module.exports = safeOp;      // <- syntactically unconditional; NOT always run
 * ```
 *
 * The final write here is a direct child of the source file, so
 * {@link isUnconditionalModuleScopeStatement} accepts it and RWF-014's
 * authority rule ("the last write must be unconditional") accepted it too
 * — and the module then exported `dangerousOp` on every run with the flag
 * set. Reproduced end to end on the commit before this one, as a
 * NOT_AFFECTED carrying a complete Family C proof over a function the
 * module exports whenever the early branch is taken; see
 * fixtures/commonjs-early-exit-whole-module-export/.
 *
 * So the property every export-provenance gate actually needs is not "is
 * this statement unconditional" but "is this statement DEFINITELY
 * REACHED", and the two come apart exactly when some earlier top-level
 * statement can complete abruptly. {@link firstModuleEvaluationCutoff}
 * finds the first such statement in one linear pass; everything starting
 * before it definitely runs (module evaluation executes top-level
 * statements in order, and nothing above it can abort), and everything
 * from it onward may not. That comparison is the whole reachability
 * model: no control-flow graph, no path enumeration, no dataflow, and no
 * evaluation of the flag.
 */
function isDefinitelyReachedModuleScopeStatement(node: ts.Node): boolean {
  if (!isUnconditionalModuleScopeStatement(node)) {
    return false;
  }
  const sourceFile = node.getSourceFile();
  const cutoff = firstModuleEvaluationCutoff(sourceFile);
  return cutoff === undefined || node.getStart(sourceFile) < cutoff;
}

/* ------------------------------------------------------------------ *
 * BL-064 (RWF-094): the competing-write window                         *
 * ------------------------------------------------------------------ */

/**
 * The key a competing export write is filed under: an exported property
 * name, or {@link WHOLE_MODULE_EXPORT} for a write that replaces the
 * whole exported value (`module.exports = X`, `export = X`).
 */
const WHOLE_MODULE_EXPORT: unique symbol = Symbol("whole-module-export");
type CompetingWriteKey = string | typeof WHOLE_MODULE_EXPORT;

/** One write of an export this file spells, at the position it runs from. */
interface CompetingWriteSite {
  readonly key: CompetingWriteKey;
  /** The assignment (or `export =`) node itself. */
  readonly node: ts.Node;
  /** The index in `sourceFile.statements` of the top-level statement holding it. */
  readonly statementIndex: number;
  /**
   * Whether it runs later than its statement, or never: inside a function
   * body or an instance field initializer.
   */
  readonly deferred: boolean;
  /**
   * Whether the value written is provably a primitive (`void 0`, a
   * literal). An observer of a primitive reaches no code through it, so
   * such a write opens no window (TypeScript's `exports.x = void 0;`
   * preamble).
   */
  readonly primitive: boolean;
  /**
   * For a whole-module write, the property names the new export object
   * can hold: the keys an object literal spells, or `"all"` for any other
   * value (a function's statics, a prototype, a spread, a computed key).
   */
  readonly carries: ReadonlySet<string> | "all";
}

/** {@link competingWriteSites}' answer, indexed for the window query. */
interface CompetingWriteSites {
  /** Every site, in source order. */
  readonly all: readonly CompetingWriteSite[];
  /** The sites of each exported property name. */
  readonly byName: ReadonlyMap<string, readonly CompetingWriteSite[]>;
  /** The whole-module sites. */
  readonly wholeModule: readonly CompetingWriteSite[];
}

const competingWriteSitesBySourceFile = new WeakMap<
  ts.SourceFile,
  CompetingWriteSites
>();

/**
 * Every export write this file spells, wherever it is (BL-064): the
 * property forms {@link commonJsExportPropertyName} reads and the
 * whole-module forms. A form neither reads (an alias, `Object.assign`,
 * `Object.defineProperty`) is E-1's un-enumerable writer, not this
 * relation's.
 */
function competingWriteSites(sourceFile: ts.SourceFile): CompetingWriteSites {
  const cached = competingWriteSitesBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  const sites: CompetingWriteSite[] = [];
  sourceFile.statements.forEach((statement, statementIndex) => {
    function visit(node: ts.Node, deferred: boolean): void {
      let key: CompetingWriteKey | undefined;
      let value: ts.Expression | undefined;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const left = unwrapParentheses(node.left);
        key =
          commonJsExportPropertyName(left) ??
          (isModuleExportsAssignmentTarget(left)
            ? WHOLE_MODULE_EXPORT
            : undefined);
        value = node.right;
      } else if (ts.isExportAssignment(node) && node.isExportEquals) {
        key = WHOLE_MODULE_EXPORT;
        value = node.expression;
      }
      if (key !== undefined && value !== undefined) {
        sites.push({
          key,
          node,
          statementIndex,
          deferred,
          primitive: isPrimitiveValue(unwrapValue(value)),
          carries:
            key === WHOLE_MODULE_EXPORT
              ? propertiesCarriedBy(unwrapValue(value))
              : "all",
        });
      }
      const nested =
        deferred ||
        ts.isFunctionLike(node) ||
        (ts.isPropertyDeclaration(node) && !isStaticClassElement(node));
      ts.forEachChild(node, (child) => visit(child, nested));
    }
    visit(statement, false);
  });
  const byName = new Map<string, CompetingWriteSite[]>();
  const wholeModule: CompetingWriteSite[] = [];
  for (const site of sites) {
    if (site.key === WHOLE_MODULE_EXPORT) {
      wholeModule.push(site);
    } else {
      const known = byName.get(site.key);
      if (known === undefined) {
        byName.set(site.key, [site]);
      } else {
        known.push(site);
      }
    }
  }
  const indexed = { all: sites, byName, wholeModule };
  competingWriteSitesBySourceFile.set(sourceFile, indexed);
  return indexed;
}

function isStaticClassElement(node: ts.ClassElement): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ??
      false)
  );
}

/**
 * The property names every object carries from `Object.prototype`, and
 * every function from its own intrinsics and `Function.prototype`. None
 * holds package code; they are listed so that a write of one of these
 * names is never treated as uncontested.
 */
const OBJECT_INTRINSIC_NAMES: readonly string[] = [
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
];
const FUNCTION_INTRINSIC_NAMES: readonly string[] = [
  ...OBJECT_INTRINSIC_NAMES,
  "apply",
  "arguments",
  "bind",
  "call",
  "caller",
  "length",
  "name",
  "prototype",
];

/**
 * The property names a whole-module export value can carry when it is
 * written (BL-064), so that it competes only with the later writes of
 * those names:
 *
 * - an object literal: its keys, unless it has a spread, a computed key
 *   or a `__proto__` (each can supply any name);
 * - a function or arrow expression: a fresh object, so only its
 *   intrinsics;
 * - an identifier naming exactly one module-scope function declaration,
 *   or `const` function or arrow, that nothing in the file reassigns and
 *   that never escapes ({@link moduleFunctionEscapes}): its intrinsics,
 *   every `P` the file writes as `name.P = ...` anywhere, and every `P` it
 *   writes as `this.P = ...` anywhere (a method called on it runs with
 *   `this` bound to it); a computed write, or any other use of `this`,
 *   carries every name;
 * - anything else: `"all"`.
 *
 * A name a writer this file does not spell can set (an alias, a
 * parameter, `Object.assign`, another module) is the un-enumerable writer
 * of ADR 0009 § 1 clause 1, E-1's, exactly as it is for every attribution
 * today.
 */
function propertiesCarriedBy(
  value: ts.Expression,
): ReadonlySet<string> | "all" {
  const node = unwrapParentheses(value);
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return new Set(FUNCTION_INTRINSIC_NAMES);
  }
  if (ts.isIdentifier(node)) {
    return propertiesCarriedByModuleFunction(node);
  }
  if (!ts.isObjectLiteralExpression(node)) {
    return "all";
  }
  const names = new Set<string>(OBJECT_INTRINSIC_NAMES);
  for (const property of node.properties) {
    const name = property.name;
    if (
      name === undefined ||
      ts.isComputedPropertyName(name) ||
      ts.isPrivateIdentifier(name)
    ) {
      return "all";
    }
    const text = ts.isIdentifier(name)
      ? name.text
      : exactCommonJsExportPropertyName(name);
    if (
      text === undefined ||
      text === "__proto__" ||
      ts.isGetAccessorDeclaration(property) ||
      ts.isSetAccessorDeclaration(property)
    ) {
      // An accessor makes a later write of its name run code, or throw.
      return "all";
    }
    names.add(text);
  }
  return names;
}

/**
 * Whether `name` is exactly one module-scope function declaration, or
 * `const` bound to a function or arrow expression, that nothing in the
 * file reassigns: a binding that always holds that one function object.
 */
function isUnreassignedModuleFunction(
  sourceFile: ts.SourceFile,
  name: string,
): boolean {
  const binding = moduleScopeBindings(sourceFile).get(name);
  return (
    binding !== undefined &&
    binding.count === 1 &&
    (binding.kind === "function" || binding.kind === "const") &&
    topLevelCallableCandidates(sourceFile).has(name) &&
    !isNameAssignedWithin(sourceFile, name) &&
    !moduleFunctionEscapes(sourceFile, name)
  );
}

const escapingModuleFunctionsBySourceFile = new WeakMap<
  ts.SourceFile,
  Map<string, boolean>
>();

/**
 * Whether any reference spelled `name` in the file can hand the function
 * object to code that may change it (`Object.freeze(fn)`,
 * `Object.defineProperty(fn, ...)`, an alias, an argument, a return):
 * every reference must be a callee, a member access's base, a `typeof`
 * operand, a declaration's own name, or the value of an assignment chain
 * whose every link writes an export target, `exports`, or a member of
 * `name` itself. Counted by spelling over the whole file, so a shadowing
 * binding only makes it more likely to answer `true`.
 */
function moduleFunctionEscapes(
  sourceFile: ts.SourceFile,
  name: string,
): boolean {
  let byName = escapingModuleFunctionsBySourceFile.get(sourceFile);
  if (byName === undefined) {
    byName = new Map();
    escapingModuleFunctionsBySourceFile.set(sourceFile, byName);
  }
  const cached = byName.get(name);
  if (cached !== undefined) {
    return cached;
  }
  let escapes = false;
  function visit(node: ts.Node): void {
    if (escapes) {
      return;
    }
    if (ts.isIdentifier(node) && node.text === name) {
      if (!isContainedModuleFunctionReference(node, name)) {
        escapes = true;
      }
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  byName.set(name, escapes);
  return escapes;
}

function isContainedModuleFunctionReference(
  node: ts.Identifier,
  name: string,
): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined || isNonReferenceName(node, parent)) {
    return true;
  }
  if (
    ((ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isVariableDeclaration(parent)) &&
      parent.name === node) ||
    (ts.isCallExpression(parent) && parent.expression === node) ||
    ((ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
      parent.expression === node) ||
    ts.isTypeOfExpression(parent)
  ) {
    return true;
  }
  // The value of an assignment chain: `exports = module.exports = fn;`,
  // `fn.self = fn;`.
  let value: ts.Node = node;
  let link = parent;
  let sawLink = false;
  while (
    ts.isBinaryExpression(link) &&
    link.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    link.right === value
  ) {
    const target = unwrapParentheses(link.left);
    const ownMember =
      (ts.isPropertyAccessExpression(target) ||
        ts.isElementAccessExpression(target)) &&
      ts.isIdentifier(target.expression) &&
      target.expression.text === name;
    // A property export (`exports.helper = fn`) is an alias of the
    // function under another name, through which it can be written
    // (`exports.helper.run = d`), so it is not one (BL-064's audit,
    // finding 7).
    if (!(
      isModuleExportsAssignmentTarget(target) ||
      (ts.isIdentifier(target) && target.text === "exports") ||
      ownMember
    )) {
      return false;
    }
    sawLink = true;
    value = link;
    link = link.parent;
  }
  return sawLink && ts.isExpressionStatement(link);
}

/**
 * What one `this` does to the object it is bound to: `undefined` for a
 * property read (`this.p`, `this[k]`, a method call `this.m()`), the name
 * for a write of an exact key (`this.p = v`, `this["p"] += v`), and
 * `"other"` for anything else (a computed write, an argument, an alias).
 */
function thisMemberWrite(node: ts.Node): string | "other" | undefined {
  const access = node.parent as ts.Node | undefined;
  if (
    access === undefined ||
    !(
      (ts.isPropertyAccessExpression(access) ||
        ts.isElementAccessExpression(access)) &&
      access.expression === node
    )
  ) {
    return "other";
  }
  const assignment = access.parent as ts.Node | undefined;
  const isWrite =
    assignment !== undefined &&
    ((ts.isBinaryExpression(assignment) &&
      isAssignmentOperatorToken(assignment.operatorToken.kind) &&
      assignment.left === access) ||
      ((ts.isPrefixUnaryExpression(assignment) ||
        ts.isPostfixUnaryExpression(assignment)) &&
        assignment.operand === access) ||
      ts.isDeleteExpression(assignment));
  if (!isWrite) {
    return undefined;
  }
  const name = ts.isPropertyAccessExpression(access)
    ? access.name.text
    : exactCommonJsExportPropertyName(access.argumentExpression);
  return name ?? "other";
}

/** {@link propertiesCarriedBy} for an identifier value. */
function propertiesCarriedByModuleFunction(
  identifier: ts.Identifier,
): ReadonlySet<string> | "all" {
  const sourceFile = identifier.getSourceFile();
  const name = identifier.text;
  if (!isUnreassignedModuleFunction(sourceFile, name)) {
    return "all";
  }
  const names = new Set<string>(FUNCTION_INTRINSIC_NAMES);
  let every = false;
  function visit(node: ts.Node): void {
    if (every) {
      return;
    }
    // A method called on the function -- through its name or through any
    // alias of the export -- runs with `this` bound to it, so every
    // `this.P = ...` in the file may set `P` on it, and any other use of
    // `this` (an argument, an alias, a computed write) may set anything.
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      const written = thisMemberWrite(node);
      if (written === "other") {
        every = true;
      } else if (written !== undefined) {
        names.add(written);
      }
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperatorToken(node.operatorToken.kind)
    ) {
      const target = unwrapParentheses(node.left);
      if (
        (ts.isPropertyAccessExpression(target) ||
          ts.isElementAccessExpression(target)) &&
        ts.isIdentifier(unwrapParentheses(target.expression)) &&
        (unwrapParentheses(target.expression) as ts.Identifier).text === name
      ) {
        const written = ts.isPropertyAccessExpression(target)
          ? target.name.text
          : exactCommonJsExportPropertyName(target.argumentExpression);
        if (written === undefined) {
          every = true;
          return;
        }
        names.add(written);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return every ? "all" : names;
}

/** A value that is provably a primitive, whatever its evaluation did first. */
function isPrimitiveValue(value: ts.Expression): boolean {
  const node = unwrapParentheses(value);
  return (
    ts.isVoidExpression(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

/** The index of the top-level statement holding `node`, or `undefined`. */
function topLevelStatementIndex(node: ts.Node): number | undefined {
  let current: ts.Node = node;
  while (current.parent !== undefined && !ts.isSourceFile(current.parent)) {
    current = current.parent;
  }
  if (current.parent === undefined) {
    return undefined;
  }
  const index = (current.parent as ts.SourceFile).statements.indexOf(
    current as ts.Statement,
  );
  return index < 0 ? undefined : index;
}

/**
 * Whether the export write whose right-hand side is `rhs` keeps its
 * authority against the file's OTHER writes of the same export (BL-064,
 * RWF-094; ADR 0009 § 1 clause 4 as amended by BL-064).
 *
 * An uncaught module-scope throw leaves the exports object holding
 * whatever was written last before it, and a module that already holds
 * the object observes that value: a module in a require cycle, any child
 * this module required (through `module.parent`), anything the object
 * escaped to. Measured against real Node: a child required BEFORE both
 * writes, with no cycle at all, reads the earlier value through
 * `module.parent.exports` after the load throws. So who can observe is
 * not a usable condition (almost every module requires something first),
 * and the condition is on the evaluation instead:
 *
 * the LAST write of `x` keeps its authority only when every evaluation
 * between the completion of the FIRST competing write of `x` and the
 * completion of this one is proven to complete normally
 * ({@link statementCompletesNormally},
 * {@link expressionCompletesNormally}). Anything else may throw -- a call
 * no proof reaches, a builtin, a property read -- and leave the earlier
 * value published, which is a second value the export can hold.
 *
 * The competing writes of a property `x` are every write of `x` and every
 * whole-module write; those of the whole-module value are every write.
 * A write of a provable primitive is not one (observing it reaches
 * nothing). A DEFERRED competing write (inside a function body) may run
 * at any point before this one, so the window opens at the start of the
 * file. A competing write in the same statement that is not a link of
 * this write's own assignment chain is refused outright.
 *
 * Fails closed: a right-hand side this relation cannot place answers
 * `false`, which withdraws authority toward `UNKNOWN`. A withdrawn
 * whole-module write also withdraws every property write it may replace
 * ({@link buildExportBindings}), so withdrawing one write never leaves a
 * stale one standing in its place. "Proven to complete" assumes the
 * engine does not run out of stack or memory at that statement: a
 * module loaded near the stack limit can throw a `RangeError` anywhere,
 * an accepted bound.
 */
function competingWritesCannotBeObservedApart(rhs: ts.Expression): boolean {
  const write = rhs.parent as ts.Node | undefined;
  if (write === undefined) {
    return false;
  }
  let key: CompetingWriteKey | undefined;
  if (
    ts.isBinaryExpression(write) &&
    write.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    write.right === rhs
  ) {
    const left = unwrapParentheses(write.left);
    key =
      commonJsExportPropertyName(left) ??
      (isModuleExportsAssignmentTarget(left) ? WHOLE_MODULE_EXPORT : undefined);
  } else if (ts.isExportAssignment(write) && write.isExportEquals) {
    key = WHOLE_MODULE_EXPORT;
  }
  const last = topLevelStatementIndex(write);
  if (key === undefined || last === undefined) {
    return false;
  }
  const sourceFile = write.getSourceFile();
  if (!exportObjectsMayBeObserved(sourceFile)) {
    return true;
  }
  const statements = sourceFile.statements;
  const lastStatement = statements[last]!;
  const chain = assignmentChainOf(lastStatement);

  // Code that can make a write fail, or set a name no write spells
  // ({@link exportWritesMayFail}), matters only once it may have RUN
  // before this write: some earlier top-level statement is not proven to
  // complete, or is a `try` (whose block runs anything). Then every
  // whole-module write can carry any name, and any window withdraws.
  const tainted =
    exportWritesMayFail(sourceFile) &&
    firstUnguardedStatementFrom(sourceFile) < last;
  const sites = competingWriteSites(sourceFile);
  const competitors =
    key === WHOLE_MODULE_EXPORT
      ? sites.all
      : [
          ...(sites.byName.get(key) ?? []),
          ...sites.wholeModule.filter(
            (site) =>
              tainted || site.carries === "all" || site.carries.has(key),
          ),
        ];
  let first: number | undefined;
  for (const site of competitors) {
    if (site.primitive || site.node === write) {
      continue;
    }
    if (site.deferred) {
      first = -1;
      break;
    }
    if (site.statementIndex === last) {
      if (!chain.includes(site.node)) {
        return false;
      }
      continue;
    }
    if (site.statementIndex < last) {
      first = Math.min(first ?? site.statementIndex, site.statementIndex);
    }
  }
  if (first === undefined) {
    return true;
  }
  if (tainted) {
    return false;
  }
  // The first competing write's own statement: only further links of its
  // assignment chain may run after the write, or it must complete whole.
  if (first >= 0) {
    const opening = statements[first]!;
    const links = assignmentChainOf(opening);
    if (
      links.length === 0
        ? !statementCompletesNormally(opening, first)
        : !links.every(
            (link) =>
              ts.isExportAssignment(link) ||
              (ts.isBinaryExpression(link) &&
                isCompletingWriteTarget(link.left, first)),
          )
    ) {
      // BL-064 (its independent audit, finding 2): an outer link of the
      // opening chain runs after the competing write it holds
      // (`holder.y = exports.run = d;`), so its target is checked too.
      return false;
    }
  }
  if (firstNonCompletingStatementFrom(sourceFile, first + 1) < last) {
    return false;
  }
  // This write's own statement: its value, then the chain's writes.
  return chainCompletesNormally(lastStatement, last);
}

const nonCompletingStatementsBySourceFile = new WeakMap<
  ts.SourceFile,
  readonly number[]
>();

/**
 * The index of the first top-level statement at or after `from` that
 * {@link statementCompletesNormally} does not prove, or the statement
 * count when there is none. Every statement is classified once per file,
 * on the first window query, so a window check is one comparison however
 * many exports ask.
 */
function firstNonCompletingStatementFrom(
  sourceFile: ts.SourceFile,
  from: number,
): number {
  let next = nonCompletingStatementsBySourceFile.get(sourceFile);
  if (next === undefined) {
    const statements = sourceFile.statements;
    const computed: number[] = new Array<number>(statements.length + 1);
    computed[statements.length] = statements.length;
    for (let i = statements.length - 1; i >= 0; i -= 1) {
      computed[i] = statementCompletesNormally(statements[i]!, i)
        ? computed[i + 1]!
        : i;
    }
    nonCompletingStatementsBySourceFile.set(sourceFile, computed);
    next = computed;
  }
  return next[Math.max(0, from)]!;
}

const exportObjectsMayBeObservedBySourceFile = new WeakMap<
  ts.SourceFile,
  boolean
>();

/**
 * Whether anything outside this module's evaluation can hold its `module`
 * or exports object, and so observe an intermediate export value after an
 * abrupt completion (BL-064). Measured against real Node: a module whose
 * load throws is deleted from `require.cache` and spliced out of its
 * parent's `module.children`, so without such a holder nothing ever sees
 * the half-written object again, and a re-require evaluates afresh.
 *
 * A holder needs a reference, so this is a census of the references this
 * file gives out, over the WHOLE file (a function body may run at module
 * time). It is a census of this file's own text, and its bounds are
 * accepted, not modelled: code outside the file that patches the loader
 * (`Module.prototype._compile`, a preload), and the deprecated
 * `fn.caller.arguments` of a sloppy-mode caller (a foreign function the
 * module calls at module scope can read the wrapper's `arguments`). The
 * references counted: any `require` (every module it loads holds `module.parent`, and
 * `require.cache` holds the module), a dynamic `import()`, any `eval`,
 * the wrapper's `arguments` or module-scope `this`, and any `module` or
 * `exports` reference other than the base of an export write target
 * (`exports.x =`, `module.exports.x =`, `module.exports =`) or a
 * rebinding of `exports` itself. Over-approximate in the safe direction:
 * a reference that escapes nowhere still counts.
 */
function exportObjectsMayBeObserved(sourceFile: ts.SourceFile): boolean {
  const cached = exportObjectsMayBeObservedBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  let observed = false;
  function visit(node: ts.Node, inOwnThisScope: boolean): void {
    if (observed) {
      return;
    }
    if (ts.isIdentifier(node)) {
      if (escapesExportObjects(node, inOwnThisScope)) {
        observed = true;
      }
      return;
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword && !inOwnThisScope) {
      observed = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      observed = true;
      return;
    }
    // TypeScript's `import x = require("...")` and an ES import compiled
    // to CommonJS load a module without spelling `require` (BL-064's
    // audit, finding 5c).
    if (
      (ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)) ||
      ts.isImportDeclaration(node) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined)
    ) {
      observed = true;
      return;
    }
    // A class's `extends` clause, its decorators and every computed key
    // (a class member's or an object-literal method's) are evaluated in
    // the ENCLOSING scope, so its `this` and `arguments` are the outer
    // ones (BL-064's audit, finding 5a); they are visited first, with the
    // outer flag, before the body is visited with its own.
    if (ts.isClassLike(node)) {
      node.heritageClauses?.forEach((clause) => visit(clause, inOwnThisScope));
      ts.getDecorators(node)?.forEach((d) => visit(d, inOwnThisScope));
      for (const member of node.members) {
        if (
          member.name !== undefined &&
          ts.isComputedPropertyName(member.name)
        ) {
          visit(member.name, inOwnThisScope);
        }
        if (ts.canHaveDecorators(member)) {
          ts.getDecorators(member)?.forEach((d) => visit(d, inOwnThisScope));
        }
      }
    } else if (
      ts.isFunctionLike(node) &&
      node.name !== undefined &&
      ts.isComputedPropertyName(node.name)
    ) {
      visit(node.name, inOwnThisScope);
    }
    // A non-arrow function, a class body and an object literal's method
    // bind their own `this` and `arguments`.
    const ownScope =
      inOwnThisScope ||
      (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) ||
      ts.isClassLike(node);
    ts.forEachChild(node, (child) => visit(child, ownScope));
  }
  visit(sourceFile, false);
  exportObjectsMayBeObservedBySourceFile.set(sourceFile, observed);
  return observed;
}

const exportWritesMayFailBySourceFile = new WeakMap<ts.SourceFile, boolean>();

/**
 * Whether code in this file may make a later export write -- or a member
 * write on a module function -- throw, or give a name a value no write
 * spells (BL-064's independent audit, finding 6): the `module` or exports
 * object handed to code (any `module`/`exports` reference other than the
 * base of an export write target or a rebinding of `exports`, which also
 * covers `Object.freeze(exports)` and `exports.m()` running `m` with
 * `this === exports`), module-scope `this`, or the builtins and keys that
 * reach the prototypes and property attributes (`Object`, `Reflect`,
 * `Function`, `globalThis`, `global`, `Proxy`, `__proto__`, `constructor`,
 * `setPrototypeOf`, `getPrototypeOf`). When it can, any window between
 * competing writes withdraws authority. Over-approximate in the safe
 * direction; tampering by code outside this file (a preload, a loader) is
 * outside every file census and is an accepted bound.
 */
function exportWritesMayFail(sourceFile: ts.SourceFile): boolean {
  const cached = exportWritesMayFailBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  let hazard = false;
  function visit(node: ts.Node, inOwnThisScope: boolean): void {
    if (hazard) {
      return;
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      // Module-scope `this` is the exports object; any other `this` may be
      // it too (a method called as `exports.m()`), so it must only ever be
      // a member access's base, never handed on.
      if (!inOwnThisScope || !isMemberAccessBase(node)) {
        hazard = true;
      }
      return;
    }
    if (ts.isIdentifier(node)) {
      if (TAMPERING_KEYS.has(node.text)) {
        hazard = true;
        return;
      }
      const parent = node.parent as ts.Node | undefined;
      if (parent === undefined || isNonReferenceName(node, parent)) {
        return;
      }
      if (
        TAMPERING_GLOBALS.has(node.text) ||
        // The wrapper's `arguments` holds `exports` and `module`.
        (node.text === "arguments" && !inOwnThisScope) ||
        (node.text === "exports" && !isExportsObjectContained(node)) ||
        (node.text === "module" && !isModuleObjectContained(node))
      ) {
        hazard = true;
      }
      return;
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      TAMPERING_KEYS.has(node.text)
    ) {
      hazard = true;
      return;
    }
    const ownScope =
      inOwnThisScope ||
      (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) ||
      ts.isClassLike(node);
    ts.forEachChild(node, (child) => visit(child, ownScope));
  }
  visit(sourceFile, false);
  exportWritesMayFailBySourceFile.set(sourceFile, hazard);
  return hazard;
}

/** Whether `node` is the object of a member access (`node.p`, `node[k]`), read, written or called. */
function isMemberAccessBase(node: ts.Node): boolean {
  const parent = node.parent as ts.Node | undefined;
  return (
    parent !== undefined &&
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  );
}

/**
 * Whether this `exports` reference keeps the object in this file's hands
 * (for {@link exportWritesMayFail}): a member access's base, or the target
 * of a rebinding of `exports` itself. A method called on it gets it as
 * `this`, which the `this` rule covers.
 */
function isExportsObjectContained(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node;
  return (
    (isMemberAccessBase(node) && !callsForeignExportMethod(parent)) ||
    (ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === node)
  );
}

/**
 * Whether `access` (`exports.m`, `module.exports.m`) is called as a
 * method whose value this file does not prove is its own function: the
 * method runs with the exports object as `this`, so a foreign one holds
 * it. Proven when every write of `m` the file spells is a function or
 * arrow value, or a module function binding; their own `this` uses are
 * the `this` rule's.
 */
function callsForeignExportMethod(access: ts.Node): boolean {
  const call = access.parent as ts.Node | undefined;
  if (
    call === undefined ||
    !(
      (ts.isCallExpression(call) && call.expression === access) ||
      (ts.isTaggedTemplateExpression(call) && call.tag === access)
    )
  ) {
    return false;
  }
  if (!ts.isPropertyAccessExpression(access)) {
    return true;
  }
  const sourceFile = access.getSourceFile();
  const values = exportPropertyWriteValues(sourceFile).get(access.name.text);
  if (values === undefined || values.length === 0) {
    return true;
  }
  const callables = topLevelCallableCandidates(sourceFile);
  return !values.every((written) => {
    const value = unwrapParentheses(unwrapValue(written));
    return (
      ts.isFunctionExpression(value) ||
      ts.isArrowFunction(value) ||
      (ts.isIdentifier(value) && callables.has(value.text))
    );
  });
}

const exportPropertyWriteValuesBySourceFile = new WeakMap<
  ts.SourceFile,
  ReadonlyMap<string, readonly ts.Expression[]>
>();

/**
 * The values every `exports.x = v` / `module.exports.x = v` in the file
 * writes, by name, wherever it is. Its own walk, so that
 * {@link exportWritesMayFail} never depends on {@link competingWriteSites}
 * (which depends on it).
 */
function exportPropertyWriteValues(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, readonly ts.Expression[]> {
  const cached = exportPropertyWriteValuesBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  const values = new Map<string, ts.Expression[]>();
  function visit(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const name = commonJsExportPropertyName(unwrapParentheses(node.left));
      if (name !== undefined) {
        const known = values.get(name);
        if (known === undefined) {
          values.set(name, [node.right]);
        } else {
          known.push(node.right);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  exportPropertyWriteValuesBySourceFile.set(sourceFile, values);
  return values;
}

/**
 * {@link isExportsObjectContained} for `module`: any member access but
 * `module.exports` is not the exports object at all; `module.exports`
 * must itself be a member access's base or a write target.
 */
function isModuleObjectContained(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node;
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node) {
    return false;
  }
  if (parent.name.text !== "exports") {
    // `module.parent`, `module.children`, `module.require`: not this
    // module's exports object, but the module object itself is not handed
    // on either.
    return true;
  }
  const outer = parent.parent as ts.Node;
  return (
    (isMemberAccessBase(parent) && !callsForeignExportMethod(outer)) ||
    (ts.isBinaryExpression(outer) &&
      outer.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      outer.left === parent)
  );
}

/** The globals through which code reaches property attributes and the prototypes. */
const TAMPERING_GLOBALS: ReadonlySet<string> = new Set([
  "eval",
  "Object",
  "Reflect",
  "Function",
  "globalThis",
  "global",
  "Proxy",
]);

/** The property keys that reach a prototype, wherever they are spelled. */
const TAMPERING_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "setPrototypeOf",
  "getPrototypeOf",
]);

/** {@link exportObjectsMayBeObserved}'s test for one identifier. */
function escapesExportObjects(
  node: ts.Identifier,
  inOwnThisScope: boolean,
): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined || isNonReferenceName(node, parent)) {
    return false;
  }
  switch (node.text) {
    case "require":
    case "eval":
      return true;
    case "arguments":
      return !inOwnThisScope;
    case "exports":
      return !(
        isExportWriteTargetBase(node) ||
        (ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          parent.left === node)
      );
    case "module":
      return !(
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.name.text === "exports" &&
        (isExportWriteTargetBase(parent) ||
          (ts.isBinaryExpression(parent.parent) &&
            parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            parent.parent.left === parent))
      );
    default:
      return false;
  }
}

/** Whether `object` is the base of an export property write target (`object.x = v`, `object["x"] = v`). */
function isExportWriteTargetBase(object: ts.Expression): boolean {
  const access = object.parent as ts.Node | undefined;
  if (
    access === undefined ||
    !(
      (ts.isPropertyAccessExpression(access) ||
        ts.isElementAccessExpression(access)) &&
      access.expression === object
    )
  ) {
    return false;
  }
  const assignment = access.parent as ts.Node | undefined;
  return (
    assignment !== undefined &&
    ts.isBinaryExpression(assignment) &&
    assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    assignment.left === access &&
    commonJsExportPropertyName(access) !== undefined
  );
}

/** An identifier in a position that names a property or member, not a binding reference. */
function isNonReferenceName(node: ts.Identifier, parent: ts.Node): boolean {
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isQualifiedName(parent) && parent.right === node) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent)) &&
      parent.name === node) ||
    (ts.isLabeledStatement(parent) && parent.label === node) ||
    ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) &&
      parent.label === node)
  );
}

const firstUnguardedStatementBySourceFile = new WeakMap<
  ts.SourceFile,
  number
>();

/**
 * The index of the first top-level statement that may run code this file
 * does not prove: one {@link statementCompletesNormally} does not prove,
 * or one holding a `try` (its block runs anything, the `catch` only stops
 * the throw). The statement count when there is none.
 */
function firstUnguardedStatementFrom(sourceFile: ts.SourceFile): number {
  const cached = firstUnguardedStatementBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  const statements = sourceFile.statements;
  // An `async` callee's call is proven to COMPLETE, but its body runs
  // synchronously up to its first `await`, so it may run anything
  // (BL-064's second audit round, finding 1): while the file has one, a
  // statement that invokes anything is not guarded.
  const hasAsyncCallable = [
    ...topLevelCallableCandidates(sourceFile).values(),
  ].some((fn) => isAsyncCallable(fn));
  let index = statements.length;
  for (let i = 0; i < statements.length; i += 1) {
    const statement = statements[i]!;
    if (
      !statementCompletesNormally(statement, i) ||
      containsTryStatement(statement) ||
      (hasAsyncCallable && containsInvocation(statement))
    ) {
      index = i;
      break;
    }
  }
  firstUnguardedStatementBySourceFile.set(sourceFile, index);
  return index;
}

/** Whether a statement holds a call or a tagged template outside any function. */
function containsInvocation(statement: ts.Statement): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found || ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(statement);
  return found;
}

/** Whether a statement holds a `try` outside any function. */
function containsTryStatement(statement: ts.Statement): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found || ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isTryStatement(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(statement);
  return found;
}

/**
 * The `=` links of a top-level statement that is nothing but an
 * assignment chain (`exports.a = exports.b = v;`, `export = v;`),
 * outermost first; empty for any other statement.
 */
function assignmentChainOf(statement: ts.Statement): ts.Node[] {
  if (ts.isExportAssignment(statement) && statement.isExportEquals) {
    return [statement];
  }
  if (!ts.isExpressionStatement(statement)) {
    return [];
  }
  const links: ts.Node[] = [];
  let current: ts.Expression = unwrapParentheses(statement.expression);
  while (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    links.push(current);
    current = unwrapParentheses(current.right);
  }
  return links;
}

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

/* ------------------------------------------------------------------ *
 * E-1 (ADR 0009 § 1, § 2): the export write set                        *
 * ------------------------------------------------------------------ */

/**
 * What one reference this file makes to its own export objects does to
 * them (task E-1; ADR 0009 § 2's closed `ExportWriteKind` union). The
 * references censused are every ambient `exports`, `module` and
 * `require`, module-scope `this` and the wrapper's `arguments`, `this` in
 * any non-arrow function (called as `exports.m()`, it IS the exports
 * object), and every member write whose base is a `require(…)` result.
 *
 * - `read`: leaves the objects in this file's hands and writes nothing
 *   (`exports.x` read or called as one of this file's own functions,
 *   `typeof exports`, a comparison, `Object.keys(exports)`).
 * - `property-write`: `exports.x = v`, `exports["x"] = v`,
 *   `module.exports.x = v`, `module.exports["x"] = v`, module-scope
 *   `this.x = v` -- the writes {@link exportWriteSet} orders.
 * - `property-other-write`: the same targets in any other write position
 *   (`+=`, `&&=`, `++`, `delete`, a destructuring or `for-of` target).
 * - `whole-module-write`: `module.exports = v` (ordered by
 *   {@link collectModuleExportsAssignments}).
 * - `exports-rebinding`: `exports = v`.
 * - `method-this-write`: a member write on `this` inside a non-arrow
 *   function, a class method or a class's static member -- the exports
 *   object when the function is called as one of its methods (or the class
 *   is the whole-module value).
 * - `method-this-hand-off`: that `this` handed on (`var self = this`,
 *   `f.call(this)`, `return this`). It is un-enumerable only when its
 *   function can be a method of an export object
 *   ({@link exportMethodOwners}); anything handed a fresh instance is no
 *   export object unless the whole-module value may be one.
 * - `define-property`: `Object.defineProperty(exports, "x", …)`,
 *   `Object.defineProperties` / `Object.assign` with object-literal
 *   sources, `Reflect.set` / `Reflect.defineProperty` with a literal key.
 * - `require-result-member-write`: `require(…).x = v`, or `r.x = v` with
 *   `const r = require(…)`: a module that requires itself gets its own
 *   exports object back.
 * - `object-alias`: an export object's value bound to a local
 *   (`const e = exports`, lodash's `var freeExports = … && exports`): the
 *   local's own uses are censused ({@link finalObjectAliasUses}).
 * - `module-alias`: `module`'s value bound to a local
 *   (`var freeModule = … && module`): counted only when the local reads
 *   members other than `exports`, uses `exports` inertly, and writes
 *   nothing ({@link moduleAliasIsInert}).
 * - `unenumerable`: anything else -- an alias (`const e = exports`,
 *   `const m = module`), `module["exports"]`, the object handed to a call
 *   or returned, `Object.freeze(exports)`, the wrapper's `arguments`,
 *   `eval`, `require.cache`, a write through a key nothing names. The
 *   default: a form this union does not name is un-enumerable.
 */
type ExportWriteKind =
  | "read"
  | "property-write"
  | "property-other-write"
  | "whole-module-write"
  | "exports-rebinding"
  | "method-this-write"
  | "method-this-hand-off"
  | "define-property"
  | "require-result-member-write"
  | "object-alias"
  | "module-alias"
  | "unenumerable";

/**
 * Where a `this` is: module scope (the original exports object); a
 * non-arrow function or class method (`function`, the exports object when
 * called as one of its methods); a class's static field or static block
 * (`static`, the class); a constructor or instance field (`fresh`, the
 * instance being constructed).
 */
type ThisContext = "module" | "function" | "static" | "fresh";

/** How a value written into an export object can make a function one of its methods. */
type MethodSourceContext =
  /** The value of one property: a function value is a method. */
  | "property"
  /** The whole-module value: its properties' values, and a class's statics. */
  | "whole"
  /** An object whose properties are copied in (`Object.assign`, `defineProperties`). */
  | "container"
  /** A property descriptor (`defineProperty`): its `get`, `set` and `value`. */
  | "descriptor"
  /** A map of descriptors (`defineProperties`): each value is a `descriptor`. */
  | "descriptors";

/** A value written into an export object, with how it can become a method. */
type MethodSource = readonly [ts.Expression, MethodSourceContext];

/** Builds one {@link ExportReference} of a classification site. */
type MakeReference = (
  kind: ExportWriteKind,
  names?: ReadonlySet<string> | "all",
  values?: readonly MethodSource[],
  assignment?: ts.BinaryExpression,
) => ExportReference;

/** One censused reference, classified. */
interface ExportReference {
  readonly kind: ExportWriteKind;
  /** The names a write of this reference can set; `"all"` for a key nothing names. */
  readonly names: ReadonlySet<string> | "all";
  /** For a `property-write`: the assignment, and which spelling it writes through. */
  readonly assignment?: ts.BinaryExpression;
  readonly base?: ExportPropertyWrite["base"];
  /** Values this reference writes into an export object, for {@link exportMethodOwners}. */
  readonly values?: readonly MethodSource[];
  /** For a `method-this-hand-off`: the function (or, for a static or fresh `this`, the class) whose `this` is handed on. */
  readonly owner?: ts.Node;
  /** For an `object-alias` or a `module-alias`: the local bound to the value. */
  readonly alias?: ts.Identifier;
  readonly thisContext?: ThisContext;
  /** Whether it runs later than its statement, or never: inside a function body or an instance field initializer. */
  readonly deferred: boolean;
  readonly statementIndex: number;
}

/** A plain `=` property write, at the position the object-identity walk orders it. */
interface ExportPropertyWrite {
  readonly name: string;
  readonly assignment: ts.BinaryExpression;
  readonly statementIndex: number;
  /** `this` is module-scope `this`: the ORIGINAL exports object, whatever `exports` is rebound to. */
  readonly base: "exports" | "module.exports" | "this";
}

/** {@link exportWriteSet}'s answer. */
interface ExportWriteSet {
  /** A reference no kind enumerates: every name of the file is withdrawn. */
  readonly unenumerable: boolean;
  /** Names a write the effective-write rule cannot order may set. */
  readonly withdrawn: ReadonlySet<string>;
  /** Every module-time `=` property write, in source order. */
  readonly propertyWrites: readonly ExportPropertyWrite[];
  /** Every `exports = …` rebinding at module time. */
  readonly rebindings: readonly ts.BinaryExpression[];
}

const NO_NAMES: ReadonlySet<string> = new Set();

/** `Object` methods that only read an object they are handed. */
const OBJECT_READERS: ReadonlySet<string> = new Set([
  "keys",
  "values",
  "entries",
  "getOwnPropertyNames",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getOwnPropertySymbols",
  "getPrototypeOf",
  "isFrozen",
  "isSealed",
  "isExtensible",
  "hasOwn",
]);

/** `Reflect` methods that only read an object they are handed. */
const REFLECT_READERS: ReadonlySet<string> = new Set([
  "get",
  "has",
  "ownKeys",
  "getOwnPropertyDescriptor",
  "getPrototypeOf",
  "isExtensible",
]);

const exportWriteSetBySourceFile = new WeakMap<ts.SourceFile, ExportWriteSet>();

/**
 * The complete write set of this file's CommonJS export objects (task E-1;
 * ADR 0009 § 1): every reference the file makes to them, classified by
 * {@link ExportWriteKind}, over the WHOLE file (a function body may run at
 * module time, or after it). Only references that denote the ambient
 * CommonJS bindings count: a parameter or local named `exports` (a
 * bundler's helper, TypeScript's `__exportStar(m, exports)`) is another
 * binding.
 *
 * Accepted bounds, which no census of one file's text can see: writes by
 * OTHER modules (E-4's), a loader patched from outside the file, a method
 * of another module run with this module's exports object as `this`, and a
 * dynamic `import()` of this file, whose namespace's `default` is the
 * exports object.
 */
function exportWriteSet(sourceFile: ts.SourceFile): ExportWriteSet {
  const cached = exportWriteSetBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  let unenumerable = false;
  const withdrawn = new Set<string>();
  const propertyWrites: ExportPropertyWrite[] = [];
  const rebindings: ts.BinaryExpression[] = [];
  const methodSources: MethodSource[] = [];
  const handOffs: ExportReference[] = [];

  const consume = (reference: ExportReference): void => {
    const names = reference.names;
    methodSources.push(...(reference.values ?? []));
    // A write named `__proto__` on an export object (or through an alias of
    // one) sets its prototype: any name may then be inherited, through a
    // getter, a setter or a method no write spells (E-1's independent
    // audit, finding 4). `Object.setPrototypeOf(exports, …)` is an
    // un-enumerable helper call for the same reason.
    if (
      names !== "all" &&
      names.has("__proto__") &&
      reference.kind !== "read"
    ) {
      unenumerable = true;
      return;
    }
    switch (reference.kind) {
      case "read":
      case "whole-module-write":
        return;
      case "method-this-hand-off":
        handOffs.push(reference);
        return;
      case "property-write":
        if (names === "all") {
          unenumerable = true;
        } else if (reference.deferred) {
          for (const name of names) withdrawn.add(name);
        } else {
          for (const name of names) {
            propertyWrites.push({
              name,
              assignment: reference.assignment!,
              statementIndex: reference.statementIndex,
              base: reference.base!,
            });
          }
        }
        return;
      case "exports-rebinding":
        if (reference.deferred) {
          unenumerable = true;
        } else {
          rebindings.push(reference.assignment!);
        }
        return;
      case "method-this-write":
        // Through a key nothing names, a method's `this` write may set any
        // name -- of an export object only when its function can be one of
        // its methods, the hand-off question.
        if (names === "all") {
          handOffs.push(reference);
        } else {
          for (const name of names) withdrawn.add(name);
        }
        return;
      case "property-other-write":
      case "define-property":
      case "require-result-member-write":
        if (names === "all") {
          unenumerable = true;
        } else {
          for (const name of names) withdrawn.add(name);
        }
        return;
      case "object-alias": {
        const uses = finalObjectAliasUses(sourceFile, reference.alias!);
        if (uses === "all") {
          unenumerable = true;
        } else {
          for (const name of uses.names) withdrawn.add(name);
          for (const written of uses.values) {
            methodSources.push([written, "property"]);
          }
        }
        return;
      }
      case "module-alias":
        if (!moduleAliasIsInert(sourceFile, reference.alias!)) {
          unenumerable = true;
        }
        return;
      case "unenumerable":
        unenumerable = true;
        return;
      default: {
        const exhaustive: never = reference.kind;
        throw new Error(`unclassified export reference ${String(exhaustive)}`);
      }
    }
  };

  sourceFile.statements.forEach((statement, statementIndex) => {
    const visit = (
      node: ts.Node,
      deferred: boolean,
      thisContext: ThisContext,
      owner: ts.Node | undefined,
    ): void => {
      const reference = classifyExportReference(
        node,
        deferred,
        thisContext,
        owner,
        statementIndex,
      );
      if (reference !== undefined) {
        consume(reference);
      }
      // A class's heritage, decorators and computed keys are evaluated in
      // the ENCLOSING context (BL-064's audit, finding 5a).
      if (ts.isClassLike(node)) {
        node.heritageClauses?.forEach((clause) =>
          visit(clause, deferred, thisContext, owner),
        );
        ts.getDecorators(node)?.forEach((d) =>
          visit(d, deferred, thisContext, owner),
        );
        for (const member of node.members) {
          if (
            member.name !== undefined &&
            ts.isComputedPropertyName(member.name)
          ) {
            visit(member.name, deferred, thisContext, owner);
          }
          if (ts.canHaveDecorators(member)) {
            ts.getDecorators(member)?.forEach((d) =>
              visit(d, deferred, thisContext, owner),
            );
          }
          // A constructor and an instance field run with the instance being
          // constructed as `this` (a class constructor cannot be called
          // without `new`); a static field and a static block with the class
          // itself; a method with whatever it is called on.
          const isStatic =
            ts.isClassStaticBlockDeclaration(member) ||
            isStaticClassElement(member);
          const memberContext: ThisContext =
            ts.isConstructorDeclaration(member) ||
            (ts.isPropertyDeclaration(member) && !isStatic)
              ? "fresh"
              : ts.isPropertyDeclaration(member) ||
                  ts.isClassStaticBlockDeclaration(member)
                ? "static"
                : "function";
          const memberOwner = memberContext === "function" ? member : node;
          const memberDeferred =
            deferred ||
            ts.isFunctionLike(member) ||
            (ts.isPropertyDeclaration(member) && !isStatic);
          ts.forEachChild(member, (child) => {
            if (child !== member.name && !ts.isDecorator(child)) {
              visit(child, memberDeferred, memberContext, memberOwner);
            }
          });
        }
        return;
      }
      if (
        ts.isFunctionLike(node) &&
        node.name !== undefined &&
        ts.isComputedPropertyName(node.name)
      ) {
        visit(node.name, deferred, thisContext, owner);
      }
      const nestedDeferred = deferred || ts.isFunctionLike(node);
      const ownsThis = ts.isFunctionLike(node) && !ts.isArrowFunction(node);
      ts.forEachChild(node, (child) => {
        if (
          ts.isFunctionLike(node) &&
          node.name !== undefined &&
          child === node.name
        ) {
          return;
        }
        visit(
          child,
          nestedDeferred,
          ownsThis ? "function" : thisContext,
          ownsThis ? node : owner,
        );
      });
    };
    visit(statement, false, "module", undefined);
  });

  // A whole-module value spelled as a binding (`module.exports = api`), or
  // a named function or class expression's own name inside it
  // (`module.exports = function main() { main.x = v; }`), is an alias of the
  // final export object.
  for (const site of competingWriteSites(sourceFile).wholeModule) {
    const value = unwrapParentheses(
      unwrapValue(
        ts.isExportAssignment(site.node)
          ? site.node.expression
          : (site.node as ts.BinaryExpression).right,
      ),
    );
    const binding = ts.isIdentifier(value)
      ? value
      : (ts.isFunctionExpression(value) || ts.isClassExpression(value)) &&
          value.name !== undefined
        ? value.name
        : undefined;
    if (binding === undefined || isAmbientReference(binding, "exports")) {
      continue;
    }
    const alias = finalObjectAliasUses(sourceFile, binding);
    if (alias === "all") {
      unenumerable = true;
    } else {
      for (const name of alias.names) withdrawn.add(name);
      // A value written through the alias is one of the final object's
      // properties: a function there is one of its methods.
      for (const written of alias.values) {
        methodSources.push([written, "property"]);
      }
    }
  }

  // A handed-on `this` reaches an export object only from a function that
  // can be one of its methods.
  if (!unenumerable && handOffs.length > 0) {
    const owners = exportMethodOwners(sourceFile, methodSources);
    unenumerable = handOffs.some(
      (handOff) =>
        owners === "all" ||
        (handOff.thisContext !== "fresh" && owners.has(handOff.owner!)),
    );
  }

  const set = { unenumerable, withdrawn, propertyWrites, rebindings };
  exportWriteSetBySourceFile.set(sourceFile, set);
  return set;
}

/**
 * The names written through `binding` (a whole-module value spelled as a
 * binding, an alias of the final export object) and the values written,
 * or `"all"` when the binding is handed on: every reference to the same
 * declaration that is not a member read, a method call, an inert use or
 * another whole-module write. A member write of any form withdraws its
 * name. A binding that is not the file's own single declaration is
 * `"all"`; a `const`, `let` or `var` initialized to another binding (a
 * second alias) adds that one's uses, accounted the same way.
 */
function finalObjectAliasUses(
  sourceFile: ts.SourceFile,
  binding: ts.Identifier,
  seen: Set<unknown> = new Set(),
):
  | {
      readonly names: ReadonlySet<string>;
      readonly values: readonly ts.Expression[];
    }
  | "all" {
  // An undeclared name is a global: its uses in this file are every
  // undeclared reference of that spelling (another module reaches it only
  // through the global object, an accepted bound of every file census).
  const declaration: ts.Node =
    lexicalDeclarationOf(binding, binding.text) ?? sourceFile;
  if (seen.size > 8 || isAmbientReference(binding, "module")) {
    return "all";
  }
  const names = new Set<string>();
  const values: ts.Expression[] = [];
  const key =
    declaration === sourceFile ? `global:${binding.text}` : declaration;
  if (seen.has(key)) {
    return { names, values };
  }
  seen.add(key);
  let handedOn = false;
  const merge = (other: ts.Identifier): void => {
    const uses = finalObjectAliasUses(sourceFile, other, seen);
    if (uses === "all") {
      handedOn = true;
      return;
    }
    for (const name of uses.names) names.add(name);
    values.push(...uses.values);
  };
  // A binding initialized to another binding aliases that one's object too,
  // and so does one initialized to this binding (`const b = a`, RWF-012's
  // chains): their uses are accounted the same way. (One initialized to a
  // call or a `new` may share its object with whatever the callee kept: no
  // census of the file's text sees that holder, an accepted bound.)
  if (ts.isVariableDeclaration(declaration)) {
    const init =
      declaration.initializer === undefined
        ? undefined
        : unwrapParentheses(declaration.initializer);
    if (init !== undefined && ts.isIdentifier(init)) {
      merge(init);
      if (handedOn) {
        return "all";
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (handedOn) {
      return;
    }
    if (
      ts.isIdentifier(node) &&
      node.text === binding.text &&
      !isNonReferenceName(node, node.parent) &&
      !isDeclarationName(node, node.parent) &&
      (lexicalDeclarationOf(node, node.text) ?? sourceFile) === declaration
    ) {
      const outer = skipOuterParentheses(node);
      const parent = outer.parent as ts.Node;
      if (
        (ts.isPropertyAccessExpression(parent) ||
          ts.isElementAccessExpression(parent)) &&
        parent.expression === outer
      ) {
        const access = skipOuterParentheses(parent);
        if (isWriteTargetPosition(access)) {
          const written = accessNames(parent);
          // A `__proto__` write sets the prototype: any name may follow.
          if (written === "all" || written.has("__proto__")) {
            handedOn = true;
          } else {
            for (const name of written) names.add(name);
          }
          const writer = access.parent as ts.Node;
          if (ts.isBinaryExpression(writer) && writer.left === access) {
            values.push(writer.right);
          } else if (
            !ts.isPrefixUnaryExpression(writer) &&
            !ts.isPostfixUnaryExpression(writer) &&
            !ts.isDeleteExpression(writer)
          ) {
            // A destructuring or `for-of` target's value is unreadable
            // here: it stands in as a member read (any function).
            values.push(access as ts.Expression);
          }
        }
        return;
      }
      if (isInertUse(outer)) {
        return;
      }
      // Another binding's initializer (`const b = a`), or assigned to one
      // (`b = a`, `module.exports = alias = impl`): a further alias.
      if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === outer &&
        ts.isIdentifier(parent.name)
      ) {
        merge(parent.name);
        return;
      }
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.right === outer &&
        ts.isIdentifier(unwrapParentheses(parent.left)) &&
        !isAmbientReference(unwrapParentheses(parent.left), "exports")
      ) {
        merge(unwrapParentheses(parent.left) as ts.Identifier);
        return;
      }
      // Stored into itself (`factory.default = factory`): it stays within
      // the final object.
      const target =
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.right === outer
          ? unwrapParentheses(parent.left)
          : undefined;
      if (
        target !== undefined &&
        (ts.isPropertyAccessExpression(target) ||
          ts.isElementAccessExpression(target)) &&
        ts.isIdentifier(unwrapParentheses(target.expression)) &&
        lexicalDeclarationOf(
          unwrapParentheses(target.expression),
          (unwrapParentheses(target.expression) as ts.Identifier).text,
        ) === declaration
      ) {
        return;
      }
      // Read by an `Object` or `Reflect` reader (`Object.keys(api)`).
      if (
        ts.isCallExpression(parent) &&
        parent.arguments[0] === outer &&
        classifyHelperCall(parent, (kind) => ({
          kind,
          names: NO_NAMES,
          deferred: false,
          statementIndex: 0,
        })).kind === "read"
      ) {
        return;
      }
      // Called or constructed, the object hands itself to nothing.
      if (
        (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
        parent.expression === outer
      ) {
        return;
      }
      // Written back into an export object (`module.exports = fn;
      // module.exports.default = fn;`): it stays in this module's exports.
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.right === outer &&
        (isModuleExportsAssignmentTarget(unwrapParentheses(parent.left)) ||
          isAmbientReference(unwrapParentheses(parent.left), "exports") ||
          commonJsExportPropertyName(unwrapParentheses(parent.left)) !==
            undefined)
      ) {
        return;
      }
      if (
        ts.isExportAssignment(parent) &&
        parent.isExportEquals &&
        parent.expression === outer
      ) {
        return;
      }
      if (isPlainAssignmentTarget(outer)) {
        // Rebound: the binding no longer holds the final object afterwards,
        // but may before; its later member writes are counted all the same.
        return;
      }
      handedOn = true;
      return;
    }
  };
  // Only identifiers spelled like the binding are visited (E-1's audit, finding 5).
  for (const reference of identifiersSpelled(sourceFile, binding.text)) {
    visit(reference);
  }
  return handedOn ? "all" : { names, values };
}

/**
 * The functions whose `this` can be an export object, because they can be
 * one of its methods (task E-1): every function value written into an
 * export object -- a property write's value, the whole-module value's
 * properties and, for a class, its static members, an `Object.assign` or
 * `defineProperties` source's values, a `defineProperty` descriptor's `get`,
 * `set` and `value`. A class is listed for its static fields and blocks.
 *
 * `"all"` when any of those values is something this cannot read -- a
 * call, a `new`, a member read, a parameter, a binding the file reassigns:
 * it may be any function of the file, and a whole-module value that is a
 * call's or a `new`'s result may be an instance of any class of the file.
 * A value from another module (`require(…)`, an import) brings that
 * module's functions, whose `this` is no census's (an accepted bound); a
 * nested object literal's methods have that object as `this`.
 */
function exportMethodOwners(
  sourceFile: ts.SourceFile,
  sources: readonly MethodSource[],
): ReadonlySet<ts.Node> | "all" {
  const owners = new Set<ts.Node>();
  let all = false;
  const visiting = new Set<ts.Node>();
  const addClass = (node: ts.ClassLikeDeclaration): void => {
    owners.add(node);
    for (const member of node.members) {
      if (
        isStaticClassElement(member) &&
        (ts.isMethodDeclaration(member) || ts.isAccessor(member))
      ) {
        owners.add(member);
      }
    }
  };
  const addObject = (
    literal: ts.ObjectLiteralExpression,
    accessors: boolean,
  ): void => {
    for (const property of literal.properties) {
      if (ts.isSpreadAssignment(property)) {
        all = true;
      } else if (
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === "__proto__"
      ) {
        // The prototype's methods are inherited, run with this object as
        // `this`.
        add(property.initializer, "container");
      } else if (ts.isPropertyAssignment(property)) {
        add(property.initializer, "property");
      } else if (ts.isShorthandPropertyAssignment(property)) {
        add(property.name, "property");
      } else if (ts.isMethodDeclaration(property)) {
        owners.add(property);
      } else if (accessors) {
        owners.add(property);
      }
    }
  };
  const add = (
    expression: ts.Expression,
    context: MethodSourceContext,
    depth = 0,
  ): void => {
    const value = unwrapParentheses(unwrapValue(expression));
    if (all || depth > 3) {
      all = true;
      return;
    }
    // A primitive and an arrow have no `this` of their own; an array is
    // its elements' `this`, never the export object's.
    if (
      isPrimitiveValue(value) ||
      ts.isArrowFunction(value) ||
      ts.isArrayLiteralExpression(value) ||
      ts.isRegularExpressionLiteral(value) ||
      ts.isTemplateExpression(value)
    ) {
      return;
    }
    if (ts.isFunctionExpression(value)) {
      if (context !== "whole") owners.add(value);
      return;
    }
    if (ts.isClassExpression(value)) {
      if (context === "whole") addClass(value);
      return;
    }
    if (ts.isObjectLiteralExpression(value)) {
      if (context === "whole" || context === "container") {
        addObject(value, context === "whole");
      } else if (context === "descriptors") {
        for (const property of value.properties) {
          if (ts.isPropertyAssignment(property)) {
            add(property.initializer, "descriptor", depth + 1);
          } else if (ts.isShorthandPropertyAssignment(property)) {
            add(property.name, "descriptor", depth + 1);
          } else {
            all = true;
          }
        }
      } else if (context === "descriptor") {
        for (const property of value.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === "value"
          ) {
            add(property.initializer, "property", depth + 1);
          } else if (
            ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property)
          ) {
            add(
              ts.isPropertyAssignment(property)
                ? property.initializer
                : property.name,
              "property",
              depth + 1,
            );
          } else if (!ts.isSpreadAssignment(property)) {
            owners.add(property);
          } else {
            all = true;
          }
        }
      }
      return;
    }
    if (isRequireResult(value) || isRequireResultMember(value)) {
      return;
    }
    // The value is one of the operands.
    if (ts.isConditionalExpression(value)) {
      add(value.whenTrue, context, depth + 1);
      add(value.whenFalse, context, depth + 1);
      return;
    }
    if (
      ts.isBinaryExpression(value) &&
      (value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      add(value.left, context, depth + 1);
      add(value.right, context, depth + 1);
      return;
    }
    if (
      ts.isBinaryExpression(value) &&
      value.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      add(value.right, context, depth + 1);
      return;
    }
    // Read off a global or another module (`Error.captureStackTrace`,
    // `lib.util.x`): no function of this file.
    if (
      (ts.isPropertyAccessExpression(value) ||
        ts.isElementAccessExpression(value)) &&
      isForeignRoot(value)
    ) {
      return;
    }
    // A call's (or a construction's) result outside the whole-module
    // position is one of this file's functions only through what the callee
    // returns -- for one of this file's own callees -- or through what it was
    // handed -- for a global's or another module's. A whole-module value
    // that is a call's or a construction's result may be an instance of any
    // class of the file.
    if (
      (ts.isCallExpression(value) || ts.isNewExpression(value)) &&
      context !== "whole"
    ) {
      const callee = unwrapParentheses(value.expression);
      if (
        ts.isCallExpression(value) &&
        isAmbientReference(
          ts.isPropertyAccessExpression(callee) ? callee.expression : callee,
          "Symbol",
        )
      ) {
        return;
      }
      // An instance of one of this file's classes has itself as its
      // methods' `this`; only a constructor's explicit return is another value.
      const constructed =
        ts.isNewExpression(value) && ts.isIdentifier(callee)
          ? lexicalDeclarationOf(callee, callee.text)
          : ts.isNewExpression(value) && ts.isClassExpression(callee)
            ? callee
            : undefined;
      if (
        constructed !== undefined &&
        (ts.isClassDeclaration(constructed) ||
          ts.isClassExpression(constructed)) &&
        !(
          ts.isIdentifier(callee) &&
          isNameAssignedWithin(sourceFile, callee.text)
        )
      ) {
        const ctor = constructed.members.find(ts.isConstructorDeclaration);
        for (const returned of ctor === undefined ? [] : returnedValues(ctor)) {
          add(returned, "property", depth + 1);
        }
        return;
      }
      const local = localCallable(sourceFile, callee);
      if (local !== undefined) {
        for (const returned of returnedValues(local)) {
          // A returned parameter (an enum IIFE's `return E2`) is what this
          // call passed at its position -- unless the parameter is written,
          // rest, or the call spreads its arguments.
          const unwrapped = unwrapParentheses(returned);
          const declared = ts.isIdentifier(unwrapped)
            ? lexicalDeclarationOf(unwrapped, unwrapped.text)
            : undefined;
          const parameter =
            declared !== undefined && ts.isParameter(declared)
              ? declared
              : undefined;
          const at =
            parameter === undefined ? -1 : local.parameters.indexOf(parameter);
          if (parameter !== undefined && at >= 0) {
            const args = value.arguments ?? [];
            if (
              parameter.dotDotDotToken !== undefined ||
              !ts.isIdentifier(parameter.name) ||
              isNameAssignedWithin(local, parameter.name.text) ||
              args.some(ts.isSpreadElement)
            ) {
              all = true;
              return;
            }
            const argument = args[at] ?? parameter.initializer;
            if (argument !== undefined) {
              add(argument, "property", depth + 1);
            }
            continue;
          }
          add(returned, "property", depth + 1);
        }
        return;
      }
      if (isForeignRoot(callee)) {
        for (const argument of value.arguments ?? []) {
          add(
            argument,
            ts.isObjectLiteralExpression(unwrapParentheses(argument))
              ? "container"
              : "property",
            depth + 1,
          );
        }
        return;
      }
      all = true;
      return;
    }
    if (ts.isIdentifier(value)) {
      if (isAmbientReference(value, "exports")) {
        return;
      }
      const declaration = lexicalDeclarationOf(value, value.text);
      if (declaration === undefined) {
        // A global (`Object`, `Symbol.iterator`'s owner): no function of
        // this file.
        return;
      }
      if (
        ts.isImportSpecifier(declaration) ||
        ts.isImportClause(declaration) ||
        ts.isNamespaceImport(declaration) ||
        ts.isImportEqualsDeclaration(declaration)
      ) {
        return;
      }
      if (ts.isFunctionDeclaration(declaration)) {
        if (context !== "whole") owners.add(declaration);
        return;
      }
      if (ts.isClassDeclaration(declaration)) {
        if (context === "whole") addClass(declaration);
        return;
      }
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined &&
        !isNameAssignedWithin(sourceFile, value.text)
      ) {
        // A binding read inside its own initializer (`var E = f(E || {})`)
        // is still `undefined` there: the cycle adds no value.
        if (visiting.has(declaration)) {
          return;
        }
        visiting.add(declaration);
        add(declaration.initializer, context, depth + 1);
        visiting.delete(declaration);
        return;
      }
      // Destructured from another module (`const { bold } = require("x")`).
      if (ts.isBindingElement(declaration)) {
        let holder: ts.Node = declaration;
        while (
          ts.isBindingElement(holder) ||
          ts.isObjectBindingPattern(holder) ||
          ts.isArrayBindingPattern(holder)
        ) {
          holder = holder.parent;
        }
        if (
          ts.isVariableDeclaration(holder) &&
          holder.initializer !== undefined &&
          isForeignRoot(holder.initializer) &&
          !isNameAssignedWithin(sourceFile, value.text)
        ) {
          return;
        }
      }
      all = true;
      return;
    }
    all = true;
  };
  for (const [expression, context] of sources) {
    add(expression, context);
    if (all) {
      return "all";
    }
  }
  return owners;
}

/**
 * Whether `expression`'s root names something outside this file's own
 * functions: a global (no declaration in scope; not the CommonJS ambient
 * names), an import, a `require(…)` result, or a binding initialized to
 * one (directly, through a member read, or through an interop helper's
 * call on it, TypeScript's `__importDefault(require("x"))`).
 */
function isForeignRoot(expression: ts.Expression): boolean {
  let root = unwrapParentheses(expression);
  while (
    ts.isPropertyAccessExpression(root) ||
    ts.isElementAccessExpression(root)
  ) {
    root = unwrapParentheses(root.expression);
  }
  if (isRequireResult(root)) {
    return true;
  }
  if (!ts.isIdentifier(root)) {
    return false;
  }
  if (
    ["exports", "module", "require", "arguments", "eval"].includes(root.text)
  ) {
    return false;
  }
  const declaration = lexicalDeclarationOf(root, root.text);
  if (declaration === undefined) {
    return true;
  }
  if (
    ts.isImportSpecifier(declaration) ||
    ts.isImportClause(declaration) ||
    ts.isNamespaceImport(declaration) ||
    ts.isImportEqualsDeclaration(declaration)
  ) {
    return true;
  }
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined ||
    isNameAssignedWithin(declaration.getSourceFile(), root.text)
  ) {
    return false;
  }
  const init = unwrapParentheses(declaration.initializer);
  return (
    isRequireResult(init) ||
    isRequireResultMember(init) ||
    (ts.isCallExpression(init) &&
      init.arguments.length === 1 &&
      isRequireResult(init.arguments[0]!))
  );
}

/** The function `callee` denotes when it is one of this file's own, unreassigned. */
function localCallable(
  sourceFile: ts.SourceFile,
  callee: ts.Expression,
): ts.FunctionLikeDeclaration | undefined {
  if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) {
    return callee;
  }
  if (
    !ts.isIdentifier(callee) ||
    isNameAssignedWithin(sourceFile, callee.text)
  ) {
    return undefined;
  }
  const declaration = lexicalDeclarationOf(callee, callee.text);
  if (declaration !== undefined && ts.isFunctionDeclaration(declaration)) {
    return declaration.body === undefined ? undefined : declaration;
  }
  if (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined
  ) {
    const init = unwrapParentheses(declaration.initializer);
    if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) {
      return init;
    }
  }
  return undefined;
}

/** Every value a function can return: its `return` expressions (not a nested function's), or a concise arrow's body. */
function returnedValues(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  if (fn.body === undefined) {
    return [];
  }
  if (!ts.isBlock(fn.body)) {
    return [fn.body];
  }
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      found.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return found;
}

/**
 * Whether `access` (`module.exports.m(…)`) calls a method every value of
 * which this file defines as its own function: no property write of `m`
 * ({@link exportPropertyWriteValues}) and, in every whole-module object
 * literal that defines `m`, a method or a function value. Such a method's
 * `this` writes and hand-offs are censused like any function's, so the call
 * hands the exports object to no code the census does not see.
 */
function isOwnLiteralMethodCall(access: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(access)) {
    return false;
  }
  const name = access.name.text;
  const sourceFile = access.getSourceFile();
  if ((exportPropertyWriteValues(sourceFile).get(name) ?? []).length > 0) {
    return false;
  }
  let defined = false;
  for (const site of competingWriteSites(sourceFile).wholeModule) {
    const value = unwrapParentheses(
      unwrapValue(
        ts.isExportAssignment(site.node)
          ? site.node.expression
          : (site.node as ts.BinaryExpression).right,
      ),
    );
    if (!ts.isObjectLiteralExpression(value)) {
      return false;
    }
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) {
        return false;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        if (property.name.text !== name) continue;
        defined = true;
        const declaration = lexicalDeclarationOf(property.name, name);
        if (
          declaration === undefined ||
          !ts.isFunctionDeclaration(declaration) ||
          isNameAssignedWithin(sourceFile, name)
        ) {
          return false;
        }
        continue;
      }
      if (
        property.name === undefined ||
        !(
          ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ) ||
        property.name.text !== name
      ) {
        continue;
      }
      defined = true;
      const own =
        ts.isMethodDeclaration(property) ||
        (ts.isPropertyAssignment(property) &&
          (ts.isFunctionExpression(unwrapParentheses(property.initializer)) ||
            ts.isArrowFunction(unwrapParentheses(property.initializer))));
      if (!own) {
        return false;
      }
    }
  }
  return defined;
}

/**
 * The local a value flows into, when `node`'s value can only end up there:
 * through parentheses, the value operands of `&&`, `||` and `??`, a
 * conditional's branches and a comma's right, into a variable's initializer
 * (`var a = … && exports`) or a plain assignment to an identifier
 * (`a = exports`). `undefined` for any other destination.
 */
function valueSink(node: ts.Node): ts.Identifier | undefined {
  let current = skipOuterParentheses(node);
  for (;;) {
    const parent = current.parent as ts.Node | undefined;
    if (parent === undefined) {
      return undefined;
    }
    if (
      (ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          (parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
            parent.right === current))) ||
      (ts.isConditionalExpression(parent) && parent.condition !== current)
    ) {
      current = skipOuterParentheses(parent);
      continue;
    }
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === current &&
      ts.isIdentifier(parent.name)
    ) {
      return parent.name;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === current &&
      ts.isIdentifier(unwrapParentheses(parent.left))
    ) {
      const target = unwrapParentheses(parent.left) as ts.Identifier;
      return isAmbientReference(target, "exports") ||
        isAmbientReference(target, "module")
        ? undefined
        : target;
    }
    return undefined;
  }
}

/**
 * Whether a local holding `module` (lodash's `var freeModule = … && module`)
 * reaches the export objects through nothing the census does not see: every
 * use of it is inert, a read or a call of a member other than `exports`
 * (`freeModule.require(…)`), or an inert use of its `exports` member
 * (`freeModule.exports === freeExports`). A write through it, its `exports`
 * read for any other use, and the local handed on are not.
 */
function moduleAliasIsInert(
  sourceFile: ts.SourceFile,
  binding: ts.Identifier,
): boolean {
  const declaration = lexicalDeclarationOf(binding, binding.text);
  if (declaration === undefined) {
    return false;
  }
  let inert = true;
  const visit = (node: ts.Node): void => {
    if (!inert) {
      return;
    }
    if (
      ts.isIdentifier(node) &&
      node.text === binding.text &&
      !isNonReferenceName(node, node.parent) &&
      !isDeclarationName(node, node.parent) &&
      lexicalDeclarationOf(node, node.text) === declaration
    ) {
      const outer = skipOuterParentheses(node);
      const parent = outer.parent as ts.Node;
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === outer
      ) {
        const access = skipOuterParentheses(parent);
        if (isWriteTargetPosition(access)) {
          inert = false;
        } else if (isInertUse(access)) {
          // A member only tested (`freeModule.require && …`).
        } else if (parent.name.text === "exports") {
          inert = false;
        } else if (parent.name.text === "require") {
          // `freeModule.require("util")`: a load of something that cannot be
          // this file.
          const call = access.parent as ts.Node;
          inert =
            ts.isCallExpression(call) &&
            call.expression === access &&
            !mayLoadThisFile(call);
        } else {
          inert = INERT_MODULE_MEMBERS.has(parent.name.text);
        }
        return;
      }
      if (isInertUse(outer) || isPlainAssignmentTarget(outer)) {
        return;
      }
      inert = false;
      return;
    }
  };
  // Only identifiers spelled like the binding are visited (E-1's audit, finding 5).
  for (const reference of identifiersSpelled(sourceFile, binding.text)) {
    visit(reference);
  }
  return inert;
}

/**
 * Whether the method `access` calls (`exports.m(…)`) is one this file
 * spells no value of at all: no property write of `m` and no whole-module
 * write whose value can carry `m`. Another module put it on the object.
 */
function isMethodWrittenElsewhere(access: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(access)) {
    return false;
  }
  const name = access.name.text;
  const sourceFile = access.getSourceFile();
  // An `Object.prototype` method is a builtin, not another module's
  // (`exports.__defineGetter__(…)` writes the object; E-1's independent
  // audit, finding 4).
  if (
    name in Object.prototype ||
    (exportPropertyWriteValues(sourceFile).get(name) ?? []).length > 0
  ) {
    return false;
  }
  return competingWriteSites(sourceFile).wholeModule.every((site) => {
    if (site.carries !== "all") {
      return !site.carries.has(name);
    }
    // A function or class value carries what is written onto it (the alias
    // census reads every such write of this file) and a class's own static
    // members; anything else (a call's result, another module's object) may
    // carry any name.
    const value = unwrapParentheses(
      unwrapValue(
        ts.isExportAssignment(site.node)
          ? site.node.expression
          : (site.node as ts.BinaryExpression).right,
      ),
    );
    // Another module's object (`module.exports = require("./debug")`)
    // carries that module's methods.
    if (isRequireResult(value) || isRequireResultMember(value)) {
      return true;
    }
    const binding = ts.isIdentifier(value)
      ? value
      : (ts.isFunctionExpression(value) || ts.isClassExpression(value)) &&
          value.name !== undefined
        ? value.name
        : undefined;
    const declared =
      binding === undefined
        ? ts.isFunctionExpression(value) || ts.isClassExpression(value)
          ? value
          : undefined
        : lexicalDeclarationOf(binding, binding.text);
    if (
      declared === undefined ||
      !(
        ts.isFunctionDeclaration(declared) ||
        ts.isFunctionExpression(declared) ||
        ts.isClassDeclaration(declared) ||
        ts.isClassExpression(declared)
      ) ||
      (ts.isClassLike(declared) &&
        declared.members.some(
          (member) =>
            member.name !== undefined &&
            ts.isIdentifier(member.name) &&
            member.name.text === name,
        ))
    ) {
      return false;
    }
    if (binding === undefined) {
      return true;
    }
    const uses = finalObjectAliasUses(sourceFile, binding);
    return uses !== "all" && !uses.names.has(name);
  });
}

/** Whether a `with` body spells any name or `this` through which an export object is reached. */
function withBodyReachesExportNames(body: ts.Node): boolean {
  let reaches = false;
  const visit = (node: ts.Node): void => {
    if (reaches) {
      return;
    }
    if (
      node.kind === ts.SyntaxKind.ThisKeyword ||
      (ts.isIdentifier(node) &&
        (node.text === "exports" ||
          node.text === "module" ||
          node.text === "require" ||
          node.text === "arguments" ||
          node.text === "eval"))
    ) {
      reaches = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return reaches;
}

/** `require(…).x`, `require(…)["x"]`: another module's export. */
function isRequireResultMember(expression: ts.Expression): boolean {
  const value = unwrapParentheses(expression);
  return (
    (ts.isPropertyAccessExpression(value) ||
      ts.isElementAccessExpression(value)) &&
    isRequireResult(value.expression)
  );
}

/** Whether `node` is an identifier reference to the AMBIENT CommonJS binding `name` (no declaration in scope). */
function isAmbientReference(node: ts.Node, name: string): boolean {
  if (!ts.isIdentifier(node) || node.text !== name) {
    return false;
  }
  const parent = node.parent as ts.Node | undefined;
  return (
    parent !== undefined &&
    !isNonReferenceName(node, parent) &&
    !isDeclarationName(node, parent) &&
    lexicalDeclarationOf(node, name) === undefined
  );
}

/**
 * Whether `node` is the name a declaration introduces, or a property name
 * a pattern or specifier reads (`{ module: m } = x`, `import { x as y }`,
 * `export { x as y }`'s outer name): not a reference.
 */
function isDeclarationName(node: ts.Identifier, parent: ts.Node): boolean {
  if (
    ((ts.isBindingElement(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isExportSpecifier(parent)) &&
      parent.propertyName === node) ||
    (ts.isExportSpecifier(parent) &&
      parent.propertyName !== undefined &&
      parent.name === node)
  ) {
    return true;
  }
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isBindingElement(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent)) &&
    (parent as { name?: ts.Node }).name === node
  );
}

/**
 * Whether `node` changes what EVERY object inherits, or reaches the loader
 * (E-1's independent audit, finding 4): then an export object may have an
 * inherited setter, getter or method no write of the file spells, and
 * `exports.x = v` may not even create a property.
 *
 * - `X.prototype` of an ambient global (`Object.prototype`,
 *   `Function.prototype`, …) written, written through
 *   (`Object.prototype.m = f`), or handed to a call
 *   (`Object.defineProperty(Object.prototype, "run", …)`); a read of it
 *   (`Object.prototype.hasOwnProperty.call(…)`) is not;
 * - a `__defineGetter__` or `__defineSetter__` call on anything;
 * - `process.mainModule` (the entry `Module`, whose `children` can hold this
 *   module) and a load of the `module` builtin (`require("module")._cache`,
 *   `._load`).
 */
function isPrototypeTampering(node: ts.Node): boolean {
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    const name = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : exactCommonJsExportPropertyName(
          unwrapParentheses(node.argumentExpression),
        );
    const base = unwrapParentheses(node.expression);
    if (
      name === "prototype" &&
      ts.isIdentifier(base) &&
      isAmbientReference(base, base.text) &&
      !["exports", "module", "require"].includes(base.text)
    ) {
      const outer = skipOuterParentheses(node);
      const parent = outer.parent as ts.Node;
      if (isWriteTargetPosition(outer)) {
        return true;
      }
      if (
        (ts.isPropertyAccessExpression(parent) ||
          ts.isElementAccessExpression(parent)) &&
        parent.expression === outer
      ) {
        return isWriteTargetPosition(skipOuterParentheses(parent));
      }
      return (
        ts.isCallExpression(parent) &&
        parent.arguments.some(
          (argument) => unwrapParentheses(argument) === node,
        ) &&
        !isBuiltinReaderCall(parent)
      );
    }
    if (
      name === "mainModule" &&
      ts.isIdentifier(base) &&
      isAmbientReference(base, "process")
    ) {
      return true;
    }
    if (
      (name === "__defineGetter__" || name === "__defineSetter__") &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression === node
    ) {
      return true;
    }
    // `globalThis.process`, `root.process` where `root` is bound to the
    // global object (lodash's `freeGlobal.process`), or a global's member
    // nothing names (E-1's re-audit, F3).
    if (
      (name === undefined || name === "process") &&
      reachesGlobalObject(base)
    ) {
      return name === undefined || !processValueIsInert(node);
    }
    return false;
  }
  if (isAmbientReference(node, "process")) {
    return !processValueIsInert(node);
  }
  if (ts.isCallExpression(node) && isRequireResult(node)) {
    const [first] = node.arguments;
    const argument = first === undefined ? undefined : unwrapParentheses(first);
    if (
      argument !== undefined &&
      ts.isStringLiteralLike(argument) &&
      (argument.text === "process" || argument.text === "node:process")
    ) {
      // The `process` builtin is the `process` object itself.
      return !processValueIsInert(node);
    }
    return (
      argument !== undefined &&
      ts.isStringLiteralLike(argument) &&
      (argument.text === "module" || argument.text === "node:module")
    );
  }
  return false;
}

/** Members of `process` that reach no module object and run no code of a module. */
const PROCESS_INERT_MEMBERS: ReadonlySet<string> = new Set([
  "env",
  "platform",
  "arch",
  "version",
  "versions",
  "release",
  "features",
  "config",
  "pid",
  "ppid",
  "argv",
  "argv0",
  "execArgv",
  "execPath",
  "title",
  "type",
  "browser",
  "cwd",
  "exit",
  "exitCode",
  "nextTick",
  "hrtime",
  "uptime",
  "memoryUsage",
  "cpuUsage",
  "resourceUsage",
  "emitWarning",
  "noDeprecation",
  "throwDeprecation",
  "traceDeprecation",
  "listeners",
  "listenerCount",
  "stdout",
  "stderr",
  "stdin",
  "umask",
  "kill",
  "getuid",
  "geteuid",
  "getgid",
  "getegid",
  "getgroups",
  "send",
  "connected",
  "disconnect",
  "channel",
]);

/** Members of `process` (its `EventEmitter` methods) that return `process` itself. */
const PROCESS_CHAINABLE_MEMBERS: ReadonlySet<string> = new Set([
  "on",
  "once",
  "off",
  "addListener",
  "removeListener",
  "removeAllListeners",
  "prependListener",
  "prependOnceListener",
  "setMaxListeners",
]);

/** Ambient names that denote the global object, or build code that returns it (`Function("return this")()`). */
const GLOBAL_OBJECT_NAMES: readonly string[] = [
  "globalThis",
  "global",
  "self",
  "window",
  "Function",
];

/**
 * Whether `base` may be the global object: an ambient `globalThis`,
 * `global`, `self` or `window`, or a binding whose initializer spells one
 * (lodash's `var freeGlobal = typeof global == "object" && global …`;
 * `root = freeGlobal || freeSelf || Function("return this")()`).
 */
function reachesGlobalObject(
  base: ts.Expression,
  seen: Set<ts.Node> = new Set(),
): boolean {
  const value = unwrapParentheses(base);
  if (!ts.isIdentifier(value)) {
    return false;
  }
  if (GLOBAL_OBJECT_NAMES.some((name) => isAmbientReference(value, name))) {
    return true;
  }
  const declaration = lexicalDeclarationOf(value, value.text);
  if (
    declaration === undefined ||
    seen.has(declaration) ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined
  ) {
    return false;
  }
  const known = globalReachByDeclaration.get(declaration);
  if (known !== undefined) {
    return known;
  }
  if (seen.size >= SUMMARY_DEPTH) {
    // Fail closed past the bound: the binding may be the global object.
    return true;
  }
  const outermost = seen.size === 0;
  seen.add(declaration);
  aliasSummaryWalks += 1;
  let reaches = false;
  const visit = (node: ts.Node): void => {
    if (reaches) {
      return;
    }
    if (ts.isIdentifier(node) && reachesGlobalObject(node, seen)) {
      reaches = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.initializer);
  // A `false` below the outermost call may be a cycle's cut, not an answer.
  if (reaches || outermost) {
    globalReachByDeclaration.set(declaration, reaches);
  }
  return reaches;
}

/**
 * How deep the alias summaries ({@link reachesGlobalObject},
 * {@link bindingMayHoldLoad}, {@link processValueIsInert}) follow bindings
 * before failing closed (E-1's audit, round 3: a 3,000-alias chain
 * overflowed the stack).
 */
const SUMMARY_DEPTH = 64;

const globalReachByDeclaration = new WeakMap<ts.Node, boolean>();
let aliasSummaryWalks = 0;

/** How many alias summaries were computed (memo misses): an operation count for the structural performance test. */
export function exportAliasSummaryWalks(): number {
  return aliasSummaryWalks;
}
const loadHoldingByDeclaration = new WeakMap<ts.Node, boolean>();

/**
 * Whether a `process` value (`process`, `globalThis.process`) reaches no
 * module object (E-1's re-audit, F3): only tested, or used through a member
 * of {@link PROCESS_INERT_MEMBERS} (`process.env.X`), or `binding("util")`
 * (lodash), directly or through a binding every use of which is so
 * (`var freeProcess = … && freeGlobal.process`). `process.mainModule`,
 * `process.getBuiltinModule("module")`, a computed member and a hand-off
 * reach the loader.
 */
function processValueIsInert(
  node: ts.Node,
  seen: Set<ts.Node> = new Set(),
): boolean {
  const outer = skipOuterParentheses(node);
  const parent = outer.parent as ts.Node;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === outer) {
    const member = parent.name.text;
    const access = skipOuterParentheses(parent);
    if (PROCESS_CHAINABLE_MEMBERS.has(member)) {
      // `process.on(…)` returns `process` itself (E-1's audit, round 3):
      // only a call whose result is discarded or tested hands nothing on.
      const call = access.parent as ts.Node;
      return (
        isInertUse(access) ||
        (ts.isCallExpression(call) &&
          call.expression === access &&
          isInertUse(call))
      );
    }
    if (PROCESS_INERT_MEMBERS.has(member)) {
      return true;
    }
    if (isInertUse(access)) {
      return true;
    }
    const call = access.parent as ts.Node;
    const [first] = ts.isCallExpression(call) ? call.arguments : [];
    return (
      member === "binding" &&
      ts.isCallExpression(call) &&
      call.expression === access &&
      first !== undefined &&
      ts.isStringLiteralLike(first) &&
      first.text === "util"
    );
  }
  if (isInertUse(outer)) {
    return true;
  }
  const top = climbValue(outer);
  if (top !== outer && isInertUse(top)) {
    return true;
  }
  const holder = top.parent as ts.Node;
  if (
    ts.isVariableDeclaration(holder) &&
    holder.initializer === top &&
    ts.isObjectBindingPattern(holder.name)
  ) {
    // `const { env } = process`: allow-listed members only, no rest.
    return holder.name.elements.every((element) => {
      const key =
        element.propertyName ??
        (ts.isIdentifier(element.name) ? element.name : undefined);
      return (
        element.dotDotDotToken === undefined &&
        key !== undefined &&
        (ts.isIdentifier(key) || ts.isStringLiteral(key)) &&
        PROCESS_INERT_MEMBERS.has(key.text)
      );
    });
  }
  if (
    !ts.isVariableDeclaration(holder) ||
    holder.initializer !== top ||
    !ts.isIdentifier(holder.name)
  ) {
    return false;
  }
  if (seen.has(holder)) {
    return true;
  }
  if (seen.size >= SUMMARY_DEPTH) {
    // Fail closed past the bound.
    return false;
  }
  seen.add(holder);
  const name = holder.name;
  return identifiersSpelled(node.getSourceFile(), name.text).every(
    (reference) =>
      reference === name ||
      isNonReferenceName(reference, reference.parent) ||
      lexicalDeclarationOf(reference, reference.text) !== holder ||
      isPlainAssignmentTarget(skipOuterParentheses(reference)) ||
      processValueIsInert(reference, seen),
  );
}

const identifiersBySourceFile = new WeakMap<
  ts.SourceFile,
  ReadonlyMap<string, readonly ts.Identifier[]>
>();
let identifierIndexBuilds = 0;

/**
 * Every identifier of the file spelled `text`, from one index built per
 * file (task E-1's independent audit, finding 5: the alias censuses walked
 * the whole file once per alias, quadratic in aliases × file size).
 */
function identifiersSpelled(
  sourceFile: ts.SourceFile,
  text: string,
): readonly ts.Identifier[] {
  let index = identifiersBySourceFile.get(sourceFile);
  if (index === undefined) {
    identifierIndexBuilds += 1;
    const built = new Map<string, ts.Identifier[]>();
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const known = built.get(node.text);
        if (known === undefined) {
          built.set(node.text, [node]);
        } else {
          known.push(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    identifiersBySourceFile.set(sourceFile, built);
    index = built;
  }
  return index.get(text) ?? [];
}

/** How many per-file identifier indexes were built (an operation count for the structural performance test). */
export function exportAliasIdentifierIndexBuilds(): number {
  return identifierIndexBuilds;
}

/**
 * Whether `C.name = v` on a class this file defines creates or sets an own
 * data property: not for its own non-writable `name`, `length` and
 * `prototype`; not when it `extends` anything (an inherited static setter
 * may take the write); not when one of its static members is an accessor of
 * the name, or a computed key that may be.
 */
function classTakesWrite(node: ts.ClassLikeDeclaration, name: string): boolean {
  if (
    name === "name" ||
    name === "length" ||
    name === "prototype" ||
    (node.heritageClauses ?? []).some(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    )
  ) {
    return false;
  }
  return !node.members.some(
    (member) =>
      isStaticClassElement(member) &&
      member.name !== undefined &&
      (ts.isComputedPropertyName(member.name) ||
        (ts.isAccessor(member) &&
          (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
          member.name.text === name)),
  );
}

/** `Object.prototype` methods that read their `this` and write nothing. */
const PROTOTYPE_READER_METHODS: ReadonlySet<string> = new Set([
  "hasOwnProperty",
  "propertyIsEnumerable",
  "isPrototypeOf",
]);

/**
 * Whether `call` only reads the objects it is handed: an ambient `Object`
 * or `Reflect` reader (`Object.getOwnPropertyDescriptor(Map.prototype, …)`),
 * or `.call` / `.apply` of a builtin prototype's reader method, spelled
 * directly or through a binding initialized to it and never written
 * (qs's `var has = Object.prototype.hasOwnProperty; has.call(o, k)`).
 */
function isBuiltinReaderCall(call: ts.CallExpression): boolean {
  return (
    isSyntacticReaderCall(call) && !fileMayPatchBuiltins(call.getSourceFile())
  );
}

/** {@link isBuiltinReaderCall}'s spelling alone, trusting that the builtins it names are the builtins. */
function isSyntacticReaderCall(call: ts.CallExpression): boolean {
  const callee = unwrapParentheses(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) {
    return false;
  }
  const receiver = unwrapParentheses(callee.expression);
  if (isAmbientReference(receiver, "Object")) {
    return OBJECT_READERS.has(callee.name.text);
  }
  if (isAmbientReference(receiver, "Reflect")) {
    return REFLECT_READERS.has(callee.name.text);
  }
  if (callee.name.text !== "call" && callee.name.text !== "apply") {
    return false;
  }
  let method: ts.Expression = receiver;
  if (ts.isIdentifier(method)) {
    const declaration = lexicalDeclarationOf(method, method.text);
    if (
      declaration === undefined ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer === undefined ||
      isNameAssignedWithin(call.getSourceFile(), method.text)
    ) {
      return false;
    }
    method = unwrapParentheses(declaration.initializer);
  }
  if (
    !ts.isPropertyAccessExpression(method) ||
    !PROTOTYPE_READER_METHODS.has(method.name.text)
  ) {
    return false;
  }
  const owner = unwrapParentheses(method.expression);
  return (
    ts.isPropertyAccessExpression(owner) &&
    owner.name.text === "prototype" &&
    BUILTIN_CONSTRUCTORS.some((name) =>
      isAmbientReference(unwrapParentheses(owner.expression), name),
    )
  );
}

/**
 * The outermost expression `node`'s value can be the value of: through
 * parentheses, the operands of `&&`, `||` and `??`, a conditional's
 * branches and a comma's right.
 */
function climbValue(node: ts.Node): ts.Node {
  let current = skipOuterParentheses(node);
  for (;;) {
    const parent = current.parent as ts.Node | undefined;
    if (
      parent !== undefined &&
      ((ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          (parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
            parent.right === current))) ||
        (ts.isConditionalExpression(parent) && parent.condition !== current))
    ) {
      current = skipOuterParentheses(parent);
      continue;
    }
    return current;
  }
}

/**
 * Whether the object `base` denotes may be a load's result or reached from
 * one: `require(x)`, `require(x).a`, `require.call(null, x)`,
 * `require.bind(null)(x)`, `c ? require(x) : y`, or a binding any
 * declaration or assignment gives such a value (`const o = require(x)`,
 * `var s; s = require(x)`, `const { self } = require(x)`), through any chain
 * of members (`o.self`). A member write on it may write this file's own
 * exports object (E-1's re-audit, F1: a cycle through another module, an
 * `imports` alias or a self-name hands it back).
 */
function baseMayBeLoaded(base: ts.Expression): boolean {
  let root = unwrapParentheses(base);
  while (
    ts.isPropertyAccessExpression(root) ||
    ts.isElementAccessExpression(root)
  ) {
    root = unwrapParentheses(root.expression);
  }
  return ts.isIdentifier(root)
    ? bindingMayHoldLoad(root)
    : valueMayBeLoaded(root);
}

/** Whether `expression`'s value may be a load's result or a member of one. */
function valueMayBeLoaded(
  expression: ts.Expression,
  seen: Set<ts.Node> = new Set(),
): boolean {
  const value = unwrapParentheses(expression);
  if (
    ts.isPropertyAccessExpression(value) ||
    ts.isElementAccessExpression(value)
  ) {
    return valueMayBeLoaded(value.expression, seen);
  }
  if (ts.isConditionalExpression(value)) {
    return (
      valueMayBeLoaded(value.whenTrue, seen) ||
      valueMayBeLoaded(value.whenFalse, seen)
    );
  }
  if (ts.isBinaryExpression(value)) {
    switch (value.operatorToken.kind) {
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.QuestionQuestionToken:
        return (
          valueMayBeLoaded(value.left, seen) ||
          valueMayBeLoaded(value.right, seen)
        );
      case ts.SyntaxKind.CommaToken:
      case ts.SyntaxKind.EqualsToken:
        return valueMayBeLoaded(value.right, seen);
      default:
        return false;
    }
  }
  if (ts.isCallExpression(value)) {
    if (isRequireResult(value)) {
      return true;
    }
    // `require.call(…)`, `require.apply(…)`, `require.bind(…)(…)`.
    let callee = unwrapParentheses(value.expression);
    while (
      ts.isPropertyAccessExpression(callee) ||
      ts.isElementAccessExpression(callee) ||
      ts.isCallExpression(callee)
    ) {
      callee = unwrapParentheses(callee.expression);
    }
    return isLoaderCallee(callee);
  }
  if (ts.isIdentifier(value)) {
    return bindingMayHoldLoad(value, seen);
  }
  return false;
}

/** Whether a declaration or an assignment of `binding` gives it a value {@link valueMayBeLoaded}. */
function bindingMayHoldLoad(
  binding: ts.Identifier,
  seen: Set<ts.Node> = new Set(),
): boolean {
  const declaration = lexicalDeclarationOf(binding, binding.text);
  if (declaration === undefined || seen.has(declaration)) {
    return false;
  }
  const known = loadHoldingByDeclaration.get(declaration);
  if (known !== undefined) {
    return known;
  }
  if (seen.size >= SUMMARY_DEPTH) {
    // Fail closed past the bound: the binding may hold a load's result.
    return true;
  }
  const outermost = seen.size === 0;
  seen.add(declaration);
  aliasSummaryWalks += 1;
  const holds = bindingSourcesMayBeLoaded(binding, declaration, seen);
  // A `false` below the outermost call may be a cycle's cut, not an answer.
  if (holds || outermost) {
    loadHoldingByDeclaration.set(declaration, holds);
  }
  return holds;
}

/** {@link bindingMayHoldLoad}'s question for one declaration: its initializer and every assignment. */
function bindingSourcesMayBeLoaded(
  binding: ts.Identifier,
  declaration: ts.Node,
  seen: Set<ts.Node>,
): boolean {
  let holder: ts.Node = declaration;
  // `const { self } = require(x)`, `const [s] = …`: the pattern's source.
  while (
    ts.isBindingElement(holder) ||
    ts.isObjectBindingPattern(holder) ||
    ts.isArrayBindingPattern(holder)
  ) {
    holder = holder.parent;
  }
  if (
    ts.isVariableDeclaration(holder) &&
    holder.initializer !== undefined &&
    valueMayBeLoaded(holder.initializer, seen)
  ) {
    return true;
  }
  return identifiersSpelled(binding.getSourceFile(), binding.text).some(
    (reference) => {
      const outer = skipOuterParentheses(reference);
      const parent = outer.parent as ts.Node;
      return (
        ts.isBinaryExpression(parent) &&
        parent.left === outer &&
        isAssignmentOperatorToken(parent.operatorToken.kind) &&
        lexicalDeclarationOf(reference, reference.text) === declaration &&
        valueMayBeLoaded(parent.right, seen)
      );
    },
  );
}

/**
 * Whether a loader call ({@link isRequireResult}) may load the file it is
 * written in, and so return this module's own exports object: a specifier
 * that is not a literal; a relative or absolute one that resolves to this
 * file (with or without an extension) or to one of its ancestor
 * directories (an `index`, or a `package.json` `main`); the package's own
 * name or a subpath of it, for a file under `node_modules/<name>/`. A
 * `require.main.require(…)` or `module.constructor._load(…)` resolves from
 * another module, so any relative or absolute specifier may be this file.
 *
 * It decides only where a self-load's result is CENSUSED as an alias of the
 * exports object. It is no proof that a load returns another object: a
 * cycle through another module (`module.exports = require("./index")`), a
 * `package.json` `imports` entry (`#self`), an installed name that differs
 * from the directory, or `module.paths` can all hand this file's exports
 * object back. A member write through ANY load's result is therefore a
 * write of its name ({@link baseMayBeLoaded}; E-1's re-audit, F1); only the
 * other flows of a load this does not accept are not censused (an accepted
 * bound: its object is another module's, task E-4).
 */
function mayLoadThisFile(call: ts.CallExpression): boolean {
  const [first] = call.arguments;
  if (first === undefined || ts.isSpreadElement(first)) {
    return true;
  }
  const argument = unwrapParentheses(first);
  if (!ts.isStringLiteralLike(argument)) {
    return true;
  }
  const specifier = argument.text;
  const file = call.getSourceFile().fileName.replace(/\\/g, "/");
  if (!file.startsWith("/")) {
    // Not a POSIX absolute path: no resolution here can rule it out.
    return true;
  }
  const callee = unwrapParentheses(call.expression);
  const elsewhere =
    ts.isPropertyAccessExpression(callee) &&
    (callee.name.text === "_load" ||
      (ts.isPropertyAccessExpression(unwrapParentheses(callee.expression)) &&
        (unwrapParentheses(callee.expression) as ts.PropertyAccessExpression)
          .name.text === "main"));
  const isPath =
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/");
  if (isPath) {
    if (elsewhere) {
      return true;
    }
    const directory = file.slice(0, file.lastIndexOf("/") + 1);
    const resolved = posixResolve(directory, specifier);
    return (
      resolved === file ||
      file.startsWith(`${resolved}/`) ||
      [
        ".js",
        ".cjs",
        ".mjs",
        ".ts",
        ".cts",
        ".mts",
        ".jsx",
        ".tsx",
        ".node",
      ].some((extension) => `${resolved}${extension}` === file)
    );
  }
  const owner = file.match(/.*\/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  return (
    owner !== null &&
    (specifier === owner[1] || specifier.startsWith(`${owner[1]}/`))
  );
}

/** `path.posix.resolve(directory, specifier)` with no filesystem access, `directory` ending in `/`. */
function posixResolve(directory: string, specifier: string): string {
  const parts = (
    specifier.startsWith("/") ? specifier : `${directory}${specifier}`
  ).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
    } else {
      out.push(part);
    }
  }
  return `/${out.join("/")}`;
}

/**
 * The members of a `module` object that reach no module object: its own
 * strings and flags, and `require` (each call of it is a loader call the
 * census follows).
 */
const INERT_MODULE_MEMBERS: ReadonlySet<string> = new Set([
  "id",
  "filename",
  "path",
  "loaded",
  "paths",
  "isPreloading",
  "require",
]);

/** Ambient names whose members a file can patch for every module: the global object and the builtins the reader allow-lists trust. */
const PATCHABLE_GLOBALS: readonly string[] = [
  "globalThis",
  "global",
  "self",
  "window",
  "Reflect",
];

const builtinPatchingBySourceFile = new WeakMap<ts.SourceFile, boolean>();

/**
 * Whether this file may replace a builtin the reader allow-lists trust
 * (`Object.keys`, `Reflect.get`, `Object.prototype.hasOwnProperty`,
 * `Object[Symbol.hasInstance]`; E-1's re-audit, F2): a write through an
 * ambient builtin or global object (`Object.keys = f`,
 * `globalThis.Object = o`, `Object.prototype.m = f`), or one of them handed
 * to code or aliased (`Object.defineProperty(Object, …)`, `const O =
 * Object`). Calling one (`Object.keys(o)`, `Object(x)`), testing one,
 * `instanceof` one, and aliasing a builtin's member that is not an object
 * of builtins (`var has = Object.prototype.hasOwnProperty`) do not. Then no
 * call of a builtin is taken for a reader.
 */
function fileMayPatchBuiltins(sourceFile: ts.SourceFile): boolean {
  const known = builtinPatchingBySourceFile.get(sourceFile);
  if (known !== undefined) {
    return known;
  }
  const names = [...BUILTIN_CONSTRUCTORS, ...PATCHABLE_GLOBALS];
  const patches = names.some((name) =>
    identifiersSpelled(sourceFile, name).some((reference) => {
      if (!isAmbientReference(reference, name)) {
        return false;
      }
      // The member chain the name heads (`Object.prototype.m`), and whether
      // its value is still an object of builtins (the global object, a
      // builtin, a builtin's `prototype`) rather than one of their methods.
      let top: ts.Node = skipOuterParentheses(reference);
      let objectValued = true;
      for (;;) {
        const parent = top.parent as ts.Node;
        if (
          !(
            ts.isPropertyAccessExpression(parent) ||
            ts.isElementAccessExpression(parent)
          ) ||
          parent.expression !== top
        ) {
          break;
        }
        const member = ts.isPropertyAccessExpression(parent)
          ? parent.name.text
          : exactCommonJsExportPropertyName(
              unwrapParentheses(parent.argumentExpression),
            );
        objectValued =
          objectValued &&
          (member === undefined ||
            member === "prototype" ||
            names.includes(member));
        top = skipOuterParentheses(parent);
      }
      const parent = top.parent as ts.Node;
      // `-Number.MAX_VALUE`, `!globalThis.window`: an operator that only
      // reads (the shared write test counts every prefix operand).
      const readOnlyUnary =
        ts.isPrefixUnaryExpression(parent) &&
        parent.operator !== ts.SyntaxKind.PlusPlusToken &&
        parent.operator !== ts.SyntaxKind.MinusMinusToken;
      if (!readOnlyUnary && isWriteTargetPosition(top)) {
        return true;
      }
      if (
        !objectValued ||
        isInertUse(top) ||
        ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
          parent.expression === top) ||
        (ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
          parent.right === top)
      ) {
        return false;
      }
      // `class E extends Error {}`: the class inherits, the builtin is not
      // changed.
      if (
        ts.isExpressionWithTypeArguments(parent) &&
        ts.isHeritageClause(parent.parent)
      ) {
        return false;
      }
      if (readOnlyUnary) {
        return false;
      }
      // `const F = Function; new F("")`, `var hasMap = typeof Map ===
      // "function" && Map.prototype` (only tested), `U = max ? f(max) :
      // Array`: an alias only tested, called or constructed.
      const value = climbValue(top);
      const holder = value.parent as ts.Node;
      if (
        ts.isVariableDeclaration(holder) &&
        holder.initializer === value &&
        ts.isIdentifier(holder.name)
      ) {
        const alias = holder.name;
        return !identifiersSpelled(sourceFile, alias.text).every(
          (use) =>
            use === alias ||
            isNonReferenceName(use, use.parent) ||
            lexicalDeclarationOf(use, use.text) !== holder ||
            isInertUse(use) ||
            ((ts.isCallExpression(use.parent) ||
              ts.isNewExpression(use.parent)) &&
              use.parent.expression === use),
        );
      }
      // `const { defineProperty, keys } = Object`: its methods, not an
      // object of builtins (no rest, no `prototype`, no builtin's name).
      if (
        ts.isVariableDeclaration(holder) &&
        holder.initializer === value &&
        ts.isObjectBindingPattern(holder.name) &&
        holder.name.elements.every((element) => {
          const key =
            element.propertyName ??
            (ts.isIdentifier(element.name) ? element.name : undefined);
          return (
            element.dotDotDotToken === undefined &&
            key !== undefined &&
            (ts.isIdentifier(key) || ts.isStringLiteral(key)) &&
            key.text !== "prototype" &&
            !names.includes(key.text)
          );
        })
      ) {
        return false;
      }
      // Handed to an `Object` or `Reflect` reader, which only reads it.
      return !(
        ts.isCallExpression(parent) &&
        parent.arguments.some((argument) => argument === top) &&
        isSyntacticReaderCall(parent)
      );
    }),
  );
  builtinPatchingBySourceFile.set(sourceFile, patches);
  return patches;
}

/** Ambient constructors whose `Symbol.hasInstance` is the builtin one. */
const BUILTIN_CONSTRUCTORS: readonly string[] = [
  "Object",
  "Function",
  "Array",
  "Error",
  "TypeError",
  "RangeError",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "String",
  "Number",
  "Boolean",
  "Symbol",
];

/** `null`, `undefined` (the ambient name) or `void …`: a loose comparison with it coerces nothing. */
function isNullish(expression: ts.Expression): boolean {
  const value = unwrapParentheses(expression);
  return (
    value.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(value) ||
    isAmbientReference(value, "undefined")
  );
}

/**
 * Whether the value of `node` (an object reference) is only tested, never
 * handed to code: `typeof x`, `!x`, `void x`, a strict comparison, a loose
 * one against `null` or `undefined`, `k in x`, `C instanceof …` with the
 * object on the right, `x instanceof B` for an ambient builtin constructor
 * `B`, a condition (`if`, a loop's, a conditional's test), the discarded
 * left of a comma, an expression statement, and the LEFT operand of `&&`
 * (ToBoolean: an object is truthy, so `x && y` yields `y`; a falsy `this`
 * is no export object). A logical expression's other operands are its
 * value, which is inert only when the whole expression is.
 *
 * NOT inert, because real Node runs code with the object (E-1's
 * independent audit, finding 3): a loose comparison against anything else
 * and a template literal (ToPrimitive: `valueOf`, `toString`,
 * `Symbol.toPrimitive`, inherited or patched), and `x instanceof C` for a
 * `C` this file defines (`C[Symbol.hasInstance](x)`). A builtin's own
 * `Symbol.hasInstance` or prototype methods are changed only by the
 * prototype tampering the census refuses ({@link isPrototypeTampering}).
 */
function isInertUse(node: ts.Node): boolean {
  const outer = skipOuterParentheses(node);
  const parent = outer.parent as ts.Node | undefined;
  if (parent === undefined) {
    return false;
  }
  if (
    ts.isTypeOfExpression(parent) ||
    ts.isVoidExpression(parent) ||
    ts.isExpressionStatement(parent) ||
    (ts.isPrefixUnaryExpression(parent) &&
      parent.operator === ts.SyntaxKind.ExclamationToken)
  ) {
    return true;
  }
  if (
    ((ts.isIfStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent)) &&
      parent.expression === outer) ||
    (ts.isForStatement(parent) && parent.condition === outer) ||
    (ts.isConditionalExpression(parent) && parent.condition === outer)
  ) {
    return true;
  }
  if (ts.isConditionalExpression(parent)) {
    // A branch is the conditional's value.
    return isInertUse(parent);
  }
  if (!ts.isBinaryExpression(parent)) {
    return false;
  }
  switch (parent.operatorToken.kind) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      return true;
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      return isNullish(parent.left === outer ? parent.right : parent.left);
    case ts.SyntaxKind.InstanceOfKeyword:
      // On the right, the object runs its own `Symbol.hasInstance` (or the
      // builtin one) with itself as `this`: its own methods are censused.
      // A builtin's, unless the file may replace it (E-1's re-audit, F4:
      // `Object.defineProperty(Object, Symbol.hasInstance, …)`).
      return (
        parent.right === outer ||
        (BUILTIN_CONSTRUCTORS.some((name) =>
          isAmbientReference(unwrapParentheses(parent.right), name),
        ) &&
          !fileMayPatchBuiltins(parent.getSourceFile()))
      );
    case ts.SyntaxKind.InKeyword:
      return parent.right === outer;
    case ts.SyntaxKind.CommaToken:
      return parent.left === outer || isInertUse(parent);
    case ts.SyntaxKind.AmpersandAmpersandToken:
      return parent.left === outer || isInertUse(parent);
    case ts.SyntaxKind.BarBarToken:
    case ts.SyntaxKind.QuestionQuestionToken:
      return isInertUse(parent);
    default:
      return false;
  }
}

/**
 * The names a property key can denote: the one exact name, none for a
 * symbol (`Symbol.toStringTag`, `Symbol("x")`, `Symbol.for("x")` with the
 * ambient `Symbol`: no export is named by a symbol), or `"all"`.
 */
function keyNames(key: ts.Expression): ReadonlySet<string> | "all" {
  const expression = unwrapParentheses(key);
  const exact = exactCommonJsExportPropertyName(expression);
  if (exact !== undefined) {
    return new Set([exact]);
  }
  const symbolBase = ts.isPropertyAccessExpression(expression)
    ? expression.expression
    : ts.isCallExpression(expression)
      ? ts.isPropertyAccessExpression(expression.expression) &&
        expression.expression.name.text === "for"
        ? expression.expression.expression
        : expression.expression
      : undefined;
  return symbolBase !== undefined &&
    isAmbientReference(unwrapParentheses(symbolBase), "Symbol")
    ? NO_NAMES
    : "all";
}

/** {@link keyNames} for a member access. */
function accessNames(
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): ReadonlySet<string> | "all" {
  return ts.isPropertyAccessExpression(access)
    ? new Set([access.name.text])
    : keyNames(access.argumentExpression);
}

/** Whether `node` is a plain `=` assignment's left-hand side. */
function isPlainAssignmentTarget(node: ts.Node): boolean {
  const parent = node.parent as ts.Node | undefined;
  return (
    parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === node
  );
}

/** The outermost parenthesized form of `node` (what its parent sees). */
function skipOuterParentheses(node: ts.Node): ts.Node {
  let current = node;
  while (
    current.parent !== undefined &&
    ts.isParenthesizedExpression(current.parent)
  ) {
    current = current.parent;
  }
  return current;
}

/**
 * {@link ExportWriteKind} for one node, or `undefined` when the node is no
 * censused reference. `object` is the reference denoting an export object
 * (`exports`, `module.exports`, module-scope `this`); its use decides.
 */
function classifyObjectUse(
  object: ts.Node,
  base: ExportPropertyWrite["base"],
  deferred: boolean,
  statementIndex: number,
): ExportReference {
  const outer = skipOuterParentheses(object);
  const parent = outer.parent as ts.Node;
  const make: MakeReference = (kind, names = NO_NAMES, values, assignment) => ({
    kind,
    names,
    values,
    assignment,
    base,
    deferred,
    statementIndex,
  });
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === outer
  ) {
    const access = skipOuterParentheses(parent);
    const names = accessNames(parent);
    if (isPlainAssignmentTarget(access)) {
      const assignment = access.parent as ts.BinaryExpression;
      return make(
        "property-write",
        names,
        [[assignment.right, "property"]],
        assignment,
      );
    }
    if (isWriteTargetPosition(access)) {
      const writer = access.parent as ts.Node;
      // The value a compound write stores is its right-hand side's (or a
      // number); a destructuring or `for-of` target's is unreadable here,
      // so it stands in as a member read (any function).
      const values: readonly MethodSource[] =
        ts.isBinaryExpression(writer) && writer.left === access
          ? [[writer.right, "property"]]
          : ts.isPrefixUnaryExpression(writer) ||
              ts.isPostfixUnaryExpression(writer) ||
              ts.isDeleteExpression(writer)
            ? []
            : [[access as ts.Expression, "property"]];
      return make("property-other-write", names, values);
    }
    // A method called on the object runs with it as `this`: one of this
    // file's own functions is censused here; any other holds it.
    // A method this file never writes was put there by another module,
    // which already holds the object: whatever it writes is a write by
    // another module (E-4's), and calling it hands over nothing new.
    return callsForeignExportMethod(access) &&
      !isOwnLiteralMethodCall(access) &&
      !isMethodWrittenElsewhere(access)
      ? make("unenumerable")
      : make("read");
  }
  if (isInertUse(outer)) {
    return make("read");
  }
  if (ts.isCallExpression(parent) && parent.arguments[0] === outer) {
    return classifyHelperCall(parent, make);
  }
  const sink = valueSink(outer);
  return sink === undefined
    ? make("unenumerable")
    : { ...make("object-alias"), alias: sink };
}

/** `Object.x(E, …)`, `Reflect.x(E, …)` and `….hasOwnProperty.call(E, …)` with an export object `E` first. */
function classifyHelperCall(
  call: ts.CallExpression,
  make: MakeReference,
): ExportReference {
  const callee = unwrapParentheses(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) {
    return make("unenumerable");
  }
  const method = callee.name.text;
  const receiver = unwrapParentheses(callee.expression);
  // A builtin reader the file cannot have replaced (`Object.keys(E)`,
  // `Object.prototype.hasOwnProperty.call(E, k)`); not any receiver's
  // `hasOwnProperty`, nor a reader the file patches (E-1's re-audit, F2).
  if (isBuiltinReaderCall(call)) {
    return make("read");
  }
  const isObject = isAmbientReference(receiver, "Object");
  const isReflect = isAmbientReference(receiver, "Reflect");
  if (!isObject && !isReflect) {
    return make("unenumerable");
  }
  if (fileMayPatchBuiltins(call.getSourceFile())) {
    return make("unenumerable");
  }
  const [, second, third, ...rest] = call.arguments;
  if (
    method === "defineProperty" ||
    (isReflect && (method === "set" || method === "deleteProperty"))
  ) {
    const values: MethodSource[] =
      third === undefined
        ? []
        : [[third, method === "set" ? "property" : "descriptor"]];
    return make(
      "define-property",
      second === undefined ? "all" : keyNames(second),
      values,
    );
  }
  if (isObject && (method === "defineProperties" || method === "assign")) {
    const sources = (
      method === "assign" ? [second, third, ...rest] : [second]
    ).filter((source): source is ts.Expression => source !== undefined);
    const values = sources.map((source): MethodSource => [
      source,
      method === "assign" ? "container" : "descriptors",
    ]);
    const names = new Set<string>();
    for (const source of sources) {
      const literal = unwrapParentheses(source);
      const keys = ts.isObjectLiteralExpression(literal)
        ? objectLiteralKeyNames(literal)
        : "all";
      if (keys === "all") {
        return make("define-property", "all", values);
      }
      for (const key of keys) names.add(key);
    }
    return make("define-property", names, values);
  }
  // `Object.freeze`, `seal`, `preventExtensions`, `setPrototypeOf`, … :
  // a later write may fail, or the object's names change.
  return make("unenumerable");
}

/** Every name an object literal defines, or `"all"` when a spread or a key nothing names may define any. */
function objectLiteralKeyNames(
  literal: ts.ObjectLiteralExpression,
): ReadonlySet<string> | "all" {
  const names = new Set<string>();
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      return "all";
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      names.add(property.name.text);
      continue;
    }
    const key = property.name;
    const name = ts.isComputedPropertyName(key)
      ? resolveComputedPropertyNameLiteral(literal.getSourceFile(), key)
      : ts.isIdentifier(key) || ts.isPrivateIdentifier(key)
        ? key.text
        : exactCommonJsExportPropertyName(key as ts.Expression);
    if (name === undefined) {
      return "all";
    }
    names.add(name);
  }
  return names;
}

/** Whether `expression` is `require(…)` or `module.require(…)`, the ambient loader. */
function isRequireResult(expression: ts.Expression): boolean {
  const call = unwrapParentheses(expression);
  return (
    ts.isCallExpression(call) &&
    isLoaderCallee(unwrapParentheses(call.expression))
  );
}

/**
 * Whether `callee` is a CommonJS loader, whose call may return this very
 * module's exports object (a self-load): the ambient `require`,
 * `module.require`, `require.main.require`, `module.constructor._load`, or
 * a local bound once to the ambient `require` and never written
 * (`const r = require`, ADV2-051).
 */
function isLoaderCallee(callee: ts.Expression): boolean {
  if (isAmbientReference(callee, "require")) {
    return true;
  }
  if (ts.isIdentifier(callee)) {
    const declaration = lexicalDeclarationOf(callee, callee.text);
    return (
      declaration !== undefined &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      isAmbientReference(
        unwrapParentheses(declaration.initializer),
        "require",
      ) &&
      !isNameAssignedWithin(callee.getSourceFile(), callee.text)
    );
  }
  if (!ts.isPropertyAccessExpression(callee)) {
    return false;
  }
  const base = unwrapParentheses(callee.expression);
  return (
    (callee.name.text === "require" &&
      (isAmbientReference(base, "module") ||
        (ts.isPropertyAccessExpression(base) &&
          base.name.text === "main" &&
          isAmbientReference(
            unwrapParentheses(base.expression),
            "require",
          )))) ||
    (callee.name.text === "_load" &&
      ts.isPropertyAccessExpression(base) &&
      base.name.text === "constructor" &&
      isAmbientReference(unwrapParentheses(base.expression), "module"))
  );
}

/**
 * Whether every use of a local bound to `require` is a call of it (or
 * inert), so that {@link isLoaderCallee} accounts for all of them.
 */
function loaderAliasIsOnlyCalled(binding: ts.Identifier): boolean {
  const sourceFile = binding.getSourceFile();
  const declaration = lexicalDeclarationOf(binding, binding.text);
  if (
    declaration === undefined ||
    isNameAssignedWithin(sourceFile, binding.text)
  ) {
    return false;
  }
  let only = true;
  const visit = (node: ts.Node): void => {
    if (!only) {
      return;
    }
    if (
      ts.isIdentifier(node) &&
      node.text === binding.text &&
      !isNonReferenceName(node, node.parent) &&
      !isDeclarationName(node, node.parent) &&
      lexicalDeclarationOf(node, node.text) === declaration
    ) {
      const outer = skipOuterParentheses(node);
      const parent = outer.parent as ts.Node;
      only =
        (ts.isCallExpression(parent) && parent.expression === outer) ||
        isInertUse(outer);
      return;
    }
  };
  // Only identifiers spelled like the binding are visited (E-1's audit, finding 5).
  for (const reference of identifiersSpelled(sourceFile, binding.text)) {
    visit(reference);
  }
  return only;
}

/** Whether `access` (`require.main`, `module.constructor`) is the base of a loader call (`require.main.require(…)`). */
function isLoaderCallBase(access: ts.Node): boolean {
  const member = access.parent as ts.Node | undefined;
  const call = member?.parent as ts.Node | undefined;
  return (
    member !== undefined &&
    ts.isPropertyAccessExpression(member) &&
    member.expression === access &&
    call !== undefined &&
    ts.isCallExpression(call) &&
    call.expression === member &&
    isLoaderCallee(member)
  );
}

function classifyExportReference(
  node: ts.Node,
  deferred: boolean,
  thisContext: ThisContext,
  owner: ts.Node | undefined,
  statementIndex: number,
): ExportReference | undefined {
  const make: MakeReference = (kind, names = NO_NAMES, values, assignment) => ({
    kind,
    names,
    values,
    assignment,
    deferred,
    statementIndex,
  });

  if (ts.isWithStatement(node)) {
    // Inside `with (o) { … }` an ambient name may be a property of `o`, so
    // `exports.x = v` there may write `o.exports` and `module.exports = v`
    // may not write the module at all. Its object expression is censused
    // like any other reference.
    return withBodyReachesExportNames(node.statement)
      ? make("unenumerable")
      : undefined;
  }
  if (ts.isExportAssignment(node) && node.isExportEquals) {
    // TypeScript's `export = X`: a whole-module write.
    return make("whole-module-write", NO_NAMES, [[node.expression, "whole"]]);
  }
  if (node.kind === ts.SyntaxKind.ThisKeyword) {
    if (thisContext === "module") {
      // Module-scope `this` is the ORIGINAL exports object.
      return classifyObjectUse(node, "this", deferred, statementIndex);
    }
    // In a function, `this` is the exports object when the function is
    // called as one of its methods (a static member's, when its class is
    // the whole-module value): any write through it may set a name. A
    // fresh instance's writes run while it is constructed, before any write
    // the walk orders after it; handing it on matters only when the
    // whole-module value may be such an instance ({@link exportMethodOwners}).
    const outer = skipOuterParentheses(node);
    const parent = outer.parent as ts.Node;
    if (
      (ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent)) &&
      parent.expression === outer
    ) {
      if (!isWriteTargetPosition(skipOuterParentheses(parent))) {
        return make("read");
      }
      return thisContext === "fresh"
        ? undefined
        : {
            ...make("method-this-write", accessNames(parent)),
            owner,
            thisContext,
          };
    }
    if (isInertUse(outer)) {
      return make("read");
    }
    return { ...make("method-this-hand-off"), owner, thisContext };
  }

  if (isPrototypeTampering(node)) {
    return make("unenumerable");
  }
  // A load that may load this very file returns its exports object (a
  // self-load): the result is an alias of it, wherever it flows (E-1's
  // independent audit, finding 1). A member write on it withdraws the
  // name; a binding it flows into is censused like any alias; anything
  // else hands it on.
  if (
    ts.isCallExpression(node) &&
    isRequireResult(node) &&
    mayLoadThisFile(node)
  ) {
    const top = climbValue(node);
    const parent = top.parent as ts.Node;
    if (
      (ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent)) &&
      parent.expression === top
    ) {
      const access = skipOuterParentheses(parent);
      if (!isWriteTargetPosition(access)) {
        return make("read");
      }
      const writer = access.parent as ts.Node;
      return make(
        "require-result-member-write",
        accessNames(parent),
        ts.isBinaryExpression(writer) && writer.left === access
          ? [[writer.right, "property"]]
          : [[access as ts.Expression, "property"]],
      );
    }
    if (isInertUse(top)) {
      return make("read");
    }
    const sink = valueSink(top);
    return sink === undefined
      ? make("unenumerable")
      : { ...make("object-alias"), alias: sink };
  }
  // A member write on any load's result, directly, through a binding or
  // through a chain of members (`require("./other").run = v`, `o.run = v`,
  // `o.self.run = v`): the loaded module may hand this file's exports object
  // back, so it withdraws the name (E-1's re-audit, F1).
  if (
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)) &&
    isWriteTargetPosition(skipOuterParentheses(node)) &&
    baseMayBeLoaded(node.expression)
  ) {
    return make("require-result-member-write", accessNames(node));
  }

  if (!ts.isIdentifier(node)) {
    return undefined;
  }
  switch (node.text) {
    case "exports": {
      if (!isAmbientReference(node, "exports")) {
        return undefined;
      }
      const outer = skipOuterParentheses(node);
      if (isPlainAssignmentTarget(outer)) {
        return make(
          "exports-rebinding",
          NO_NAMES,
          undefined,
          outer.parent as ts.BinaryExpression,
        );
      }
      if (isWriteTargetPosition(outer)) {
        return make("unenumerable");
      }
      // `module.exports = exports`: the value is tracked by the identity walk.
      const parent = outer.parent as ts.Node;
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.right === outer &&
        isModuleExportsAssignmentTarget(unwrapParentheses(parent.left))
      ) {
        return make("read");
      }
      return classifyObjectUse(node, "exports", deferred, statementIndex);
    }
    case "module": {
      if (!isAmbientReference(node, "module")) {
        return undefined;
      }
      const outer = skipOuterParentheses(node);
      const parent = outer.parent as ts.Node;
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === outer
      ) {
        const member = parent.name.text;
        if (member !== "exports") {
          // Only the members that reach no module object are reads
          // (`module.id`, `module.filename`, a `module.require(…)` load,
          // censused as a loader call); `module.parent.children` and
          // `module.children` can hold this module itself, and
          // `module.constructor` reaches the loader's cache (E-1's
          // independent audit, finding 2).
          // A member only tested (`!module.nodeType`) hands nothing on.
          return INERT_MODULE_MEMBERS.has(member) ||
            isInertUse(skipOuterParentheses(parent)) ||
            (member === "constructor" && isLoaderCallBase(parent))
            ? make("read")
            : make("unenumerable");
        }
        const access = skipOuterParentheses(parent);
        if (isPlainAssignmentTarget(access)) {
          return make("whole-module-write", NO_NAMES, [
            [(access.parent as ts.BinaryExpression).right, "whole"],
          ]);
        }
        if (isWriteTargetPosition(access)) {
          return make("unenumerable");
        }
        // `exports = module.exports`: tracked by the identity walk.
        const accessParent = access.parent as ts.Node;
        if (
          ts.isBinaryExpression(accessParent) &&
          accessParent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          accessParent.right === access &&
          isAmbientReference(unwrapParentheses(accessParent.left), "exports")
        ) {
          return make("read");
        }
        return classifyObjectUse(
          parent,
          "module.exports",
          deferred,
          statementIndex,
        );
      }
      if (isInertUse(outer)) {
        return make("read");
      }
      const moduleSink = valueSink(outer);
      return moduleSink === undefined
        ? make("unenumerable")
        : { ...make("module-alias"), alias: moduleSink };
    }
    case "require": {
      if (!isAmbientReference(node, "require")) {
        return undefined;
      }
      const outer = skipOuterParentheses(node);
      const parent = outer.parent as ts.Node;
      if (ts.isCallExpression(parent) && parent.expression === outer) {
        return make("read");
      }
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === outer
      ) {
        // `require.cache` holds this module; `require.main` is this module
        // when it is the entry, except in a comparison.
        if (parent.name.text === "cache") {
          return make("unenumerable");
        }
        if (parent.name.text === "main") {
          // `require.main.require(…)` is a loader call (its result is
          // censused like `require(…)`'s).
          return isInertUse(skipOuterParentheses(parent)) ||
            isLoaderCallBase(parent)
            ? make("read")
            : make("unenumerable");
        }
        return make("read");
      }
      if (isInertUse(outer)) {
        return make("read");
      }
      // `const r = require`: a loader alias, whose calls are censused like
      // `require(…)`'s, as long as it is only ever called.
      const loaderSink = valueSink(outer);
      return loaderSink !== undefined &&
        ts.isVariableDeclaration(loaderSink.parent) &&
        loaderAliasIsOnlyCalled(loaderSink)
        ? make("read")
        : make("unenumerable");
    }
    case "arguments":
      return thisContext === "module" && isAmbientReference(node, "arguments")
        ? make("unenumerable")
        : undefined;
    case "eval":
      // Only a DIRECT `eval(…)` sees the module's scope; an indirect one runs
      // in the global scope, where `module` and `exports` are not bound.
      return isAmbientReference(node, "eval") &&
        ts.isCallExpression(skipOuterParentheses(node).parent) &&
        (skipOuterParentheses(node).parent as ts.CallExpression).expression ===
          skipOuterParentheses(node)
        ? make("unenumerable")
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Collapses this file's CommonJS named bindings to one per name: the one
 * effective write's binding, or one withdrawn binding (task E-1; ADR 0009
 * § 1 clauses 1, 2 and 5).
 *
 * The effective write of a name is the LAST module-time write of it to the
 * FINAL export object -- the object `module.exports` holds once module
 * evaluation completes. Which object each write reaches is decided by an
 * identity walk over the top-level statements: `module.exports = X`
 * installs a new object, `exports = module.exports = X` points `exports` at
 * it too, `exports = module.exports` points `exports` back at the current
 * one, and any other rebinding of `exports` points it at an object that is
 * no export. A write to a STALE object (`exports.x = v` after a
 * `module.exports = { … }` that `exports` does not follow) is no write of
 * the final export and is ignored; a write whose object the walk cannot
 * place (inside a statement that also rebinds one of the two names, or
 * after a conditional rebinding) withdraws the name.
 *
 * A name is also withdrawn when any write the walk cannot order may set it
 * ({@link ExportWriteSet.withdrawn}: a deferred write, a compound or
 * destructuring write, a method's `this` write, `Object.defineProperty`, a
 * member write on a `require(…)` result), and every name -- the
 * whole-module export too -- when the census meets a reference no kind
 * enumerates.
 *
 * The binding kept for the effective write is the one its own
 * provenance was built from: a literal's definition, or the property
 * binding of the name's last write in source order
 * ({@link commonJsPropertyExportRhs}). When the effective write is some
 * other write, the name is withdrawn rather than given a provenance its
 * binding does not carry.
 *
 * Applied only where the whole-module value is decided (no whole-module
 * write, or {@link selectAuthoritativeWholeModuleExport}'s one): an
 * undecided one is BL-064's (RWF-100) withdrawal in
 * {@link buildExportBindings}.
 */
function applyExportWriteSet(
  index: SourceIndex,
  results: ExportBinding[],
  authoritative: ModuleExportsAssignment | undefined,
  wholeModuleWrites: number,
  literalDefinitions: ReadonlySet<ExportBinding>,
): ExportBinding[] {
  if (!results.some((binding) => binding.syntax === "commonjs")) {
    return results;
  }
  const sourceFile = index.sourceFile;
  const set = exportWriteSet(sourceFile);
  const withdrawnBinding = (binding: ExportBinding): ExportBinding => ({
    kind: binding.kind,
    syntax: binding.syntax,
    exportedName: binding.exportedName,
    exportAttributionWithdrawn: true,
    location: binding.location,
  });
  if (set.unenumerable) {
    return results.map((binding) =>
      binding.syntax === "commonjs" && binding.kind !== "re-export"
        ? withdrawnBinding(binding)
        : binding,
    );
  }
  if (wholeModuleWrites > 0 && authoritative === undefined) {
    // BL-064's (RWF-100) path decides; the census still withdraws.
    return results.map((binding) =>
      binding.syntax === "commonjs" &&
      binding.kind === "named" &&
      binding.exportedName !== undefined &&
      set.withdrawn.has(binding.exportedName)
        ? withdrawnBinding(binding)
        : binding,
    );
  }

  // The identity walk. 0 is the original exports object; statement i's
  // whole-module write installs object i + 1; -1 is an object the walk
  // cannot place.
  const statements = sourceFile.statements;
  const wholeWritesByStatement = new Map<number, ts.Node[]>();
  for (const site of competingWriteSites(sourceFile).wholeModule) {
    if (site.deferred) continue;
    const known = wholeWritesByStatement.get(site.statementIndex);
    if (known === undefined) {
      wholeWritesByStatement.set(site.statementIndex, [site.node]);
    } else {
      known.push(site.node);
    }
  }
  const rebindingsByStatement = new Map<number, ts.BinaryExpression[]>();
  for (const rebinding of set.rebindings) {
    const at = topLevelStatementIndex(rebinding);
    if (at === undefined) continue;
    const known = rebindingsByStatement.get(at);
    if (known === undefined) {
      rebindingsByStatement.set(at, [rebinding]);
    } else {
      known.push(rebinding);
    }
  }
  const writesByStatement = new Map<number, ExportPropertyWrite[]>();
  const writesByName = new Map<string, ExportPropertyWrite[]>();
  for (const write of set.propertyWrites) {
    for (const [map, key] of [
      [writesByStatement, write.statementIndex],
      [writesByName, write.name],
    ] as const) {
      const byKey = map as Map<typeof key, ExportPropertyWrite[]>;
      const known = byKey.get(key);
      if (known === undefined) {
        byKey.set(key, [write]);
      } else {
        known.push(write);
      }
    }
  }

  let moduleExportsObject = 0;
  let exportsObject = 0;
  /** Each property write's object. */
  const objectOf = new Map<ExportPropertyWrite, number>();
  for (let i = 0; i < statements.length; i += 1) {
    const wholeWrites = wholeWritesByStatement.get(i) ?? [];
    const rebinds = rebindingsByStatement.get(i) ?? [];
    const changes = wholeWrites.length > 0 || rebinds.length > 0;
    for (const write of writesByStatement.get(i) ?? []) {
      objectOf.set(
        write,
        write.base === "this"
          ? 0
          : changes
            ? -1
            : write.base === "module.exports"
              ? moduleExportsObject
              : exportsObject,
      );
    }
    if (!changes) continue;
    const chain = assignmentChainOf(statements[i]!);
    const inChain = (node: ts.Node): boolean => chain.includes(node);
    if (
      !wholeWrites.every(inChain) ||
      !rebinds.every((rebinding) => inChain(rebinding))
    ) {
      // A rebinding inside a condition, a comma, a nested expression.
      if (wholeWrites.length > 0) moduleExportsObject = -1;
      if (rebinds.length > 0) exportsObject = -1;
      continue;
    }
    const lastLink = chain.at(-1)!;
    const innermost = unwrapParentheses(
      unwrapValue(
        ts.isExportAssignment(lastLink)
          ? lastLink.expression
          : (lastLink as ts.BinaryExpression).right,
      ),
    );
    if (wholeWrites.length > 0) {
      moduleExportsObject = isAmbientReference(innermost, "exports")
        ? exportsObject
        : i + 1;
    }
    if (rebinds.length > 0) {
      exportsObject =
        wholeWrites.length > 0
          ? moduleExportsObject
          : isModuleExportsAssignmentTarget(innermost)
            ? moduleExportsObject
            : -1;
    }
  }
  const finalObject = moduleExportsObject;

  /**
   * Whether `module.exports.name = v` on the final object creates or sets
   * an own data property (E-1's independent audit, finding 2's follow-up):
   * the final object is one this file makes as a plain object -- an object
   * literal with no accessor or `__proto__:` for the name, a function or a
   * class (whose own `name` and `length`, and a class's `prototype`, are
   * not writable). A call's or a construction's result, another module's
   * object or a binding to one may be frozen, a proxy, or have a setter.
   */
  const writesTakeOnFinalObject = (name: string): boolean => {
    if (authoritative === undefined) {
      return false;
    }
    let value = unwrapParentheses(unwrapValue(authoritative.rhs));
    if (ts.isIdentifier(value) && !isAmbientReference(value, "exports")) {
      const declaration = lexicalDeclarationOf(value, value.text);
      if (
        declaration === undefined ||
        isNameAssignedWithin(sourceFile, value.text)
      ) {
        return false;
      }
      if (ts.isFunctionDeclaration(declaration)) {
        return name !== "name" && name !== "length";
      }
      if (ts.isClassDeclaration(declaration)) {
        return classTakesWrite(declaration, name);
      }
      if (
        !ts.isVariableDeclaration(declaration) ||
        declaration.initializer === undefined
      ) {
        return false;
      }
      value = unwrapParentheses(declaration.initializer);
    }
    if (isAmbientReference(value, "exports")) {
      return true;
    }
    if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) {
      return name !== "name" && name !== "length";
    }
    if (ts.isClassExpression(value)) {
      return classTakesWrite(value, name);
    }
    if (!ts.isObjectLiteralExpression(value)) {
      return false;
    }
    return !value.properties.some(
      (property) =>
        ts.isSpreadAssignment(property) ||
        ((ts.isGetAccessorDeclaration(property) ||
          ts.isSetAccessorDeclaration(property)) &&
          (property.name === undefined ||
            !(
              ts.isIdentifier(property.name) ||
              ts.isStringLiteral(property.name)
            ) ||
            property.name.text === name)) ||
        (ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) ||
            ts.isStringLiteral(property.name)) &&
          property.name.text === "__proto__"),
    );
  };

  // The authoritative literal's own definitions: the final object's, since
  // that write installed it ({@link selectAuthoritativeWholeModuleExport}
  // keeps only the last whole-module write).
  const literalBindings = new Map<string, ExportBinding>();
  for (const binding of literalDefinitions) {
    if (binding.exportedName !== undefined) {
      literalBindings.set(binding.exportedName, binding);
    }
  }

  /** What each name's bindings collapse to: one binding, or none. */
  const decided = new Map<string, ExportBinding | undefined>();
  const decide = (name: string, bindings: ExportBinding[]): void => {
    const sample = bindings[0]!;
    if (set.withdrawn.has(name) || finalObject < 0) {
      decided.set(name, withdrawnBinding(sample));
      return;
    }
    const writes = writesByName.get(name) ?? [];
    if (writes.some((write) => objectOf.get(write) === -1)) {
      decided.set(name, withdrawnBinding(sample));
      return;
    }
    // An object id is the statement that installed it, so a write that
    // reaches the final object runs after the write that installed it.
    const onFinal = writes.filter(
      (write) => objectOf.get(write) === finalObject,
    );
    const literal = literalBindings.get(name);
    if (onFinal.length === 0) {
      // No write reaches the final object but the literal's own: the
      // others went to a stale object.
      decided.set(name, literal);
      return;
    }
    // A write on an object this file did not make as a plain one may not
    // take (a frozen object, a setter, a proxy, an inherited accessor).
    if (finalObject > 0 && !writesTakeOnFinalObject(name)) {
      decided.set(name, withdrawnBinding(sample));
      return;
    }
    const effective = onFinal.at(-1)!;
    const property = bindings.find(
      (binding) => !literalDefinitions.has(binding),
    );
    decided.set(
      name,
      property !== undefined &&
        effective.base !== "this" &&
        commonJsPropertyExportRhs(index, name) === effective.assignment.right
        ? property
        : withdrawnBinding(sample),
    );
  };

  const byName = new Map<string, ExportBinding[]>();
  for (const binding of results) {
    if (
      binding.syntax === "commonjs" &&
      binding.kind === "named" &&
      binding.exportedName !== undefined
    ) {
      const known = byName.get(binding.exportedName);
      if (known === undefined) {
        byName.set(binding.exportedName, [binding]);
      } else {
        known.push(binding);
      }
    }
  }
  for (const [name, bindings] of byName) {
    decide(name, bindings);
  }

  // E-2 (RWF-105): the names a forward of the final object must not
  // answer for -- every name the census withdraws, and every `=` write
  // that may reach the final object. See
  // {@link ExportBinding.forwardingShadowedNames}.
  const shadowed = new Set(set.withdrawn);
  for (const write of set.propertyWrites) {
    const object = objectOf.get(write);
    if (finalObject < 0 || object === finalObject || object === -1) {
      shadowed.add(write.name);
    }
  }

  const emitted = new Set<string>();
  const collapsed: ExportBinding[] = [];
  for (const binding of results) {
    if (
      binding.syntax === "commonjs" &&
      binding.kind === "default" &&
      binding.commonJsReExport !== undefined
    ) {
      collapsed.push({ ...binding, forwardingShadowedNames: shadowed });
      continue;
    }
    if (
      binding.syntax !== "commonjs" ||
      binding.kind !== "named" ||
      binding.exportedName === undefined
    ) {
      collapsed.push(binding);
      continue;
    }
    const name = binding.exportedName;
    if (emitted.has(name)) continue;
    emitted.add(name);
    const kept = decided.get(name);
    if (kept !== undefined) {
      collapsed.push(kept);
    }
  }
  return collapsed;
}

/** One module-scope binding: how it is declared, where, and how often. */
interface ModuleScopeBinding {
  readonly kind: "function" | "var" | "let" | "const" | "class" | "other";
  /** The top-level statement that declares it (the first one). */
  readonly statementIndex: number;
  readonly count: number;
}

const moduleScopeBindingsBySourceFile = new WeakMap<
  ts.SourceFile,
  ReadonlyMap<string, ModuleScopeBinding>
>();

/**
 * The bindings the module scope declares (BL-064): top-level function,
 * class and `let`/`const` declarations, `var` anywhere outside a function
 * body (hoisted), and anything else (an import, an enum, a namespace) as
 * `"other"`, which no read is proven safe for.
 */
function moduleScopeBindings(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, ModuleScopeBinding> {
  const cached = moduleScopeBindingsBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  const bindings = new Map<string, ModuleScopeBinding>();
  function add(
    name: string,
    kind: ModuleScopeBinding["kind"],
    statementIndex: number,
  ): void {
    const known = bindings.get(name);
    bindings.set(
      name,
      known === undefined
        ? { kind, statementIndex, count: 1 }
        : {
            kind: known.kind === kind ? kind : "other",
            statementIndex: known.statementIndex,
            count: known.count + 1,
          },
    );
  }
  function addBindingName(
    name: ts.BindingName,
    kind: ModuleScopeBinding["kind"],
    statementIndex: number,
  ): void {
    if (ts.isIdentifier(name)) {
      add(name.text, kind, statementIndex);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        addBindingName(element.name, kind, statementIndex);
      }
    }
  }
  function collectVars(node: ts.Node, statementIndex: number): void {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      // A function declaration in a block (Annex B): in sloppy mode it
      // also writes a function-scoped binding when the block runs, so no
      // read or call of the name is proven (BL-064's audit, finding 4).
      add(node.name.text, "other", statementIndex);
      return;
    }
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
      return;
    }
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.BlockScoped) === 0
    ) {
      for (const declaration of node.declarations) {
        addBindingName(declaration.name, "var", statementIndex);
      }
    }
    ts.forEachChild(node, (child) => collectVars(child, statementIndex));
  }
  sourceFile.statements.forEach((statement, statementIndex) => {
    if (hasDeclareModifier(statement)) {
      // No runtime binding at all: a read of it is a `ReferenceError`.
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          addBindingName(declaration.name, "other", statementIndex);
        }
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement)) &&
        statement.name !== undefined
      ) {
        add(statement.name.text, "other", statementIndex);
      }
      return;
    }
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name !== undefined && statement.body !== undefined) {
        add(statement.name.text, "function", statementIndex);
      }
      return;
    }
    if (ts.isClassDeclaration(statement)) {
      if (statement.name !== undefined) {
        add(statement.name.text, "class", statementIndex);
      }
      return;
    }
    if (ts.isVariableStatement(statement)) {
      const flags = statement.declarationList.flags;
      if ((flags & ts.NodeFlags.BlockScoped) !== 0) {
        const kind = (flags & ts.NodeFlags.Const) !== 0 ? "const" : "let";
        for (const declaration of statement.declarationList.declarations) {
          addBindingName(declaration.name, kind, statementIndex);
        }
        return;
      }
    }
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name !== undefined) {
        add(clause.name.text, "other", statementIndex);
      }
      const named = clause?.namedBindings;
      if (named !== undefined && ts.isNamespaceImport(named)) {
        add(named.name.text, "other", statementIndex);
      } else if (named !== undefined) {
        for (const element of named.elements) {
          add(element.name.text, "other", statementIndex);
        }
      }
      return;
    }
    if (
      (ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement)) &&
      ts.isIdentifier(statement.name)
    ) {
      add(statement.name.text, "other", statementIndex);
      return;
    }
    collectVars(statement, statementIndex);
  });
  moduleScopeBindingsBySourceFile.set(sourceFile, bindings);
  return bindings;
}

function hasDeclareModifier(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ??
      false)
  );
}

/** The CommonJS wrapper's parameters, readable whenever nothing declares them. */
const COMMONJS_WRAPPER_PARAMETERS: ReadonlySet<string> = new Set([
  "exports",
  "require",
  "module",
  "__filename",
  "__dirname",
]);

/** Global value properties that are non-writable and non-configurable. */
const IMMUTABLE_GLOBAL_VALUES: ReadonlySet<string> = new Set([
  "undefined",
  "NaN",
  "Infinity",
]);

/**
 * Whether reading `name` at module scope, in the top-level statement
 * `statementIndex`, cannot throw: a hoisted function or `var`, a
 * `let`/`const`/`class` an EARLIER top-level statement declared (reaching
 * this statement means that one completed, so the binding is out of its
 * temporal dead zone), an undeclared CommonJS wrapper parameter, or an
 * immutable global value. Anything else may be a `ReferenceError`.
 */
function moduleScopeReadCompletes(
  sourceFile: ts.SourceFile,
  name: string,
  statementIndex: number,
): boolean {
  const binding = moduleScopeBindings(sourceFile).get(name);
  if (binding === undefined) {
    return (
      COMMONJS_WRAPPER_PARAMETERS.has(name) || IMMUTABLE_GLOBAL_VALUES.has(name)
    );
  }
  switch (binding.kind) {
    case "function":
    case "var":
      return true;
    case "let":
    case "const":
    case "class":
      return binding.count === 1 && binding.statementIndex < statementIndex;
    case "other":
      return false;
  }
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
 * Whether `node` is one of the constructs that can hold STATEMENTS — the
 * only places a `return`/`throw` can be, once function bodies are excluded
 * (RWF-015).
 *
 * This is what keeps {@link firstModuleEvaluationCutoff} off the hot path
 * of large files. `return` and `throw` are statements, and a statement can
 * only appear in a statement position: a block, an `if` arm, a loop or
 * `with` body, a `switch` clause, a `try`/`catch`/`finally` block, or a
 * labeled statement. It can never appear inside an EXPRESSION — with two
 * exceptions, and both are handled elsewhere: a function body (skipped
 * deliberately, see {@link mayEndModuleEvaluation}) and a class `static`
 * block (the reason for the `scanExpressions` escape hatch, since a class
 * EXPRESSION can sit anywhere an expression can).
 *
 * So descending only through these is not an approximation — it reaches
 * every node that could hold the thing being looked for, and skips the
 * expression trees that make up the bulk of a real file. On the
 * scan-performance suite's single-file fixture (9,001 top-level
 * statements, nearly all of them object literals and call expressions)
 * walking expressions too cost ~190ms per module model, multiplied by
 * every model a scan builds; this walk is a per-statement kind check.
 */
function mayContainNestedStatements(node: ts.Node): boolean {
  return (
    ts.isBlock(node) ||
    ts.isIfStatement(node) ||
    ts.isIterationStatement(node, false) ||
    ts.isSwitchStatement(node) ||
    ts.isCaseBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node) ||
    ts.isTryStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isLabeledStatement(node) ||
    ts.isWithStatement(node)
  );
}

/**
 * Whether this file could contain a class element that EXECUTES at
 * class-definition time — a `static { ... }` block (RWF-015) or a
 * `static x = ...` field initializer (RWF-018) — and therefore needs
 * {@link mayEndModuleEvaluation}'s full expression walk to be classified
 * correctly.
 *
 * Those two are the only constructs that run code inside an EXPRESSION
 * without a function body around them: a static block is the only place a
 * statement can sit there, and a static field initializer the only place
 * an expression is evaluated there. Neither can exist unless the token
 * `static` appears in the file, so the same one-line text test gates both.
 * It is a sound over-approximation: a `static` in a comment, a string, or
 * an ordinary static METHOD modifier costs that one file the fast walk and
 * changes no answer, while a file containing no `static` at all provably
 * has neither — which makes the cheap statement-position walk exactly
 * complete rather than merely close.
 */
function mayContainClassStaticEvaluation(sourceFile: ts.SourceFile): boolean {
  return /\bstatic\b/.test(sourceFile.text);
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

/**
 * Whether an operator token assigns to its left-hand side (`=`, `+=`,
 * `??=`, ...). Local copy of the same test commonjs-reexports.ts's
 * `collectFacts` uses, kept independent rather than exported/shared: this
 * relation and that one answer different questions and coupling their
 * implementations would make either one harder to change without risking
 * the other.
 */
function isAssignmentOperatorToken(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

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
 * The module-TOP-LEVEL callable named `name` this file's own text can read
 * a body out of directly (RWF-016) — the call-target candidate half of
 * {@link resolveExactLocalCallable}'s proof, before reassignment and
 * shadowing are even considered:
 *
 * - a module-TOP-LEVEL `function bail() {}` declaration, or
 * - a module-TOP-LEVEL `const bail = function () {}` / `const bail = () =>
 *   {}` — deliberately restricted to `const`, mirroring
 *   commonjs-reexports.ts's own `isConstDeclaration` gate for the same
 *   reason: a `const` can be reassigned nowhere in the language.
 *
 * `undefined` for every other shape sharing the name: a `let`/`var`
 * binding, a destructured binding, an import, a class, or any initializer
 * that isn't a function/arrow expression.
 *
 * Cheap and already properly scoped without any extra work: this only
 * ever iterates `sourceFile.statements` itself (never recursing into a
 * nested block or an expression), so it costs one shape check per
 * top-level statement.
 */
const topLevelCallableCandidatesBySourceFile = new WeakMap<
  ts.SourceFile,
  ReadonlyMap<
    string,
    ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction
  >
>();

function topLevelCallableCandidates(
  sourceFile: ts.SourceFile,
): ReadonlyMap<
  string,
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction
> {
  const cached = topLevelCallableCandidatesBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }

  const candidates = new Map<
    string,
    ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction
  >();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      candidates.set(statement.name.text, statement);
    } else if (
      ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
    ) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) {
          continue;
        }
        const initializer = unwrapParentheses(decl.initializer);
        if (
          ts.isFunctionExpression(initializer) ||
          ts.isArrowFunction(initializer)
        ) {
          candidates.set(decl.name.text, initializer);
        }
      }
    }
  }

  topLevelCallableCandidatesBySourceFile.set(sourceFile, candidates);
  return candidates;
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

/**
 * Whether `node` sits in a position that WRITES to whatever it denotes
 * (RWF-028).
 *
 * The direct forms are the obvious ones — `h.x = v`, `h.x ??= v`,
 * `h.x++`, `delete h.x`. The ones worth building a walk for are the
 * destructuring forms, because a write target can be nested arbitrarily
 * deep inside a pattern that is syntactically an object or array
 * LITERAL:
 *
 * ```js
 * ({ a: h.x } = source);       // writes h.x
 * [h.x] = values;              // writes h.x
 * ({ a: { b: h.x } } = source) // writes h.x
 * for (h.x of list) {}         // writes h.x, once per iteration
 * ```
 *
 * An earlier version of this test looked only at `node`'s immediate
 * parent and missed every one of those — `const h = { bail }; ({ a:
 * h.bail } = { a: safeFn }); h.bail();` was proven non-completing when it
 * completes perfectly well, which is a false AFFECTED invented by this
 * rule. Found by RWF-028's own self-review attack pass.
 *
 * So the walk climbs the pattern's own structure — parentheses and TS
 * type-only wrappers, array and object literals, property assignments and
 * spreads — and answers `true` only if it lands on something that is
 * actually an assignment. Climbing a literal proves nothing on its own:
 * `foo({ a: h.x })` and `const y = [h.x]` climb exactly the same nodes and
 * correctly answer `false`, because the walk ends at a call and a
 * declaration rather than at an assignment's left-hand side.
 */
function isWriteTargetPosition(node: ts.Node): boolean {
  let current: ts.Node = node;
  for (;;) {
    const parent = current.parent as ts.Node | undefined;
    if (parent === undefined) {
      return false;
    }

    if (
      ts.isBinaryExpression(parent) &&
      isAssignmentOperatorToken(parent.operatorToken.kind) &&
      parent.left === current
    ) {
      return true;
    }
    if (
      (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) &&
      parent.initializer === current
    ) {
      return true;
    }
    if (
      (ts.isPrefixUnaryExpression(parent) ||
        ts.isPostfixUnaryExpression(parent)) &&
      parent.operand === current
    ) {
      return true;
    }
    if (ts.isDeleteExpression(parent) && parent.expression === current) {
      return true;
    }

    // Structure a write target can legitimately be nested inside. Nothing
    // here is a decision — only the tests above decide — so climbing one
    // of these in a non-assignment context is harmless.
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === current)
    ) {
      current = parent;
      continue;
    }

    return false;
  }
}

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

/**
 * {@link WholeModuleExportAuthority} for one `module.exports = X` /
 * `export = X` write (RWF-014).
 *
 * `node` is the write itself (the assignment expression, or the
 * `ExportAssignment`); `rhs` is its right-hand side, which is what
 * {@link isDefinitelyReachedExportAssignment} needs in order to climb out
 * through a chained assignment first.
 *
 * The `"deferred"` walk stops at the source file and asks only about node
 * KINDS, never about names or call sites — a function/class body between
 * the write and the file means the write's execution time is not tied to
 * module evaluation at all.
 */
function classifyWholeModuleExportAuthority(
  node: ts.Node,
  rhs: ts.Expression,
): WholeModuleExportAuthority {
  if (isDefinitelyReachedExportAssignment(rhs)) {
    return "unconditional";
  }
  // Written as a top-level statement, but some earlier top-level statement
  // can end module evaluation before this one runs (RWF-015). Checked
  // before the `"deferred"` walk because the two are mutually exclusive: a
  // direct child of the source file has no function or class body between
  // it and the file.
  if (isTopLevelExportAssignment(rhs)) {
    return "bypassable";
  }
  for (
    let ancestor: ts.Node | undefined = node.parent as ts.Node | undefined;
    ancestor !== undefined && !ts.isSourceFile(ancestor);
    ancestor = ancestor.parent as ts.Node | undefined
  ) {
    if (
      ts.isFunctionLike(ancestor) ||
      ts.isClassLike(ancestor) ||
      ts.isClassStaticBlockDeclaration(ancestor)
    ) {
      return "deferred";
    }
  }
  return "conditional";
}

/**
 * Every `module.exports = X` (or TypeScript's `export = X`) write in the
 * file, in SOURCE ORDER, each carrying its own
 * {@link WholeModuleExportAuthority}.
 *
 * `ts.forEachChild` visits children in syntactic order and this walk is
 * pre-order, so the emitted sequence is already ordered by source start
 * position (an ancestor starts before its descendants, and siblings are
 * visited in order) — no sort is needed, and the whole pass stays one
 * linear traversal.
 *
 * This deliberately collects CONDITIONAL and DEFERRED writes too, which
 * the pre-RWF-014 `findLastModuleExportsAssignment` also did — but that
 * function returned whichever write it saw LAST and let every consumer
 * treat it as the module's exported value. Keeping them visible is the
 * point: they are exactly the evidence
 * {@link selectAuthoritativeWholeModuleExport} needs in order to REFUSE.
 */
function collectModuleExportsAssignments(
  sourceFile: ts.SourceFile,
): readonly ModuleExportsAssignment[] {
  const found: ModuleExportsAssignment[] = [];

  function record(node: ts.Node, rhs: ts.Expression): void {
    found.push({
      rhs,
      location: toSourceLocation(sourceFile, node),
      isModuleScope: isUnconditionalModuleScopeStatement(node),
      authority: classifyWholeModuleExportAuthority(node, rhs),
    });
  }

  function visit(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === "module" &&
      node.left.name.text === "exports"
    ) {
      record(node, node.right);
    } else if (ts.isExportAssignment(node) && node.isExportEquals) {
      record(node, node.expression);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

/**
 * The ONE `module.exports = X` write that provably decides the module's
 * exported value, or `undefined` when no single write can be proven to
 * (RWF-014) — the single authority gate every whole-module export fact
 * passes through.
 *
 * Node's `module.exports` really is last-write-wins, and the pre-RWF-014
 * code took that as licence to keep the last write in SOURCE order. Those
 * are not the same thing. Source order is last-write order only when
 * every write definitely runs, in that order; the moment a write is
 * conditional or deferred, "last in the file" is a branch picked
 * arbitrarily and then presented as the module's identity. That is a false
 * NOT_AFFECTED whenever the branch NOT picked is the one that reaches the
 * finding's sink:
 *
 * ```js
 * function dangerousOp() { danger.explode(); }   // reaches the sink
 * function safeOp() {}
 * if (FLAG) { module.exports = dangerousOp; }
 * else      { module.exports = safeOp; }
 * ```
 *
 * Here the export bound to `safeOp`, the caller's `fixture(input)` got a
 * fully RESOLVED edge to it, `dangerousOp` was left with no incoming edge,
 * and the reachability search returned unreachable with
 * `reachableSubgraphComplete: true` — a complete Family C proof for a
 * package that calls `explode` on every run that takes the other branch.
 * Reproduced end to end before this gate existed; see
 * fixtures/commonjs-conditional-whole-module-export/.
 *
 * Two conditions, and both are about EXECUTION ORDER rather than text
 * order:
 *
 * 1. **The last write in the file must be `"unconditional"`.** It then
 *    definitely runs, and — because module evaluation executes top-level
 *    statements in order — it runs AFTER every write above it, so it
 *    overwrites all of them whether or not they ran. Anything textually
 *    before it is therefore irrelevant, which is what makes the legitimate
 *    shapes below still work with no special-casing:
 *
 *    ```js
 *    module.exports = first;  module.exports = second;   // -> second
 *    if (flag) { module.exports = first; }
 *    module.exports = second;                            // -> second
 *    ```
 *
 *    and equally what refuses the mirror image, where the conditional
 *    write is the one that runs last:
 *
 *    ```js
 *    module.exports = first;
 *    if (flag) { module.exports = second; }               // -> ambiguous
 *    ```
 *
 *    Requiring the LAST collected write to be unconditional expresses both
 *    at once: if it is, no conditional write survives after it; if it is
 *    not, a write whose execution this module cannot decide is the final
 *    one. (Note this is strictly a check on the last element, not "the
 *    last unconditional write plus a scan for conditional writes after it"
 *    — the two are the same statement, and the shorter one cannot be got
 *    wrong.)
 *
 * 2. **No `"deferred"` write anywhere in the file.** A write inside a
 *    function body is not ordered by source position at all: nothing stops
 *    an importer from calling `configure()` after module evaluation and
 *    replacing an exported value that a later top-level statement had
 *    "definitively" set. Position cannot dominate what position does
 *    not order, so a single deferred write withdraws the whole file's
 *    whole-module identity — including from an otherwise perfect
 *    unconditional final assignment.
 *
 * Refusing is cheap and never invents a verdict: an unattributed
 * whole-module export is an unresolved target, and an unresolved target is
 * UNKNOWN (see verdict.ts's Site A). It is also honest downstream —
 * call-graph.ts turns a call through an export it cannot attribute into an
 * `unknown(unresolved_target)` edge, which makes the reachable subgraph
 * incomplete and withdraws Family C rather than silently narrowing it.
 *
 * Linear in the number of collected writes, with no CFG, no dataflow, and
 * no target execution.
 */
function selectAuthoritativeWholeModuleExport(
  assignments: readonly ModuleExportsAssignment[],
): ModuleExportsAssignment | undefined {
  const last = assignments.at(-1);
  if (last === undefined || last.authority !== "unconditional") {
    return undefined;
  }
  return assignments.some((a) => a.authority === "deferred") ? undefined : last;
}

/**
 * The whole-module export binding for a file whose `module.exports` writes
 * {@link selectAuthoritativeWholeModuleExport} refused to collapse into
 * one value (RWF-014).
 *
 * The export still EXISTS — this file assigns `module.exports`, and
 * dropping the binding entirely would be its own unsound claim (a module
 * that exports nothing, which downstream absence reasoning could read as
 * positive evidence). What it carries is nothing: no `localName`, no
 * `localFunctionLocation`, no `commonJsReExport`. Every one of those would
 * name one branch, and naming one branch is precisely the defect.
 *
 * `location` anchors to the LAST write observed, purely so the binding
 * points somewhere real in the file; it is a position, not an attribution,
 * and nothing resolves a target through it.
 *
 * {@link ExportBinding.exportAttributionWithdrawn} marks it as this
 * refusal rather than an attributed export that merely happens to name no
 * callable (RWF-021). Nothing about TARGET attribution reads that flag —
 * an export this relation refused stays exactly as unattributable as it
 * was. It exists so that ROOT selection can tell "we declined to name the
 * exported callable" apart from "there is no exported callable", and widen
 * instead of dropping the root. See {@link entrypointRootCandidates}.
 */
function ambiguousWholeModuleExport(
  observed: ModuleExportsAssignment,
): ExportBinding {
  return {
    kind: "default",
    syntax: "commonjs",
    exportAttributionWithdrawn: true,
    location: observed.location,
  };
}

/**
 * The property name a computed key (`[expr]:` / `[expr]() {}`) denotes,
 * when it is directly a string or numeric literal or an identifier bound to
 * a `const` initialized to one (VT-217) -- e.g.
 * `const NAME = "vulnerable"; module.exports = { [NAME]: impl };`.
 * `undefined` for anything else (a parameter, a call, a runtime value): a
 * genuinely dynamic key, which {@link unpackObjectLiteralExports} treats as
 * able to define any name.
 *
 * E-1 (PRM-28): the identifier resolves LEXICALLY, from the key itself, to
 * the one declaration it binds to ({@link lexicalDeclarationOf}), which
 * must be written before the key (a `const` read earlier is in its temporal
 * dead zone). This used to take the first `const` of that spelling anywhere
 * in the file, so a function's or block's own `const K = "other"` decided
 * what a module-scope `[K]` published. A numeric key yields its property
 * name only when it round-trips ({@link exactCommonJsExportPropertyName}):
 * `1e3` denotes `"1000"`.
 */
function resolveComputedPropertyNameLiteral(
  sourceFile: ts.SourceFile,
  name: ts.ComputedPropertyName,
): string | undefined {
  const expr = unwrapParentheses(name.expression);
  const literal = exactCommonJsExportPropertyName(expr);
  if (literal !== undefined || !ts.isIdentifier(expr)) {
    return literal;
  }
  const declaration = lexicalDeclarationOf(expr, expr.text);
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    declaration.getEnd() > expr.getStart(sourceFile)
  ) {
    return undefined;
  }
  return exactCommonJsExportPropertyName(
    unwrapParentheses(declaration.initializer),
  );
}

/**
 * Unpacks `module.exports = { a, b: c, "d": e, [K]: f, method() {} }` into
 * individual named exports (TASK-017; VT-217 for computed keys) -- one of
 * the most common CommonJS export patterns, whose members would otherwise
 * be invisible to symbol resolution.
 *
 * E-1 (PRM-27; ADR 0009 § 4, "duplicate keys inside one object literal"):
 * a literal can define one name several times, and Node evaluates its
 * properties in order, so the LAST definition is the one published. Per
 * name, then:
 *
 * - every key form the literal can spell names a property: an identifier,
 *   a string, a numeric key that round-trips, a computed key
 *   {@link resolveComputedPropertyNameLiteral} resolves, a shorthand, a
 *   method, a getter or a setter;
 * - the name is published by its last definition when every definition of
 *   it is a plain value (a property, a shorthand or a method);
 * - a getter or setter among its definitions withdraws it (the value is
 *   computed at the read, or a setter alone leaves `undefined`);
 * - a computed key nothing resolves can define ANY name, so it withdraws
 *   every name whose last definition comes before it;
 * - a spread anywhere in the literal withdraws every name, as ADR 0009 § 4
 *   states (a name defined after the spread would be sound to keep --
 *   `{ ...defaults, run: safe }` publishes `safe` -- but the ADR decides);
 * - a non-computed `__proto__:` sets the prototype and defines no own
 *   property: it is no export (the names it makes inherited are no binding
 *   here, hence unresolved).
 *
 * A withdrawn name keeps a binding, marked
 * {@link ExportBinding.exportAttributionWithdrawn}: the export exists and
 * its value is not determined. Returns `undefined` when the right-hand side
 * is not an object literal, or names nothing.
 */
function unpackObjectLiteralExports(
  index: SourceIndex,
  assignment: ModuleExportsAssignment,
): ExportBinding[] | undefined {
  const sourceFile = index.sourceFile;
  if (!ts.isObjectLiteralExpression(assignment.rhs)) {
    return undefined;
  }

  interface Definitions {
    /** The binding of the name's last plain definition, if its last definition is one. */
    last: ExportBinding | undefined;
    /** The index of the name's last definition among the literal's properties. */
    lastIndex: number;
    accessor: boolean;
  }
  const byName = new Map<string, Definitions>();
  /** The index of the last spread or unresolved computed key. */
  let lastOpenIndex = -1;
  /** ADR 0009 § 4: a spread anywhere in the literal withdraws every name. */
  let sawSpread = false;

  const valueBinding = (
    exportedName: string,
    property: ts.ObjectLiteralElementLike,
    value: ts.Expression,
  ): ExportBinding => ({
    kind: "named",
    syntax: "commonjs",
    exportedName,
    localName: ts.isIdentifier(value) ? value.text : undefined,
    // RWF-011: `{ foo: function () {} }` / `{ foo: () => {} }` /
    // `{ Foo: class {} }` — the property's VALUE is the function node,
    // an identity.
    localFunctionLocation: objectLiteralValueLocation(
      sourceFile,
      assignment,
      value,
    ),
    // `module.exports = { Range }` over a local
    // `const Range = require("./classes/range")` -- the dominant
    // real-world shape (semver, qs; see the audit's § 5.2).
    commonJsReExport: objectLiteralValueReExport(index, assignment, value),
    // RWF-013: a reassigned identifier is refused in every key form.
    localIdentifierProvenanceRefused: refusedProvenanceFlag(
      refusesLocalIdentifierProvenance(index, value),
    ),
    location: toSourceLocation(sourceFile, property),
  });

  const define = (
    name: string,
    propertyIndex: number,
    binding: ExportBinding | undefined,
  ): void => {
    const known = byName.get(name);
    if (known === undefined) {
      byName.set(name, {
        last: binding,
        lastIndex: propertyIndex,
        accessor: binding === undefined,
      });
    } else {
      known.last = binding;
      known.lastIndex = propertyIndex;
      known.accessor ||= binding === undefined;
    }
  };

  assignment.rhs.properties.forEach((property, propertyIndex) => {
    if (ts.isSpreadAssignment(property)) {
      sawSpread = true;
      return;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      // The shorthand's own identifier IS the value expression.
      define(
        property.name.text,
        propertyIndex,
        valueBinding(property.name.text, property, property.name),
      );
      return;
    }
    const key = property.name;
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(key) || ts.isStringLiteral(key)) &&
      key.text === "__proto__"
    ) {
      return;
    }
    const name = ts.isComputedPropertyName(key)
      ? resolveComputedPropertyNameLiteral(sourceFile, key)
      : ts.isIdentifier(key) || ts.isPrivateIdentifier(key)
        ? key.text
        : exactCommonJsExportPropertyName(key as ts.Expression);
    if (name === undefined) {
      lastOpenIndex = propertyIndex;
      return;
    }
    if (ts.isPropertyAssignment(property)) {
      define(
        name,
        propertyIndex,
        valueBinding(name, property, property.initializer),
      );
    } else if (ts.isMethodDeclaration(property)) {
      // RWF-011: a method IS its own function node, so it is bound by
      // position only. Its name is no reference (E-1): resolving it
      // lexically would land on a same-named declaration in scope.
      define(name, propertyIndex, {
        kind: "named",
        syntax: "commonjs",
        exportedName: name,
        localFunctionLocation: methodValueLocation(
          sourceFile,
          assignment,
          property,
        ),
        location: toSourceLocation(sourceFile, property),
      });
    } else {
      // A getter or a setter.
      define(name, propertyIndex, undefined);
    }
  });

  const results: ExportBinding[] = [];
  for (const [name, definitions] of byName) {
    if (
      definitions.last !== undefined &&
      !definitions.accessor &&
      !sawSpread &&
      definitions.lastIndex > lastOpenIndex
    ) {
      results.push(definitions.last);
    } else {
      results.push({
        kind: "named",
        syntax: "commonjs",
        exportedName: name,
        exportAttributionWithdrawn: true,
        location: toSourceLocation(sourceFile, assignment.rhs),
      });
    }
  }
  return results.length > 0 ? results : undefined;
}

/**
 * {@link directValueFunctionLocation} for one property of a
 * `module.exports = { ... }` object literal, gated on the enclosing
 * assignment being unconditional module scope — the same guard the other
 * two identity relations apply, for the same reason: an object literal
 * assigned inside an `if`/`try`/loop may never be the module's exported
 * value at all, and `findLastModuleExportsAssignment` picks by source
 * order, not by control flow.
 */
function objectLiteralValueLocation(
  sourceFile: ts.SourceFile,
  assignment: ModuleExportsAssignment,
  value: ts.Expression,
): SourceLocation | undefined {
  return assignment.isModuleScope
    ? directValueFunctionLocation(sourceFile, value)
    : undefined;
}

/**
 * {@link resolveCommonJsReExportExpression} for one object-literal
 * property's value, gated on the enclosing `module.exports = { ... }`
 * assignment running unconditionally at module scope (RWF-004b).
 *
 * The same gate {@link objectLiteralValueLocation} applies immediately
 * above, for the same reason: `findLastModuleExportsAssignment` picks by
 * source order, not by control flow, so a `module.exports = {...}` inside
 * an `if`/`try`/function body describes one arbitrarily-chosen branch. A
 * re-export origin read out of it forwards the export to that branch's
 * package as though the other branch did not exist — see
 * {@link isDefinitelyReachedExportAssignment}.
 */
function objectLiteralValueReExport(
  index: SourceIndex,
  assignment: ModuleExportsAssignment,
  value: ts.Expression,
): CommonJsReExportOrigin | undefined {
  return isDefinitelyReachedExportAssignment(assignment.rhs)
    ? resolveCommonJsReExportExpression(index, value)
    : undefined;
}

/** The identity of a `module.exports = { foo() {} }` method — the method node itself, under the same module-scope guard. */
function methodValueLocation(
  sourceFile: ts.SourceFile,
  assignment: ModuleExportsAssignment,
  method: ts.MethodDeclaration,
): SourceLocation | undefined {
  return assignment.isModuleScope
    ? toSourceLocation(sourceFile, method)
    : undefined;
}

function buildExportBindings(
  index: SourceIndex,
  exportsList: readonly IndexedExport[],
): ExportBinding[] {
  const sourceFile = index.sourceFile;
  const results: ExportBinding[] = [];
  let sawCommonJsModuleExports = false;
  let authoritative: ModuleExportsAssignment | undefined;
  let wholeModuleWrites = 0;
  const literalDefinitions = new Set<ExportBinding>();

  for (const exp of exportsList) {
    switch (exp.bindingKind) {
      case "commonjs-module-exports":
        sawCommonJsModuleExports = true;
        break;
      case "commonjs-exports-property": {
        // `exports.parse = parse` binds an export to an identifier
        // exactly as `module.exports = parse` does, and is the shape the
        // RWF-013 reproducer actually hits (see
        // fixtures/commonjs-stale-alias-export/).
        //
        // RWF-011: the export's own right-hand side is the ONLY thing
        // allowed to establish what it holds — as `localName` when it
        // names a local symbol, or as `localFunctionLocation` when it IS
        // a function/class node. Before this, a property export carried
        // neither, and `mapExportsToFunctions` searched the file for a
        // function named after the EXPORTED name, which bound
        // `exports.parse = registry.impl` to any unrelated same-file
        // `function parse()`. See {@link propertyExportProvenance}.
        const propertyRhs =
          exp.exportedName === undefined
            ? undefined
            : commonJsPropertyExportRhs(index, exp.exportedName);
        results.push({
          kind: "named",
          syntax: "commonjs",
          exportedName: exp.exportedName,
          ...propertyExportProvenance(index, propertyRhs),
          // Gated on the SAME unconditional-module-scope test as the
          // provenance fields above it (RWF-004b): the origin is read out
          // of the same last-write-wins map, so a branch-local assignment
          // would forward the export to whichever branch came last in the
          // file. See {@link isDefinitelyReachedExportAssignment}.
          commonJsReExport:
            exp.exportedName !== undefined &&
            propertyRhs !== undefined &&
            isDefinitelyReachedExportAssignment(propertyRhs)
              ? commonJsPropertyReExportOrigin(index, exp.exportedName)
              : undefined,
          localIdentifierProvenanceRefused: refusedProvenanceFlag(
            propertyRhs !== undefined &&
              refusesLocalIdentifierProvenance(index, propertyRhs),
          ),
          location: exp.location,
        });
        break;
      }
      case "named":
      case "default":
      case "re-export":
        results.push({
          kind: exp.bindingKind,
          syntax: "esm",
          exportedName: exp.exportedName,
          localName: exp.localName,
          specifier: exp.specifier,
          // E-1 (PRM-62; ADR 0009 § 1 clause 2): an ES module exports a
          // LIVE binding, so a local the file assigns anywhere -- at module
          // scope, or in a function an importer calls later -- holds more
          // than its declaration's value. {@link mapExportsToFunctions}
          // refuses it ({@link exportLocalCallableLocation}); the flag
          // lets root selection widen rather than drop it.
          exportAttributionWithdrawn:
            exp.bindingKind !== "re-export" &&
            exp.localName !== undefined &&
            isNameAssignedWithin(sourceFile, exp.localName)
              ? true
              : undefined,
          location: exp.location,
        });
        break;
    }
  }

  if (sawCommonJsModuleExports) {
    // RWF-014: the module's whole exported value comes from the ONE write
    // that provably decides it, or from nothing at all. Object-literal
    // unpacking sits inside this gate rather than beside it: the named
    // bindings it produces (`module.exports = { foo }` -> export `foo`)
    // describe the contents of ONE assigned object, so a conditionally
    // assigned literal would publish a branch's export table as the
    // module's. See {@link selectAuthoritativeWholeModuleExport}.
    const assignments = collectModuleExportsAssignments(sourceFile);
    wholeModuleWrites = assignments.length;
    authoritative = selectAuthoritativeWholeModuleExport(assignments);
    const observed = assignments.at(-1);
    if (authoritative) {
      const unpacked = unpackObjectLiteralExports(index, authoritative);
      unpacked?.forEach((binding) => literalDefinitions.add(binding));
      results.push(
        ...(unpacked ?? [wholeModuleDefaultExport(index, authoritative)]),
      );
    } else if (observed) {
      results.push(ambiguousWholeModuleExport(observed));
      // BL-064 (its independent audit, finding 1): a whole-module write
      // this file cannot settle may or may not replace the object the
      // property writes went to, so where its value can carry a name, that
      // name may be published with ITS value instead. Leaving the property
      // write attributed let a withdrawn `module.exports = { run: dangerous }`
      // hand `run` to a stale `exports.run = safe`. A value that cannot
      // carry the name (`module.exports = {}`) publishes nothing callable
      // under it, so the property write keeps its attribution.
      const wholeSites = competingWriteSites(sourceFile).wholeModule;
      // Code that may reach the prototypes (`Object.prototype.run = d`)
      // lets any value carry any name, inherited (second audit round,
      // finding 3).
      const tampered = exportWritesMayFail(sourceFile);
      const mayCarry = (name: string | undefined): boolean =>
        wholeSites.some(
          (site) =>
            !site.primitive &&
            (tampered ||
              site.carries === "all" ||
              name === undefined ||
              site.carries.has(name)),
        );
      for (const [i, binding] of results.entries()) {
        if (
          binding.syntax === "commonjs" &&
          binding.kind === "named" &&
          binding.exportAttributionWithdrawn !== true &&
          mayCarry(binding.exportedName)
        ) {
          results[i] = {
            kind: binding.kind,
            syntax: binding.syntax,
            exportedName: binding.exportedName,
            exportAttributionWithdrawn: true,
            location: binding.location,
          };
        }
      }
    }
  }

  // E-1 (ADR 0009 § 1): one effective write per CommonJS name, from the
  // file's complete write set. See {@link applyExportWriteSet}.
  return applyExportWriteSet(
    index,
    results,
    authoritative,
    wholeModuleWrites,
    literalDefinitions,
  );
}

/**
 * The non-object-literal `module.exports = X` fallback. When `X` is an
 * identifier (`module.exports = main;`) or a named function/class
 * expression (`module.exports = function main() {};`), captures that name
 * as `localName` — needed to correlate this export back to the function
 * that implements it (see TASK-018 Call Graph, which relies on this to
 * find the node for `fixtures/commonjs/src/index.cjs`'s real
 * `module.exports = function main() {...}` pattern). Left `undefined` for
 * anything else (e.g. an inline anonymous arrow function): still a valid
 * "the module's default export exists" fact, just not attributable to a
 * named local declaration.
 */
/**
 * The concrete function identity a `module.exports = X` / `export = X`
 * assignment binds the module's whole exported value to — the RWF-003
 * relation (see {@link ExportBinding.localFunctionLocation}).
 *
 * Two shapes produce an identity, both of which name a function node
 * *structurally*, never by its text:
 *
 * ```text
 * module.exports = function () {}            -> that FunctionExpression
 * module.exports = function named() {}       -> that FunctionExpression
 * module.exports = async function () {}      -> that FunctionExpression
 * module.exports = () => {}                  -> that ArrowFunction
 * module.exports = async () => {}            -> that ArrowFunction
 * module.exports = fn   (const fn = function () {} / () => {})
 *                                            -> that same function node
 * export = function () {}                    -> that FunctionExpression
 * ```
 *
 * An arrow function is included because source-index.ts indexes arrows as
 * first-class function nodes exactly like function expressions
 * (`isFunctionLike`), and call-graph.ts registers and walks them the same
 * way — so this is integrating an already-authoritative representation,
 * not adding a partial one.
 *
 * Three guards make the result a fact rather than a guess, and each one
 * returning `undefined` leaves the export exactly as unattributed as it
 * was before RWF-003 (an unresolved target, hence UNKNOWN — never a
 * verdict):
 *
 * 1. **Unconditional module scope.** Node's `module.exports` is
 *    last-write-wins at RUNTIME, and this task has no control-flow
 *    semantics. An assignment nested in an `if`/`try`/loop/function may or
 *    may not run, and `findLastModuleExportsAssignment` picks the last one
 *    in SOURCE order — so binding to it would be choosing a branch
 *    arbitrarily. Requiring the winning assignment to be a direct
 *    statement of the file makes "this is the module's final exported
 *    value" true by the language's own rules.
 * 2. **CommonJS ambient provenance.** A file that declares its own
 *    `module`/`exports`/`require` binding is refused outright, so
 *    `const module = { exports: null }; module.exports = function () {}`
 *    creates no export identity at all — the RWF-004a protection, applied
 *    to this relation too (see `declaresCommonJsAmbientShadow`).
 * 3. **A fully proven alias chain.** The identifier form goes through
 *    commonjs-reexports.ts's module-scope single-assignment proof at
 *    EVERY hop (RWF-012's {@link resolveLocalValue}), so
 *    `const fn = function () {}; const a = fn; const b = a;
 *    module.exports = b` now lands on that function node, while a chain
 *    with one reassigned, multiply-declared, conditionally-initialized,
 *    destructured or cyclic hop anywhere along it resolves to nothing
 *    here — exactly as unattributed as before RWF-003.
 *
 * A class expression (`module.exports = class {}`) is deliberately NOT
 * matched: its callable target is an implicit or explicit constructor and
 * its members are attributed by a different relation
 * ({@link findExportedClassMembers}), which is keyed on the class's own
 * name. Extending identity-based attribution to anonymous classes is a
 * separate question, and refusing here costs only the precision it
 * already lacked.
 */
function directExportedFunctionLocation(
  index: SourceIndex,
  assignment: ModuleExportsAssignment,
): SourceLocation | undefined {
  if (!assignment.isModuleScope) {
    return undefined;
  }

  const value = unwrapValue(assignment.rhs);

  if (isDirectFunctionValue(value)) {
    return declaresCommonJsAmbientShadow(index)
      ? undefined
      : toSourceLocation(index.sourceFile, value);
  }

  if (!ts.isIdentifier(value) || declaresCommonJsAmbientShadow(index)) {
    return undefined;
  }

  const bound = resolveLocalValue(index, value);
  if (bound.kind !== "value") {
    return undefined;
  }
  return isDirectFunctionValue(bound.value)
    ? toSourceLocation(index.sourceFile, bound.value)
    : undefined;
}

/**
 * `true` or absent, never `false` — {@link ExportBinding} is a bag of
 * facts about an export, and "we did not refuse anything" is the absence
 * of a fact rather than one. Keeps every export binding this relation has
 * nothing to say about shaped exactly as it was before RWF-013.
 */
function refusedProvenanceFlag(refused: boolean): true | undefined {
  return refused ? true : undefined;
}

function wholeModuleDefaultExport(
  index: SourceIndex,
  assignment: ModuleExportsAssignment,
): ExportBinding {
  let localName: string | undefined;

  // RWF-012: read through parentheses and chained assignments, so
  // `module.exports = exports.decode = decode` names `decode` exactly as
  // the bare `module.exports = decode` form does. The value of `x = v` is
  // `v`, so this is the same fact, differently spelled — see
  // {@link unwrapValue}.
  //
  // Gated on {@link isDefinitelyReachedExportAssignment}, for the same reason
  // every other export-provenance fact in this module is, and this is the
  // ONE place RWF-012 could have skipped it. Reading through an assignment
  // turns a right-hand side this relation previously had nothing to say
  // about into a local NAME, and that name goes on to drive
  // `mapExportsToFunctions`'s same-file name search. In a conditional or
  // nested position that would be a branch chosen arbitrarily by source
  // order and then presented as certainty:
  //
  // ```js
  // if (FLAG) { module.exports = alias = dangerousOp; }
  // else      { module.exports = alias = safeOp; }
  // ```
  //
  // `findLastModuleExportsAssignment` keeps only the LAST assignment, so
  // the export would bind to `safeOp` and a complete Family C proof over
  // that node would report NOT_AFFECTED — while the run that took the
  // other branch reaches `dangerousOp`. Reproduced end to end as exactly
  // that false NOT_AFFECTED before this guard existed.
  //
  // Un-gated, the raw right-hand side is used instead, which is precisely
  // the pre-RWF-012 behaviour: a chained assignment is a `BinaryExpression`
  // and names nothing, so a conditional chained export goes back to
  // carrying no provenance at all. This deliberately does NOT change the
  // plain-identifier conditional form (`if (c) { module.exports = fn; }`),
  // whose raw right-hand side is already an identifier — that is a
  // separate, older gap in this same relation, and closing it here would
  // be an unrelated behaviour change smuggled into RWF-012.
  const rhsValue = isDefinitelyReachedExportAssignment(assignment.rhs)
    ? unwrapValue(assignment.rhs)
    : assignment.rhs;

  if (ts.isIdentifier(rhsValue)) {
    localName = rhsValue.text;
  } else if (
    (ts.isFunctionExpression(rhsValue) || ts.isClassExpression(rhsValue)) &&
    rhsValue.name
  ) {
    localName = rhsValue.name.text;
  }

  return {
    kind: "default",
    syntax: "commonjs",
    localName,
    // The export's concrete function identity, when the assignment names
    // one structurally (RWF-003). Independent of `localName`: an anonymous
    // value has an identity and no name, and a named function expression
    // has both.
    //
    // E-1: a NAMED class expression (`module.exports = class Cursor {}`)
    // is identified by its constructor's position. Its name is bound only
    // inside the class, so lexical identity finds no declaration of it in
    // module scope, where the name `find` used to find its constructor.
    // An anonymous one stays unattributed, as before.
    localFunctionLocation:
      directExportedFunctionLocation(index, assignment) ??
      (ts.isClassExpression(rhsValue) &&
      rhsValue.name !== undefined &&
      isDefinitelyReachedExportAssignment(assignment.rhs) &&
      !declaresCommonJsAmbientShadow(index)
        ? toSourceLocation(index.sourceFile, classConstructorNode(rhsValue))
        : undefined),
    // RWF-013: `module.exports = fn` where `fn` is a variable this file
    // reassigns (or otherwise cannot prove single-assignment for). The
    // name "fn" is still a perfectly good same-file match for the STALE
    // initializer, so the fallback must be told not to take it.
    localIdentifierProvenanceRefused: refusedProvenanceFlag(
      refusesLocalIdentifierProvenance(index, assignment.rhs),
    ),
    // `module.exports = require("./lib")` / `= require("./lib").foo`
    // (RWF-004a/RWF-004b): the module's whole exported value comes from
    // another module. Unlike `localName`, this survives the value being
    // anonymous.
    //
    // Uses {@link isDefinitelyReachedExportAssignment} rather than
    // `assignment.isModuleScope` (RWF-004b): the two differ only for a
    // CHAINED assignment, and real `debug@2.0.0`'s `node.js` is exactly
    // that — `exports = module.exports = require('./debug')`, one
    // unconditional top-level statement whose inner assignment's enclosing
    // node is the outer assignment rather than the statement. A
    // conditionally-assigned `module.exports` is refused by both.
    commonJsReExport: isDefinitelyReachedExportAssignment(assignment.rhs)
      ? commonJsModuleReExportOrigin(index)
      : undefined,
    location: assignment.location,
  };
}

/**
 * Builds the unified import/export model for a file already indexed by
 * TASK-014 (see docs/SDD.md § 15-17).
 */
export function buildModuleModel(index: SourceIndex): ModuleModel {
  return {
    filePath: index.filePath,
    imports: index.imports.map(toImportBinding),
    exports: buildExportBindings(index, index.exports),
  };
}

/**
 * The reachability roots {@link entrypointRootCandidates} found: names to
 * match a graph node by, and exact function POSITIONS to match one by when
 * the callable has no name at all (RWF-003's anonymous export shape).
 *
 * Both are matched against the entrypoint file's own graph nodes by
 * src/analysis/verdict.ts's `entrypointSourceNodes`; neither is an
 * attribution, and nothing resolves a vulnerable target through either.
 */
/**
 * Why {@link entrypointRootCandidates} could not turn a configured
 * entrypoint's exported behavior into concrete reachability roots (P0-Z).
 *
 * - `unresolved_entrypoint_reexport` — the entrypoint publishes an export
 *   whose value comes from ANOTHER module (`module.exports =
 *   require("./x")`, `module.exports.run = require("./x").run`,
 *   `export { run } from "./x"`, `export * from "./x"`). The callable an
 *   importer actually receives does not live in this file, and
 *   `entrypointSourceNodes` matches roots only among this file's own
 *   graph nodes, so no local node can stand for it.
 * - `unresolved_export_forwarding` — a call MUTATES the export object
 *   with values this model does not enumerate (`Object.assign(
 *   module.exports, require("./x"))`). The module model produces no
 *   export binding at all for this shape, so without an explicit signal
 *   it is indistinguishable from a file that exports nothing.
 * - `unresolved_computed_export_name` — the file publishes a value under a
 *   name that is not statically known (`module.exports[k] = run`). The
 *   callable is LOCAL and rootable in principle, but no export binding is
 *   produced for it, so it contributes no root and the file looks like one
 *   that exports nothing. An importer that knows the runtime name calls it
 *   perfectly well.
 * An entrypoint that cannot be PARSED is deliberately not a reason here:
 * that file is also a `ModuleLoadClosure` root, so the closure already
 * records `parse_failure` and `callGraphNegativeProofBlockers` already
 * blocks families B and C on it. Closure completeness and root-derivation
 * completeness are independent assumptions, and duplicating one inside the
 * other would blur which condition actually mattered.
 */
export type EntrypointRootIncompletenessReason =
  | "unresolved_entrypoint_reexport"
  | "unresolved_export_forwarding"
  | "unresolved_computed_export_name"
  /**
   * A root candidate that must denote a callable could not be MATERIALIZED
   * to an actual node (P0-Z round 3). Raised by `entrypointSourceNodes`,
   * which is the only place that can ask the question, since it alone
   * holds both the candidates and the call graph.
   */
  | "unresolved_entrypoint_root_candidate";

/** One concrete reason a configured entrypoint's root set is incomplete. */
export interface EntrypointRootIncompleteness {
  readonly reason: EntrypointRootIncompletenessReason;
  /** The module the exported value was forwarded from, when known. */
  readonly specifier?: string;
  /** The exported name affected, when the form names one. */
  readonly exportedName?: string;
  readonly location?: SourceLocation;
}

export interface EntrypointRootCandidates {
  /**
   * The names the candidates were written with -- for diagnostics only.
   * No root is looked up by them since task V-3 (PRM-25, PRM-31): a root is
   * a node at one of `locations`.
   */
  readonly names: ReadonlySet<string>;
  readonly locations: readonly SourceLocation[];
  /**
   * Whether every relevant exported root was either concretely derived or
   * positively proven irrelevant (P0-Z).
   *
   * THE DISTINCTION THIS EXISTS TO MAKE. Before P0-Z this result was just
   * `{names, locations}`, so an empty root set meant two different things
   * that must never be conflated:
   *
   * ```js
   * const x = 1;                              // no exported callable:
   *                                           //   nothing to root, COMPLETE
   * module.exports = require("./sibling.js"); // exports a callable this
   *                                           //   analyzer cannot root: INCOMPLETE
   * ```
   *
   * Both produced zero names. The second then let `analyzeReachability`
   * start effectively at the `<module>` node alone, meet no unresolved
   * edge, and report `unreachable` — which family C serialized as
   * `reachableSubgraphComplete: true`. The subgraph really was exhausted;
   * it was simply never ROOTED correctly, and the analyzer had no way to
   * say so. P0-Z reproduced this against runtime-reachable targets in
   * three rounds: six forms in the original audit, two more (a two-hop
   * chain and a dynamic computed export name) while remediating it, and a
   * final six -- every element-access CommonJS export spelling -- in the
   * focused re-audit, where the key was statically exact but
   * `describeCommonJsExportTarget` modeled only the dot form.
   *
   * Deliberately NOT expressed by emptying or widening `names`: this is
   * uncertainty about WHICH ROOT, not about which callable is the export,
   * and faking a root (or faking an unresolved call edge later) would put
   * the uncertainty at the wrong layer and lie in diagnostics. It is also
   * deliberately independent of `ModuleLoadClosure.complete`, which
   * answers a different question about a different traversal.
   */
  readonly complete: boolean;
  readonly incompleteness: readonly EntrypointRootIncompleteness[];
  /**
   * One entry per export binding that could publish a CALLABLE, listing
   * every alternative that would materialize it (P0-Z round 3).
   *
   * THE INVARIANT THIS EXISTS TO ENFORCE: a candidate name is not a root.
   * A root is a NODE. Before this, `entrypointRootCandidates` contributed
   * `exp.localName ?? exp.exportedName` and called the derivation
   * complete — but for `const alias = bad; module.exports.run = alias` the
   * contributed name is `alias`, while the only callable node is `bad`.
   * The name matched nothing, the entrypoint got no root beyond
   * `<module>`, and family C certified `reachableSubgraphComplete: true`
   * over a sink Node executes. Modeling the export was never the missing
   * piece; materializing the candidate was.
   *
   * A requirement is satisfied by ANY of its `locations`. Until task V-3
   * a NAME satisfied it too, by spelling, and a nested function sharing
   * the spelling of the exported local stood in for it (PRM-25, PRM-31):
   * each name is now resolved to the declaration it binds to at the
   * export's site, and that declaration's callable position is one of the
   * `locations`.
   *
   * Bindings that provably publish no callable (`module.exports.x = 42`)
   * emit NO requirement -- "there is no root here" stays a complete
   * answer, which is what keeps valid family C proofs alive.
   */
  readonly rootRequirements: readonly EntrypointRootRequirement[];
}

/** One export binding's materialization alternatives (P0-Z round 3). */
export interface EntrypointRootRequirement {
  /** The exported name, for diagnostics. */
  readonly exportedName?: string;
  /**
   * The name an importer binds the export by -- `"default"` for a default
   * or whole-module export, the exported name otherwise -- which a
   * configured `{file, symbol}` entrypoint selects by (task V-3).
   */
  readonly canonicalName?: string;
  /** The names the binding was written with, for diagnostics only. */
  readonly names: readonly string[];
  /**
   * The positions that materialize the binding: a function value's own,
   * and the callable each provenance name DECLARES at the export's site
   * (task V-3). The requirement is satisfied by a node at any of them, and
   * by nothing else -- a node that merely shares a name's spelling
   * satisfies nothing.
   */
  readonly locations: readonly SourceLocation[];
}

/**
 * The callable surface an entrypoint file can be entered through — the
 * reachability ROOTS for src/analysis/verdict.ts's
 * `entrypointSourceNodes` (RWF-021).
 *
 * **Root provenance is not export provenance, and conflating them is the
 * defect this exists to fix.** Those two questions look alike and are not:
 *
 * - *export attribution* asks "WHICH function is this module's exported
 *   value?", and its correct failure mode is to REFUSE. Naming a function
 *   the module might not export manufactures a target out of nothing, and
 *   RWF-011/013/014 are all fixes for having answered it too eagerly.
 * - *root selection* asks "which of this file's own functions might an
 *   outside caller invoke?", and its correct failure mode is to WIDEN.
 *   An entrypoint's exports are by definition callable from outside the
 *   analyzed codebase, so a root this file cannot pin down is a root that
 *   might be any of its top-level callables — not none of them.
 *
 * Before RWF-021 both questions were answered by the same expression
 * (`exp.localName ?? exp.exportedName`), so a soundness cutoff that
 * correctly withdrew ATTRIBUTION silently withdrew the ROOT too:
 *
 * ```js
 * const dep = require("vuln-lib");
 * function main(u) { return dep.dangerousOp(u); }   // the only path to the sink
 * function bail() { throw new Error("boom"); }
 * if (flag) { bail(); }        // RWF-016 cutoff -> authority withdrawn
 * module.exports = main;       // bypassable, so `localName` is refused
 * ```
 *
 * `main` stopped being a root, its body was never traversed, the sink
 * became unreachable, and the result was a **complete Family C proof and a
 * false NOT_AFFECTED** — for a module that, on every run where the branch
 * is not taken, really does export `main` and really does reach the sink.
 * Reproduced on `8d18130` for all four merged cutoff families (RWF-016's
 * bare call, RWF-017's variable initializer, RWF-018's static field and
 * RWF-019's computed key), and the same mechanism would have admitted
 * RWF-020's heritage clause as a fifth.
 *
 * **The rule.** Losing export precision must never shrink this set:
 *
 * - every export that still carries a name contributes it, exactly as
 *   before — the precise case is untouched, so a file whose export
 *   authority is intact widens nothing and costs nothing;
 * - an export whose attribution was WITHDRAWN
 *   ({@link ExportBinding.exportAttributionWithdrawn}) additionally
 *   contributes every callable this file's own EXPORT WRITES could
 *   publish — see {@link collectExportWriteCandidates}.
 *
 * The result is a superset of the precise answer by construction: names
 * and positions are only ever added. That is the monotonicity property
 * RWF-021 asserts directly in its tests.
 *
 * **Why export writes and not every top-level callable.** RWF-021's first
 * cut widened to `topLevelCallableCandidates`, and its audit showed that
 * to be strictly too broad: it rooted functions that no export write
 * mentions anywhere, which cannot be published on any run, and that
 * manufactured false AFFECTED findings. The eligible set is the values the
 * file's real `module.exports = X` / `exports.Y = X` writes could hand an
 * importer — bounded above by what the language can actually publish, and
 * still bounded below by every write, so nothing plausible is lost.
 *
 * A function nested inside another function's body is excluded by the same
 * rule rather than by a separate one — nothing assigns it to an export:
 *
 * ```js
 * function outer() { function hidden() { dep.dangerousOp(); } }
 * ```
 *
 * `hidden` is not a plausible exported value and is not rooted.
 *
 * **What this deliberately does NOT do.** It does not attribute anything:
 * no target resolves through a widened root, no evidence claims a widened
 * root is the export, and {@link mapExportsToFunctions} is untouched. It
 * does not resurrect name-only attribution (RWF-011) — a widened name is a
 * traversal start point, never an identity claim. It does not fall back to
 * an earlier write, a stale binding, a re-export's origin or another
 * PackageInstance. And it manufactures nothing: a file with an ambiguous
 * export and no top-level callables contributes no names, leaving the
 * module node as the only root, which keeps the honest UNKNOWN rather than
 * inventing a root to root.
 */
/**
 * Adds the callable candidates ONE export write's right-hand side could
 * publish, to the widened root set (RWF-021, narrowed by its own audit).
 *
 * This is the constraint that keeps widening honest. The first cut of
 * RWF-021 widened to every TOP-LEVEL CALLABLE in the file, which is a
 * strictly larger set than "the values this module's export writes can
 * publish" — and the difference is not academic. It rooted functions no
 * export write mentions anywhere, so a helper that merely happens to touch
 * a vulnerable dependency turned into a reported call path:
 *
 * ```js
 * function main(u) { return "safe:" + u; }               // the ONLY export
 * function neverExported(u) { return dep.dangerousOp(u); } // assigned to nothing
 * if (flag) { bail(); }
 * module.exports = main;
 * ```
 *
 * No run of that module can publish `neverExported`, so rooting it
 * manufactured a false AFFECTED. The rule below is the fix: a callable is
 * eligible only if some real export write could actually hand it to an
 * importer.
 *
 * What each right-hand-side shape contributes:
 *
 * - **a directly written function/arrow/class** (`module.exports =
 *   function (u) {...}`) — its exact POSITION, which is RWF-003's identity
 *   evidence and needs no name;
 * - **an identifier** (`module.exports = main`) — the name, unless
 *   {@link resolveLocalValue} REFUSES it. A refusal is RWF-013/013b's
 *   reassignment proof, and honouring it here is what stops the stale
 *   original from being rooted after `main = safe`;
 * - **an object literal** (`module.exports = { run: main }`) — each
 *   property's value, recursively, matching the precise path's own
 *   object-literal unpacking so withdrawal loses no root the intact case
 *   would have had;
 * - **anything else** — nothing. A `require(...)` re-export publishes
 *   another package, never a local callable, so no local root is invented
 *   from it; a non-callable value has no root to contribute.
 *
 * Bounded by construction: it reads the writes this file already collected
 * and resolves each right-hand side once, with no whole-file rescan and no
 * new symbol resolver.
 */
function collectExportWriteCandidates(
  index: SourceIndex,
  rhs: ts.Expression,
  names: Set<string>,
  locations: SourceLocation[],
  unresolved: SourceLocation[],
): void {
  const value = unwrapValue(rhs);

  const direct = directValueFunctionLocation(index.sourceFile, value);
  if (direct) {
    locations.push(direct);
    return;
  }

  if (ts.isObjectLiteralExpression(value)) {
    for (const property of value.properties) {
      if (ts.isPropertyAssignment(property)) {
        collectExportWriteCandidates(
          index,
          property.initializer,
          names,
          locations,
          unresolved,
        );
      } else if (ts.isShorthandPropertyAssignment(property)) {
        collectExportWriteCandidates(
          index,
          property.name,
          names,
          locations,
          unresolved,
        );
      } else if (ts.isMethodDeclaration(property)) {
        locations.push(toSourceLocation(index.sourceFile, property));
      } else {
        // A spread, an accessor: a value the widening cannot name a root
        // for (task V-3).
        unresolved.push(toSourceLocation(index.sourceFile, property));
      }
    }
    return;
  }

  if (!ts.isIdentifier(value)) {
    // Task V-3: a call's result, a member read, a conditional -- a value
    // that may be callable and that no position names. Contributing
    // nothing here was a silently dropped root.
    if (mayBeCallableValue(value)) {
      unresolved.push(toSourceLocation(index.sourceFile, value));
    }
    return;
  }

  // RWF-013/013b's reassignment proof, reused verbatim and honoured here
  // exactly as attribution honours it: a name this file writes to is not a
  // stable alias for whatever it was declared as, so the DECLARATION is
  // not a plausible published value. Refusing rather than rooting the
  // stale node is what makes `main = safe; module.exports = main` stop
  // reporting the original `main`'s body -- and, since task V-3, the
  // refusal is a gap the root set reports, not a root it silently lacks.
  const resolved = resolveLocalValue(index, value);
  if (resolved.kind === "refused") {
    unresolved.push(toSourceLocation(index.sourceFile, value));
    return;
  }

  names.add(value.text);
  if (resolved.kind === "value") {
    const chased = directValueFunctionLocation(
      index.sourceFile,
      resolved.value,
    );
    if (chased) {
      locations.push(chased);
      return;
    }
  }
  // Task V-3: the identifier's own declaration -- or, for an alias, the
  // declaration its chain ends on -- resolved lexically from this
  // reference: the root a name used to reach by spelling. A write inside a
  // function body may run later or never, and its names were collected by
  // a whole-file walk; whatever this cannot name a callable for is root
  // INCOMPLETENESS, never nothing: a whole-module binding has no
  // requirement of its own to fail closed instead (task V-3's independent
  // audit, finding 1).
  if (isInsideFunctionBody(value)) {
    unresolved.push(toSourceLocation(index.sourceFile, value));
    return;
  }
  const candidates = [value.text];
  if (resolved.kind === "unmodeled" && resolved.name !== undefined) {
    candidates.push(resolved.name);
  }
  let named = false;
  for (const candidate of candidates) {
    const declared = declaredRootAt(index.sourceFile, value, candidate);
    if (declared.kind === "callable") {
      locations.push(declared.location);
      named = true;
    } else if (declared.kind === "none") {
      named = true;
    }
  }
  if (!named) {
    unresolved.push(toSourceLocation(index.sourceFile, value));
  }
}

/**
 * Whether one export binding publishes a value that comes from ANOTHER
 * module, so no node in the entrypoint's own file can serve as its root
 * (P0-Z).
 *
 * Both syntaxes are covered because both lose the root the same way, and
 * each carries the fact on its own field: ESM's `export { x } from "./y"`
 * / `export * from "./y"` arrives as `kind: "re-export"`, while CommonJS
 * `module.exports = require("./y")` arrives as {@link
 * ExportBinding.commonJsReExport} (see that field's own doc comment for
 * why the two are deliberately separate).
 *
 * A name on the binding does NOT make it rootable: `export { run } from
 * "./x"` and `module.exports.run = require("./x").run` both carry the name
 * `run`, and both publish a callable defined in `./x`, so a same-file
 * lookup for `run` finds either nothing or — worse — an unrelated local
 * that merely shares the text.
 */
function isForeignOriginExport(exp: ExportBinding): boolean {
  return exp.kind === "re-export" || exp.commonJsReExport !== undefined;
}

/**
 * Whether a call MUTATES the CommonJS export object directly, e.g.
 * `Object.assign(module.exports, require("./x"))` (P0-Z).
 *
 * Deliberately keyed on the export object being the call's FIRST argument
 * — the mutation TARGET position for `Object.assign`,
 * `Object.defineProperty` and `Object.defineProperties` alike. A mention
 * anywhere else (`console.log("exports are", module.exports)`,
 * `{ ...module.exports }`) publishes nothing and must not make an
 * otherwise-complete entrypoint incomplete, which is why this is not a
 * blanket "mentions `module.exports` anywhere" test.
 *
 * KNOWN, DELIBERATE IMPRECISION: a pure READ that happens to sit in
 * first-argument position (`JSON.stringify(module.exports)`) is reported
 * too. Distinguishing it would require knowing whether the callee mutates
 * its argument, which is exactly the whole-program question this fix is
 * scoped not to open — and the costs are asymmetric. Over-reporting turns
 * a NOT_AFFECTED into an UNKNOWN; under-reporting turns a reachable target
 * into a false NOT_AFFECTED, which is the defect this exists to prevent.
 * The imprecise direction is the safe one, so it is taken knowingly rather
 * than narrowed to a fragile allowlist of known-mutating callees.
 *
 * The module model produces no {@link ExportBinding} whatsoever for this
 * shape, so unlike a re-export there is nothing else to detect it by.
 */
function isCommonJsExportObject(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) {
    return node.text === "exports";
  }
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "module" &&
    node.name.text === "exports"
  );
}

function exportForwardingCalls(
  sourceFile: ts.SourceFile,
): readonly ts.CallExpression[] {
  const found: ts.CallExpression[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      isCommonJsExportObject(node.arguments[0]!)
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

/**
 * Every `module.exports[<computed>] = ...` write whose published NAME is
 * not statically known (P0-Z).
 *
 * The callable on the right-hand side is typically local and perfectly
 * rootable; what is missing is the name it becomes visible under. The
 * module model produces no {@link ExportBinding} for such a write, so the
 * file looks exactly like one that exports nothing — the same conflation
 * as a re-export, reached through a third route:
 *
 * ```js
 * function run(u) { return dep.dangerousOp(u); }
 * module.exports[process.env.K] = run;   // publishes `run`; name unknown
 * ```
 *
 * A LITERAL computed key (`module.exports["run"] = run`) is deliberately
 * excluded: its name is statically known and the ordinary named-export
 * path already models it, so reporting it would cost precision for no
 * soundness gain.
 */
function computedExportNameWrites(
  sourceFile: ts.SourceFile,
): readonly ts.ElementAccessExpression[] {
  const found: ts.ElementAccessExpression[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      isCommonJsExportObject(node.left.expression) &&
      // P0-Z: refuse exactly the keys source-index.ts could NOT name. The
      // two must use one predicate: a key it names becomes a real export
      // binding (and therefore a root), and a key it refuses has no
      // binding anywhere, so it must surface here as incompleteness. An
      // independent spelling of "looks literal" is how `1e3` -- which
      // denotes "1000", not "1e3" -- could be excluded from BOTH and
      // silently report a complete, root-less derivation.
      exactCommonJsExportPropertyName(node.left.argumentExpression) ===
        undefined
    ) {
      found.push(node.left);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

/**
 * Whether a resolved export value could be a callable at runtime (P0-Z
 * round 3).
 *
 * Deliberately a NEGATIVE test: everything is assumed callable-capable
 * unless it is one of the few literal forms that provably is not. Getting
 * this wrong in the permissive direction costs an UNKNOWN; getting it
 * wrong in the restrictive direction costs a false NOT_AFFECTED, because
 * a binding wrongly classified "not callable" emits no requirement and
 * its unmaterialized root goes unnoticed.
 */
function mayBeCallableValue(value: ts.Expression): boolean {
  return !(
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    ts.isStringLiteralLike(value) ||
    ts.isRegularExpressionLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(value) && value.text === "undefined")
  );
}

/**
 * The resolved value of a CommonJS PROPERTY export that carries no
 * `localName` (P0-Z round 3) -- `module.exports.run = obj.bad`, where the
 * right-hand side is not a bare identifier so no local name was recorded.
 *
 * Without this such a binding looks exactly like `module.exports.run = 42`:
 * both have no `localName`, no `localFunctionLocation`, and would emit no
 * requirement. One of them can publish a callable.
 */
function commonJsPropertyExportValue(
  index: SourceIndex,
  exp: ExportBinding,
): LocalValueProvenance | undefined {
  if (
    exp.syntax !== "commonjs" ||
    exp.kind !== "named" ||
    exp.exportedName === undefined
  ) {
    return undefined;
  }
  const rhs = commonJsPropertyExportRhs(index, exp.exportedName);
  return rhs === undefined ? undefined : resolveLocalValue(index, rhs);
}

export function entrypointRootCandidates(
  index: SourceIndex,
  model: ModuleModel,
): EntrypointRootCandidates {
  const names = new Set<string>();
  const locations: SourceLocation[] = [];
  const incompleteness: EntrypointRootIncompleteness[] = [];
  const rootRequirements: EntrypointRootRequirement[] = [];
  let withdrawn = false;

  for (const exp of model.exports) {
    // P0-Z round 3: what this binding would have to materialize to.
    const requiredNames: string[] = [];
    const requiredLocations: SourceLocation[] = [];
    // Task V-3: the names that carry provenance for this binding -- the
    // local it was written with, and where its alias chain ends. NOT the
    // `exportedName` fallback below: a public name is not provenance for a
    // local (RWF-011), so it may widen nothing and satisfy nothing.
    const provenanceNames: string[] = [];
    if (exp.localName) {
      provenanceNames.push(exp.localName);
    }
    let requiresCallableRoot = false;
    // The names the binding was written with, `exportedName` fallback
    // included, kept in `names` and `requiredNames` for diagnostics only.
    // Until task V-3 the fallback ROOTED and WITNESSED by spelling, on the
    // premise that an extra root only makes more code reachable; it also
    // satisfied the requirement, so a same-named decoy stood in for the
    // export and the real one was never searched (PRM-31). A root is a
    // position now (`provenanceNames` below), and the exported name, as
    // RWF-011 already decided for attribution, is no provenance.
    const name = exp.localName ?? exp.exportedName;
    if (name) {
      names.add(name);
      requiredNames.push(name);
    }
    // RWF-003's anonymous-callable evidence, which root selection never
    // consulted before RWF-021: `module.exports = function (u) { ... }`
    // has an exact function IDENTITY and no name at all, so a name-only
    // root lookup lost it even when attribution was fully precise.
    if (exp.localFunctionLocation) {
      // Task V-3: a callable the export publishes, so a requirement -- met
      // by its position only when the function is evaluated before the
      // export reads it (`exports.main = run; var run = function () {}`
      // publishes `undefined`; its independent audit, finding 5).
      requiresCallableRoot = true;
      const fn = nodeAtLocation(index.sourceFile, exp.localFunctionLocation);
      if (fn !== undefined && evaluatedBeforeExport(index, fn, exp)) {
        locations.push(exp.localFunctionLocation);
        requiredLocations.push(exp.localFunctionLocation);
      }
    }
    if (exp.exportAttributionWithdrawn) {
      withdrawn = true;
    }

    // P0-Z round 3 -- RESOLVE THE EXPORTED LOCAL THROUGH ITS ALIAS CHAIN.
    //
    // `exp.localName` is the name the export was written with, which for
    // `const alias = bad; module.exports.run = alias` is `alias` -- a
    // variable, not a callable node. The chain walk is RWF-012/013's
    // existing bounded one (`resolveLocalValue`, entered by name), so
    // reassignment, cycles, destructuring and non-module-scope bindings
    // all refuse here exactly as they refuse for attribution. This adds
    // hops, never permissiveness.
    const published = exp.localName
      ? resolveLocalValueByName(index, exp.localName)
      : commonJsPropertyExportValue(index, exp);

    if (published !== undefined) {
      switch (published.kind) {
        case "unmodeled": {
          // The chain ended on a name this file does not bind -- an
          // un-reassigned function/class declaration, or an import. THAT
          // is the callable a root must be looked up by.
          if (published.name !== undefined) {
            names.add(published.name);
            requiredNames.push(published.name);
            provenanceNames.push(published.name);
          }
          requiresCallableRoot = true;
          break;
        }
        case "value": {
          const chased = directValueFunctionLocation(
            index.sourceFile,
            published.value,
          );
          if (chased && evaluatedBeforeExport(index, published.value, exp)) {
            // An exact function/arrow/class expression: materialized by
            // POSITION, which needs no name at all (RWF-003's evidence).
            locations.push(chased);
            requiredLocations.push(chased);
            requiresCallableRoot = true;
          } else if (chased || mayBeCallableValue(published.value)) {
            // Task V-3 (its independent audit, finding 5): a function
            // value assigned only AFTER the export reads the binding --
            // `exports.main = run; var run = function () {}` -- is not
            // what the export publishes (it published `undefined`).
            // A conditional, a call, a property access: could publish a
            // callable and this analyzer cannot say which. Requiring it
            // is what turns the guess into an honest UNKNOWN.
            requiresCallableRoot = true;
          }
          // Anything provably non-callable (a numeric/string literal)
          // requires no root at all, and must not manufacture one.
          break;
        }
        case "refused": {
          // RWF-013/013b proved the file rewrites this binding, so what it
          // publishes is genuinely undetermined. The stale declaration must
          // not be rooted, and pretending the derivation is complete is the
          // defect this whole effort removes.
          requiresCallableRoot = true;
          break;
        }
      }
    }

    // Task V-3 (its independent audit, finding 2): an ESM default export
    // the model records with no local and no position -- `export default
    // run`, `export default function () {}`, `export default () => ...`
    // -- published a callable and required no root, so `{file, symbol:
    // "default"}` and a plain file entrypoint called the root set
    // complete without it.
    if (
      exp.kind === "default" &&
      exp.syntax === "esm" &&
      exp.localName === undefined &&
      exp.localFunctionLocation === undefined
    ) {
      const site = nodeAtLocation(index.sourceFile, exp.location);
      requiresCallableRoot = true;
      if (site !== undefined && ts.isExportAssignment(site)) {
        const value = unwrapParentheses(site.expression);
        const direct = directValueFunctionLocation(index.sourceFile, value);
        if (ts.isIdentifier(value)) {
          provenanceNames.push(value.text);
        } else if (direct !== undefined) {
          locations.push(direct);
          requiredLocations.push(direct);
        } else if (!mayBeCallableValue(value)) {
          requiresCallableRoot = false;
        }
      } else if (
        site !== undefined &&
        ts.isFunctionDeclaration(site) &&
        site.body !== undefined
      ) {
        const location = toSourceLocation(index.sourceFile, site);
        locations.push(location);
        requiredLocations.push(location);
      } else if (site !== undefined && ts.isClassDeclaration(site)) {
        const location = toSourceLocation(
          index.sourceFile,
          classConstructorNode(site),
        );
        locations.push(location);
        requiredLocations.push(location);
      }
    }

    if (requiresCallableRoot) {
      // Task V-3: each provenance name materializes at the position of the
      // callable it DECLARES at the export's site, and only there -- unless
      // the binding is REFUSED (the file rewrites it): its declaration is
      // then the stale value, which may neither root nor witness (task
      // V-3's independent audit, finding 3).
      const provenance =
        published?.kind === "refused"
          ? []
          : provenanceNameLocations(index, exp, provenanceNames);
      for (const location of provenance) {
        locations.push(location);
        requiredLocations.push(location);
      }
      rootRequirements.push({
        exportedName: exp.exportedName,
        canonicalName: canonicalExportName(exp),
        names: requiredNames,
        locations: requiredLocations,
      });
    }
    // P0-Z: an export forwarded from another module has no root in THIS
    // file. Recorded rather than silently contributing nothing, which is
    // how the root vanished and family C still claimed completeness.
    if (isForeignOriginExport(exp)) {
      incompleteness.push({
        reason: "unresolved_entrypoint_reexport",
        specifier: exp.specifier ?? exp.commonJsReExport?.specifier,
        exportedName: exp.exportedName,
        location: exp.location,
      });
    }
  }

  // P0-Z: export-object mutation the model produces no binding for.
  for (const call of exportForwardingCalls(index.sourceFile)) {
    incompleteness.push({
      reason: "unresolved_export_forwarding",
      location: toSourceLocation(index.sourceFile, call),
    });
  }

  // P0-Z: a real local callable published under a name only the runtime
  // knows. Rootable in principle, invisible to the model in practice.
  for (const write of computedExportNameWrites(index.sourceFile)) {
    incompleteness.push({
      reason: "unresolved_computed_export_name",
      location: toSourceLocation(index.sourceFile, write),
    });
  }

  const wideningLocations: SourceLocation[] = [];
  const wideningUnresolved: SourceLocation[] = [];
  if (withdrawn) {
    // Every value this file's own export writes could publish — and
    // nothing else. See {@link exportWriteRootCandidates}.
    for (const assignment of collectModuleExportsAssignments(
      index.sourceFile,
    )) {
      collectExportWriteCandidates(
        index,
        assignment.rhs,
        names,
        wideningLocations,
        wideningUnresolved,
      );
    }
    for (const exp of model.exports) {
      if (exp.kind !== "named" || exp.syntax !== "commonjs") {
        continue;
      }
      const rhs =
        exp.exportedName === undefined
          ? undefined
          : commonJsPropertyExportRhs(index, exp.exportedName);
      if (rhs !== undefined) {
        collectExportWriteCandidates(
          index,
          rhs,
          names,
          wideningLocations,
          wideningUnresolved,
        );
      }
    }
    locations.push(...wideningLocations);
    // Task V-3: a value an export write may publish that no position
    // names is a root gap, reported -- it used to contribute nothing.
    for (const location of wideningUnresolved) {
      incompleteness.push({
        reason: "unresolved_entrypoint_root_candidate",
        location,
      });
    }
  }

  return {
    names,
    locations,
    complete: incompleteness.length === 0,
    incompleteness,
    rootRequirements,
  };
}

/**
 * Maps each of a module's *canonical* export names (the name an importer
 * would bind to — "default" for a default/whole-module export, or the
 * named-export identifier otherwise) to the {@link IndexedFunction} that
 * implements it, when that can be attributed to a local function
 * declaration.
 *
 * This is the one place that reconciles a canonical export name with the
 * underlying function's own declared name, which can differ — most
 * commonly for CommonJS's `module.exports = someNamedFunction;` idiom
 * (used throughout the real npm ecosystem, e.g. lodash's per-method
 * files): the canonical export name is `"default"`, but the function
 * itself is still named `someNamedFunction`. Any consumer that needs to
 * go from "the export a rule/import specifier names" to "the real
 * function" — not just "a function that happens to share the export's
 * literal name" — must go through this mapping rather than comparing
 * against a function's own name directly (see call-graph.ts's
 * `prepareFile`, which builds call edges this way, and
 * src/analysis/verdict.ts's `findExportNodeInFile`, which locates a rule's
 * declared target the same way — see TASK-023 completion report for the
 * regression this fixes).
 */
export function mapExportsToFunctions(
  index: SourceIndex,
  model: ModuleModel,
): ReadonlyMap<string, IndexedFunction> {
  const result = new Map<string, IndexedFunction>();
  /** Built at most once per call, and only when some export actually carries an identity. */
  let functionsByPosition: ReadonlyMap<string, IndexedFunction> | undefined;

  for (const exp of model.exports) {
    if (exp.kind === "re-export") {
      // Chasing a re-export to its ultimate source file is not attempted
      // here — see TASK-018 completion report.
      continue;
    }
    const canonicalName = exp.kind === "default" ? "default" : exp.exportedName;
    if (!canonicalName) {
      continue;
    }

    // RWF-003: a structurally-referenced function node is the export's real
    // identity and always wins over the name search below — it is exact
    // where the name search is a same-file text match, and it is the ONLY
    // mechanism available at all when the exported function is anonymous.
    // See ExportBinding.localFunctionLocation.
    if (exp.localFunctionLocation) {
      functionsByPosition ??= indexFunctionsByPosition(index);
      const byIdentity = functionsByPosition.get(
        positionKey(exp.localFunctionLocation),
      );
      if (byIdentity) {
        result.set(canonicalName, byIdentity);
        continue;
      }
    }

    // RWF-013: the export's value is an identifier whose binding this
    // file's own text contradicts (reassigned, multiply declared, not
    // module scope, ...). The name search below would still find a
    // same-named function -- typically the STALE initializer, which
    // source indexing names after the very variable that was reassigned
    // away from it -- and binding that manufactures a confident target
    // out of a value the analyzer just proved it cannot determine. An
    // export nothing can attribute is an unresolved target (UNKNOWN),
    // which is the correct answer here; a stale one is a false verdict in
    // whichever direction the stale node's reachability happens to fall.
    // See ExportBinding.localIdentifierProvenanceRefused.
    if (exp.localIdentifierProvenanceRefused) {
      continue;
    }

    // RWF-011: ONLY a local name the export's own right-hand side
    // established may name the export's function -- never the public
    // export name, which is provenance for no local symbol
    // (`exports.parse = registry.impl` beside an unrelated
    // `function parse()`).
    //
    // E-1 (PRM-26; ADR 0009 § 1 clause 5): and that local name denotes
    // the ONE declaration it binds to where the export is written, by
    // lexical identity, never the first indexed function that merely
    // shares its spelling (a class method, a nested function, an
    // `o.run = function () {}` that source indexing names after the
    // property). A name nothing in scope declares, declares twice, or the
    // file assigns anywhere attributes nothing: an unresolved target,
    // UNKNOWN. See {@link exportLocalCallableLocation}.
    if (exp.localName === undefined) {
      continue;
    }
    const location = exportLocalCallableLocation(index, exp, exp.localName);
    if (location !== undefined) {
      functionsByPosition ??= indexFunctionsByPosition(index);
      const byIdentity = functionsByPosition.get(positionKey(location));
      if (byIdentity) {
        result.set(canonicalName, byIdentity);
      }
    }
  }

  return result;
}

/**
 * The position of the callable `localName` denotes at `exp`'s own site, by
 * lexical identity (task E-1, PRM-26), or `undefined` when it denotes no
 * one callable this file defines.
 *
 * The site is the export's own statement, declaration or specifier, and
 * the name resolves through its scope chain to the one declaration that
 * owns it ({@link lexicalDeclarationOf}): a class method, a nested
 * function or a property function that merely shares the spelling is never
 * it. Refused, toward an unresolved target:
 *
 * - a site inside a function body (a write that may run later, or never);
 * - a name the file assigns ANYWHERE (`run = other`, in any scope): its
 *   declaration's value is not the export's (RWF-013 for CommonJS, PRM-62
 *   for an ES module's live binding, which an assignment anywhere changes
 *   for every importer);
 * - for CommonJS, a variable whose initializer has not run where the
 *   export reads it (`exports.run = run; var run = function () {}`
 *   publishes `undefined`). An ES module export is a live binding, read at
 *   the importer's call, so its order is not asked.
 */
function exportLocalCallableLocation(
  index: SourceIndex,
  exp: ExportBinding,
  localName: string,
): SourceLocation | undefined {
  const sourceFile = index.sourceFile;
  const site = nodeAtLocation(sourceFile, exp.location);
  if (site === undefined || isInsideFunctionBody(site)) {
    return undefined;
  }
  const declaration = lexicalDeclarationOf(site, localName);
  if (
    declaration === undefined ||
    isNameAssignedWithin(sourceFile, localName)
  ) {
    return undefined;
  }
  if (ts.isVariableDeclaration(declaration)) {
    if (declaration.initializer === undefined) {
      return undefined;
    }
    if (
      exp.syntax === "commonjs" &&
      declaration.getEnd() > site.getStart(sourceFile)
    ) {
      return undefined;
    }
  }
  return declaredCallableLocation(sourceFile, declaration);
}

/** A function node's own start position, the identity key {@link ExportBinding.localFunctionLocation} resolves against. */
function positionKey(location: SourceLocation): string {
  return `${location.line}:${location.column}`;
}

/**
 * Every indexed function keyed by its own start position, built once per
 * {@link mapExportsToFunctions} call rather than re-scanned per export —
 * exactly one AST node begins at a given position, so first-wins here can
 * only ever be an exact match (the guard exists solely so a synthesized
 * implicit-constructor entry, whose position is its class's name rather
 * than its own node, can never displace a real function node).
 */
function indexFunctionsByPosition(
  index: SourceIndex,
): ReadonlyMap<string, IndexedFunction> {
  const byPosition = new Map<string, IndexedFunction>();
  for (const fn of index.functions) {
    const key = positionKey(fn.location);
    if (!byPosition.has(key)) {
      byPosition.set(key, fn);
    }
  }
  return byPosition;
}

/**
 * Structurally attributes a rule target's `export` name to every
 * class-member declaration (method or constructor) reachable through a
 * REAL, module-level export binding that names a class (VT-301A; see
 * docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 7.3/§ 10's RWF-011/R-6
 * provenance requirement).
 *
 * The chain is exact, never a same-file name search:
 *
 * ```text
 * export binding (canonical name -> local class name)
 *   -> that class's own IndexedFunction (mapExportsToFunctions,
 *      kind === "constructor" -- constructors are always named after
 *      their enclosing class, see source-index.ts)
 *   -> every OTHER IndexedFunction in the same file whose
 *      memberOf.className equals that class's own name AND whose own
 *      name equals memberName
 * ```
 *
 * A method/constructor belonging to a class the module does not itself
 * export is never a candidate here, no matter how uniquely its bare name
 * matches `memberName` elsewhere in the file — this is exactly the
 * coincidence RWF-011 identified as unsafe for a same-file bare-name
 * search to rely on.
 *
 * When more than one exported class legitimately declares a member named
 * `memberName` (e.g. two exported classes both happen to have a `parse()`
 * method), every one of them is a structurally valid candidate: this
 * returns ALL of them rather than arbitrarily picking one. It is the
 * caller's (`findExportNodeInFile`'s) job to turn each into a graph node,
 * and `resolveTargetNodes`/`checkReachability`'s existing
 * OR-across-candidate-nodes aggregation that already backs
 * multiple-`VulnerableSymbolTarget`/multiple-entrypoint reachability
 * decides AFFECTED/NOT_AFFECTED/UNKNOWN from there — this function never
 * narrows ambiguity down to one answer itself.
 *
 * Returns an empty array (not a guess) when the module exports no class
 * at all, or when no exported class's own members include `memberName` —
 * e.g. a webpack-bundled module whose export table
 * (`mapExportsToFunctions`) has no attributable class entry at all (see
 * RWF-006/RWB-03: this deliberately does not fall back to treating every
 * class in the file as if it were exported).
 */
export function findExportedClassMembers(
  index: SourceIndex,
  model: ModuleModel,
  memberName: string,
): readonly IndexedFunction[] {
  const exportedClassNames = new Set<string>();
  for (const fn of mapExportsToFunctions(index, model).values()) {
    if (fn.kind === "constructor" && fn.name !== undefined) {
      exportedClassNames.add(fn.name);
    }
  }

  if (exportedClassNames.size === 0) {
    return [];
  }

  return index.functions.filter(
    (fn) =>
      fn.name === memberName &&
      fn.memberOf !== undefined &&
      exportedClassNames.has(fn.memberOf.className),
  );
}
