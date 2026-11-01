/**
 * The module scope's own bindings: the module-scope declarations of a file,
 * whether a read of one completes normally, and the file's top-level
 * callable candidates.
 *
 * Split out of `module-model.ts` by concern, as a pure move (task BL-121):
 * the declarations below are those of that file, unchanged and in its order.
 * `module-model.ts` re-exports the public ones.
 */
import ts from "typescript";
import { unwrapParentheses } from "./commonjs-reexports.js";

/** One module-scope binding: how it is declared, where, and how often. */
interface ModuleScopeBinding {
  readonly kind: "function" | "var" | "let" | "const" | "class" | "other";
  /** The top-level statement that declares it (the first one). */
  readonly statementIndex: number;
  readonly count: number;
}

const moduleScopeBindingsBySourceFile = new WeakMap<
  ts.SourceFile,
  ReadonlyMap<string, ModuleScopeBinding>
>();

/**
 * The bindings the module scope declares (BL-064): top-level function,
 * class and `let`/`const` declarations, `var` anywhere outside a function
 * body (hoisted), and anything else (an import, an enum, a namespace) as
 * `"other"`, which no read is proven safe for.
 */
function moduleScopeBindings(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, ModuleScopeBinding> {
  const cached = moduleScopeBindingsBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }
  const bindings = new Map<string, ModuleScopeBinding>();
  function add(
    name: string,
    kind: ModuleScopeBinding["kind"],
    statementIndex: number,
  ): void {
    const known = bindings.get(name);
    bindings.set(
      name,
      known === undefined
        ? { kind, statementIndex, count: 1 }
        : {
            kind: known.kind === kind ? kind : "other",
            statementIndex: known.statementIndex,
            count: known.count + 1,
          },
    );
  }
  function addBindingName(
    name: ts.BindingName,
    kind: ModuleScopeBinding["kind"],
    statementIndex: number,
  ): void {
    if (ts.isIdentifier(name)) {
      add(name.text, kind, statementIndex);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        addBindingName(element.name, kind, statementIndex);
      }
    }
  }
  function collectVars(node: ts.Node, statementIndex: number): void {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      // A function declaration in a block (Annex B): in sloppy mode it
      // also writes a function-scoped binding when the block runs, so no
      // read or call of the name is proven (BL-064's audit, finding 4).
      add(node.name.text, "other", statementIndex);
      return;
    }
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
      return;
    }
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.BlockScoped) === 0
    ) {
      for (const declaration of node.declarations) {
        addBindingName(declaration.name, "var", statementIndex);
      }
    }
    ts.forEachChild(node, (child) => collectVars(child, statementIndex));
  }
  sourceFile.statements.forEach((statement, statementIndex) => {
    if (hasDeclareModifier(statement)) {
      // No runtime binding at all: a read of it is a `ReferenceError`.
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          addBindingName(declaration.name, "other", statementIndex);
        }
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement)) &&
        statement.name !== undefined
      ) {
        add(statement.name.text, "other", statementIndex);
      }
      return;
    }
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name !== undefined && statement.body !== undefined) {
        add(statement.name.text, "function", statementIndex);
      }
      return;
    }
    if (ts.isClassDeclaration(statement)) {
      if (statement.name !== undefined) {
        add(statement.name.text, "class", statementIndex);
      }
      return;
    }
    if (ts.isVariableStatement(statement)) {
      const flags = statement.declarationList.flags;
      if ((flags & ts.NodeFlags.BlockScoped) !== 0) {
        const kind = (flags & ts.NodeFlags.Const) !== 0 ? "const" : "let";
        for (const declaration of statement.declarationList.declarations) {
          addBindingName(declaration.name, kind, statementIndex);
        }
        return;
      }
    }
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name !== undefined) {
        add(clause.name.text, "other", statementIndex);
      }
      const named = clause?.namedBindings;
      if (named !== undefined && ts.isNamespaceImport(named)) {
        add(named.name.text, "other", statementIndex);
      } else if (named !== undefined) {
        for (const element of named.elements) {
          add(element.name.text, "other", statementIndex);
        }
      }
      return;
    }
    if (
      (ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement)) &&
      ts.isIdentifier(statement.name)
    ) {
      add(statement.name.text, "other", statementIndex);
      return;
    }
    collectVars(statement, statementIndex);
  });
  moduleScopeBindingsBySourceFile.set(sourceFile, bindings);
  return bindings;
}

