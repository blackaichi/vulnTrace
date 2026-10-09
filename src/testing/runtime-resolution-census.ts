import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";

/**
 * ADR 0010 § 2's RUNTIME-RESOLUTION CENSUS (task C-1, Foundation invariant
 * `VT-INV-C-runtime-resolution`).
 *
 * Invariant C2: every resolution that decides which file Node loads uses
 * Node's algorithm, whatever the project's tsconfig says. Mechanically:
 * the compiler options handed to TypeScript's module resolution on the
 * runtime path are Node's (`moduleResolution` NodeNext), for every
 * tsconfig. The behaviour is the 40-row table in
 * `src/code-intelligence/module-resolver.runtime-resolution.test.ts`; this
 * census owns the AUTHORITY: no production code reaches TypeScript's module
 * resolution with options it did not get from module-resolver.ts's one
 * producer.
 *
 * WHAT COUNTS (found by the TypeScript checker, not by text):
 *
 * - every call, in a production `.ts` file under `src/` (not a test, not
 *   `src/testing/`, not a `.d.ts`), whose resolved signature is declared
 *   by TypeScript's own `typescript.d.ts` and named in
 *   {@link RESOLUTION_APIS} -- an alias (`const r = ts.resolveModuleName`)
 *   is seen through. Each is reported with its file, its enclosing named
 *   function, the API, and whether its compiler-options argument carries
 *   the `NodeResolutionOptions` brand (an API with no such argument is
 *   reported unbranded: it is not allowed in production at all);
 * - every `as T` / `<T>x` in such a file whose asserted type carries the
 *   brand: only its producer may assert it.
 *
 * WHAT DOES NOT. A call through `any`, or through a `ts` value laundered by
 * a generic helper, has no resolved TypeScript signature; an options object
 * built with the brand and then mutated (the producer freezes its result)
 * through an `any`; a `@ts-expect-error`. Each compiles. Those routes are
 * left to review, as V-4's cast census leaves its own. Two more, found by
 * C-1's independent audit:
 *
 * - The brand does not tell the cross-check's options (Node's plus the
 *   tsconfig's `baseUrl` / `paths`) from the runtime ones: both come from
 *   the one producer. Returning the cross-check's answer instead of Node's
 *   keeps every call branded; the behavioural RWF-083 cases in
 *   module-resolver.runtime-resolution.test.ts catch it, not this census.
 * - Resolution written by hand, outside TypeScript's API, is invisible
 *   here: module-resolver.ts's own `package.json` reads
 *   (`attemptSiblingRuntimeFile`'s `main`, `siblingFallbackAllowed`),
 *   package-entry.ts's `exports` reading and entrypoints.ts's `main` /
 *   `bin`. Each decides a file and is owned by its own tests.
 */

/** TypeScript's module-resolution and program-construction entry points. */
export const RESOLUTION_APIS: ReadonlyMap<string, number | undefined> = new Map<
  string,
  number | undefined
>([
  // name -> index of the compiler-options argument (undefined: none)
  ["resolveModuleName", 2],
  ["getImpliedNodeFormatForFile", 3],
  ["nodeModuleNameResolver", 2],
  ["bundlerModuleNameResolver", 2],
  ["classicNameResolver", 2],
  ["resolveModuleNameFromCache", undefined],
  ["createModuleResolutionCache", 2],
  ["createProgram", 1],
  ["createCompilerHost", 0],
  ["createLanguageService", undefined],
  ["createWatchProgram", undefined],
]);

/** The brand's declaring file and the `unique symbol` that names it. */
export const BRAND_FILE = "src/code-intelligence/module-resolver.ts";
const BRAND_SYMBOL = "nodeResolutionOptionsBrand";

export interface ResolutionCall {
  /** Repo-relative file. */
  readonly file: string;
  /** The enclosing named function, or `<module>`. */
  readonly enclosing: string;
  /** The TypeScript API called. */
  readonly api: string;
  /** Whether the compiler-options argument carries the brand. */
  readonly branded: boolean;
}

export interface BrandAssertion {
  readonly file: string;
  readonly enclosing: string;
}

/** Every call the runtime path makes: each receives branded options. */
export const ALLOWED_RESOLUTION_CALLS: readonly ResolutionCall[] = [
  {
    file: BRAND_FILE,
    enclosing: "resolutionModeFor",
    api: "getImpliedNodeFormatForFile",
    branded: true,
  },
  {
    file: BRAND_FILE,
    enclosing: "attemptNoDtsResolution",
    api: "resolveModuleName",
    branded: true,
  },
  {
    file: BRAND_FILE,
    enclosing: "resolveSync",
    api: "resolveModuleName",
    branded: true,
  },
];

