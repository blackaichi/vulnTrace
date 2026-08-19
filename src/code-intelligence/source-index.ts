import { readFileSync } from "node:fs";
import ts from "typescript";
import type { GraphNodeKind, SourceLocation } from "../domain/graph.js";
import { SourceFileNotFoundError } from "./source-index-errors.js";

/**
 * Structural class-membership provenance for a {@link IndexedFunction}
 * that is a method or constructor (see VT-301A;
 * docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md RWF-011/R-6). `className` is the
 * enclosing class's own identity — its declared name
 * (`class Lib { ... }`), or, for an anonymous class expression, the same
 * assigned-name inference {@link inferAssignedName} already uses for
 * implicit constructors (`module.exports = class { ... }`,
 * `const Lib = class { ... }`) — never derived from the member's own name,
 * which is exactly the coincidence RWF-011 identified as unsafe.
 *
 * This is real AST parent-child structure, not an inference: a
 * `MethodDeclaration`/`ConstructorDeclaration` can only ever appear as a
 * direct child of a `ClassDeclaration`/`ClassExpression`'s body, so
 * deriving `memberOf` from `node.parent` is exact, not heuristic.
 */
export interface ClassMemberOwnership {
  readonly className: string;
  readonly isStatic: boolean;
}

export interface IndexedFunction {
  readonly kind: GraphNodeKind;
  readonly name?: string;
  readonly isAsync: boolean;
  readonly location: SourceLocation;
  /**
   * Set only for a method or constructor whose enclosing class could be
   * identified (see {@link ClassMemberOwnership}); `undefined` for every
   * other function-like construct (a plain function, a callback, a method
   * on a plain object literal — `{ foo() {} }` is not a class member).
   */
  readonly memberOf?: ClassMemberOwnership;
}

export type ImportBindingKind =
  "default" | "named" | "namespace" | "side-effect" | "commonjs";

/**
 * One binding introduced by an `import` declaration or a `require()` call.
 * `import type`/type-only named-import elements are intentionally excluded
 * — they are erased at compile time and can never be part of a runtime
 * call path (see docs/SDD.md § 15, § 21).
 */
export interface IndexedImport {
  readonly specifier: string;
  readonly bindingKind: ImportBindingKind;
  readonly localName?: string;
  /** The original exported name, when it differs from `localName` (aliasing). */
  readonly importedName?: string;
  readonly location: SourceLocation;
}

export type ExportBindingKind =
  | "named"
  | "default"
  | "re-export"
  | "commonjs-module-exports"
  | "commonjs-exports-property";

/**
 * One export introduced by an `export` declaration/modifier, or a
 * `module.exports`/`exports.foo` CommonJS assignment. `export type`/
 * type-only named-export elements are intentionally excluded (see
 * {@link IndexedImport}).
 */
export interface IndexedExport {
  readonly bindingKind: ExportBindingKind;
  readonly exportedName?: string;
  readonly localName?: string;
  /** The source module, for re-exports (`export { a } from "./x"`). */
  readonly specifier?: string;
  readonly location: SourceLocation;
}

/**
 * The parsed AST plus a flattened structural index for one source file
 * (see docs/SDD.md § 15-18). `sourceFile` is the real TypeScript AST,
 * available for later Code Intelligence tasks (module resolution, symbol
 * binding, call graph) that need deeper traversal than this summary index
 * provides — it is not exposed outside `src/code-intelligence/`
 * (AGENTS.md: "Keep AST/parser implementation behind analysis interfaces").
 */
export interface SourceIndex {
  readonly filePath: string;
  readonly sourceFile: ts.SourceFile;
  readonly functions: readonly IndexedFunction[];
  readonly imports: readonly IndexedImport[];
  readonly exports: readonly IndexedExport[];
}

/** Shared by other code-intelligence modules that need to locate AST nodes (e.g. module-model.ts). */
export function toSourceLocation(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): SourceLocation {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return { file: sourceFile.fileName, line: line + 1, column: character + 1 };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
  );
}

