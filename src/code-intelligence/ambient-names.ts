import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * The file-wide NAME questions that decide whether an identifier denotes
 * the ambient binding it is spelled like: every name the file declares in
 * any form, every bare name it writes, and whether a reference sits in a
 * `with` body. Moved unchanged out of `escape-row.ts` by task A-5a, so
 * that the lexical model (`named-bindings.ts`) can ask the same questions
 * about `require` without importing the escape row (ADR 0008 § 2,
 * `AmbientStaticRequire`: "the callee is the *ambient* `require`, proved
 * lexically"; `named-bindings.ts`, `isAmbientStaticRequireCall`). Depends
 * on the compiler, and on the file system only to read the nearest
 * `package.json`'s `"type"` ({@link isProvenCommonJsModuleScope}).
 */

/** Parentheses, type assertions, `!` and `satisfies`, which change no value. */
export function skipOuterExpressions(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Names that denote the global object itself: `globalThis.setTimeout` is `setTimeout`. */
export const GLOBAL_OBJECT_NAMES: ReadonlySet<string> = new Set([
  "globalThis",
  "global",
]);

/** Every name the file declares, in any form, or assigns to as a bare name. */
const fileNamesCache = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

export function declaredOrAssignedNames(
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const cached = fileNamesCache.get(sourceFile);
  if (cached) {
    return cached;
  }
  const names = new Set<string>(assignedNames(sourceFile));
  const visit = (node: ts.Node): void => {
    const name = (node as ts.NamedDeclaration).name;
    if (
      name !== undefined &&
      ts.isIdentifier(name) &&
      (ts.isVariableDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isImportEqualsDeclaration(node) ||
        ts.isImportClause(node) ||
        ts.isImportSpecifier(node) ||
        ts.isNamespaceImport(node))
    ) {
      names.add(name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  fileNamesCache.set(sourceFile, names);
  return names;
}

const assignedNamesCache = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

/**
 * Every bare name the file WRITES, in any assignment form: `x = v` and the
 * compound and logical assignments, a destructuring-assignment target
 * (`({ x } = v)`, `({ a: x } = v)`, `[x] = v`, rest elements), a
 * `for (x of …)` / `for (x in …)` head, and `++x` / `x--`. Task A-3a's
 * independent audit found the first version saw only `x = v`, so
 * `({ URL } = …)` and `for (URL of …)` replaced a global unseen.
 */
export function assignedNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const cached = assignedNamesCache.get(sourceFile);
  if (cached) {
    return cached;
  }
  const names = new Set<string>();
  const target = (raw: ts.Node): void => {
    // Every value-free wrapper, not only a parenthesis: `x! = v` and
    // `(x as T) = v` write `x` too (task A-5a's independent audit).
    const node = ts.isExpression(raw) ? skipOuterExpressions(raw) : raw;
    if (ts.isIdentifier(node)) {
      names.add(node.text);
    } else if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(skipOuterExpressions(node.expression)) &&
      GLOBAL_OBJECT_NAMES.has(
        (skipOuterExpressions(node.expression) as ts.Identifier).text,
      )
    ) {
      // `globalThis.setTimeout = stub` replaces the global binding exactly
      // as `setTimeout = stub` does (task A-3a's re-audit).
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : undefined;
      if (name !== undefined) {
        names.add(name);
      }
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          names.add(property.name.text);
        } else if (ts.isPropertyAssignment(property)) {
          target(property.initializer);
        } else if (ts.isSpreadAssignment(property)) {
          target(property.expression);
        }
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        target(ts.isSpreadElement(element) ? element.expression : element);
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      // A default in a destructuring target: `({ x = 1 } = v)`, `[x = 1] = v`.
      target(node.left);
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      target(node.left);
    } else if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      target(node.initializer);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      target(node.operand);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assignedNamesCache.set(sourceFile, names);
  return names;
}

/** Whether `node` is inside the body of a `with` statement, where any name may be a property of its object. */
export function insideWith(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isWithStatement(current) && current.statement !== node) {
      return true;
    }
  }
  return false;
}

const typeScriptOnlyNamesCache = new WeakMap<
  ts.SourceFile,
  ReadonlySet<string>
>();

/**
 * Every name a TypeScript `enum` or `namespace` (`module`) declaration in
 * the file introduces: the two declaration forms the lexical model
 * (`named-bindings.ts`) does not record, but which bind a runtime value.
 */
export function enumOrNamespaceNames(
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const cached = typeScriptOnlyNamesCache.get(sourceFile);
  if (cached) {
    return cached;
  }
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) &&
      ts.isIdentifier(node.name)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  typeScriptOnlyNamesCache.set(sourceFile, names);
  return names;
}

const commonJsScopeCache = new WeakMap<ts.SourceFile, boolean>();

