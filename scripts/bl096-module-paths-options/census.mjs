// BL-096 corpus census (docs/tasks/BL-096-module-paths-read-only-exemptions.md):
// the two numbers the decision on RWF-136 needs from real code.
//
// 1. USES. How many files use a `Module` instance's lookup list at all --
//    `module.paths`, `require.main.paths`, `process.mainModule.paths`,
//    `module.parent.paths`, `module.children[i].paths` -- split into the
//    uses the loader classifier exempts as read-only and the rest. A file
//    with no use pays nothing under either option.
// 2. OPTION (a)'s PRECONDITION. Option (a) keeps the exemptions only while
//    no loaded file may write a member of a builtin prototype. The escape
//    row of ADR 0008 (BL-081's decision record) already decides, per
//    store, whether a store may write onto an object the program did not
//    create (`escapingAssignmentOf`, `escape-row.ts`); this counts, per
//    package, the files with at least one such assignment. It is a LOWER
//    bound on how often (a)'s precondition fails: builtin calls that store
//    (`Object.defineProperty`, `Object.setPrototypeOf`, `Reflect.set`, ...)
//    and the other store forms (`for…of` heads, declarations, `with`
//    bodies) are not counted.
//
// Usage:
//   node scripts/bl096-module-paths-options/census.mjs [--dist <dir>] [roots...]
//
// `--dist` is a build of the analyzer (default `dist`, from
// `npm run build`); each root is a `node_modules` directory (default the
// repository's own). Every `.js`, `.cjs` and `.mjs` file under each root
// is read, nested `node_modules` included; nothing is executed.

import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const args = process.argv.slice(2);
function option(name) {
  const at = args.indexOf(name);
  if (at < 0) {
    return undefined;
  }
  const [value] = args.splice(at, 2).slice(1);
  return value;
}
const dist = option("--dist") ?? "dist";
const roots = args.length > 0 ? args : ["node_modules"];

const escapeRow = await import(
  pathToFileURL(path.resolve(dist, "code-intelligence/escape-row.js")).href
);

const EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const MAX_FILE_BYTES = 2_000_000;

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

/** The package directory a file belongs to: the path up to its innermost `node_modules/<name>` (scoped names included). */
function packageOf(file) {
  const parts = file.split(path.sep);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length) {
    return "(none)";
  }
  const name = parts[at + 1].startsWith("@")
    ? parts.slice(at + 1, at + 3).join("/")
    : parts[at + 1];
  return parts.slice(0, at + 1).join(path.sep) + path.sep + name;
}

/** Whether `expr` is syntactically a `Module` instance: `module`, `require.main`, `process.mainModule`, `module.parent`, `module.children[i]`. */
function isModuleInstanceSyntax(expr) {
  if (ts.isParenthesizedExpression(expr)) {
    return isModuleInstanceSyntax(expr.expression);
  }
  if (ts.isIdentifier(expr)) {
    return expr.text === "module";
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const owner = expr.expression;
    const name = expr.name.text;
    return (
      (name === "main" && ts.isIdentifier(owner) && owner.text === "require") ||
      (name === "mainModule" &&
        ts.isIdentifier(owner) &&
        owner.text === "process") ||
      (name === "parent" && isModuleInstanceSyntax(owner))
    );
  }
  if (ts.isElementAccessExpression(expr)) {
    return (
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === "children" &&
      isModuleInstanceSyntax(expr.expression.expression)
    );
  }
  return false;
}

const READ_METHODS = new Set([
  "at", "concat", "entries", "flat", "includes", "indexOf", "join", "keys",
  "lastIndexOf", "slice", "toReversed", "toSorted", "toSpliced", "toString",
  "values", "with",
]);

/** How a `<instance>.paths` node is used: `read-method`, `member-read`, `iterated`, `converted`, or `other`. */
function useOf(node) {
  const parent = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === node
  ) {
    const name = ts.isPropertyAccessExpression(parent)
      ? parent.name.text
      : undefined;
    if (
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    ) {
      return name !== undefined && READ_METHODS.has(name)
        ? "read-method"
        : "other";
    }
    return "member-read";
  }
  if (
    (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) &&
    parent.expression === node
  ) {
    return "iterated";
  }
  if (ts.isTemplateSpan(parent) || ts.isBinaryExpression(parent)) {
    return "converted";
  }
  return "other";
}

const totals = {
  files: 0,
  unreadable: 0,
  filesWithListUse: 0,
  uses: { "read-method": 0, "member-read": 0, iterated: 0, converted: 0, other: 0 },
  filesWithEscapingStore: 0,
};
const useSites = [];
const perPackage = new Map();

for (const root of roots) {
  for (const file of walk(root)) {
    let text;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) {
        totals.unreadable += 1;
        continue;
      }
      text = fs.readFileSync(file, "utf8");
    } catch {
      totals.unreadable += 1;
      continue;
    }
    totals.files += 1;
    const pkg = packageOf(file);
    const entry = perPackage.get(pkg) ?? { files: 0, escaping: 0 };
    entry.files += 1;
    perPackage.set(pkg, entry);

    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    let listUse = false;
    let escaping = false;
    const visit = (node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "paths" &&
        isModuleInstanceSyntax(node.expression)
      ) {
        listUse = true;
        const use = useOf(node);
        totals.uses[use] += 1;
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        useSites.push(`${file}:${line + 1} ${use}`);
      }
      if (
        !escaping &&
        ts.isBinaryExpression(node) &&
        escapeRow.escapingAssignmentOf(node, isBuiltin) !== undefined
      ) {
        escaping = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (listUse) {
      totals.filesWithListUse += 1;
    }
    if (escaping) {
      totals.filesWithEscapingStore += 1;
      entry.escaping += 1;
    }
  }
}

const packages = [...perPackage.values()];
const packagesWithEscape = packages.filter((p) => p.escaping > 0).length;
console.log(`roots: ${roots.join(", ")}`);
console.log(`files read: ${totals.files} (skipped: ${totals.unreadable})`);
console.log(`files using a Module instance's lookup list: ${totals.filesWithListUse}`);
console.log(`  uses by kind: ${JSON.stringify(totals.uses)}`);
for (const site of useSites) {
  console.log(`  ${site}`);
}
console.log(
  `files with at least one escaping store (escapingAssignmentOf): ${totals.filesWithEscapingStore} of ${totals.files}`,
);
console.log(
  `packages with at least one such file: ${packagesWithEscape} of ${packages.length}`,
);