function isAsyncFunction(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.AsyncKeyword);
}

/**
 * A function/arrow expression passed directly as a call argument is a
 * "callback" (see docs/SDD.md § 18); one assigned to a name is a
 * "function". This mirrors the domain distinction in
 * src/domain/graph.ts's `GraphNodeKind`, not an arbitrary heuristic.
 */
function functionKind(
  node:
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction,
): GraphNodeKind {
  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }
  if (ts.isMethodDeclaration(node)) {
    return "method";
  }
  if (ts.isFunctionDeclaration(node)) {
    return "function";
  }

  const parent = node.parent as ts.Node | undefined;
  if (
    parent &&
    ts.isCallExpression(parent) &&
    parent.arguments.includes(node)
  ) {
    return "callback";
  }
  return "function";
}

function inferAssignedName(node: ts.Node): string | undefined {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) {
    return undefined;
  }
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (
    (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    if (ts.isPropertyAccessExpression(parent.left)) {
      return parent.left.name.text;
    }
    if (ts.isIdentifier(parent.left)) {
      return parent.left.text;
    }
  }
  // A constructor has no `ts.Node#name` of its own -- see VT-207
  // (SDD-v0.2.md § 7.2): its "name" is its enclosing class's name
  // (`export class Vulnerable { constructor() {} }` exports "Vulnerable",
  // not the constructor). For an anonymous class, fall through to the
  // class's own assigned name (`const Foo = class { constructor() {} }`,
  // `module.exports = class { constructor() {} }`), reusing the same
  // variable/assignment-target cases above by recursing one level.
  if (
    ts.isConstructorDeclaration(node) &&
    (ts.isClassDeclaration(parent) || ts.isClassExpression(parent))
  ) {
    return parent.name ? parent.name.text : inferAssignedName(parent);
  }
  return undefined;
}

function classHasOwnConstructor(
  node: ts.ClassDeclaration | ts.ClassExpression,
): boolean {
  return node.members.some((member) => ts.isConstructorDeclaration(member));
}

/**
 * A class relying on the implicit/default constructor (no explicit
 * `constructor() {}` of its own -- extremely common; most classes don't
 * need constructor logic) has no corresponding AST node at all --
 * TypeScript's parser never synthesizes one (see VT-215, SDD-v0.2.md
 * § 7.2). Without an entry here, `new SomeClass()` for such a class can
 * never resolve to any graph node, degrading to an
 * `unknown(unresolved_target)` edge that has nothing to do with whatever
 * else the call graph is actually trying to determine, and can spuriously
 * block an otherwise-confirmed `unreachable` conclusion elsewhere in the
 * same search (see ADV2-041, tests/adversarial-v2/).
 *
 * Synthesizing this entry is safe: its `location` (the class's own
 * name-identifier position) corresponds to no real `ConstructorDeclaration`
 * node, so `walkFile`'s traversal can never treat it as a `from` context
 * to visit further calls from -- an implicit constructor provably does
 * nothing, and this entry can never acquire outgoing edges of its own.
 * Named the same way an explicit constructor already is (see
 * {@link inferAssignedName}): the enclosing class's own name.
 */
/**
 * Builds a {@link ClassMemberOwnership}, or `undefined` when the enclosing
 * class has no derivable identity at all (e.g. a fully anonymous class
 * expression with no name and no assignment target — genuinely
 * unattributable, not a bug in this derivation).
 */
function classMemberOwnership(
  className: string | undefined,
  isStatic: boolean,
): ClassMemberOwnership | undefined {
  return className ? { className, isStatic } : undefined;
}

