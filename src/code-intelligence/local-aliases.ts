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
 * The initializer of a same-file `const name = <value>;` declaration, or
 * `undefined` when no such declaration exists. `const`-only: a `let`/`var`
 * could be reassigned elsewhere in the file, which this makes no attempt
 * to track. Whole-file search, first-match-wins on a shadowed name -- the
 * same acceptable imprecision `resolveHigherOrderCallTarget` (VT-210) and
 * `findLocalFunctionNodeId` already carry, both already shipped.
 */
export function resolveSingleAssignmentValue(
  name: string,
  sourceFile: ts.SourceFile,
): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  function visit(node: ts.Node): void {
    if (found) {
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      isConstDeclaration(node)
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}
