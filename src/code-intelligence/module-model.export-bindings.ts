/**
 * Export bindings: the whole-module export's authority, the object-literal
 * exports it unpacks, and every export binding of a file.
 *
 * Split out of `module-model.ts` by concern, as a pure move (task BL-121):
 * the declarations below are those of that file, unchanged and in its order.
 * `module-model.ts` re-exports the public ones.
 */
import ts from "typescript";
import type { SourceLocation } from "../domain/graph.js";
import {
  commonJsModuleReExportOrigin,
  commonJsPropertyExportRhs,
  commonJsPropertyReExportOrigin,
  declaresCommonJsAmbientShadow,
  refusesLocalIdentifierProvenance,
  resolveCommonJsReExportExpression,
  resolveLocalValue,
  unwrapValue,
  type CommonJsReExportOrigin,
} from "./commonjs-reexports.js";
import { isNameAssignedWithin } from "./named-bindings.js";
import {
  exactCommonJsExportPropertyName,
  type IndexedExport,
  type SourceIndex,
  toSourceLocation,
} from "./source-index.js";
import type { ExportBinding } from "./module-model.js";
import { resolveComputedPropertyNameLiteral } from "./module-model.syntax.js";
import { competingWriteSites } from "./module-model.competing-write-sites.js";
import { exportWritesMayFail } from "./module-model.competing-writes.js";
import {
  isDirectFunctionValue,
  directValueFunctionLocation,
  classConstructorNode,
  propertyExportProvenance,
  isDefinitelyReachedExportAssignment,
  isTopLevelExportAssignment,
  isUnconditionalModuleScopeStatement,
} from "./module-model.export-provenance.js";
import type {
  WholeModuleExportAuthority,
  ModuleExportsAssignment,
} from "./module-model.export-provenance.js";
import { applyExportWriteSet } from "./module-model.export-write-set.js";
import type { LoadReach } from "./module-model.load-result-escape.js";

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
  reach: LoadReach | undefined,
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
    reach,
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

export { collectModuleExportsAssignments, buildExportBindings };
