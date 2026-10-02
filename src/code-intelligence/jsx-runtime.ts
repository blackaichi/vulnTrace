import { isBuiltin } from "node:module";
import ts from "typescript";

/**
 * Task A-3b (PRM-116, RWF-066): what a JSX element or fragment compiles to,
 * decided the way TypeScript decides it, so the call graph and the
 * module-load closure ask one question and cannot disagree.
 *
 * A JSX site is a call. With the CLASSIC runtime (`jsx: react`), `<A />`
 * compiles to `factory(A, props, ...children)`, the factory being the
 * file's `@jsx` pragma, the project's `jsxFactory`, or
 * `React.createElement` (a fragment to `factory(fragmentFactory, null,
 * ...)`, from `@jsxFrag`, `jsxFragmentFactory` or `React.Fragment`): a
 * value already in scope. With the AUTOMATIC runtime (`jsx: react-jsx` /
 * `react-jsxdev`) it compiles to a call of `jsx` / `jsxs` / `jsxDEV` from
 * `require("<importSource>/jsx-runtime")` -- a module load that no source
 * line spells (RWF-066). A file's own `@jsxRuntime` pragma overrides the
 * project's choice, and an `@jsxImportSource` pragma alone switches it to
 * the automatic runtime, and so does the project option `jsxImportSource`
 * (TypeScript's `getJSXImplicitImportBase`; each rule here is checked
 * against TypeScript 5.9.3's emit in `jsx-runtime.test.ts`). The project's
 * root `tsconfig.json` is taken as the compiler of record: a build that
 * compiles JSX with another tool or settings is not modeled (backlog
 * BL-041).
 *
 * Anything else is UNDETERMINED: `jsx: preserve` and `react-native` leave
 * the JSX to a later tool this analyzer does not see, a missing `jsx`
 * option makes the source not compile, and without the project's settings
 * at all nothing is known. A JavaScript file (`.js`, `.jsx`) is compiled
 * by TypeScript only under `allowJs`; without it, whatever compiles its JSX
 * is not the project's TypeScript, and its runtime is undetermined too. An
 * undetermined runtime may load a module, so every consumer fails closed
 * on it.
 */

/** The project's JSX compiler options, as `tsconfig.json` sets them. */
export interface JsxSettings {
  readonly jsx?: ts.JsxEmit;
  /** Whether TypeScript compiles JavaScript files (`.js`, `.jsx`) at all. */
  readonly allowJs?: boolean;
  readonly jsxFactory?: string;
  readonly jsxFragmentFactory?: string;
  readonly jsxImportSource?: string;
  /**
   * The namespace of the default classic factories (`<ns>.createElement`,
   * `<ns>.Fragment`); `React` when unset. Missed by the first versions
   * (task A-3b's fourth audit round): with it set, the compiled call goes
   * through another name than the one the factory rule inspected.
   */
  readonly reactNamespace?: string;
}

export type JsxRuntime =
  | {
      readonly kind: "classic";
      /** The entity the compiled element calls (`React.createElement`, `h`). */
      readonly factory: string;
      /** The entity a compiled fragment hands the factory (`React.Fragment`). */
      readonly fragmentFactory: string;
    }
  | {
      readonly kind: "automatic";
      /** The package whose `jsx-runtime` the compiled file requires. */
      readonly importSource: string;
    }
  | { readonly kind: "undetermined" };

export type JsxSite =
  ts.JsxOpeningElement | ts.JsxSelfClosingElement | ts.JsxOpeningFragment;

export function isJsxSite(node: ts.Node): node is JsxSite {
  return (
    ts.isJsxOpeningElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxOpeningFragment(node)
  );
}

/**
 * One pragma's argument, as TypeScript's parser recorded it on the file.
 * A repeated pragma is recorded as an array: TypeScript reads the LAST
 * `@jsxRuntime` / `@jsxImportSource` (`getJSXImplicitImportBase`), and for
 * `@jsx` / `@jsxFrag` this module does not rely on which one it reads --
 * a repeated factory pragma is `"repeated"`, and the runtime undetermined
 * (task A-3b's independent audit: reading the first of several
 * `@jsxRuntime` pragmas took a file TypeScript compiles for the automatic
 * runtime for a classic one).
 */