function hasDeclareModifier(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ??
      false)
  );
}

/** The CommonJS wrapper's parameters, readable whenever nothing declares them. */
const COMMONJS_WRAPPER_PARAMETERS: ReadonlySet<string> = new Set([
  "exports",
  "require",
  "module",
  "__filename",
  "__dirname",
]);

/** Global value properties that are non-writable and non-configurable. */
const IMMUTABLE_GLOBAL_VALUES: ReadonlySet<string> = new Set([
  "undefined",
  "NaN",
  "Infinity",
]);

/**
 * Whether reading `name` at module scope, in the top-level statement
 * `statementIndex`, cannot throw: a hoisted function or `var`, a
 * `let`/`const`/`class` an EARLIER top-level statement declared (reaching
 * this statement means that one completed, so the binding is out of its
 * temporal dead zone), an undeclared CommonJS wrapper parameter, or an
 * immutable global value. Anything else may be a `ReferenceError`.
 */
function moduleScopeReadCompletes(
  sourceFile: ts.SourceFile,
  name: string,
  statementIndex: number,
): boolean {
  const binding = moduleScopeBindings(sourceFile).get(name);
  if (binding === undefined) {
    return (
      COMMONJS_WRAPPER_PARAMETERS.has(name) || IMMUTABLE_GLOBAL_VALUES.has(name)
    );
  }
  switch (binding.kind) {
    case "function":
    case "var":
      return true;
    case "let":
    case "const":
    case "class":
      return binding.count === 1 && binding.statementIndex < statementIndex;
    case "other":
      return false;
  }
}

/**
 * The module-TOP-LEVEL callable named `name` this file's own text can read
 * a body out of directly (RWF-016) — the call-target candidate half of
 * {@link resolveExactLocalCallable}'s proof, before reassignment and
 * shadowing are even considered:
 *
 * - a module-TOP-LEVEL `function bail() {}` declaration, or
 * - a module-TOP-LEVEL `const bail = function () {}` / `const bail = () =>
 *   {}` — deliberately restricted to `const`, mirroring
 *   commonjs-reexports.ts's own `isConstDeclaration` gate for the same
 *   reason: a `const` can be reassigned nowhere in the language.
 *
 * `undefined` for every other shape sharing the name: a `let`/`var`
 * binding, a destructured binding, an import, a class, or any initializer
 * that isn't a function/arrow expression.
 *
 * Cheap and already properly scoped without any extra work: this only
 * ever iterates `sourceFile.statements` itself (never recursing into a
 * nested block or an expression), so it costs one shape check per
 * top-level statement.
 */
const topLevelCallableCandidatesBySourceFile = new WeakMap<
  ts.SourceFile,
  ReadonlyMap<
    string,
    ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction
  >
>();

function topLevelCallableCandidates(
  sourceFile: ts.SourceFile,
): ReadonlyMap<
  string,
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction
> {
  const cached = topLevelCallableCandidatesBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }

  const candidates = new Map<
    string,
    ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction
  >();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      candidates.set(statement.name.text, statement);
    } else if (
      ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
    ) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) {
          continue;
        }
        const initializer = unwrapParentheses(decl.initializer);
        if (
          ts.isFunctionExpression(initializer) ||
          ts.isArrowFunction(initializer)
        ) {
          candidates.set(decl.name.text, initializer);
        }
      }
    }
  }

  topLevelCallableCandidatesBySourceFile.set(sourceFile, candidates);
  return candidates;
}

export {
  moduleScopeBindings,
  hasDeclareModifier,
  COMMONJS_WRAPPER_PARAMETERS,
  moduleScopeReadCompletes,
  topLevelCallableCandidates,
};
