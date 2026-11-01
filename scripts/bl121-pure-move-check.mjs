#!/usr/bin/env node
/**
 * Task BL-121: proves that the split of `src/code-intelligence/module-model.ts`
 * into `module-model.*.ts` is a pure move.
 *
 *   node scripts/bl121-pure-move-check.mjs [<base ref>]   # default: BL-121's base
 *
 * Reads the base commit's `module-model.ts` and this tree's
 * `src/code-intelligence/module-model.ts` and `module-model.*.ts` (test files
 * excluded), and checks, with the TypeScript parser:
 *
 * 1. Every top-level statement of the base file other than its imports is
 *    found in exactly one of the new files, byte-identical with its leading
 *    comments (leading blank lines aside), and every top-level statement of
 *    the new files that is not an import, an export list (`export { … };`,
 *    `export type { … };`, with or without `from`) is one of them: nothing
 *    added, nothing lost, nothing edited, nothing duplicated.
 * 2. Within each new file the moved statements keep the base file's order.
 * 3. The only comment that is not a moved statement's own is each new
 *    file's header, which precedes its first import.
 * 4. `module-model.ts` exports exactly the names the base file exported,
 *    with the same value-or-type meaning (the TypeScript checker's view of
 *    the module's exports).
 * 5. The import graph of the new files, value imports only, is acyclic
 *    (type-only imports are erased under `verbatimModuleSyntax`).
 * 6. No split file imports a value from `module-model.ts`: only its public
 *    types come back to it.
 *
 * Exit 0 when every check holds; 1 with the differences otherwise.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const BASE = process.argv[2] ?? "a337f82d9714a3f5b224bcf828e5a46727419e80";
const dir = "src/code-intelligence";
const failures = [];
const fail = (m) => failures.push(m);

const baseText = execFileSync("git", ["show", `${BASE}:${dir}/module-model.ts`], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const files = readdirSync(dir)
  .filter((f) => /^module-model(\.[a-z-]+)?\.ts$/.test(f) && !f.endsWith(".test.ts"))
  .sort();

const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const isExportList = (s) => ts.isExportDeclaration(s) && s.exportClause !== undefined && ts.isNamedExports(s.exportClause);
/** A statement's text with its leading comments, leading blank lines removed. */
const fullText = (sf, s) => sf.getFullText().slice(s.getFullStart(), s.getEnd()).replace(/^\s*\n/, "");

// 1. the multiset of moved statements
const baseSf = parse("base.ts", baseText);
const baseStatements = baseSf.statements.filter((s) => !ts.isImportDeclaration(s));
const remaining = new Map(); // text -> base index
baseStatements.forEach((s, i) => {
  const t = fullText(baseSf, s);
  if (remaining.has(t)) fail(`base file has a duplicated statement at index ${i}`);
  remaining.set(t, i);
});
const found = new Map(); // base index -> file
const valueImports = new Map(); // file -> Set(file)
for (const f of files) {
  const text = readFileSync(path.join(dir, f), "utf8");
  const sf = parse(f, text);
  let lastIndex = -1;
  let seenNonImport = false;
  valueImports.set(f, new Set());
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s)) {
      if (seenNonImport) fail(`${f}: an import after the moved statements`);
      const spec = s.moduleSpecifier.text;
      const typeOnly = s.importClause?.isTypeOnly === true;
      if (!typeOnly && spec.startsWith("./module-model")) valueImports.get(f).add(spec.slice(2).replace(/\.js$/, ".ts"));
      continue;
    }
    if (isExportList(s)) {
      // export lists: the facade's re-exports and each file's own list
      if (!s.isTypeOnly && s.moduleSpecifier) valueImports.get(f).add(s.moduleSpecifier.text.slice(2).replace(/\.js$/, ".ts"));
      const leading = sf.getFullText().slice(s.getFullStart(), s.getStart(sf));
      if (leading.trim() !== "") fail(`${f}: a comment before an export list: ${leading.trim().slice(0, 80)}`);
      continue;
    }
    seenNonImport = true;
    const t = fullText(sf, s);
    if (!remaining.has(t)) {
      fail(`${f}: statement not in the base file (edited or added): ${s.getText(sf).split("\n")[0].slice(0, 100)}`);
      continue;
    }
    const i = remaining.get(t);
    if (found.has(i)) fail(`${f}: statement ${i} moved twice (also in ${found.get(i)})`);
    found.set(i, f);
    // 2. order within the file
    if (i < lastIndex) fail(`${f}: statement ${i} out of the base order (after ${lastIndex})`);
    lastIndex = i;
  }
  // 3. the only other comment is the header before the first import
  const firstImport = sf.statements.find(ts.isImportDeclaration);
  if (f !== "module-model.ts") {
    const header = firstImport ? sf.getFullText().slice(0, firstImport.getStart(sf)).trim() : "";
    if (!header.startsWith("/**") || !header.includes("task BL-121")) fail(`${f}: no BL-121 header before its imports`);
  }
  for (const s of sf.statements.filter(ts.isImportDeclaration)) {
    if (s === firstImport) continue;
    const leading = sf.getFullText().slice(s.getFullStart(), s.getStart(sf));
    if (leading.trim() !== "") fail(`${f}: a comment before a non-first import`);
  }
  const tail = sf.getFullText().slice(sf.statements.at(-1)?.getEnd() ?? 0);
  if (tail.trim() !== "") fail(`${f}: trailing content after the last statement`);
}
baseStatements.forEach((s, i) => {
  if (!found.has(i)) fail(`base statement ${i} missing: ${s.getText(baseSf).split("\n")[0].slice(0, 100)}`);
});

