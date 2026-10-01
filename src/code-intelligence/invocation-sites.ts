import { isBuiltin } from "node:module";
import ts from "typescript";
import { escapingAssignmentOf, type EscapeRoot } from "./escape-row.js";
import { classHasOwnConstructor } from "./source-index.js";

/**
 * ADR 0008 invariant A1 (task A-1): WHICH syntax is an invocation-capable
 * site, and which is not, decided once, for every `ts.SyntaxKind`.
 *
 * Two things live here, deliberately together:
 *
 * - {@link invocationSiteOf}, the ONE question the call-graph walk asks
 *   of every node ("is this a site, and of which kind?"). Its answer
 *   drives `call-graph.ts`'s handler table, which is typed over
 *   {@link InvocationSiteKind}, so a site kind with no handler is a type
 *   error.
 * - {@link SYNTAX_KIND_CENSUS}, the classification of every node kind the
 *   parser can produce, with the reason for each. A TypeScript upgrade
 *   that adds a node kind fails `invocation-sites.census.test.ts` until
 *   someone classifies it here -- which is the point: before this task,
 *   `walkFile` simply ignored every kind it did not name, and three of
 *   them (tagged templates, decorators, derived classes with no
 *   constructor) ran user code the graph never saw (PRM-37, PRM-115,
 *   PRM-19).
 */

/** The site kinds A-1 accounts for, and `escaping_assignment` (task A-3a). Later lane-A tasks add theirs. */
export type InvocationSiteKind =
  | "call"
  | "construct"
  | "tagged_template"
  | "decorator"
  | "implicit_super"
  | "escaping_assignment";

export type ClassLike = ts.ClassDeclaration | ts.ClassExpression;

export type InvocationSite =
  | { readonly kind: "call"; readonly node: ts.CallExpression }
  | { readonly kind: "construct"; readonly node: ts.NewExpression }
  | {
      readonly kind: "tagged_template";
      readonly node: ts.TaggedTemplateExpression;
    }
  | {
      readonly kind: "decorator";
      readonly node: ts.Decorator;
      /**
       * The class whose DEFINITION invokes this decorator -- the class
       * itself for a class decorator, the enclosing class for a member or
       * parameter decorator -- or `undefined` when the decorator sits
       * where no class definition evaluates it (a syntax error the parser
       * recovered from). Every decorator, whatever it decorates, is
       * invoked while its class definition is evaluated, never when the
       * decorated member later runs.
       */
      readonly decoratedClass: ClassLike | undefined;
    }
  | {
      readonly kind: "implicit_super";
      readonly node: ClassLike;
      /** The `extends` expression: the constructor `super(...args)` runs. */
      readonly base: ts.Expression;
    }
  | {
      /**
       * Task A-3a, ADR 0008 § 2's escape row: "the right-hand side of an
       * assignment to a member rooted in an ambient or builtin value". The
       * runtime may invoke what is stored (`Error.prepareStackTrace = f`,
       * PRM-114), and a later call of the builtin reaches it
       * (`Math.max = f; Math.max(1)`).
       */
      readonly kind: "escaping_assignment";
      readonly node: ts.BinaryExpression;
      readonly root: EscapeRoot;
    };

/**
 * The invocation site `node` is, if any. Total over the node kinds the
 * census marks `site`; `undefined` for every other kind, and for a class
 * that is not a derived class relying on its implicit constructor.
 */
export function invocationSiteOf(node: ts.Node): InvocationSite | undefined {
  if (ts.isCallExpression(node)) {
    return { kind: "call", node };
  }
  if (ts.isNewExpression(node)) {
    return { kind: "construct", node };
  }
  if (ts.isTaggedTemplateExpression(node)) {
    return { kind: "tagged_template", node };
  }
  if (ts.isDecorator(node)) {
    return isEmittedDecorator(node)
      ? { kind: "decorator", node, decoratedClass: decoratedClassOf(node) }
      : undefined;
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    const base = implicitSuperBaseOf(node);
    return base ? { kind: "implicit_super", node, base } : undefined;
  }
  if (ts.isBinaryExpression(node)) {
    const root = escapingAssignmentOf(node, isBuiltin);
    return root ? { kind: "escaping_assignment", node, root } : undefined;
  }
  return undefined;
}

/**
 * The `extends` expression of a derived class whose constructor is the
 * implicit `constructor(...args) { super(...args); }` -- i.e. the class
 * has no constructor of its own (the same test `source-index.ts` uses to
 * synthesize the implicit constructor's node, so the two cannot
 * disagree). `undefined` for a base class, a class with a constructor,
 * and an ambient (`declare`) class, which has no runtime definition.
 */
