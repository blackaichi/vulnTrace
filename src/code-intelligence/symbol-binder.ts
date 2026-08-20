import ts from "typescript";
import type { DynamicCallReason } from "../domain/graph.js";
import type { ModuleModel } from "./module-model.js";
import type { ModuleResolver } from "./module-resolver.js";

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

/** The callee does not reference an imported binding at all (e.g. a call to a locally-defined function). */
export interface SymbolBindingNotAnImport {
  readonly kind: "not_an_import";
}

export type SymbolBindingResult =
  | SymbolBindingResolved
  | SymbolBindingAmbiguous
  | SymbolBindingUnresolvedModule
  | SymbolBindingDeclarationOnly
  | SymbolBindingNotAnImport;

interface CalleeShape {
  readonly rootIdentifier?: string;
  readonly propertyChain: readonly string[];
  readonly dynamicReason?: DynamicCallReason;
}

function analyzeCalleeShape(callee: ts.Expression): CalleeShape {
  if (ts.isIdentifier(callee)) {
    return { rootIdentifier: callee.text, propertyChain: [] };
  }

  if (ts.isPropertyAccessExpression(callee)) {
    const chain: string[] = [];
    let current: ts.Expression = callee;
    while (ts.isPropertyAccessExpression(current)) {
      chain.unshift(current.name.text);
      current = current.expression;
    }
    if (ts.isIdentifier(current)) {
      return { rootIdentifier: current.text, propertyChain: chain };
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
        rootIdentifier: callee.expression.text,
        propertyChain: [callee.argumentExpression.text],
      };
    }
    // foo[method]() — genuinely dynamic; must not fabricate an edge.
    return { propertyChain: [], dynamicReason: "dynamic_member_access" };
  }

  return { propertyChain: [] };
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
 */
export async function bindCallee(
  callee: ts.Expression,
  moduleModel: ModuleModel,
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

  const binding = moduleModel.imports.find(
    (imp) => imp.localName === shape.rootIdentifier,
  );

  if (!binding) {
    return { kind: "not_an_import" };
  }

  let exportedName: string;

  if (binding.kind === "named") {
    // A trailing property chain here (e.g. `vulnerable.someMethod()`) is a
    // method call on the already-bound export's value, not a reference to
    // a different export — the chain is intentionally not consulted.
    exportedName = binding.importedName ?? shape.rootIdentifier;
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

  return {
    kind: "resolved",
    target: {
      modulePath: resolution.resolvedFileName,
      specifier: binding.specifier,
      exportedName,
    },
  };
}
