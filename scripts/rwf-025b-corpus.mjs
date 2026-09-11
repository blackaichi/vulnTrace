// RWF-025b corpus measurement.
//
// Walks every vendored JS/CJS/MJS/TS file reachable from fixtures/ and
// recomputes `collectFacts`'s `reassignedNames` twice over the same visit
// driver: once with the OLD broad `ts.forEachChild(target, markAssigned)`
// traversal, once with the RWF-025b destination/evaluated-subexpression
// split. The difference is the exact set of poison candidates.
//
// Reports counts only — it makes no claim about verdicts, which are
// measured by the fixture suite and the validation baseline.

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOTS = process.argv.slice(2);
if (ROOTS.length === 0) ROOTS.push("fixtures");

const EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"]);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

function isAssignmentOperator(kind) {
  return (
    kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
  );
}

/** The traversal as it stood on main before RWF-025b. */
function oldMark(target, into) {
  if (ts.isIdentifier(target)) {
    into.add(target.text);
    return;
  }
  if (ts.isPropertyAccessExpression(target)) return;
  ts.forEachChild(target, (child) => oldMark(child, into));
}

function unwrapAssignmentTarget(target) {
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

/** The RWF-025b traversal. */
function newMark(target, into) {
  const u = unwrapAssignmentTarget(target);
  if (ts.isIdentifier(u)) {
    into.add(u.text);
    return;
  }
  if (ts.isObjectLiteralExpression(u)) {
    for (const p of u.properties) {
      if (ts.isPropertyAssignment(p)) {
        if (ts.isComputedPropertyName(p.name)) newEval(p.name.expression, into);
        newMark(p.initializer, into);
      } else if (ts.isShorthandPropertyAssignment(p)) {
        into.add(p.name.text);
        if (p.objectAssignmentInitializer)
          newEval(p.objectAssignmentInitializer, into);
      } else if (ts.isSpreadAssignment(p)) {
        newMark(p.expression, into);
      }
    }
    return;
  }
  if (ts.isArrayLiteralExpression(u)) {
    for (const e of u.elements) {
      if (ts.isOmittedExpression(e)) continue;
      if (ts.isSpreadElement(e)) {
        newMark(e.expression, into);
        continue;
      }
      newMark(e, into);
    }
    return;
  }
  if (
    ts.isBinaryExpression(u) &&
    u.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    newMark(u.left, into);
    newEval(u.right, into);
    return;
  }
  if (ts.isElementAccessExpression(u)) {
    newEval(u.expression, into);
    newEval(u.argumentExpression, into);
    return;
  }
  if (ts.isPropertyAccessExpression(u)) {
    newEval(u.expression, into);
    return;
  }
}

function newEval(node, into) {
  if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    newMark(node.left, into);
    newEval(node.right, into);
    return;
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    newMark(node.operand, into);
    return;
  }
  ts.forEachChild(node, (child) => newEval(child, into));
}

const stats = {
  filesScanned: 0,
  filesParsed: 0,
  assignmentTargets: 0,
  nonIdentifierTargets: 0,
  targetsWithIdentifierReferences: 0,
  filesWithPoison: 0,
  poisonNameOccurrences: 0,
  filesWithCommonJsExportLogic: 0,
  poisonFilesWithCommonJsExportLogic: 0,
};
const poisonByFile = new Map();

for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    stats.filesScanned += 1;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let sf;
    try {
      sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    } catch {
      continue;
    }
    stats.filesParsed += 1;

    const hasCjs = /\b(module\.exports|exports\.|require\s*\()/.test(text);
    if (hasCjs) stats.filesWithCommonJsExportLogic += 1;

    const oldNames = new Set();
    const newNames = new Set();

    const targets = [];
    const visit = (node) => {
      if (ts.isBinaryExpression(node)) {
        if (isAssignmentOperator(node.operatorToken.kind)) targets.push(node.left);
      } else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        targets.push(node.operand);
      } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
        if (!ts.isVariableDeclarationList(node.initializer))
          targets.push(node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    for (const target of targets) {
      stats.assignmentTargets += 1;
      if (!ts.isIdentifier(target)) {
        stats.nonIdentifierTargets += 1;
        let refs = 0;
        const countRefs = (n) => {
          if (ts.isIdentifier(n)) refs += 1;
          ts.forEachChild(n, countRefs);
        };
        ts.forEachChild(target, countRefs);
        if (refs > 0) stats.targetsWithIdentifierReferences += 1;
      }
      oldMark(target, oldNames);
      newMark(target, newNames);
    }

    const poison = [...oldNames].filter((n) => !newNames.has(n));
    // Sanity: the new traversal must never record a name the old one did not.
    const widened = [...newNames].filter((n) => !oldNames.has(n));
    if (widened.length > 0) {
      console.error(`WIDENED (unexpected) ${file}: ${widened.join(", ")}`);
      process.exitCode = 1;
    }
    if (poison.length > 0) {
      stats.filesWithPoison += 1;
      stats.poisonNameOccurrences += poison.length;
      if (hasCjs) stats.poisonFilesWithCommonJsExportLogic += 1;
      poisonByFile.set(file, poison);
    }
  }
}

console.log(JSON.stringify(stats, null, 2));
console.log("\nPoison candidates by file:");
if (poisonByFile.size === 0) {
  console.log("  (none)");
} else {
  for (const [file, names] of poisonByFile) {
    console.log(`  ${file}: ${names.join(", ")}`);
  }
}
