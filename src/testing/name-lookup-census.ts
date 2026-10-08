import { readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * ADR 0011 § 2's NAME-KEYED-LOOKUP CENSUS (task V-3).
 *
 * Invariant V says a negative proof is built only from facts keyed by exact
 * identity: `PackageInstanceId` for packages, declaration identity (file +
 * source position) for graph nodes. A lookup that finds a graph node or an
 * indexed function by comparing its `name` with a string cannot fail
 * loudly: a name that matches nothing, or matches another declaration of
 * the same spelling, yields an empty or wrong answer, and a proof built on
 * it proves nothing (PRM-25, PRM-31, PRM-26).
 *
 * Some such lookups are sound by DIRECTION: their failure can only widen
 * what is searched, or only refuse an answer, or happens only under a
 * test-only flag. This file is where each one that exists is listed, with
 * the direction it is declared to have and why; the test next to it scans
 * `src/analysis/` and `src/code-intelligence/` and fails on any lookup not
 * listed here, and on any listed one that no longer exists. A new
 * name-keyed lookup therefore cannot be added without stating, here and in
 * review, which way it fails.
 *
 * WHAT COUNTS (each found by the TypeScript checker, not by text), where a
 * NAME READ is `x.name` / `x?.name` / `x["name"]` with `x` a `GraphNode` or
 * an `IndexedFunction`, or `x.className` with `x` a
 * `ClassMemberOwnership`:
 *
 * - a name read compared for (in)equality with anything but `undefined`;
 * - a name read switched on;
 * - a name read handed to a key lookup (`includes`, `has`, `get`, `set`,
 *   `delete`, `indexOf`, `lastIndexOf`) or put in an array literal (a
 *   map's or set's entries);
 * - destructuring the name key off such a value (`({ name }) => ...`),
 *   whatever is done with it;
 * - a call of a function -- a declaration, or an arrow or function
 *   expression a variable holds -- whose own body contains one of the
 *   above (a name-matching helper: each call is a lookup of its own);
 * - a call of `graphPackageInstancesByName`, which finds the package
 *   instances of the graph by their manifest NAME.
 *
 * Every `.ts` file under the census directories is scanned, at any depth.
 * A read that only carries the name along -- into a label, a diagnostic --
 * is not a lookup. A spelling this list does not cover (say, matching on
 * the id string a node's name is part of) is not caught: the gate is a
 * strong net, not a proof.
 *
 * WHAT DOES NOT: a comparison of a TypeScript AST node's `name` (a syntax
 * question, not a lookup), and a map keyed by an EXPORT name
 * (`exportNameToNodeId`): an export is identified by its module and its
 * exported name, so that key is the identity itself.
 */

export type NameLookupDirection =
  /** A wrong or empty answer can only add starting points or targets: more is searched, never less. */
  | "widen-only"
  /** A match can only withhold an answer (UNKNOWN), never produce one. */
  | "refuse-only"
  /** Reachable only under a flag no production caller sets. */
  | "test-flag-only"
  /** Known unsound: names the open finding and the task that removes it. */
  | "open";

export interface NameLookupCensusEntry {
  /** Repo-relative file. */
  readonly file: string;
  /** The enclosing named function, or `<module>`. */
  readonly enclosing: string;
  /** The lookup expression's own text, whitespace collapsed; ` (2)`, ` (3)`, ... for a repeat in the same function. */
  readonly expression: string;
  readonly direction: NameLookupDirection;
  /** For `open`: the finding and the task that removes the lookup. */
  readonly openFinding?: { readonly finding: string; readonly task: string };
  readonly why: string;
}

const PRM_26 = { finding: "PRM-26", task: "E-1" } as const;

export const NAME_LOOKUP_CENSUS: readonly NameLookupCensusEntry[] = [
  // -- Target attribution: the export map's first match by name (PRM-26) --
  {
    file: "src/code-intelligence/module-model.ts",
    enclosing: "mapExportsToFunctions",
    expression: "fn.name === localKey",
    direction: "open",
    openFinding: PRM_26,
    why: "takes the FIRST indexed function named like the export's local -- a class method, a nested function, an `obj.x = function(){}` -- as the export's implementation; ADR 0009 replaces it with lexical identity (task E-1)",
  },
  {
    file: "src/code-intelligence/module-model.ts",
    enclosing: "findExportedClassMembers",
    expression: "mapExportsToFunctions(index, model)",
    direction: "open",
    openFinding: PRM_26,
    why: "the exported classes are read off the PRM-26 map",
  },
  {
    file: "src/code-intelligence/module-model.ts",
    enclosing: "findExportedClassMembers",
    expression: "exportedClassNames.has(fn.memberOf.className)",
    direction: "widen-only",
    why: "the members of EVERY class whose name an exported class has -- a nested class of the same name included -- are targets, ORed by the caller: a target too many (a false-AFFECTED risk, found by task V-3's independent audit), never one too few; the exported-class set is the open PRM-26 entry above",
  },
  {
    file: "src/code-intelligence/module-model.ts",
    enclosing: "findExportedClassMembers",
    expression: "fn.name === memberName",
    direction: "widen-only",
    why: "returns EVERY member so named of every exported class, and the caller ORs reachability across them: a same-named member is one more target, never a substitute (VT-301A); the exported-class set it filters by is the open PRM-26 entry above",
  },
  {
    file: "src/analysis/verdict.ts",
    enclosing: "findExportNodeInFile",
    expression: "mapExportsToFunctions(index, model)",
    direction: "open",
    openFinding: PRM_26,
    why: "a rule's target is attributed through the PRM-26 map",
  },
  {
    file: "src/analysis/verdict.ts",
    enclosing: "findExportNodeInFile",
    expression: "findExportedClassMembers(index, model, exportName)",
    direction: "open",
    openFinding: PRM_26,
    why: "a method target is attributed through the exported classes the PRM-26 map names",
  },
  {
    file: "src/code-intelligence/call-graph.ts",
    enclosing: "prepareFile",
    expression: "mapExportsToFunctions(index, model)",
    direction: "open",
    openFinding: PRM_26,
    why: "each file's export-name -> node map, which call edges into the file resolve through, is built from the PRM-26 map",
  },
  // -- The synthetic-graph target fallback -------------------------------
  {
    file: "src/analysis/verdict.ts",
    enclosing: "isNamedNode",
    expression: "node.name === name",
    direction: "test-flag-only",
    why: "its one caller is findExportNodeInFile's synthetic fallback below; the entrypoint lookups that also used it bind by position since task V-3 (PRM-25, PRM-31)",
  },
  {
    file: "src/analysis/verdict.ts",
    enclosing: "findExportNodeInFile",
    expression: "isNamedNode(n, resolvedFile, exportName)",
    direction: "test-flag-only",
    why: "reached only with `allowSyntheticNameOnlyTargetBinding`, which every production caller leaves false (VT-301B): synthetic test graphs have no file to attribute from",
  },
  // -- A refusal keyed by name -----------------------------------------------
  {
    file: "src/code-intelligence/call-graph.ts",
    enclosing: "resolvesToUnrelatedConstructor",
    expression: "fn.name === binding.target.exportedName",
    direction: "refuse-only",
    why: "a constructor so named in the target file makes `lib.X()` stay unresolved rather than bind to the class (ADV2-021); a spurious match costs a resolution, never makes one",
  },
  {
    file: "src/code-intelligence/call-graph.ts",
    enclosing: "classifyCallee",
    expression: "resolvesToUnrelatedConstructor(callee, binding, targetFile)",
    direction: "refuse-only",
    why: "true withholds the edge (see resolvesToUnrelatedConstructor)",
  },
  {
    file: "src/code-intelligence/call-graph.ts",
    enclosing: "classifyConstructee",
    expression: "resolvesToUnrelatedConstructor(callee, binding, targetFile)",
    direction: "refuse-only",
    why: "true withholds the edge (see resolvesToUnrelatedConstructor)",
  },
  {
    file: "src/code-intelligence/call-graph.ts",
    enclosing: "escapeTargetOf",
    expression:
      "resolvesToUnrelatedConstructor(value.expr, binding, targetFile)",
    direction: "refuse-only",
    why: "true leaves the escaped value unattributed, which the escape row accounts for with an unknown edge -- its own, or the unattributable callee's (ADR 0008 § 2)",
  },
  {
    file: "src/code-intelligence/call-graph.ts",
    enclosing: "resolveAliasedValue",
    expression: "resolvesToUnrelatedConstructor(resolved, binding, targetFile)",
    direction: "refuse-only",
    why: "true withholds the import-based answer; what remains is `callableNodeIdFor`, the same-file LEXICAL resolver (P1-B3b § 19), an authority that reads no name -- so the match can only remove an answer, never supply one",
  },
  // -- A package instance found by its manifest name ------------------------
  {
    file: "src/analysis/verdict.ts",
    enclosing: "graphPackageInstances",
    expression:
      "graphPackageInstancesByName( caches, graph, knownPackageRoots, packageName, )",
    direction: "refuse-only",
    why: "attributes no target since task V-1 (Site A vs Site B is chosen by the exact instance); it only chooses between family B and Site B for an instance the graph never traversed, and either branch reaches NOT_AFFECTED only through a complete closure without the instance. CAVEAT (REMEDIATION-PLAN § 5a, V-1 additions): it is a precision difference, not nothing -- an unloaded nested install is family B when a same-named instance is in the graph and UNKNOWN when none is",
  },
];

/** The directories the census covers (ADR 0011 § 2). */
export const CENSUS_DIRECTORIES: readonly string[] = [
  "src/analysis",
  "src/code-intelligence",
];

/** The types whose named key identifies a declaration only by spelling. */
const NAME_KEYS: ReadonlyMap<string, string> = new Map([
  ["GraphNode", "name"],
  ["IndexedFunction", "name"],
  ["ClassMemberOwnership", "className"],
]);
/** Methods that look a key up: a name read passed to one is a lookup. */
const LOOKUP_METHODS = new Set([
  "includes",
  "has",
  "get",
  "set",
  "delete",
  "indexOf",
  "lastIndexOf",
]);
const NAME_KEYED_PACKAGE_LOOKUPS = new Set(["graphPackageInstancesByName"]);

export interface FoundNameLookup {
  readonly file: string;
  readonly enclosing: string;
  readonly expression: string;
}

/** Every production `.ts` file of the census directories. */
export function censusFiles(repoRoot: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(full);
      }
    }
  };
  for (const directory of CENSUS_DIRECTORIES) {
    walk(path.join(repoRoot, directory));
  }
  return files.sort();
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function enclosingName(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) &&
      current.name !== undefined
    ) {
      return current.name.getText();
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
  }
  return "<module>";
}

