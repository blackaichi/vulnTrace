import { readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * ADR 0011 § 2's PROOF-INPUT CAST CENSUS (task V-4).
 *
 * Families B and C are built only from branded values (`verdict.ts`'s
 * `ClosureCorroboration`, `EvaluatedClosureCorroboration` and
 * `AttributedTarget`), and their evidence types (`domain/evidence.ts`'s
 * `ConfirmedAbsentInstance` and `ConfirmedUnreachableTarget`) carry a
 * nominal brand, so an object literal of any of the five is a compile
 * error. A type assertion is the one way past that: `{...} as unknown as
 * ConfirmedUnreachableTarget` compiles, and so does `{...} as Finding` with
 * an unbranded evidence object inside it. The five functions that produce
 * the values must assert; nothing else in production may.
 *
 * WHAT COUNTS (found by the TypeScript checker, not by text):
 *
 * - every `as T` and `<T>x` in a production `.ts` file under `src/` (not a
 *   test, not `src/testing/`, not a `.d.ts`) whose asserted type T CONTAINS
 *   a branded type -- is one, or reaches one through a union or
 *   intersection member, a property (a mapped type's too: `Partial<X>`,
 *   `Readonly<X>`, `Pick<X, K>`, `Omit<X, K>`), a numeric or string index,
 *   a type argument (`Map<K, X>`, `Promise<X>`, `readonly X[]`) or an
 *   alias's type argument, or a call or construct signature's parameter or
 *   return type (`() => X`). A type alias is seen through. Each is
 *   reported with its file, its enclosing named function, and the branded
 *   type it reaches;
 * - every production import of `src/testing/` (reported with
 *   `brandedType: "<src/testing import>"`): its evidence fixtures build a
 *   branded object with no assertion in production code. Relative
 *   string-literal specifiers only (`import`, `export ... from`,
 *   `require(...)`, `import(...)`); a computed specifier or a
 *   `createRequire` loader returns `any`, one of the unseen routes below.
 *
 * WHAT DOES NOT, stated so no one reads the gate as a proof. A branded
 * position reached without an assertion naming a branded type: through
 * `any` (`JSON.parse`, an untyped value), `as never`, a generic helper
 * (`cast<T>(x: unknown): T { return x as T }` -- its own assertion is to a
 * type parameter), a type predicate or an `asserts` function, an overload
 * over an `unknown` implementation, or a `@ts-expect-error` / `@ts-ignore`
 * directive. Each compiles. For the three proof INPUTS a second layer
 * remains -- each evidence constructor refuses a value without the
 * module-private runtime mark (`verdict.ts`) -- but the two EVIDENCE types
 * have no runtime mark: they are serialized output, and a forged one is
 * caught only by this census and by review. "Unforgeable" means through
 * the type system and this census; that a corroboration describes THIS
 * finding's closure, graph and instance comes from `buildFinding`'s call
 * sites and the branded `AnalysisProofContext`, not from the types.
 */

/** The `brandedType` a production import of `src/testing/` is reported with. */
export const TESTING_IMPORT = "<src/testing import>";

/** The branded proof types, by declaring file and name. */
export const BRANDED_PROOF_TYPES: readonly {
  readonly file: string;
  readonly name: string;
}[] = [
  { file: "src/domain/evidence.ts", name: "ConfirmedAbsentInstance" },
  { file: "src/domain/evidence.ts", name: "ConfirmedUnreachableTarget" },
  { file: "src/analysis/verdict.ts", name: "ClosureCorroboration" },
  { file: "src/analysis/verdict.ts", name: "EvaluatedClosureCorroboration" },
  { file: "src/analysis/verdict.ts", name: "AttributedTarget" },
];

export interface ProofInputCast {
  /** Repo-relative file. */
  readonly file: string;
  /** The enclosing named function, or `<module>`. */
  readonly enclosing: string;
  /** The branded type the asserted type reaches. */
  readonly brandedType: string;
}

/**
 * The only assertions allowed: each producer and constructor asserts the
 * one branded type it returns, once.
 */
export const ALLOWED_PROOF_INPUT_CASTS: readonly ProofInputCast[] = [
  {
    file: "src/analysis/verdict.ts",
    enclosing: "corroborateClosure",
    brandedType: "ClosureCorroboration",
  },
  {
    file: "src/analysis/verdict.ts",
    enclosing: "corroborateEvaluation",
    brandedType: "EvaluatedClosureCorroboration",
  },
  {
    file: "src/analysis/verdict.ts",
    enclosing: "attributeTarget",
    brandedType: "AttributedTarget",
  },
  {
    file: "src/analysis/verdict.ts",
    enclosing: "confirmedAbsentInstanceEvidence",
    brandedType: "ConfirmedAbsentInstance",
  },
  {
    file: "src/analysis/verdict.ts",
    enclosing: "confirmedUnreachableTargetEvidence",
    brandedType: "ConfirmedUnreachableTarget",
  },
];

/** Every production `.ts` file under `src/`. */
export function productionFiles(repoRoot: string): string[] {
  const files: string[] = [];
  const testing = path.join(repoRoot, "src", "testing");
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (full !== testing) {
          walk(full);
        }
      } else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(full);
      }
    }
  };
  walk(path.join(repoRoot, "src"));
  return files.sort();
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

