// RWF-047 prevalence instrument. Scans a directory tree for the recorded
// shape: a file that binds a require/import to a name and then WRITES a
// member of that binding, by assignment, `delete`, or
// `Object.defineProperty`. It reports every hit with its file and line, so
// the prevalence figures in the RWF-047 record are reproducible rather than
// asserted.
//
// Run:  node tests/binding-grammar/require-member-write-prevalence.mjs <dir>...
//
// Deliberately SYNTACTIC and deliberately over-approximate on the receiver:
// it reports a write to any name bound to a require/import in the same file,
// without proving the write and the later call reach the same object. It is
// a prevalence probe, not an oracle -- the oracles are
// `src/analysis/require-member-write-widening.integration.test.ts` and
// `src/analysis/verdict.require-member-write-authority.integration.test.ts`.

/* global process, console */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const roots = process.argv.slice(2);
const hits = [];
let filesScanned = 0;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(p);
    } else if (/\.(js|cjs|mjs|ts)$/.test(e)) {
      yield p;
    }
  }
}

function scan(file) {
  filesScanned += 1;
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

  // Names bound to a require() call or to an import declaration.
  const moduleBound = new Map(); // localName -> specifier

  const visitBind = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "require" &&
      node.initializer.arguments.length === 1 &&
      ts.isStringLiteral(node.initializer.arguments[0])
    ) {
      moduleBound.set(node.name.text, node.initializer.arguments[0].text);
    }
    if (ts.isImportDeclaration(node) && node.importClause) {
      const spec = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : "?";
      const c = node.importClause;
      if (c.name) moduleBound.set(c.name.text, spec);
      if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) {
        moduleBound.set(c.namedBindings.name.text, spec);
      }
    }
    ts.forEachChild(node, visitBind);
  };
  visitBind(sf);
  if (moduleBound.size === 0) return;

  const record = (kind, receiver, member, node) => {
    const spec = moduleBound.get(receiver);
    if (spec === undefined) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    hits.push({ file, line: line + 1, kind, receiver, spec, member });
  };

  const visitWrite = (node) => {
    // mod.member = ...
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression)
    ) {
      record("assign", node.left.expression.text, node.left.name.text, node);
    }
    // delete mod.member
    if (
      ts.isDeleteExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      record(
        "delete",
        node.expression.expression.text,
        node.expression.name.text,
        node,
      );
    }
    // Object.defineProperty(mod, "member", ...)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      node.expression.name.text === "defineProperty" &&
      node.arguments.length >= 2 &&
      ts.isIdentifier(node.arguments[0])
    ) {
      const key = ts.isStringLiteral(node.arguments[1])
        ? node.arguments[1].text
        : "<computed>";
      record("defineProperty", node.arguments[0].text, key, node);
    }
    ts.forEachChild(node, visitWrite);
  };
  visitWrite(sf);
}

for (const root of roots) {
  for (const f of walk(root)) scan(f);
}

console.log(`files scanned: ${filesScanned}`);
console.log(`hits: ${hits.length}`);
for (const h of hits) {
  console.log(
    `  ${h.kind.padEnd(14)} ${h.receiver}.${h.member}  <- require("${h.spec}")  ${path.relative(process.cwd(), h.file)}:${h.line}`,
  );
}