function extractImplicitConstructor(
  sourceFile: ts.SourceFile,
  node: ts.ClassDeclaration | ts.ClassExpression,
): IndexedFunction {
  const name = node.name ? node.name.text : inferAssignedName(node);
  return {
    kind: "constructor",
    name,
    isAsync: false,
    location: toSourceLocation(sourceFile, node.name ?? node),
    // An implicit constructor is itself the class's own member (VT-301A):
    // recorded the same way an explicit constructor below is, for
    // consistency, even though canonical-export attribution
    // (mapExportsToFunctions) already resolves constructor targets via
    // the class's own name directly and does not need this field.
    memberOf: classMemberOwnership(name, false),
  };
}

/**
 * A `MethodDeclaration`/`ConstructorDeclaration` can only ever appear as a
 * direct child of a `ClassDeclaration`/`ClassExpression`'s body — real AST
 * structure, not an inference (VT-301A). Returns `undefined` for every
 * other function-like construct (plain functions, callbacks, methods on a
 * plain object literal), which are not class members at all.
 */
function classMembershipOf(
  node:
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction,
): ClassMemberOwnership | undefined {
  if (!ts.isMethodDeclaration(node) && !ts.isConstructorDeclaration(node)) {
    return undefined;
  }
  const parent = node.parent as ts.Node | undefined;
  if (
    !parent ||
    (!ts.isClassDeclaration(parent) && !ts.isClassExpression(parent))
  ) {
    return undefined;
  }
  const className = parent.name ? parent.name.text : inferAssignedName(parent);
  const isStatic =
    ts.isMethodDeclaration(node) &&
    hasModifier(node, ts.SyntaxKind.StaticKeyword);
  return classMemberOwnership(className, isStatic);
}

function extractFunction(
  sourceFile: ts.SourceFile,
  node:
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction,
): IndexedFunction {
  // A function/method/function-expression's own declared name (e.g. the
  // "main" in `function main() {}`) takes precedence over the name of
  // whatever it happens to be assigned to — otherwise
  // `module.exports = function main() {}` would misreport the name as
  // "exports" (the assignment target) instead of "main".
  const ownName =
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node)) &&
    node.name
      ? node.name.getText(sourceFile)
      : undefined;
  const name = ownName ?? inferAssignedName(node);

  return {
    kind: functionKind(node),
    name,
    isAsync: isAsyncFunction(node),
    location: toSourceLocation(sourceFile, node),
    memberOf: classMembershipOf(node),
  };
}

function isRequireCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
    return false;
  }
  if (node.expression.text !== "require" || node.arguments.length !== 1) {
    return false;
  }
  const [firstArgument] = node.arguments;
  return firstArgument !== undefined && ts.isStringLiteral(firstArgument);
}

/**
 * Extracts CommonJS `require()` bindings. Only the two common,
 * unambiguous forms are unpacked into named bindings: a direct identifier
 * assignment (`const foo = require("foo")`) and a direct object
 * destructure (`const { a, b: c } = require("foo")`). Anything else —
 * deep member access (`require("foo").bar.baz`), array destructuring, a
 * require expression nested in a larger expression — is recorded as a
 * side-effect-only `require` of its specifier, without fabricating a
 * binding this task cannot confidently attribute. Converging these forms
 * onto the same semantic target (docs/SDD.md § 17) is TASK-017 (Symbol
 * Binding)'s job, not this structural index's.
 */
function extractRequireBindings(
  sourceFile: ts.SourceFile,
  call: ts.CallExpression,
): IndexedImport[] {
  const specifier = (call.arguments[0] as ts.StringLiteral).text;
  const parent = call.parent as ts.Node | undefined;

  if (
    parent &&
    ts.isVariableDeclaration(parent) &&
    parent.initializer === call
  ) {
    if (ts.isIdentifier(parent.name)) {
      return [
        {
          specifier,
          bindingKind: "commonjs",
          localName: parent.name.text,
          location: toSourceLocation(sourceFile, call),
        },
      ];
    }

    if (ts.isObjectBindingPattern(parent.name)) {
      const bindings: IndexedImport[] = [];
      for (const element of parent.name.elements) {
        if (ts.isIdentifier(element.name) && !element.dotDotDotToken) {
          const importedName =
            element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : element.name.text;
          bindings.push({
            specifier,
            bindingKind: "commonjs",
            localName: element.name.text,
            importedName,
            location: toSourceLocation(sourceFile, element),
          });
        }
      }
      if (bindings.length > 0) {
        return bindings;
      }
    }
  }

  return [
    {
      specifier,
      bindingKind: "commonjs",
      location: toSourceLocation(sourceFile, call),
    },
  ];
}

