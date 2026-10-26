import ts from "typescript";

/**
 * Same-file `const` alias resolution, shared by the two layers that both
 * need to answer "what value does this local name hold?" without a full
 * dataflow analysis: call-graph.ts (higher-order call targets, VT-210) and
 * loader-constructs.ts (aliased loader detection, VT-307b). Extracted here
 * in VT-307c-fix-3 purely so those two can share one implementation rather
 * than importing each other -- the semantics are unchanged from the
 * original call-graph.ts definitions.
 */

/** Whether `decl` belongs to a `const` declaration list (not `let`/`var`). */
export function isConstDeclaration(decl: ts.VariableDeclaration): boolean {
  const list = decl.parent;
  return (
    ts.isVariableDeclarationList(list) &&
    (list.flags & ts.NodeFlags.Const) !== 0
  );
}

/**
 * Every same-file `const name = <value>;` declaration's initializer,
 * keyed by name, first-match-wins on a shadowed name (pre-order visit
 * order) -- computed ONCE per `sourceFile` and cached in a `WeakMap`, so
 * every subsequent lookup against the same file is an O(1) hash read
 * rather than a fresh O(file-size) traversal.
 *
 * This cache is the reason {@link resolveSingleAssignmentValue} is safe
 * to call from many call sites per file (VT-307c-capability-floor/flow
 * added several dozen new ones -- every call argument, variable
 * initializer, `return`, `throw`, export, and default parameter in a
 * file, not just one classification per construct): before this cache
 * existed, each of those calls re-walked the WHOLE file from scratch,
 * which is O(call sites x file size) -- effectively quadratic, and
 * measured taking 40-60+ SECONDS on a single real-world ~17,000-line
 * file (lodash.js) once VT-307c-capability-flow's new anchor points
 * multiplied the call-site count. That wall-clock cost was severe enough
 * to make the OSV network calls sharing the same event loop look like
 * they were failing/timing out downstream, in `tests/validation`'s real
 * end-to-end suite -- a purely algorithmic problem masquerading as a
 * network one. The cache is keyed on the `ts.SourceFile` object itself
 * (stable for the lifetime of one classification pass over that file),
 * so it never leaks across different files or different scans, and
 * needs no explicit invalidation -- letting the `SourceFile` itself be
 * garbage-collected drops its cache entry along with it.
 */
const constDeclarationsBySourceFile = new WeakMap<
  ts.SourceFile,
  ReadonlyMap<string, ts.Expression>
>();

function constDeclarationsOf(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, ts.Expression> {
  const cached = constDeclarationsBySourceFile.get(sourceFile);
  if (cached) {
    return cached;
  }

  const declarations = new Map<string, ts.Expression>();
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isConstDeclaration(node) &&
      !declarations.has(node.name.text)
    ) {
      declarations.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  constDeclarationsBySourceFile.set(sourceFile, declarations);
  return declarations;
}

/**
 * The initializer of a same-file `const name = <value>;` declaration, or
 * `undefined` when no such declaration exists. `const`-only: a `let`/`var`
 * could be reassigned elsewhere in the file, which this makes no attempt
 * to track. Whole-file search, first-match-wins on a shadowed name -- the
 * same acceptable imprecision `resolveHigherOrderCallTarget` (VT-210) and
 * `findLocalFunctionNodeId` already carry, both already shipped. Backed by
 * {@link constDeclarationsOf}'s per-file cache -- see that function's own
 * doc comment for why the caching exists.
 */
export function resolveSingleAssignmentValue(
  name: string,
  sourceFile: ts.SourceFile,
): ts.Expression | undefined {
  return constDeclarationsOf(sourceFile).get(name);
}

/**
 * Whether `id` sits where it READS or WRITES a binding by its name -- a
 * value position -- rather than where its text is a property name, a key,
 * a label, an exported alias, or the name a declaration introduces.
 *
 * Exclusions only, each one a position the language never resolves as a
 * binding: anything not listed counts. A shorthand property (`{ each }`)
 * and an export specifier without an alias (`export { each }`) DO read the
 * binding and are counted. Over-counting refuses a resolution; missing a
 * reference would let an escaped function's other callers go unseen.
 *
 * Shared by call-graph.ts (escaped-function references) and, since task
 * BL-110, loader-constructs.ts (the uses of a `Module` instance's lookup
 * list), moved here unchanged so neither imports the other. The left of a
 * qualified name counts: `import a = p.x.y` in TypeScript is `var a =
 * p.x.y`, a read of `p`.
 */
export function isValueReferenceName(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === id) ||
    (ts.isQualifiedName(parent) && parent.right === id) ||
    (ts.isMetaProperty(parent) && parent.name === id) ||
    (ts.isBindingElement(parent) && parent.propertyName === id) ||
    (ts.isImportSpecifier(parent) && parent.propertyName === id) ||
    (ts.isExportSpecifier(parent) &&
      parent.propertyName !== undefined &&
      parent.name === id) ||
    ((ts.isLabeledStatement(parent) ||
      ts.isBreakStatement(parent) ||
      ts.isContinueStatement(parent)) &&
      parent.label === id)
  ) {
    return false;
  }
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isJsxAttribute(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent)) &&
    parent.name === id
  ) {
    return false;
  }
  return true;
}
