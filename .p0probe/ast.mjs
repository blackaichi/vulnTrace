// Replicates RWF-024's isDefinitelyAbruptComputedObjectLiteralKey SHAPE
// test (minus the callee proof) to find out whether the destructuring
// assignment-target spelling fails the shape test or the callee proof.
import ts from "typescript";

const snippets = {
  "A02 objlit computed key": `const o = { [bail()]: 1 };`,
  "A21 destructuring target": `let x; ({ [bail()]: x } = HOLDER);`,
  "A21b destructuring target const": `const { [bail()]: y } = HOLDER;`,
  "A26 export write objlit": `module.exports = { k: bail() };`,
};

for (const [label, text] of Object.entries(snippets)) {
  const sf = ts.createSourceFile("t.js", text, ts.ScriptTarget.ES2022, true);
  const hits = [];
  function visit(node) {
    const isElementLike = ts.isObjectLiteralElementLike(node);
    const hasComputed =
      isElementLike && node.name !== undefined && ts.isComputedPropertyName(node.name);
    if (hasComputed) {
      hits.push({
        kind: ts.SyntaxKind[node.kind],
        parentKind: ts.SyntaxKind[node.parent.kind],
        parentIsObjectLiteral: ts.isObjectLiteralExpression(node.parent),
        keyExpr: node.name.expression.getText(sf),
        keyExprKind: ts.SyntaxKind[node.name.expression.kind],
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  console.log(label, "->", hits.length ? JSON.stringify(hits) : "NO COMPUTED-KEY ELEMENT FOUND");
}