function extractEsmImport(
  sourceFile: ts.SourceFile,
  node: ts.ImportDeclaration,
): IndexedImport[] {
  if (!ts.isStringLiteral(node.moduleSpecifier)) {
    return [];
  }

  const specifier = node.moduleSpecifier.text;
  const clause = node.importClause;

  if (!clause) {
    return [
      {
        specifier,
        bindingKind: "side-effect",
        location: toSourceLocation(sourceFile, node),
      },
    ];
  }

  if (clause.isTypeOnly) {
    return [];
  }

  const imports: IndexedImport[] = [];

  if (clause.name) {
    imports.push({
      specifier,
      bindingKind: "default",
      localName: clause.name.text,
      location: toSourceLocation(sourceFile, clause.name),
    });
  }

  const namedBindings = clause.namedBindings;
  if (namedBindings && ts.isNamespaceImport(namedBindings)) {
    imports.push({
      specifier,
      bindingKind: "namespace",
      localName: namedBindings.name.text,
      location: toSourceLocation(sourceFile, namedBindings),
    });
  } else if (namedBindings && ts.isNamedImports(namedBindings)) {
    for (const element of namedBindings.elements) {
      if (element.isTypeOnly) {
        continue;
      }
      imports.push({
        specifier,
        bindingKind: "named",
        localName: element.name.text,
        importedName: element.propertyName?.text ?? element.name.text,
        location: toSourceLocation(sourceFile, element),
      });
    }
  }

  return imports;
}

interface CommonJsExportTarget {
  readonly bindingKind: "commonjs-module-exports" | "commonjs-exports-property";
  readonly exportedName?: string;
}

function describeCommonJsExportTarget(
  left: ts.Expression,
): CommonJsExportTarget | undefined {
  if (!ts.isPropertyAccessExpression(left)) {
    return undefined;
  }

  // exports.foo = ...
  if (ts.isIdentifier(left.expression) && left.expression.text === "exports") {
    return {
      bindingKind: "commonjs-exports-property",
      exportedName: left.name.text,
    };
  }

  // module.exports = ...
  if (
    ts.isIdentifier(left.expression) &&
    left.expression.text === "module" &&
    left.name.text === "exports"
  ) {
    return { bindingKind: "commonjs-module-exports" };
  }

  // module.exports.foo = ...
  if (
    ts.isPropertyAccessExpression(left.expression) &&
    ts.isIdentifier(left.expression.expression) &&
    left.expression.expression.text === "module" &&
    left.expression.name.text === "exports"
  ) {
    return {
      bindingKind: "commonjs-exports-property",
      exportedName: left.name.text,
    };
  }

  return undefined;
}

function extractExportDeclaration(
  sourceFile: ts.SourceFile,
  node: ts.ExportDeclaration,
): IndexedExport[] {
  if (node.isTypeOnly) {
    return [];
  }

  const specifier =
    node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      ? node.moduleSpecifier.text
      : undefined;

  if (node.exportClause && ts.isNamedExports(node.exportClause)) {
    const results: IndexedExport[] = [];
    for (const element of node.exportClause.elements) {
      if (element.isTypeOnly) {
        continue;
      }
      results.push({
        bindingKind: specifier ? "re-export" : "named",
        exportedName: element.name.text,
        localName: element.propertyName?.text ?? element.name.text,
        specifier,
        location: toSourceLocation(sourceFile, element),
      });
    }
    return results;
  }

  if (!node.exportClause && specifier) {
    // export * from "./x";
    return [
      {
        bindingKind: "re-export",
        specifier,
        location: toSourceLocation(sourceFile, node),
      },
    ];
  }

  return [];
}

