import ts from "typescript";

/**
 * A TypeScript namespace's exported members, grouped across the blocks
 * that merge into one namespace (task BL-095, RWF-131; shared with the
 * scope walk of named-bindings.ts by task BL-099, RWF-141).
 *
 * TypeScript compiles a namespace's exports onto the namespace's object,
 * and a use of one in a body of the namespace to a read or write of that
 * object (`h(1)` → `N.h(1)`, `k = v` → `N.k = v`). Which uses it rewrites
 * is decided by the namespace's merged exports. The escape row reads them
 * here; the resolver refuses every name a use walks out of a namespace for
 * (named-bindings.ts, `leavesNamespace`), since a namespace may have
 * blocks no file's syntax shows.
 */

/** One exported member of a namespace's blocks: its name and its declaration. */
export interface NamespaceMember {
  readonly name: string;
  readonly declaration: ts.Node;
}

export function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

/** Whether `node` is in an ambient context: it or an ancestor is `declare`d, or the file is a declaration file. */
function inAmbientContext(node: ts.Node): boolean {
  for (
    let current: ts.Node | undefined = node;
    current;
    current = current.parent
  ) {
    if (ts.isSourceFile(current)) {
      return current.isDeclarationFile;
    }
    if (
      ts.canHaveModifiers(current) &&
      (ts.getModifiers(current) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
      )
    ) {
      return true;
    }
  }
  return false;
}

function bindingNames(name: ts.BindingName): ts.Identifier[] {
  return ts.isIdentifier(name)
    ? [name]
    : name.elements.flatMap((element) =>
        ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
      );
}

/** `A.B.C` for `C` in `namespace A { export namespace B.C {} }`; a string name (`declare module "m"`) is quoted. */
export function qualifiedNamespaceName(ns: ts.ModuleDeclaration): string {
  const parts: string[] = [];
  let current: ts.Node = ns;
  for (;;) {
    if (ts.isModuleDeclaration(current)) {
      parts.unshift(
        ts.isIdentifier(current.name)
          ? current.name.text
          : JSON.stringify(current.name.text),
      );
      current = current.parent;
    } else if (
      ts.isModuleBlock(current) &&
      ts.isModuleDeclaration(current.parent)
    ) {
      current = current.parent;
    } else {
      return parts.join(".");
    }
  }
}

/**
 * Every namespace block of the file, by qualified name: every block with
 * the same qualified name, at any depth (`namespace A { export namespace B
 * {} }`, `namespace A.B {}` and a second `namespace A { namespace B {} }`
 * are one; merging a block that is not exported too can only refuse).
 * Built once per file.
 */
export function namespaceBlocks(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, readonly ts.ModuleDeclaration[]> {
  let blocks = namespaceBlocksCache.get(sourceFile);
  if (!blocks) {
    namespaceBlockIndexBuilds += 1;
    const built = new Map<string, ts.ModuleDeclaration[]>();
    const visit = (node: ts.Node): void => {
      if (ts.isModuleDeclaration(node)) {
        const path = qualifiedNamespaceName(node);
        const list = built.get(path);
        if (list) {
          list.push(node);
        } else {
          built.set(path, [node]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    blocks = built;
    namespaceBlocksCache.set(sourceFile, blocks);
  }
  return blocks;
}

const namespaceBlocksCache = new WeakMap<
  ts.SourceFile,
  ReadonlyMap<string, readonly ts.ModuleDeclaration[]>
>();

/**
 * The exported members of a namespace's blocks: every exported variable
 * (each name a pattern binds), function, class, enum, namespace and
 * `export import`, and the inner namespace of a dotted `namespace A.B`. A
 * member declared with `declare` emits no store, but a use of it in a body
 * is rewritten like the others (`export declare let k` → `D.k = v`, task
 * BL-095's audit, round 1, finding 5), so it is a member here; so is every
 * declaration of an ambient block, exported without the keyword (task
 * BL-099's audit, round 1).
 */
export function exportedNamespaceMembers(
  blocks: readonly ts.ModuleDeclaration[],
): NamespaceMember[] {
  const members: NamespaceMember[] = [];
  for (const block of blocks) {
    if (block.body === undefined) {
      continue;
    }
    if (ts.isModuleDeclaration(block.body)) {
      // `namespace A.B { … }`: `B` is A's exported member.
      if (ts.isIdentifier(block.body.name)) {
        members.push({ name: block.body.name.text, declaration: block.body });
      }
      continue;
    }
    if (!ts.isModuleBlock(block.body)) {
      continue;
    }
    // Task BL-099's independent audit, round 1: in an ambient block
    // (`declare namespace N { let h: any; }`, or one nested in it) every
    // declaration is exported without the keyword, and a use in another
    // block of the namespace is rewritten (`h(1)` → `N.h(1)`). Only an
    // `export {}` in the block turns that off; counting its declarations
    // anyway can only refuse more.
    const ambient = inAmbientContext(block);
    for (const statement of block.body.statements) {
      if (!ambient && !hasExportModifier(statement)) {
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          for (const id of bindingNames(declaration.name)) {
            members.push({ name: id.text, declaration });
          }
        }
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isModuleDeclaration(statement) ||
          ts.isImportEqualsDeclaration(statement)) &&
        statement.name !== undefined &&
        ts.isIdentifier(statement.name)
      ) {
        members.push({ name: statement.name.text, declaration: statement });
      }
    }
  }
  return members;
}

let namespaceBlockIndexBuilds = 0;

/** Structural counters for the performance tests (ARCHITECTURE § 10.2). */
export function namespaceMemberCounters(): {
  readonly namespaceBlockIndexBuilds: number;
} {
  return { namespaceBlockIndexBuilds };
}