// 4. the facade's exports, by the checker
function exportsOf(fileName, host) {
  const program = ts.createProgram([fileName], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
  }, host);
  const checker = program.getTypeChecker();
  const sym = checker.getSymbolAtLocation(program.getSourceFile(fileName));
  return new Map(
    checker.getExportsOfModule(sym).map((e) => {
      const target = e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e;
      return [e.name, target.flags & ts.SymbolFlags.Value ? "value" : "type"];
    }),
  );
}
const facadePath = path.resolve(dir, "module-model.ts");
const headExports = exportsOf(facadePath);
const baseHost = ts.createCompilerHost({});
const realRead = baseHost.readFile;
baseHost.readFile = (p) => (path.resolve(p) === facadePath ? baseText : realRead(p));
const baseGetSf = baseHost.getSourceFile;
baseHost.getSourceFile = (p, lang, ...rest) =>
  path.resolve(p) === facadePath ? ts.createSourceFile(p, baseText, lang, true) : baseGetSf(p, lang, ...rest);
const baseExports = exportsOf(facadePath, baseHost);
for (const [n, k] of baseExports) {
  if (!headExports.has(n)) fail(`module-model.ts no longer exports ${n}`);
  else if (headExports.get(n) !== k) fail(`module-model.ts exports ${n} as a ${headExports.get(n)}, was a ${k}`);
}
for (const n of headExports.keys()) if (!baseExports.has(n)) fail(`module-model.ts newly exports ${n}`);

// 5. value-import graph acyclic
const state = new Map();
const stack = [];
function dfs(f) {
  state.set(f, 1);
  stack.push(f);
  for (const g of valueImports.get(f) ?? []) {
    if (state.get(g) === 1) fail(`value-import cycle: ${[...stack.slice(stack.indexOf(g)), g].join(" -> ")}`);
    else if (!state.has(g)) dfs(g);
  }
  stack.pop();
  state.set(f, 2);
}
for (const f of files) if (!state.has(f)) dfs(f);
// 6. the split files take only types from module-model.ts
for (const f of files) {
  if (f !== "module-model.ts" && valueImports.get(f).has("module-model.ts")) {
    fail(`${f} imports a value from module-model.ts`);
  }
}

console.log(
  `base ${BASE.slice(0, 7)}: ${baseStatements.length} statements; ${files.length} files; ` +
    `${found.size} statements found; module-model.ts exports ${headExports.size} names (base ${baseExports.size})`,
);
if (failures.length) {
  for (const m of failures) console.log(`FAIL ${m}`);
  process.exit(1);
}
console.log("OK: a pure move");