function extractDeclarationExport(
  sourceFile: ts.SourceFile,
  node: ts.FunctionDeclaration | ts.ClassDeclaration | ts.VariableStatement,
): IndexedExport[] {
  const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);

  if (ts.isVariableStatement(node)) {
    const results: IndexedExport[] = [];
    for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        results.push({
          bindingKind: isDefault ? "default" : "named",
          exportedName: isDefault ? undefined : declaration.name.text,
          localName: declaration.name.text,
          location: toSourceLocation(sourceFile, declaration),
        });
      }
    }
    return results;
  }

  if (node.name) {
    return [
      {
        bindingKind: isDefault ? "default" : "named",
        exportedName: isDefault ? undefined : node.name.text,
        localName: node.name.text,
        location: toSourceLocation(sourceFile, node),
      },
    ];
  }

  if (isDefault) {
    // export default function () {} / export default class {} (anonymous)
    return [
      { bindingKind: "default", location: toSourceLocation(sourceFile, node) },
    ];
  }

  return [];
}

/** Shared by other code-intelligence modules that need to track function boundaries (e.g. call-graph.ts). */
export function isFunctionLike(
  node: ts.Node,
): node is
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

function buildIndex(sourceFile: ts.SourceFile): SourceIndex {
  const functions: IndexedFunction[] = [];
  const imports: IndexedImport[] = [];
  const exportsList: IndexedExport[] = [];

  function visit(node: ts.Node): void {
    // Not part of the else-if chain below: a node like
    // `export function foo() {}` is simultaneously function-like AND an
    // exported declaration, so these two checks must not be mutually
    // exclusive.
    if (isFunctionLike(node)) {
      functions.push(extractFunction(sourceFile, node));
    } else if (
      (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
      !classHasOwnConstructor(node)
    ) {
      functions.push(extractImplicitConstructor(sourceFile, node));
    }

    if (ts.isImportDeclaration(node)) {
      imports.push(...extractEsmImport(sourceFile, node));
    } else if (isRequireCall(node)) {
      imports.push(...extractRequireBindings(sourceFile, node));
    } else if (ts.isExportDeclaration(node)) {
      exportsList.push(...extractExportDeclaration(sourceFile, node));
    } else if (ts.isExportAssignment(node)) {
      exportsList.push({
        bindingKind: node.isExportEquals
          ? "commonjs-module-exports"
          : "default",
        location: toSourceLocation(sourceFile, node),
      });
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isVariableStatement(node)) &&
      hasModifier(node, ts.SyntaxKind.ExportKeyword)
    ) {
      exportsList.push(...extractDeclarationExport(sourceFile, node));
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const target = describeCommonJsExportTarget(node.left);
      if (target) {
        exportsList.push({
          ...target,
          location: toSourceLocation(sourceFile, node),
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return {
    filePath: sourceFile.fileName,
    sourceFile,
    functions,
    imports,
    exports: exportsList,
  };
}

/** Parses JS/TS source text into an AST and structural index (see docs/SDD.md § 15). */
export function indexSourceFile(
  filePath: string,
  sourceText: string,
): SourceIndex {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  return buildIndex(sourceFile);
}

/**
 * Reads a source file from disk and indexes it.
 *
 * Reading and parsing source text is permitted under the project's
 * security constraints (see docs/SDD.md § 29): it is analyzed statically
 * and never executed.
 */
export function indexSourceFileFromDisk(filePath: string): SourceIndex {
  let text: string;

  try {
    text = readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new SourceFileNotFoundError(filePath, error);
  }

  return indexSourceFile(filePath, text);
}

/** Indexes multiple files (e.g. a {@link TsProject}'s `fileNames`). */
export function indexSourceFiles(filePaths: readonly string[]): SourceIndex[] {
  return filePaths.map((filePath) => indexSourceFileFromDisk(filePath));
}