function implicitSuperBaseOf(node: ClassLike): ts.Expression | undefined {
  if (classHasOwnConstructor(node) || isAmbient(node)) {
    return undefined;
  }
  const extendsClause = node.heritageClauses?.find(
    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
  );
  return extendsClause?.types[0]?.expression;
}

/**
 * Whether `node` is in an ambient context: it, or a declaration enclosing
 * it (a `declare namespace`, a `declare module`), carries `declare`, or
 * the file is a declaration file. Ambient code has no runtime definition.
 */
function isAmbient(node: ts.Node): boolean {
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

/**
 * Whether the compiled program calls this decorator at all. TypeScript
 * ERASES a decorator in some positions, emitting no call, and ADR 0008
 * § 4's premise -- "resolved, because the language guarantees the call"
 * -- holds only where it does not. A decorator in an erased position is
 * therefore not a site: resolving it would fabricate an edge (the task A-1
 * audit reproduced a false AFFECTED for `@logged declare class X {}` and
 * for a setter-parameter decorator).
 *
 * Measured with the repository's TypeScript, both decorator modes
 * (`experimentalDecorators` on and off), target ES2022: every mode erases
 * a decorator on anything in an ambient context (`declare class`,
 * `declare namespace`, a `.d.ts`), on a method or constructor without a
 * body (an abstract method, an overload signature -- and the parameters
 * of either), on a parameter of anything but a constructor or method (a
 * setter, a function), on an object-literal member and on an index
 * signature -- and, in a CLASS EXPRESSION, on a parameter or a `declare`
 * field (legacy erases every decorator of a class expression, standard
 * those two positions; the task A-1 audit's round 2). Only those are
 * excluded. Four positions are erased by ONE mode only -- a class expression (legacy), a constructor or method
 * parameter, a `declare` field and an abstract property (standard) -- and
 * each is a compile error in the mode that erases it, so they stay sites:
 * over-approximating an erroneous program's reachability cannot hide a
 * target, where dropping the site in the other mode could.
 */
function isEmittedDecorator(decorator: ts.Decorator): boolean {
  const target = decorator.parent;
  if (ts.isParameter(target)) {
    const fn = target.parent;
    return (
      (ts.isConstructorDeclaration(fn) || ts.isMethodDeclaration(fn)) &&
      fn.body !== undefined &&
      ts.isClassDeclaration(fn.parent) &&
      !isAmbient(fn.parent)
    );
  }
  if (isClassLike(target)) {
    return !isAmbient(target);
  }
  if (
    (ts.isMethodDeclaration(target) ||
      ts.isConstructorDeclaration(target) ||
      ts.isGetAccessorDeclaration(target) ||
      ts.isSetAccessorDeclaration(target)) &&
    target.body === undefined
  ) {
    return false;
  }
  if (ts.isIndexSignatureDeclaration(target)) {
    return false;
  }
  if (
    ts.isPropertyDeclaration(target) &&
    ts.isClassExpression(target.parent) &&
    (ts.getModifiers(target) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
    )
  ) {
    return false;
  }
  return isClassLike(target.parent) && !isAmbient(target.parent);
}

function isClassLike(node: ts.Node): node is ClassLike {
  return ts.isClassDeclaration(node) || ts.isClassExpression(node);
}

/**
 * The class whose definition evaluates `decorator`: a class decorator's
 * own class, a class element's class, or -- for a parameter decorator --
 * the class of the constructor or method that declares the parameter.
 */
function decoratedClassOf(decorator: ts.Decorator): ClassLike | undefined {
  let owner: ts.Node = decorator.parent;
  if (ts.isParameter(owner)) {
    owner = owner.parent;
  }
  if (isClassLike(owner)) {
    return owner;
  }
  return isClassLike(owner.parent) ? owner.parent : undefined;
}

// ---------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------

/**
 * How one syntax kind stands with respect to invariant A1.
 *
 * - `site`: an invocation-capable site with a handler today.
 * - `pending`: invocation-capable, and NOT yet accounted for. An open
 *   soundness defect, owned by the lane-A task and findings named -- not
 *   an exception. The task that accounts for it turns it into a `site`.
 * - `none`: not an invocation site, for the reason given.
 */
export type CensusEntry =
  | {
      readonly role: "site";
      readonly site: InvocationSiteKind;
      /** Set when only some nodes of the kind are sites. */
      readonly when?: string;
      /**
       * Set when other nodes of the kind are invocation-capable and still
       * unaccounted: the part a later lane-A task owns (task A-3a's
       * `BinaryExpression`, whose protocol-named property writes are A-4's).
       */
      readonly pending?: Omit<
        Extract<CensusEntry, { role: "pending" }>,
        "role"
      >;
    }
  | {
      readonly role: "pending";
      readonly tasks: readonly ("A-3b" | "A-4")[];
      readonly findings: readonly string[];
      readonly what: string;
    }
  | { readonly role: "none"; readonly why: string };

const none = (why: string): CensusEntry => ({ role: "none", why });

const STRUCTURE = none(
  "structure: evaluating it invokes nothing itself; every call it contains is its own site",
);
const DEFINITION = none(
  "a definition: creating it invokes nothing; its body runs only when a site invokes it",
);
const TYPE_ONLY = none(
  "TypeScript-only: erased from the emitted JavaScript, or a type position",
);
const MODULE_SYNTAX = none(
  "module syntax: the module it loads is accounted by module_load edges (VT-307a) and the module-load closure, not by a call edge",
);
const COMPILER_ONLY = none(
  "compiler-internal: never produced by the parser for a source file",
);
/**
 * ADR 0008 § 2's design: an implicit invocation that a use site triggers
 * -- a coercion, a `then` read by `await`, an iterator, a getter, a Proxy
 * trap -- is accounted at the DEFINITION of the invoked member (the
 * protocol-member row, Amendment A-0 part B's accessor rule, or the escape
 * row at the Proxy's creation), not at the use site, which cannot know
 * what it invokes.
 */
const USE_SITE = none(
  "use site of an implicit invocation that ADR 0008 § 2 accounts at the definition (protocol member, accessor, Proxy creation), not here",
);
const PROTOCOL_DEFINITION: CensusEntry = {
  role: "pending",
  tasks: ["A-4"],
  findings: ["PRM-38", "PRM-112", "PRM-113"],
  what: "a protocol-named method or function-valued property (toString, valueOf, toJSON, then, Symbol.iterator, …) is invoked implicitly: ADR 0008 § 2's protocol-member row",
};
const ACCESSOR_DEFINITION: CensusEntry = {
  role: "pending",
  tasks: ["A-4"],
  findings: ["PRM-118"],
  what: "an accessor body is its own owner, invoked implicitly by a property read or write: ADR 0008 Amendment A-0 part B",
};
const JSX_ELEMENT: CensusEntry = {
  role: "pending",
  tasks: ["A-3b"],
  findings: ["PRM-116"],
  what: "a JSX element is a call to the configured factory, which may render the component: ADR 0008 § 2's JSX row",
};

/**
 * Every node kind outside the four lexical families below, by name. The
 * names are the `ts.SyntaxKind` member names; where the enum gives a kind
 * a second (marker) name, the census uses the descriptive one.
 */
export const SYNTAX_KIND_CENSUS = {
  // -- invocation sites -----------------------------------------------------
  CallExpression: { role: "site", site: "call" },
  NewExpression: { role: "site", site: "construct" },
  TaggedTemplateExpression: { role: "site", site: "tagged_template" },
  Decorator: {
    role: "site",
    site: "decorator",
    when: "a decorator the compiled program calls: not in an ambient context, on a bodiless method or constructor, on a parameter of anything but a constructor or method, on an object-literal member or on an index signature, where TypeScript erases it",
  },
  ClassDeclaration: {
    role: "site",
    site: "implicit_super",
    when: "a derived class with no constructor of its own: its implicit constructor runs the base constructor",
  },
  ClassExpression: {
    role: "site",
    site: "implicit_super",
    when: "a derived class with no constructor of its own: its implicit constructor runs the base constructor",
  },

  // -- pending: invocation-capable, not yet accounted -----------------------
  JsxOpeningElement: JSX_ELEMENT,
  JsxSelfClosingElement: JSX_ELEMENT,
  JsxOpeningFragment: {
    role: "pending",
    tasks: ["A-3b"],
    findings: ["PRM-116"],
    what: "a fragment is a call to the configured factory too; ADR 0008 § 2 names only non-intrinsic element tags, so A-3b decides its account",
  },
  BinaryExpression: {
    role: "site",
    site: "escaping_assignment",
    when: "an assignment (`=`, `||=`, `&&=`, `??=`) that stores a value which may carry the program's own code into an ambient global, a member of one, or a member of a builtin module's value (task A-3a, ADR 0008 § 2's escape row, PRM-114)",
    pending: {
      tasks: ["A-4"],
      findings: ["PRM-38"],
      what: "an assignment to a protocol-named property registers a method the runtime invokes implicitly (A-4). Its operators' coercions are use sites (see USE_SITE)",
    },
  },
  MethodDeclaration: PROTOCOL_DEFINITION,
  PropertyAssignment: PROTOCOL_DEFINITION,
  ShorthandPropertyAssignment: PROTOCOL_DEFINITION,
  PropertyDeclaration: PROTOCOL_DEFINITION,
  GetAccessor: ACCESSOR_DEFINITION,
  SetAccessor: ACCESSOR_DEFINITION,

  // -- use sites, accounted at the definition --------------------------------
  PropertyAccessExpression: USE_SITE,
  ElementAccessExpression: USE_SITE,
  AwaitExpression: USE_SITE,
  YieldExpression: USE_SITE,
  SpreadElement: USE_SITE,
  SpreadAssignment: USE_SITE,
  ArrayBindingPattern: USE_SITE,
  ObjectBindingPattern: USE_SITE,
  BindingElement: USE_SITE,
  TemplateExpression: USE_SITE,
  PrefixUnaryExpression: USE_SITE,
  PostfixUnaryExpression: USE_SITE,
  DeleteExpression: USE_SITE,
  ComputedPropertyName: USE_SITE,
  ForOfStatement: USE_SITE,
  ForInStatement: USE_SITE,
  WithStatement: USE_SITE,
  VariableDeclarationList: USE_SITE,
  HeritageClause: USE_SITE,
  ExpressionWithTypeArguments: USE_SITE,
  JsxSpreadAttribute: USE_SITE,

  // -- definitions ------------------------------------------------------------
  FunctionDeclaration: DEFINITION,
  FunctionExpression: DEFINITION,
  ArrowFunction: DEFINITION,
  Constructor: DEFINITION,
  ClassStaticBlockDeclaration: none(
    "a definition whose body runs at class definition: every call in it is its own site, attributed to the owner that evaluates the class",
  ),
  Parameter: DEFINITION,
  VariableDeclaration: DEFINITION,
  EnumDeclaration: none(
    "evaluated where it is declared: its member initializers run at once, and every call in them is its own site under the enclosing owner",
  ),
  EnumMember: none(
    "evaluated where its enum is declared: a call in its initializer is its own site under the enclosing owner",
  ),
  ModuleDeclaration: none(
    "a TypeScript namespace: its body runs where it is declared, and every call in it is its own site under the enclosing owner",
  ),
  SemicolonClassElement: DEFINITION,
  MissingDeclaration: DEFINITION,

  // -- structure --------------------------------------------------------------
  SourceFile: STRUCTURE,
  Block: STRUCTURE,
  ModuleBlock: STRUCTURE,
  CaseBlock: STRUCTURE,
  EmptyStatement: STRUCTURE,
  VariableStatement: STRUCTURE,
  ExpressionStatement: STRUCTURE,
  IfStatement: none(
    "structure; a branch the walk prunes has every site in it accounted `constant_folded_branch` (UnprovenNoEdgeReason)",
  ),
  DoStatement: STRUCTURE,
  WhileStatement: STRUCTURE,
  ForStatement: STRUCTURE,
  ContinueStatement: STRUCTURE,
  BreakStatement: STRUCTURE,
  ReturnStatement: STRUCTURE,
  SwitchStatement: STRUCTURE,
  LabeledStatement: STRUCTURE,
  ThrowStatement: STRUCTURE,
  TryStatement: STRUCTURE,
  DebuggerStatement: STRUCTURE,
  CaseClause: STRUCTURE,
  DefaultClause: STRUCTURE,
  CatchClause: STRUCTURE,
  ArrayLiteralExpression: STRUCTURE,
  ObjectLiteralExpression: STRUCTURE,
  ParenthesizedExpression: STRUCTURE,
  TypeOfExpression: STRUCTURE,
  VoidExpression: STRUCTURE,
  ConditionalExpression: STRUCTURE,
  OmittedExpression: STRUCTURE,
  MetaProperty: STRUCTURE,
  TemplateSpan: STRUCTURE,
  QualifiedName: STRUCTURE,
  JsxElement: none(
    "structure: its invocation is accounted at its opening element",
  ),
  JsxFragment: none(
    "structure: its invocation is accounted at its opening fragment",
  ),
  JsxClosingElement: STRUCTURE,
  JsxClosingFragment: STRUCTURE,
  JsxAttribute: STRUCTURE,
  JsxAttributes: STRUCTURE,
  JsxExpression: STRUCTURE,
  JsxNamespacedName: STRUCTURE,

  // -- TypeScript-only --------------------------------------------------------
  TypeParameter: TYPE_ONLY,
  PropertySignature: TYPE_ONLY,
  MethodSignature: TYPE_ONLY,
  CallSignature: TYPE_ONLY,
  ConstructSignature: TYPE_ONLY,
  IndexSignature: TYPE_ONLY,
  InterfaceDeclaration: TYPE_ONLY,
  TypeAliasDeclaration: TYPE_ONLY,
  TypeAssertionExpression: TYPE_ONLY,
  AsExpression: TYPE_ONLY,
  NonNullExpression: TYPE_ONLY,
  SatisfiesExpression: TYPE_ONLY,

  // -- module syntax ----------------------------------------------------------
  ImportDeclaration: MODULE_SYNTAX,
  ImportEqualsDeclaration: MODULE_SYNTAX,
  ExportDeclaration: MODULE_SYNTAX,
  ExportAssignment: MODULE_SYNTAX,
  NamespaceExportDeclaration: MODULE_SYNTAX,
  ExternalModuleReference: MODULE_SYNTAX,
  ImportClause: MODULE_SYNTAX,
  NamespaceImport: MODULE_SYNTAX,
  NamedImports: MODULE_SYNTAX,
  ImportSpecifier: MODULE_SYNTAX,
  NamedExports: MODULE_SYNTAX,
  NamespaceExport: MODULE_SYNTAX,
  ExportSpecifier: MODULE_SYNTAX,
  ImportAttributes: MODULE_SYNTAX,
  ImportAttribute: MODULE_SYNTAX,
  ImportTypeAssertionContainer: MODULE_SYNTAX,

  // -- compiler-internal ------------------------------------------------------
  SyntheticExpression: COMPILER_ONLY,
  NotEmittedStatement: COMPILER_ONLY,
  NotEmittedTypeElement: COMPILER_ONLY,
  PartiallyEmittedExpression: COMPILER_ONLY,
  CommaListExpression: COMPILER_ONLY,
  SyntheticReferenceExpression: COMPILER_ONLY,
  SyntaxList: COMPILER_ONLY,
  Bundle: COMPILER_ONLY,
} as const satisfies Readonly<
  Partial<Record<keyof typeof ts.SyntaxKind, CensusEntry>>
>;

/**
 * The four families classified by range rather than by name, because no
 * member of them is a node that evaluates anything: tokens and keywords
 * are lexical (a keyword that is also an expression, such as `this` or
 * `super`, is invoked only as part of an enclosing call, which is the
 * site), type nodes are erased, and JSDoc nodes are comments. The ranges
 * are TypeScript's own markers, so a new member of a family lands in its
 * family; a new NODE kind lands in none of them and must be named in
 * {@link SYNTAX_KIND_CENSUS}.
 */
export const LEXICAL_FAMILIES: readonly {
  readonly family: string;
  readonly first: ts.SyntaxKind;
  readonly last: ts.SyntaxKind;
  readonly entry: CensusEntry;
}[] = [
  {
    family: "token or keyword",
    first: ts.SyntaxKind.FirstToken,
    last: ts.SyntaxKind.LastToken,
    entry: none(
      "lexical: a token or keyword; where it is an expression, the call that uses it is the site",
    ),
  },
  {
    family: "type node",
    first: ts.SyntaxKind.FirstTypeNode,
    last: ts.SyntaxKind.LastTypeNode,
    entry: TYPE_ONLY,
  },
  {
    family: "JSDoc node",
    first: ts.SyntaxKind.FirstJSDocNode,
    last: ts.SyntaxKind.LastJSDocNode,
    entry: none("a JSDoc comment node: never evaluated"),
  },
];

const censusByKind = new Map<ts.SyntaxKind, CensusEntry>(
  Object.entries(SYNTAX_KIND_CENSUS).map(([name, entry]) => [
    ts.SyntaxKind[name as keyof typeof ts.SyntaxKind],
    entry,
  ]),
);

/**
 * The census entry for `kind`, or `undefined` when nobody has classified
 * it -- which `invocation-sites.census.test.ts` turns into a failure for
 * every kind the installed TypeScript defines.
 */
export function censusEntryFor(kind: ts.SyntaxKind): CensusEntry | undefined {
  const named = censusByKind.get(kind);
  if (named) {
    return named;
  }
  return LEXICAL_FAMILIES.find(
    (family) => kind >= family.first && kind <= family.last,
  )?.entry;
}