/** The one assertion allowed: the producer's. */
export const ALLOWED_BRAND_ASSERTIONS: readonly BrandAssertion[] = [
  { file: BRAND_FILE, enclosing: "nodeResolutionOptions" },
];

const TYPESCRIPT_DTS = path.join(
  path.dirname(createRequire(import.meta.url).resolve("typescript")),
  "typescript.d.ts",
);

function productionFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path.relative(root, full) === path.join("src", "testing")) continue;
        walk(full);
      } else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".d.ts") &&
        !/\.test\.ts$/.test(entry.name)
      ) {
        out.push(full);
      }
    }
  };
  walk(path.join(root, "src"));
  return out.sort();
}

function enclosingName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (
      (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) &&
      n.name !== undefined &&
      ts.isIdentifier(n.name)
    ) {
      return n.name.text;
    }
    if (
      (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) &&
      ts.isVariableDeclaration(n.parent) &&
      ts.isIdentifier(n.parent.name)
    ) {
      return n.parent.name.text;
    }
  }
  return "<module>";
}

/**
 * The TypeScript API a call's callee is, or `undefined`. A callee whose
 * symbol (import aliases followed) is a function or method declaration is
 * decided by those declarations alone; any other callee -- a variable,
 * parameter or property holding a function, which is how an alias such
 * as `const r = ts.resolveModuleName` reaches a call -- is decided by its
 * type's call signatures. Computing the type of every callee, which the
 * second rule alone would do, took most of the suite's per-test ceiling.
 */
function calledTypescriptApi(
  checker: ts.TypeChecker,
  callee: ts.Expression,
): string | undefined {
  const named = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  let symbol = checker.getSymbolAtLocation(named);
  if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const declarations = symbol?.declarations ?? [];
  if (
    declarations.length > 0 &&
    declarations.every(
      (d) =>
        ts.isFunctionDeclaration(d) ||
        ts.isMethodDeclaration(d) ||
        ts.isMethodSignature(d),
    )
  ) {
    return declarations
      .map((d) => typescriptApiName(d as ts.SignatureDeclaration))
      .find((name) => name !== undefined);
  }
  return checker
    .getTypeAtLocation(callee)
    .getCallSignatures()
    .map((signature) => typescriptApiName(signature.declaration))
    .find((name) => name !== undefined);
}

/** The name of a function TypeScript's own `typescript.d.ts` declares, if `declaration` is one. */
function typescriptApiName(
  declaration: ts.SignatureDeclaration | ts.JSDocSignature | undefined,
): string | undefined {
  if (
    declaration === undefined ||
    path.resolve(declaration.getSourceFile().fileName) !== TYPESCRIPT_DTS ||
    !(
      ts.isFunctionDeclaration(declaration) || ts.isMethodSignature(declaration)
    )
  ) {
    return undefined;
  }
  return declaration.name?.getText(declaration.getSourceFile());
}

function carriesBrand(type: ts.Type): boolean {
  return type
    .getProperties()
    .some((p) => p.getName().startsWith(`__@${BRAND_SYMBOL}@`));
}

/**
 * Every TypeScript resolution call and every brand assertion in the
 * production sources under `root`, found through the TypeScript checker.
 */
export function findRuntimeResolution(root: string): {
  readonly calls: ResolutionCall[];
  readonly assertions: BrandAssertion[];
} {
  const files = productionFiles(root);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    // One resolution of `typescript` for the repository and for a
    // scratch tree alike: this repository's own installed declarations.
    baseUrl: root,
    paths: { typescript: [TYPESCRIPT_DTS] },
  });
  const checker = program.getTypeChecker();
  const calls: ResolutionCall[] = [];
  const assertions: BrandAssertion[] = [];

  // In file order (then source position), whatever order the program
  // loaded them in.
  const sourceFiles = program
    .getSourceFiles()
    .filter((sourceFile) => files.includes(path.resolve(sourceFile.fileName)))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
  for (const sourceFile of sourceFiles) {
    const file = path.relative(root, sourceFile.fileName);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const api = calledTypescriptApi(checker, node.expression);
        if (api !== undefined && RESOLUTION_APIS.has(api)) {
          const index = RESOLUTION_APIS.get(api);
          const argument =
            index === undefined ? undefined : node.arguments[index];
          calls.push({
            file,
            enclosing: enclosingName(node),
            api,
            branded:
              argument !== undefined &&
              carriesBrand(checker.getTypeAtLocation(argument)),
          });
        }
      }
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        if (carriesBrand(checker.getTypeFromTypeNode(node.type))) {
          assertions.push({ file, enclosing: enclosingName(node) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { calls, assertions };
}
