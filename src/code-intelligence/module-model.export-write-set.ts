/**
 * The export write set (task E-1; ADR 0009 § 1, § 2): every write a file
 * makes to its own export objects, in order, and how it is applied to the
 * file's export bindings.
 *
 * Split out of `module-model.ts` by concern, as a pure move (task BL-121):
 * the declarations below are those of that file, unchanged and in its order.
 * `module-model.ts` re-exports the public ones.
 */
import ts from "typescript";
import {
  commonJsPropertyExportRhs,
  isModuleExportsAssignmentTarget,
  unwrapParentheses,
  unwrapValue,
} from "./commonjs-reexports.js";
import {
  isNameAssignedWithin,
  lexicalDeclarationOf,
} from "./named-bindings.js";
import type { SourceIndex } from "./source-index.js";
import type { ExportBinding } from "./module-model.js";
import {
  isStaticClassElement,
  assignmentChainOf,
  isAmbientReference,
} from "./module-model.syntax.js";
import { competingWriteSites } from "./module-model.competing-write-sites.js";
import { topLevelStatementIndex } from "./module-model.competing-writes.js";
import type { ModuleExportsAssignment } from "./module-model.export-provenance.js";
import { classifyExportReference } from "./module-model.export-references.js";
import type {
  ThisContext,
  MethodSource,
  ExportReference,
  ExportPropertyWrite,
} from "./module-model.export-references.js";
import { finalObjectAliasUses } from "./module-model.final-object.js";
import {
  finalObjectRouteUses,
  exportMethodOwners,
} from "./module-model.own-object-routes.js";
import { moduleAliasIsInert } from "./module-model.export-methods.js";
import { classTakesWrite } from "./module-model.alias-summaries.js";
import { loadResultEscapes } from "./module-model.load-result-escape.js";
import type { LoadReach } from "./module-model.load-result-escape.js";

