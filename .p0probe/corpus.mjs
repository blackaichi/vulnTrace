// Real-world corpus sweep. Over every vendored .js/.cjs/.mjs file in the
// repository's fixtures (real installed packages), measure:
//   1. files scanned;
//   2. files with a module-reachable call to a LOCAL always-throwing
//      top-level callable (the RWF-016 callee proof, replicated);
//   3. of those, which syntactic POSITION the call sits in -- modeled by
//      the merged RWF chain, or one of the P0-A gap positions;
//   4. files that additionally have a LATER whole-module/property export
//      write, i.e. the shape where the gap can actually change a verdict.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOTS = ["fixtures", "tests/validation/fixtures"];
const files = [];

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p);
    } else if (/\.(js|cjs|mjs)$/.test(e.name)) {
      files.push(p);
    }
  }
}
for (const r of ROOTS) walk(r);

// --- replicate the RWF-016 callee proof, narrowly ---
function alwaysThrows(fn) {
  const body = fn.body;
  if (body === undefined || !ts.isBlock(body)) return false;
  const stmts = body.statements;
  return stmts.length === 1 && ts.isThrowStatement(stmts[0]);
}

function topLevelThrowers(sf) {
  const map = new Map();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && alwaysThrows(st)) {
      map.set(st.name.text, st);
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.initializer &&
          (ts.isFunctionExpression(d.initializer) ||
            ts.isArrowFunction(d.initializer)) &&
          alwaysThrows(d.initializer)
        ) {
          map.set(d.name.text, d.initializer);
        }
      }
    }
  }
  return map;
}

// Positions the merged RWF-015..024 chain already models.
const MODELED = new Set([
  "ExpressionStatement",
  "VariableStatement-initializer",
  "ThrowStatement-direct",
  "ClassStaticField-initializer",
  "ClassElement-computedKey",
  "ObjectLiteralElement-computedKey",
  "ClassHeritage",
]);

function positionOf(call) {
  let n = call;
  // climb out of parentheses
  while (n.parent && ts.isParenthesizedExpression(n.parent)) n = n.parent;
  const p = n.parent;
  if (!p) return "Unknown";
  if (ts.isExpressionStatement(p)) return "ExpressionStatement";
  if (ts.isVariableDeclaration(p) && p.initializer === n)
    return "VariableStatement-initializer";
  if (ts.isThrowStatement(p)) return "ThrowStatement-direct";
  if (ts.isComputedPropertyName(p)) {
    const el = p.parent;
    if (el && el.parent && ts.isObjectLiteralExpression(el.parent))
      return "ObjectLiteralElement-computedKey";
    return "ClassElement-computedKey";
  }
  if (ts.isPropertyDeclaration(p) && p.initializer === n)
    return "ClassStaticField-initializer";
  if (ts.isExpressionWithTypeArguments(p)) return "ClassHeritage";
  // --- P0-A gap positions ---
  if (ts.isPropertyAssignment(p)) return "GAP:objectLiteral-value";
  if (ts.isArrayLiteralExpression(p)) return "GAP:array-element";
  if (ts.isCallExpression(p) && p.arguments.includes(n))
    return "GAP:call-argument";
  if (ts.isNewExpression(p)) return "GAP:new-argument";
  if (ts.isTemplateSpan(p)) return "GAP:template-substitution";
  if (ts.isBinaryExpression(p))
    return p.left === n ? "GAP:binary-left" : "GAP:binary-right";
  if (ts.isSpreadElement(p) || ts.isSpreadAssignment(p)) return "GAP:spread";
  if (ts.isPropertyAccessExpression(p)) return "GAP:property-access";
  if (ts.isElementAccessExpression(p)) return "GAP:element-access";
  if (ts.isIfStatement(p) && p.expression === n) return "GAP:if-test";
  if (ts.isSwitchStatement(p)) return "GAP:switch-discriminant";
  if (ts.isConditionalExpression(p))
    return p.condition === n ? "GAP:conditional-test" : "SAFE:conditional-branch";
  return "GAP:other-" + ts.SyntaxKind[p.kind];
}

const positionCounts = new Map();
let scanned = 0;
let filesWithThrower = 0;
let filesWithGapOccurrence = 0;
let filesWithGapAndLaterExport = 0;
const examples = [];

for (const f of files) {
  scanned++;
  let text;
  try {
    text = fs.readFileSync(f, "utf-8");
  } catch {
    continue;
  }
  if (!/throw/.test(text)) continue;
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.ES2022, true);
  const throwers = topLevelThrowers(sf);
  if (throwers.size === 0) continue;
  filesWithThrower++;

  let sawGap = false;
  const gapPositions = [];
  // Walk module-reachable region: skip function bodies, like the analyzer.
  function visit(node, inFn) {
    if (ts.isFunctionLike(node)) inFn = true;
    if (
      !inFn &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      throwers.has(node.expression.text)
    ) {
      const pos = positionOf(node);
      positionCounts.set(pos, (positionCounts.get(pos) ?? 0) + 1);
      if (pos.startsWith("GAP:")) {
        sawGap = true;
        gapPositions.push(pos);
      }
    }
    ts.forEachChild(node, (c) => visit(c, inFn));
  }
  visit(sf, false);

  if (sawGap) {
    filesWithGapOccurrence++;
    const hasExportWrite = /module\.exports\s*=|exports\.[A-Za-z_$]/.test(text);
    if (hasExportWrite) {
      filesWithGapAndLaterExport++;
      if (examples.length < 12)
        examples.push({ file: f, positions: [...new Set(gapPositions)] });
    }
  }
}

console.log("files scanned:                         ", scanned);
console.log("files with a local always-throws callable:", filesWithThrower);
console.log("files w/ module-reachable call to it:  ", [...positionCounts.values()].reduce((a, b) => a + b, 0), "occurrences");
console.log("files with a GAP-position occurrence:  ", filesWithGapOccurrence);
console.log("...of those, also having export writes:", filesWithGapAndLaterExport);
console.log("\nposition histogram:");
for (const [k, v] of [...positionCounts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)}  ${MODELED.has(k) ? "[modeled]" : k.startsWith("GAP:") ? "[GAP]    " : "[safe]   "} ${k}`);
}
console.log("\nexamples:");
for (const e of examples) console.log(" ", e.file, e.positions.join(","));