/** The key that names a declaration by spelling on `type`, if any. */
function nameKeyOf(type: ts.Type): string | undefined {
  const parts = type.isUnion() ? type.types : [type];
  for (const part of parts) {
    const symbol = part.aliasSymbol ?? part.getSymbol();
    const key =
      symbol === undefined ? undefined : NAME_KEYS.get(symbol.getName());
    if (key !== undefined) {
      return key;
    }
  }
  return undefined;
}

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

function isUndefinedLiteral(node: ts.Expression): boolean {
  return ts.isIdentifier(node) && node.text === "undefined";
}

/**
 * Every name-keyed lookup in the census directories, found through the
 * TypeScript checker over the repository's own sources.
 */
export function findNameLookups(repoRoot: string): FoundNameLookup[] {
  const files = censusFiles(repoRoot);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();

  /** Whether `node` reads a declaration's name off a node, function or class owner. */
  const isNameRead = (node: ts.Node): boolean => {
    let key: string | undefined;
    let receiver: ts.Expression | undefined;
    if (ts.isPropertyAccessExpression(node)) {
      key = node.name.text;
      receiver = node.expression;
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      key = node.argumentExpression.text;
      receiver = node.expression;
    }
    return (
      key !== undefined &&
      receiver !== undefined &&
      nameKeyOf(checker.getTypeAtLocation(receiver)) === key
    );
  };

  /** Whether a binding pattern element destructures the name key. */
  const isNameDestructuring = (node: ts.Node): boolean => {
    if (!ts.isBindingElement(node) || !ts.isObjectBindingPattern(node.parent)) {
      return false;
    }
    const property = node.propertyName ?? node.name;
    if (!ts.isIdentifier(property) && !ts.isStringLiteralLike(property)) {
      return false;
    }
    return nameKeyOf(checker.getTypeAtLocation(node.parent)) === property.text;
  };

  /**
   * The lookup a name read takes part in, or `undefined` for a read that
   * only carries the name along (a label, a diagnostic): compared for
   * equality, switched on, handed to a key lookup, or put in an array (a
   * map's or set's entries).
   */
  const lookupOf = (read: ts.Node): ts.Node | undefined => {
    let current: ts.Node = read;
    while (
      ts.isParenthesizedExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      // `n.name ?? ""`, `n.name || fallback`: the name flows through.
      (ts.isBinaryExpression(current.parent) &&
        (current.parent.operatorToken.kind ===
          ts.SyntaxKind.QuestionQuestionToken ||
          current.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken))
    ) {
      current = current.parent;
    }
    const parent = current.parent;
    if (
      ts.isBinaryExpression(parent) &&
      EQUALITY.has(parent.operatorToken.kind)
    ) {
      const other = parent.left === current ? parent.right : parent.left;
      return isUndefinedLiteral(other) ? undefined : parent;
    }
    if (ts.isSwitchStatement(parent) && parent.expression === current) {
      return current;
    }
    if (
      ts.isCallExpression(parent) &&
      parent.arguments.some((argument) => argument === current) &&
      ts.isPropertyAccessExpression(parent.expression) &&
      LOOKUP_METHODS.has(parent.expression.name.text)
    ) {
      return parent;
    }
    if (ts.isArrayLiteralExpression(parent)) {
      return parent;
    }
    return undefined;
  };

  /** The function a lookup sits in, when it is one a call can name. */
  const helperOf = (node: ts.Node): ts.Node | undefined => {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isFunctionDeclaration(current)) {
        return current;
      }
      if (
        (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
        ts.isVariableDeclaration(current.parent)
      ) {
        return current.parent;
      }
    }
    return undefined;
  };

  /** Functions whose own body looks a node's or function's name up. */
  const matchingHelpers = new Set<ts.Node>();
  const lookups = new Set<ts.Node>();
  const sources = files.map((file) => {
    const sourceFile = program.getSourceFile(file);
    if (sourceFile === undefined) {
      throw new Error(`name-lookup census: ${file} is not in the program`);
    }
    return sourceFile;
  });
  for (const sourceFile of sources) {
    const visit = (node: ts.Node): void => {
      const lookup = isNameRead(node)
        ? lookupOf(node)
        : isNameDestructuring(node)
          ? node
          : undefined;
      if (lookup !== undefined) {
        lookups.add(lookup);
        const helper = helperOf(lookup);
        if (helper !== undefined) {
          matchingHelpers.add(helper);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const found: FoundNameLookup[] = [];
  const record = (node: ts.Node): void => {
    found.push({
      file: path
        .relative(repoRoot, node.getSourceFile().fileName)
        .split(path.sep)
        .join("/"),
      enclosing: enclosingName(node),
      expression: collapse(node.getText()),
    });
  };
  for (const lookup of lookups) {
    record(lookup);
  }
  for (const sourceFile of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const symbol = checker.getSymbolAtLocation(node.expression);
        const resolved =
          symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias
            ? checker.getAliasedSymbol(symbol)
            : symbol;
        const declaration = resolved?.declarations?.[0];
        if (
          (declaration !== undefined && matchingHelpers.has(declaration)) ||
          (resolved !== undefined &&
            NAME_KEYED_PACKAGE_LOOKUPS.has(resolved.getName()))
        ) {
          record(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  found.sort((a, b) =>
    `${a.file}#${a.enclosing}#${a.expression}`.localeCompare(
      `${b.file}#${b.enclosing}#${b.expression}`,
    ),
  );
  // Two lookups with the same text in the same function are two entries:
  // the second and later ones are numbered, so neither can hide behind the
  // other's census line.
  const seen = new Map<string, number>();
  return found.map((entry) => {
    const id = `${entry.file}#${entry.enclosing}#${entry.expression}`;
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    return count === 1
      ? entry
      : { ...entry, expression: `${entry.expression} (${count})` };
  });
}
