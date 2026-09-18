import ts from "typescript";
import type { DynamicCallReason } from "../domain/graph.js";
import type { BindingKind } from "./module-model.js";
import type { ModuleResolver } from "./module-resolver.js";
import { resolveImportProvenanceDeclaration } from "./named-bindings.js";

export interface CanonicalSymbolTarget {
  readonly modulePath: string;
  readonly specifier: string;
  readonly exportedName: string;
}

export interface SymbolBindingResolved {
  readonly kind: "resolved";
  readonly target: CanonicalSymbolTarget;
}

/**
 * The callee references a known import, but which target it calls cannot
 * be statically determined (see docs/SDD.md § 18, § 21). Never coerced
 * into "not_an_import" or silently dropped — this is a first-class,
 * explicit outcome.
 */
export interface SymbolBindingAmbiguous {
  readonly kind: "ambiguous";
  readonly reason: DynamicCallReason;
}

/** The callee references a known import, but its module specifier did not resolve (see module-resolver.ts). */
export interface SymbolBindingUnresolvedModule {
  readonly kind: "unresolved_module";
  readonly specifier: string;
  readonly reason: string;
}

/**
 * The callee references a known import, but its module specifier resolved
 * only to a TypeScript declaration file, never a runtime implementation
 * (VT-304, see module-resolver.ts's {@link DeclarationOnlyModule}). Kept
 * distinct from {@link SymbolBindingUnresolvedModule}: the specifier itself
 * resolved successfully (to a real file on disk), so callers that want the
 * more specific diagnostic can distinguish "nothing there" from "type
 * information only, no runtime evidence."
 */
export interface SymbolBindingDeclarationOnly {
  readonly kind: "declaration_only";
  readonly specifier: string;
  readonly resolvedFileName: string;
}

/**
 * The callee references a known import, but its module specifier names a
 * Node.js builtin module (VT-305, RWF-007, see module-resolver.ts's
 * {@link BuiltinModule}) -- a known runtime module supplied by Node
 * itself, never an npm package to look up or an uncertainty to flag.
 * `specifier` is the normalized, unprefixed form (`"fs"`, not
 * `"node:fs"`).
 */
export interface SymbolBindingBuiltin {
  readonly kind: "builtin";
  readonly specifier: string;
}

/** The callee does not reference an imported binding at all (e.g. a call to a locally-defined function). */
export interface SymbolBindingNotAnImport {
  readonly kind: "not_an_import";
}

export type SymbolBindingResult =
  | SymbolBindingResolved
  | SymbolBindingAmbiguous
  | SymbolBindingUnresolvedModule
  | SymbolBindingDeclarationOnly
  | SymbolBindingBuiltin
  | SymbolBindingNotAnImport;

interface CalleeShape {
  /**
   * The identifier NODE at the root of the callee, never its text
   * (RWF-046). Everything that decides which module this callee reaches
   * -- which declaration binds the name, whether an inner one shadows an
   * outer, whether a write invalidated it -- is a property of where the
   * name is written, and the text alone cannot carry it. The text is
   * still read for the export name, but only AFTER the declaration has
   * been identified.
   */
  readonly rootIdentifier?: ts.Identifier;
  readonly propertyChain: readonly string[];
  readonly dynamicReason?: DynamicCallReason;
}

function analyzeCalleeShape(callee: ts.Expression): CalleeShape {
  if (ts.isIdentifier(callee)) {
    return { rootIdentifier: callee, propertyChain: [] };
  }

  if (ts.isPropertyAccessExpression(callee)) {
    const chain: string[] = [];
    let current: ts.Expression = callee;
    while (ts.isPropertyAccessExpression(current)) {
      chain.unshift(current.name.text);
      current = current.expression;
    }
    if (ts.isIdentifier(current)) {
      return { rootIdentifier: current, propertyChain: chain };
    }
    // Root of the chain isn't a plain identifier (e.g. `foo().bar()`) —
    // nothing this binder can attribute to an import.
    return { propertyChain: chain };
  }

  if (ts.isElementAccessExpression(callee)) {
    if (
      ts.isIdentifier(callee.expression) &&
      ts.isStringLiteralLike(callee.argumentExpression)
    ) {
      // foo["vulnerable"]() — statically known despite bracket syntax.
      return {
        rootIdentifier: callee.expression,
        propertyChain: [callee.argumentExpression.text],
      };
    }
    // foo[method]() — genuinely dynamic; must not fabricate an edge.
    return { propertyChain: [], dynamicReason: "dynamic_member_access" };
  }

  return { propertyChain: [] };
}