/**
 * Whether the file's module scope provably holds the CommonJS wrapper's
 * own `require` binding, untouched by anything but a write to its name
 * (which {@link assignedNames} sees). Two ways it does not, both found by
 * task A-5a's independent audit:
 *
 * - The file is an ES module (`.mjs` / `.mts`, ESM syntax -- an `import`
 *   or `export` declaration, `import.meta`, a top-level `await`, a top-level
 *   `let` / `const` / `class` redeclaring a wrapper parameter -- or a nearest `package.json`
 *   with `"type": "module"`). An ES module has no `require` binding at
 *   all: a bare `require` is a lookup on the global object, which any
 *   other module may set (`globalThis.require = …`).
 * - The module scope reads the sloppy wrapper's `arguments`: the wrapper
 *   is `function (exports, require, module, __filename, __dirname)`, so
 *   `arguments[1] = v` -- at top level, or in an arrow function, which
 *   shares it -- rebinds `require` with no assignment to the name. Every
 *   `arguments` with no enclosing non-arrow function counts.
 *
 * A TypeScript file with ESM syntax compiled to CommonJS fails this too:
 * a precision cost, never an invented binding.
 */
export function isProvenCommonJsModuleScope(
  sourceFile: ts.SourceFile,
): boolean {
  const cached = commonJsScopeCache.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  const result =
    !/\.m[jt]s$/i.test(sourceFile.fileName) &&
    !hasModuleSyntaxOrWrapperArguments(sourceFile) &&
    // Only a real location has a nearest `package.json`; a relative name
    // is an in-memory source (a test's `indexSourceFile("a.js", …)`), not
    // a file under the working directory.
    !(
      path.isAbsolute(sourceFile.fileName) &&
      nearestPackageType(path.dirname(sourceFile.fileName)) === "module"
    );
  commonJsScopeCache.set(sourceFile, result);
  return result;
}

/** The CommonJS wrapper's parameters. */
const WRAPPER_PARAMETERS: ReadonlySet<string> = new Set([
  "exports",
  "require",
  "module",
  "__filename",
  "__dirname",
]);

/**
 * Whether a statement directly in the source file is a `let`, `const` or
 * `class` declaration of a wrapper parameter's name. That is a
 * redeclaration SyntaxError inside the CommonJS wrapper, and Node's module
 * syntax detection then runs the file as an ES module (task A-5a's third
 * audit round). A `var`, a `function` or a nested block declaration is
 * valid CommonJS.
 */
function redeclaresWrapperParameter(statement: ts.Statement): boolean {
  if (ts.isClassDeclaration(statement)) {
    return (
      statement.name !== undefined &&
      WRAPPER_PARAMETERS.has(statement.name.text)
    );
  }
  if (
    ts.isVariableStatement(statement) &&
    (statement.declarationList.flags &
      (ts.NodeFlags.Let | ts.NodeFlags.Const)) !==
      0
  ) {
    const names: string[] = [];
    const collect = (name: ts.BindingName): void => {
      if (ts.isIdentifier(name)) {
        names.push(name.text);
      } else {
        for (const element of name.elements) {
          if (ts.isBindingElement(element)) {
            collect(element.name);
          }
        }
      }
    };
    for (const declaration of statement.declarationList.declarations) {
      collect(declaration.name);
    }
    return names.some((name) => WRAPPER_PARAMETERS.has(name));
  }
  return false;
}

function hasModuleSyntaxOrWrapperArguments(sourceFile: ts.SourceFile): boolean {
  if (sourceFile.statements.some(redeclaresWrapperParameter)) {
    return true;
  }
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      (ts.isExportAssignment(node) && !node.isExportEquals) ||
      (ts.isMetaProperty(node) &&
        node.keywordToken === ts.SyntaxKind.ImportKeyword) ||
      // Top-level `await` (and `for await`): Node's module syntax
      // detection runs such a `.js` file as an ES module (task A-5a's
      // re-audit).
      ((ts.isAwaitExpression(node) ||
        (ts.isForOfStatement(node) && node.awaitModifier !== undefined)) &&
        !hasEnclosingFunction(node)) ||
      (ts.canHaveModifiers(node) &&
        ts
          .getModifiers(node)
          ?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
          ) === true) ||
      (ts.isIdentifier(node) &&
        node.text === "arguments" &&
        !(
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name === node
        ) &&
        !hasEnclosingNonArrowFunction(node))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function hasEnclosingFunction(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      return true;
    }
  }
  return false;
}

function hasEnclosingNonArrowFunction(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current) && !ts.isArrowFunction(current)) {
      return true;
    }
  }
  return false;
}

/**
 * The `"type"` of the nearest `package.json` at or above `directory`, or
 * `undefined` when there is none. Read per call, never cached by path
 * (the caller caches per `SourceFile`, which dies with the AST).
 */
function nearestPackageType(directory: string): string | undefined {
  for (let current = directory; ; current = path.dirname(current)) {
    const manifest = path.join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
          type?: unknown;
        };
        return typeof parsed.type === "string" ? parsed.type : undefined;
      } catch {
        // An unreadable manifest proves nothing: not "commonjs" either.
        return "module";
      }
    }
    if (path.dirname(current) === current) {
      return undefined;
    }
  }
}