/** {@link exportWriteSet}'s answer. */
interface ExportWriteSet {
  /** A reference no kind enumerates: every name of the file is withdrawn. */
  readonly unenumerable: boolean;
  /**
   * A route to a function or class the final object may be is handed on
   * (BL-084): any name may be written onto it, so every named export is
   * withdrawn; the whole-module value itself is not replaced.
   */
  readonly propertiesUnenumerable: boolean;
  /** Names a write the effective-write rule cannot order may set. */
  readonly withdrawn: ReadonlySet<string>;
  /** Every module-time `=` property write, in source order. */
  readonly propertyWrites: readonly ExportPropertyWrite[];
  /** Every `exports = …` rebinding at module time. */
  readonly rebindings: readonly ts.BinaryExpression[];
  /**
   * A `whole-module-write` anywhere (`module.exports = v`, at module time or
   * later). The CommonJS walk orders these itself
   * ({@link collectModuleExportsAssignments}); an ES module's own exports
   * are replaced by any of them (task BL-105, {@link withdrawOverwrittenEsmExports}).
   */
  readonly wholeModuleWritten: boolean;
}

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
  let wholeModuleWritten = false;
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
        return;
      case "whole-module-write":
        wholeModuleWritten = true;
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

  // A function or class the final object may be is also reached without
  // its name (BL-084: `arguments.callee`, `new.target`, `constructor`,
  // `caller`): each route is censused like the binding. One handed on can
  // write any name onto the function, but cannot replace `module.exports`.
  let propertiesUnenumerable = false;
  if (!unenumerable) {
    const routed = finalObjectRouteUses(sourceFile);
    if (routed === "all") {
      propertiesUnenumerable = true;
    } else if (routed !== undefined) {
      for (const name of routed.names) withdrawn.add(name);
      for (const written of routed.values) {
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

  const set = {
    unenumerable,
    propertiesUnenumerable,
    withdrawn,
    propertyWrites,
    rebindings,
    wholeModuleWritten,
  };
  exportWriteSetBySourceFile.set(sourceFile, set);
  return set;
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
 *
 * Then {@link withdrawOverwrittenEsmExports}: the same write set gates an
 * ES module's own exports (task BL-105).
 */
function applyExportWriteSet(
  index: SourceIndex,
  results: ExportBinding[],
  authoritative: ModuleExportsAssignment | undefined,
  wholeModuleWrites: number,
  literalDefinitions: ReadonlySet<ExportBinding>,
  reach: LoadReach | undefined,
): ExportBinding[] {
  return withdrawOverwrittenEsmExports(
    index,
    applyCommonJsExportWriteSet(
      index,
      results,
      authoritative,
      wholeModuleWrites,
      literalDefinitions,
      reach,
    ),
    reach,
  );
}

/**
 * Task BL-105 (RWF-150): an ES module compiled to CommonJS (TypeScript's
 * `module: commonjs`) publishes each export as a property of the wrapper's
 * `exports` object (`exports.dec = dec`), and an importer reads that
 * property at each use (`(0, decs_1.dec)()`). A write the file itself
 * makes onto its export objects -- `(exports as any).dec = v`, through an
 * alias, `Object.defineProperty`, `module.exports = v` -- replaces what the
 * importer reads, so the declaration is not the export's value.
 *
 * Withdrawn, toward an unresolved target, by E-1's census
 * ({@link exportWriteSet}), whatever the order of the write and the
 * declaration (TypeScript hoists a function's `exports.dec = dec` above
 * every statement, and a variable's runs at its declaration):
 *
 * - every ES export, when the census meets a reference it cannot
 *   enumerate, a rebinding of `exports`, any `module.exports` write, or a
 *   load result that may be this file's exports handed where it cannot
 *   follow;
 * - otherwise each ES export whose name a write may set, and a CommonJS
 *   binding of a name an ES export also publishes, whose order against
 *   the emitted write is not this walk's.
 *
 * A file Node runs as a real ES module has no `exports` binding (a write
 * through it throws, or reaches a global): the withdrawal is then a
 * precision cost, never an invented binding.
 */
function withdrawOverwrittenEsmExports(
  index: SourceIndex,
  results: ExportBinding[],
  reach: LoadReach | undefined,
): ExportBinding[] {
  if (!results.some((binding) => binding.syntax === "esm")) {
    return results;
  }
  const sourceFile = index.sourceFile;
  const set = exportWriteSet(sourceFile);
  // `set.propertiesUnenumerable` (BL-084's routes) needs a whole-module
  // value, which `wholeModuleWritten` already withdraws every name for.
  const everyName =
    set.unenumerable ||
    set.wholeModuleWritten ||
    set.rebindings.length > 0 ||
    loadResultEscapes(sourceFile, reach);
  const written = new Set(set.withdrawn);
  for (const write of set.propertyWrites) written.add(write.name);
  const nameOf = (binding: ExportBinding): string | undefined =>
    binding.kind === "default" ? "default" : binding.exportedName;
  const esmNames = new Set(
    results
      .filter((binding) => binding.syntax === "esm")
      .map(nameOf)
      .filter((name) => name !== undefined),
  );
  return results.map((binding) => {
    if (binding.exportAttributionWithdrawn === true) {
      return binding;
    }
    const name = nameOf(binding);
    const overwritten =
      binding.syntax === "esm"
        ? everyName || (name !== undefined && written.has(name))
        : name !== undefined && esmNames.has(name);
    if (!overwritten) {
      return binding;
    }
    // A re-export keeps its specifier (the module it loads); the hop
    // refuses a withdrawn one (export-forwarding.ts).
    return {
      kind: binding.kind,
      syntax: binding.syntax,
      exportedName: binding.exportedName,
      ...(binding.kind === "re-export" ? { specifier: binding.specifier } : {}),
      exportAttributionWithdrawn: true,
      location: binding.location,
    };
  });
}

/** {@link applyExportWriteSet}'s CommonJS half: task E-1's walk. */
function applyCommonJsExportWriteSet(
  index: SourceIndex,
  results: ExportBinding[],
  authoritative: ModuleExportsAssignment | undefined,
  wholeModuleWrites: number,
  literalDefinitions: ReadonlySet<ExportBinding>,
  reach: LoadReach | undefined,
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
  // BL-074 (RWF-103, RWF-106): a load's result that may be an export
  // object of this file, handed where the census cannot follow it, may be
  // written there under any name -- the whole-module re-export's forward
  // included.
  if (set.unenumerable || loadResultEscapes(sourceFile, reach)) {
    return results.map((binding) =>
      binding.syntax === "commonjs" && binding.kind !== "re-export"
        ? withdrawnBinding(binding)
        : binding,
    );
  }
  if (set.propertiesUnenumerable) {
    // BL-084: every name may be written onto the function the final object
    // may be; a whole-module forward is withdrawn too, since the names it
    // would answer for are no longer enumerable.
    return results.map((binding) =>
      binding.syntax === "commonjs" &&
      (binding.kind === "named" || binding.commonJsReExport !== undefined)
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

export { applyExportWriteSet };