/**
 * What a reference's OWN declaration says about the module it denotes --
 * the same three facts an `ImportBinding` row carried, but derived from
 * the exact declaration that binds this reference rather than looked up
 * by spelling (RWF-046).
 */
interface ResolvedImportBinding {
  readonly specifier: string;
  readonly kind: BindingKind;
  readonly importedName?: string;
}

/** The ESM module specifier an import binding node was written with, if it is a literal one. */
function esmSpecifierOf(
  node:
    | ts.ImportClause
    | ts.ImportSpecifier
    | ts.NamespaceImport
    | ts.ImportEqualsDeclaration,
): string | undefined {
  if (ts.isImportEqualsDeclaration(node)) {
    // `import lib = require("pkg")`. The entity-name form
    // (`import q = A.B`) loads no module and is correctly excluded, as
    // source-index.ts's own extraction already excludes it.
    if (
      node.isTypeOnly ||
      !ts.isExternalModuleReference(node.moduleReference) ||
      !ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      return undefined;
    }
    return node.moduleReference.expression.text;
  }

  const clause = ts.isImportClause(node)
    ? node
    : ts.isNamespaceImport(node)
      ? node.parent
      : node.parent.parent;
  // A type-only import is erased before anything runs and can never be
  // part of a call path — the same exclusion source-index.ts applies.
  if (clause.isTypeOnly || (ts.isImportSpecifier(node) && node.isTypeOnly)) {
    return undefined;
  }
  const declaration = clause.parent;
  return ts.isStringLiteral(declaration.moduleSpecifier)
    ? declaration.moduleSpecifier.text
    : undefined;
}

/**
 * The import provenance a reference inherits from THE EXACT LEXICAL
 * DECLARATION that owns it, or `undefined` when no declaration in scope
 * supplies any (RWF-046).
 *
 * This replaced a `moduleModel.imports.find(imp => imp.localName === text)`
 * whose authority was a file-wide, name-keyed table. `undefined` here is
 * a genuine "this reference is not an import binding" — a parameter, a
 * catch binding, a plain local, a reassigned one — and is never a
 * licence to keep searching by name. Falling through to the table on a
 * miss is exactly the collapse this closes.
 */
function importBindingFor(
  reference: ts.Identifier,
): ResolvedImportBinding | undefined {
  const declaration = resolveImportProvenanceDeclaration(reference);

  if (declaration.kind === "none") {
    return undefined;
  }

  if (declaration.kind === "require") {
    // `const source = require("pkg")` binds the WHOLE module to one name,
    // which is the same shape `import source from "pkg"` binds — the
    // convergence module-model.ts's `toImportBinding` already describes.
    const [specifier] = declaration.call.arguments;
    return ts.isStringLiteral(specifier as ts.Node)
      ? { specifier: (specifier as ts.StringLiteral).text, kind: "default" }
      : undefined;
  }

  if (declaration.kind === "require-element") {
    const { element } = declaration;
    // A rest element (`const { ...rest } = require("pkg")`) binds an
    // object of the remaining members, not any one export, so it names
    // nothing this can be authoritative about.
    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) {
      return undefined;
    }
    const propertyName = element.propertyName ?? element.name;
    if (
      !ts.isIdentifier(propertyName) &&
      !ts.isStringLiteralLike(propertyName)
    ) {
      // A computed key (`const { [k]: run } = require("pkg")`) names no
      // export statically.
      return undefined;
    }
    const [specifier] = declaration.call.arguments;
    if (!ts.isStringLiteral(specifier as ts.Node)) {
      return undefined;
    }
    return {
      specifier: (specifier as ts.StringLiteral).text,
      kind: "named",
      importedName: propertyName.text,
    };
  }

  const specifier = esmSpecifierOf(declaration.node);
  if (specifier === undefined) {
    return undefined;
  }
  const node = declaration.node;
  if (ts.isImportSpecifier(node)) {
    return {
      specifier,
      kind: "named",
      importedName: (node.propertyName ?? node.name).text,
    };
  }
  if (ts.isNamespaceImport(node)) {
    return { specifier, kind: "namespace" };
  }
  // An `ImportClause`'s own name is the DEFAULT import; an
  // `ImportEqualsDeclaration` binds the whole module, which converges on
  // the same shape (see module-model.ts's `toImportBinding`).
  return { specifier, kind: "default" };
}