/** Every type assertion in production `src/` whose asserted type contains a branded proof type. */
export function findProofInputCasts(repoRoot: string): ProofInputCast[] {
  const files = productionFiles(repoRoot);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const relative = (file: string): string =>
    path.relative(repoRoot, file).split(path.sep).join("/");

  const brandedOf = (type: ts.Type): string | undefined => {
    const symbol = type.aliasSymbol ?? type.getSymbol();
    const declaration = symbol?.declarations?.[0];
    if (symbol === undefined || declaration === undefined) {
      return undefined;
    }
    const file = relative(declaration.getSourceFile().fileName);
    return BRANDED_PROOF_TYPES.some(
      (branded) => branded.file === file && branded.name === symbol.getName(),
    )
      ? symbol.getName()
      : undefined;
  };

  /** The first branded type `root` contains, depth first, or `undefined`. */
  const containedBranded = (root: ts.Type): string | undefined => {
    const seen = new Set<ts.Type>();
    const visit = (type: ts.Type): string | undefined => {
      if (seen.has(type)) {
        return undefined;
      }
      seen.add(type);
      const branded = brandedOf(type);
      if (branded !== undefined) {
        return branded;
      }
      const parts: ts.Type[] = [];
      if (type.isUnionOrIntersection()) {
        parts.push(...type.types);
      }
      // An alias's own type arguments: `Partial<Finding>` is an alias
      // instantiation whose argument is reached here even before its
      // (mapped) properties are.
      parts.push(...(type.aliasTypeArguments ?? []));
      if (type.flags & ts.TypeFlags.Object) {
        const object = type as ts.ObjectType;
        if (object.objectFlags & ts.ObjectFlags.Reference) {
          parts.push(...checker.getTypeArguments(type as ts.TypeReference));
        }
        for (const property of checker.getPropertiesOfType(type)) {
          // A lib type's own members (Array's methods, Map's) hold no proof
          // value of their own; what they hold is reached through the type
          // arguments above. Every other property is walked -- a mapped
          // type's (`Partial`, `Pick`, `Omit`, `Readonly`) included, whose
          // symbol may have no value declaration of its own.
          const declarations = property.declarations ?? [];
          const libOnly =
            declarations.length > 0 &&
            declarations.every(
              (declaration) =>
                program.isSourceFileDefaultLibrary(
                  declaration.getSourceFile(),
                ) ||
                declaration.getSourceFile().fileName.includes("node_modules"),
            );
          if (!libOnly) {
            parts.push(checker.getTypeOfSymbol(property));
          }
        }
        for (const signature of [
          ...checker.getSignaturesOfType(type, ts.SignatureKind.Call),
          ...checker.getSignaturesOfType(type, ts.SignatureKind.Construct),
        ]) {
          parts.push(checker.getReturnTypeOfSignature(signature));
          for (const parameter of signature.getParameters()) {
            parts.push(checker.getTypeOfSymbol(parameter));
          }
        }
        // Every index signature: string, number, symbol and template-literal keys.
        for (const info of checker.getIndexInfosOfType(type)) {
          parts.push(info.type);
        }
      }
      for (const part of parts) {
        const found = visit(part);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    };
    return visit(root);
  };

  const testingDirectory = path.join(repoRoot, "src", "testing");
  const found: ProofInputCast[] = [];
  for (const file of files) {
    const sourceFile = program.getSourceFile(file);
    if (sourceFile === undefined) {
      continue;
    }
    const visit = (node: ts.Node): void => {
      const specifier =
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : ts.isCallExpression(node) &&
              (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) &&
                  node.expression.text === "require")) &&
              node.arguments[0] !== undefined &&
              ts.isStringLiteralLike(node.arguments[0])
            ? node.arguments[0].text
            : undefined;
      if (
        specifier !== undefined &&
        specifier.startsWith(".") &&
        path
          .resolve(path.dirname(file), specifier)
          .startsWith(testingDirectory + path.sep)
      ) {
        found.push({
          file: relative(file),
          enclosing: enclosingName(node),
          brandedType: TESTING_IMPORT,
        });
      }
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const typeNode = node.type;
        const isConst =
          ts.isTypeReferenceNode(typeNode) &&
          ts.isIdentifier(typeNode.typeName) &&
          typeNode.typeName.text === "const";
        if (!isConst) {
          const brandedType = containedBranded(
            checker.getTypeFromTypeNode(typeNode),
          );
          if (brandedType !== undefined) {
            found.push({
              file: relative(file),
              enclosing: enclosingName(node),
              brandedType,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return found;
}