function pragmaArgument(
  sourceFile: ts.SourceFile,
  name: string,
  repeated: "last" | "refuse",
): string | undefined | "unreadable" | "repeated" {
  // `pragmas` is populated by the parser for every source file but left
  // off the public `ts.SourceFile` type, like `parseDiagnostics`
  // (source-index.ts). If a TypeScript upgrade moves it, the pragmas can
  // no longer be read, and the runtime is undetermined.
  const pragmas = (sourceFile as { pragmas?: unknown }).pragmas;
  if (!(pragmas instanceof Map)) {
    return "unreadable";
  }
  const entry: unknown = pragmas.get(name);
  if (entry === undefined) {
    return undefined;
  }
  if (Array.isArray(entry) && entry.length > 1 && repeated === "refuse") {
    return "repeated";
  }
  const read: unknown = Array.isArray(entry) ? entry[entry.length - 1] : entry;
  const factory = (read as { arguments?: { factory?: unknown } } | undefined)
    ?.arguments?.factory;
  return typeof factory === "string" ? factory : "unreadable";
}

/**
 * The runtime `sourceFile`'s JSX compiles for, under the project's
 * `settings` (`undefined`: no project, so undetermined).
 */
export function jsxRuntimeOf(
  sourceFile: ts.SourceFile,
  settings: JsxSettings | undefined,
): JsxRuntime {
  if (
    settings === undefined ||
    (isJavaScriptFile(sourceFile) && settings.allowJs !== true)
  ) {
    return { kind: "undetermined" };
  }
  const { jsx } = settings;
  if (
    jsx !== ts.JsxEmit.React &&
    jsx !== ts.JsxEmit.ReactJSX &&
    jsx !== ts.JsxEmit.ReactJSXDev
  ) {
    return { kind: "undetermined" };
  }
  const runtime = pragmaArgument(sourceFile, "jsxruntime", "last");
  const importSource = pragmaArgument(sourceFile, "jsximportsource", "last");
  const factory = pragmaArgument(sourceFile, "jsx", "refuse");
  const fragmentFactory = pragmaArgument(sourceFile, "jsxfrag", "refuse");
  if (
    runtime === "unreadable" ||
    runtime === "repeated" ||
    importSource === "unreadable" ||
    importSource === "repeated" ||
    factory === "unreadable" ||
    factory === "repeated" ||
    fragmentFactory === "unreadable" ||
    fragmentFactory === "repeated"
  ) {
    return { kind: "undetermined" };
  }
  if (
    runtime !== undefined &&
    runtime !== "automatic" &&
    runtime !== "classic"
  ) {
    return { kind: "undetermined" };
  }
  // TypeScript's `getJSXImplicitImportBase`: a classic `@jsxRuntime`
  // pragma wins; otherwise the automatic runtime is chosen by the `jsx`
  // mode, the project's `jsxImportSource` option, an `@jsxImportSource`
  // pragma or an automatic `@jsxRuntime` pragma (the project option was
  // missed by the first version; task A-3b's independent audit).
  const automatic =
    runtime !== "classic" &&
    (jsx !== ts.JsxEmit.React ||
      settings.jsxImportSource !== undefined ||
      importSource !== undefined ||
      runtime === "automatic");
  if (automatic) {
    return {
      kind: "automatic",
      importSource: importSource ?? settings.jsxImportSource ?? "react",
    };
  }
  return {
    kind: "classic",
    factory:
      factory ??
      settings.jsxFactory ??
      `${settings.reactNamespace ?? "React"}.createElement`,
    fragmentFactory:
      fragmentFactory ??
      settings.jsxFragmentFactory ??
      `${settings.reactNamespace ?? "React"}.Fragment`,
  };
}

function isJavaScriptFile(sourceFile: ts.SourceFile): boolean {
  return /\.(c|m)?jsx?$/i.test(sourceFile.fileName);
}

function entityRoot(entity: string): string {
  return entity.split(".")[0]!.trim();
}

/**
 * Whether a classic factory rooted in `name` is provably NOT the module
 * loader, in `sourceFile`: every declaration of the name anywhere in the
 * file is a top-level, non-`declare` function or class declaration, or a
 * value import from a module that is not a Node builtin, and nothing
 * assigns the bare name (a destructuring-assignment pattern included). Anything
 * else -- a name the file does not declare (a global, the module's own
 * `require`), a `const` / `let` / `var` / parameter / destructured
 * binding (`const r = require`, `const { _load: h } = require("module")`),
 * a type-only import, an import from a builtin, a file with a `with`
 * statement -- may be a loader capability, and the site is treated as
 * one that may load a module.
 *
 * Deciding by the root's SPELLING, as the first version did, was wrong in
 * the dangerous direction: an alias of `require` under any other name
 * passed (task A-3b's independent audit, a family-A false `NOT_AFFECTED`).
 * The loader classifier catches such an alias only at a call that spells
 * it, and a JSX site spells none.
 */