/**
 * Binds a call expression's callee to a canonical `{module, export}`
 * target (see docs/SDD.md § 17), converging the four forms in SDD's own
 * examples onto the same target:
 *
 * ```
 * import { vulnerable as v } from "foo"; v();
 * const { vulnerable } = require("foo"); vulnerable();
 * const foo = require("foo"); foo.vulnerable();
 * import foo from "foo"; foo.vulnerable();
 * ```
 *
 * Only direct destructuring/member access on the import binding itself is
 * supported. Indirection through an intermediate local variable (e.g.
 * `import foo from "foo"; const { vulnerable } = foo;`, or reassigning an
 * imported binding) is full data-flow analysis and explicitly out of MVP
 * scope (docs/SDD.md § 22) — such calls fall through to `"not_an_import"`,
 * not a fabricated target.
 *
 * TAKES NO `ModuleModel` (RWF-046). It used to, and used it for exactly
 * one thing: `imports.find((imp) => imp.localName === calleeText)`. That
 * table is file-wide and name-keyed, so it could not say WHICH
 * declaration bound the name, and the first row spelled the same won
 * every reference in the file — a function-local `require("inner")`
 * resolved to a file-scope `require("outer")`. The parameter is removed
 * rather than left unused so no later caller can reach for it as an
 * authority again. `ModuleModel.imports` remains the right answer to
 * "what does this FILE load" — a different question, still asked by the
 * module-load closure and the loader-construct pass.
 */
export async function bindCallee(
  callee: ts.Expression,
  resolver: ModuleResolver,
  importerFilePath: string,
): Promise<SymbolBindingResult> {
  const shape = analyzeCalleeShape(callee);

  if (shape.dynamicReason) {
    return { kind: "ambiguous", reason: shape.dynamicReason };
  }

  if (!shape.rootIdentifier) {
    return { kind: "not_an_import" };
  }

  const binding = importBindingFor(shape.rootIdentifier);

  if (!binding) {
    return { kind: "not_an_import" };
  }

  let exportedName: string;

  if (binding.kind === "named") {
    // A trailing property chain here (e.g. `vulnerable.someMethod()`) is a
    // method call on the already-bound export's value, not a reference to
    // a different export — the chain is intentionally not consulted.
    exportedName = binding.importedName ?? shape.rootIdentifier.text;
  } else if (binding.kind === "default" || binding.kind === "namespace") {
    const [firstProperty] = shape.propertyChain;
    // No property access at all means the default export / whole module
    // is being called directly (e.g. `module.exports = function () {}`).
    exportedName = firstProperty ?? "default";
  } else {
    return { kind: "not_an_import" };
  }

  const resolution = await resolver.resolve(
    binding.specifier,
    importerFilePath,
  );

  if (resolution.kind === "unresolved") {
    return {
      kind: "unresolved_module",
      specifier: binding.specifier,
      reason: resolution.reason,
    };
  }

  if (resolution.kind === "declaration") {
    return {
      kind: "declaration_only",
      specifier: binding.specifier,
      resolvedFileName: resolution.resolvedFileName,
    };
  }

  if (resolution.kind === "builtin") {
    return {
      kind: "builtin",
      specifier: resolution.specifier,
    };
  }

  return {
    kind: "resolved",
    target: {
      modulePath: resolution.resolvedFileName,
      specifier: binding.specifier,
      exportedName,
    },
  };
}