function classicFactoryRootIsInert(
  sourceFile: ts.SourceFile,
  name: string,
): boolean {
  let declared = false;
  let inert = true;
  const visit = (node: ts.Node): void => {
    if (!inert) {
      return;
    }
    if (ts.isWithStatement(node)) {
      inert = false;
      return;
    }
    if (ts.isIdentifier(node) && node.text === name) {
      const verdict = identifierRole(node);
      if (verdict === "inert_declaration") {
        declared = true;
      } else if (verdict === "other_declaration" || verdict === "write") {
        inert = false;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return inert && declared;
}

function isAmbientDeclaration(node: ts.Node): boolean {
  return (
    node.getSourceFile().isDeclarationFile ||
    (ts.canHaveModifiers(node) &&
      (ts.getModifiers(node) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
      ))
  );
}

function identifierRole(
  id: ts.Identifier,
): "inert_declaration" | "other_declaration" | "write" | "use" {
  const parent = id.parent;
  if (
    (ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) &&
    parent.name === id
  ) {
    // Inert only where it binds the name the JSX site resolves: at the top
    // level of the file, and not an ambient `declare` form (which binds
    // nothing at runtime, so the site reads a global). A function overload
    // signature (no body) neither binds nor refuses. A nested declaration
    // binds the name in another scope, so the site may read a global
    // (task A-3b's second audit round).
    if (ts.isFunctionDeclaration(parent) && parent.body === undefined) {
      return isAmbientDeclaration(parent) ? "other_declaration" : "use";
    }
    return ts.isSourceFile(parent.parent) && !isAmbientDeclaration(parent)
      ? "inert_declaration"
      : "other_declaration";
  }
  if (
    (ts.isImportClause(parent) && parent.name === id) ||
    (ts.isImportSpecifier(parent) && parent.name === id) ||
    (ts.isNamespaceImport(parent) && parent.name === id)
  ) {
    const declaration = ts.findAncestor(parent, ts.isImportDeclaration);
    const clause = ts.findAncestor(parent, ts.isImportClause);
    const typeOnly =
      clause?.isTypeOnly === true ||
      (ts.isImportSpecifier(parent) && parent.isTypeOnly);
    const specifier = declaration?.moduleSpecifier;
    return !typeOnly &&
      specifier !== undefined &&
      ts.isStringLiteral(specifier) &&
      !isBuiltin(specifier.text)
      ? "inert_declaration"
      : "other_declaration";
  }
  if (ts.isImportEqualsDeclaration(parent) && parent.name === id) {
    const reference = parent.moduleReference;
    return !parent.isTypeOnly &&
      ts.isExternalModuleReference(reference) &&
      ts.isStringLiteral(reference.expression) &&
      !isBuiltin(reference.expression.text)
      ? "inert_declaration"
      : "other_declaration";
  }
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassExpression(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent)) &&
    parent.name === id
  ) {
    // A binding whose value this module does not prove inert: a variable
    // (`const r = require`), a parameter, a named function or class
    // expression, an enum or a namespace. A property name or a member key
    // is not a binding and is not listed.
    return "other_declaration";
  }
  if (ts.isBindingElement(parent) || ts.isShorthandPropertyAssignment(parent)) {
    // `const { h } = …` (a binding element's own name) and `({ h } = …)`.
    return parent.name === id ? "other_declaration" : "use";
  }
  // Climb every wrapper TypeScript erases from an assignment target, not
  // only parentheses: `h!`, `h as T`, `h satisfies T` and `<T>h` are each
  // a plain write to `h` once compiled (task A-3b's third audit round).
  let target: ts.Node = id;
  while (
    ts.isParenthesizedExpression(target.parent) ||
    ts.isNonNullExpression(target.parent) ||
    ts.isAsExpression(target.parent) ||
    ts.isSatisfiesExpression(target.parent) ||
    ts.isTypeAssertionExpression(target.parent) ||
    ts.isPartiallyEmittedExpression(target.parent)
  ) {
    target = target.parent;
  }
  const holder = target.parent;
  if (
    (ts.isPropertyAssignment(holder) && holder.initializer === target) ||
    ts.isSpreadAssignment(holder)
  ) {
    // A value position of an object literal, which is a WRITE when the
    // literal is a destructuring-assignment target (`({ x: h } = o)`,
    // `for ({ x: h } of …)`, at any depth). Over-approximated: any
    // appearance there counts (task A-3b's second audit round).
    return "write";
  }
  if (
    (ts.isBinaryExpression(holder) &&
      holder.left === target &&
      holder.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      holder.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    ((ts.isPrefixUnaryExpression(holder) ||
      ts.isPostfixUnaryExpression(holder)) &&
      (holder.operator === ts.SyntaxKind.PlusPlusToken ||
        holder.operator === ts.SyntaxKind.MinusMinusToken)) ||
    ((ts.isForInStatement(holder) || ts.isForOfStatement(holder)) &&
      holder.initializer === target) ||
    ts.isArrayLiteralExpression(holder) ||
    ts.isSpreadElement(holder)
  ) {
    // An assignment to the bare name, including a destructuring target
    // (an array literal or spread being written to is over-approximated:
    // any appearance there counts).
    return "write";
  }
  return "use";
}

/**
 * Whether the compiled form of `site` may LOAD a module no source line
 * spells: under the automatic runtime it always does (`jsx-runtime`); under
 * an undetermined runtime it may; under the classic runtime unless the
 * factory it calls (and, for a fragment, the fragment factory it hands
 * over) is rooted in a name the file provably binds to something other
 * than a loader ({@link classicFactoryRootIsInert}). This one predicate decides
 * both the call graph's edge reason (`jsx_runtime_load` against
 * `jsx_factory_call`) and whether the module-load closure records the
 * site.
 */
export function jsxSiteMayLoad(site: JsxSite, runtime: JsxRuntime): boolean {
  if (runtime.kind !== "classic") {
    return true;
  }
  const entities = ts.isJsxOpeningFragment(site)
    ? [runtime.factory, runtime.fragmentFactory]
    : [runtime.factory];
  const sourceFile = site.getSourceFile();
  return entities.some(
    (entity) => !classicFactoryRootIsInert(sourceFile, entityRoot(entity)),
  );
}

/**
 * Whether a JSX tag names an intrinsic element (`<div>`, `<my-element>`,
 * `<svg:rect>`), which compiles to a string rather than a reference to a
 * component -- TypeScript's own rule: a plain identifier starting with a
 * lower-case letter, or containing a dash, or a namespaced name.
 */
export function isIntrinsicJsxTag(tag: ts.JsxTagNameExpression): boolean {
  if (ts.isJsxNamespacedName(tag)) {
    return true;
  }
  if (!ts.isIdentifier(tag)) {
    return false;
  }
  const text = tag.text;
  return text.includes("-") || /^[a-z]/.test(text);
}

/**
 * The expressions a JSX site hands its factory, in the factory call's
 * order: the tag when it names a component (never an intrinsic element's
 * string), then every attribute value and spread, then every child
 * expression. A nested element, fragment or attribute element is a site
 * of its own and is not listed; a string attribute or text child is
 * primitive and is not listed either.
 */
export function jsxHandedExpressions(site: JsxSite): ts.Expression[] {
  const handed: ts.Expression[] = [];
  const hand = (expression: ts.Expression | undefined): void => {
    if (expression && !isJsxValue(expression)) {
      handed.push(expression);
    }
  };
  if (!ts.isJsxOpeningFragment(site)) {
    const tag = site.tagName;
    if (!isIntrinsicJsxTag(tag) && !ts.isJsxNamespacedName(tag)) {
      handed.push(tag);
    }
    for (const attribute of site.attributes.properties) {
      if (ts.isJsxSpreadAttribute(attribute)) {
        hand(attribute.expression);
      } else if (
        attribute.initializer &&
        ts.isJsxExpression(attribute.initializer)
      ) {
        hand(attribute.initializer.expression);
      }
    }
  }
  const children = ts.isJsxSelfClosingElement(site)
    ? []
    : ts.isJsxOpeningFragment(site)
      ? (site.parent as ts.JsxFragment).children
      : (site.parent as ts.JsxElement).children;
  for (const child of children) {
    if (ts.isJsxExpression(child)) {
      hand(child.expression);
    }
  }
  return handed;
}

/** A JSX element or fragment, possibly parenthesized: a site of its own. */
function isJsxValue(expression: ts.Expression): boolean {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return (
    ts.isJsxElement(current) ||
    ts.isJsxSelfClosingElement(current) ||
    ts.isJsxFragment(current)
  );
}
