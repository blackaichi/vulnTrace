import ts from "typescript";
import type {
  CallEdge,
  CallGraph,
  DynamicCallReason,
  GraphNode,
  GraphNodeId,
} from "../domain/graph.js";
import type { KnownPackageRoots } from "../domain/resolved-target.js";
import {
  classifyClosureWideningCall,
  isStaticRequireCall,
} from "./loader-constructs.js";
import {
  isConstDeclaration,
  resolveSingleAssignmentValue,
} from "./local-aliases.js";
import {
  buildModuleModel,
  mapExportsToFunctions,
  type ModuleModel,
} from "./module-model.js";
import type { ModuleResolver } from "./module-resolver.js";
import {
  type IndexedFunction,
  type SourceIndex,
  indexSourceFileFromDisk,
  isFunctionLike,
  toSourceLocation,
} from "./source-index.js";
import { bindCallee, type SymbolBindingResolved } from "./symbol-binder.js";
import type { TsProject } from "./ts-project.js";

function locationKey(location: { line?: number; column?: number }): string {
  return `${location.line ?? "?"}:${location.column ?? "?"}`;
}

/**
 * The {@link CallEdge} `type` each loader-shaped reason produces. The
 * two module-loading forms are `"import"` edges; every other loader
 * construct is a `"direct"` call whose callee happens to be a route to
 * arbitrary code. Only the edge SHAPE lives here -- the classification
 * itself is loader-constructs.ts's (VT-307c-fix-3), shared with
 * ModuleLoadClosure. Reasons absent from this map default to `"direct"`,
 * which is why it lists only the two exceptions.
 */
const LOADER_EDGE_TYPE: Partial<Record<DynamicCallReason, CallEdge["type"]>> = {
  dynamic_import: "import",
  dynamic_require: "import",
};

/**
 * Ambient ECMAScript/Node.js globals that can never resolve to a tracked
 * import or an analyzed local declaration, and can never be the target of
 * a vulnerable-symbol rule (they aren't installable npm packages). Calls
 * and constructions rooted in one of these are intentionally left without
 * a graph edge (see VT-201, docs/SDD.md § 3.1) -- flagging every
 * `console.log()`/`new Map()` in a real codebase as an explicit UNKNOWN
 * edge would make almost every real-world scan degrade to UNKNOWN, since
 * virtually all real code calls some builtin somewhere; that is a far
 * worse outcome than the silent-edge gap VT-201 closes. Every OTHER
 * unresolvable call-like construct -- crucially, anything rooted in a
 * local parameter, variable, or constructed instance the analyzer cannot
 * fully trace -- still becomes an explicit `unsupported_construct` edge
 * (see {@link classifyCall}, {@link classifyNew}); this list only bounds
 * that to a known, finite, auditable set of ambient identifiers, never
 * anything project-defined.
 */
const KNOWN_GLOBAL_IDENTIFIERS: ReadonlySet<string> = new Set([
  "console",
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Symbol",
  "Proxy",
  "Reflect",
  "Function",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Intl",
  "globalThis",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "queueMicrotask",
  "structuredClone",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "fetch",
  "process",
  "Buffer",
  "module",
  "exports",
  "require",
  "__dirname",
  "__filename",
  "global",
]);

function isKnownGlobalIdentifier(name: string): boolean {
  return KNOWN_GLOBAL_IDENTIFIERS.has(name);
}

/**
 * The leftmost identifier of a call/construct callee's expression chain
 * (`foo` for `foo()`/`foo.bar()`/`foo.bar.baz()`/`foo[x]()`), or
 * `undefined` when the callee isn't rooted in a plain identifier at all
 * (e.g. `foo().bar()`) -- used only to check {@link isKnownGlobalIdentifier}
 * before deciding whether an unresolvable call-like construct still
 * deserves an explicit UNKNOWN edge.
 */
function rootIdentifierOf(expr: ts.Expression): string | undefined {
  let current: ts.Expression = expr;
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

function functionNodeId(filePath: string, fn: IndexedFunction): GraphNodeId {
  return `${filePath}#${fn.name ?? "<anonymous>"}@${locationKey(fn.location)}`;
}

function moduleNodeId(filePath: string): GraphNodeId {
  return `${filePath}#<module>`;
}

interface FileGraphData {
  readonly index: SourceIndex;
  readonly model: ModuleModel;
  readonly moduleNodeId: GraphNodeId;
  readonly functionNodeIdByLocation: ReadonlyMap<string, GraphNodeId>;
  /** Export name -> the node implementing it, when it could be attributed to a local function declaration. */
  readonly exportNameToNodeId: ReadonlyMap<string, GraphNodeId>;
}

/**
 * Indexes one file, registers a node for it and every function it
 * contains, and builds the export-name -> node lookup call-edge resolution
 * needs. Returns `undefined` (rather than throwing) when the file cannot
 * be read/parsed — this is target-project data, so a single bad file
 * degrades gracefully instead of aborting the whole graph build (see
 * docs/SDD.md § 5: UNKNOWN over false certainty).
 */
function prepareFile(
  filePath: string,
  registerNode: (node: GraphNode) => void,
): FileGraphData | undefined {
  let index: SourceIndex;
  try {
    index = indexSourceFileFromDisk(filePath);
  } catch {
    return undefined;
  }

  const model = buildModuleModel(index);
  const modNodeId = moduleNodeId(filePath);
  registerNode({ id: modNodeId, kind: "module", module: filePath });

  const functionNodeIdByLocation = new Map<string, GraphNodeId>();
  for (const fn of index.functions) {
    const id = functionNodeId(filePath, fn);
    functionNodeIdByLocation.set(locationKey(fn.location), id);
    registerNode({
      id,
      kind: fn.kind,
      module: filePath,
      name: fn.name,
      location: fn.location,
    });
  }

  const exportNameToNodeId = new Map<string, GraphNodeId>();
  for (const [canonicalName, fn] of mapExportsToFunctions(index, model)) {
    const nodeId = functionNodeIdByLocation.get(locationKey(fn.location));
    if (nodeId) {
      exportNameToNodeId.set(canonicalName, nodeId);
    }
  }

  return {
    index,
    model,
    moduleNodeId: modNodeId,
    functionNodeIdByLocation,
    exportNameToNodeId,
  };
}

function findLocalFunctionNodeId(
  callee: ts.Expression,
  prepared: FileGraphData,
): GraphNodeId | undefined {
  if (!ts.isIdentifier(callee)) {
    return undefined;
  }
  const match = prepared.index.functions.find((fn) => fn.name === callee.text);
  if (!match) {
    return undefined;
  }
  return prepared.functionNodeIdByLocation.get(locationKey(match.location));
}

/**
 * Follows a re-export chain (one or more hops) to the graph node
 * implementing its ultimate origin (see SDD-v0.2.md § 7.4, VT-209;
 * RWF-004a). Two syntaxes are chased, by two deliberately separate
 * relations with deliberately different reach:
 *
 * - ESM `export { x } from "y";` — unchanged since VT-209, including its
 *   cross-package reach ({@link resolveEsmReExport}).
 * - CommonJS `exports.x = require("./y").x` and friends, restricted to the
 *   SAME canonical PackageInstance ({@link resolveCommonJsReExport}).
 *
 * `visited` guards against a re-export cycle (`a` re-exports from `b`, `b`
 * re-exports from `a`, with no real definition anywhere): each
 * file+export-name hop is recorded here, ONCE, before either relation
 * runs, and a repeat stops the chase rather than recursing forever. Both
 * relations recurse back through this function, so they share one visited
 * set and compose across syntaxes without either needing to know about the
 * other. There is deliberately no separate depth limit: the visited set
 * already bounds the chase by the (file, export name) pairs reachable
 * through real resolved specifiers, and a fixed depth cap would silently
 * return "no target" — indistinguishable from "no re-export" — on a
 * legitimate deep chain.
 */
async function resolveReExportChain(
  prepared: FileGraphData,
  exportName: string,
  ctx: WalkContext,
  visited: Set<string>,
): Promise<GraphNodeId | undefined> {
  const hopKey = `${prepared.index.filePath}#${exportName}`;
  if (visited.has(hopKey)) {
    return undefined;
  }
  visited.add(hopKey);

  const viaEsm = await resolveEsmReExport(prepared, exportName, ctx, visited);
  if (viaEsm) {
    return viaEsm;
  }

  return resolveCommonJsReExport(prepared, exportName, ctx, visited);
}

/**
 * The ESM half of {@link resolveReExportChain} (VT-209), behaviorally
 * unchanged since it shipped — extracted only so the CommonJS half can sit
 * beside it rather than inside it. Before VT-209, `export { x } from "y"`
 * was recorded in the module model but never chased: `mapExportsToFunctions`
 * deliberately skips `kind: "re-export"` entries (see module-model.ts).
 *
 * Scoped to the named form only — `export * from "y"` wildcard re-exports
 * are a different problem (matching one specific name against an
 * unenumerated set of re-exported names) and aren't attempted here.
 */
async function resolveEsmReExport(
  prepared: FileGraphData,
  exportName: string,
  ctx: WalkContext,
  visited: Set<string>,
): Promise<GraphNodeId | undefined> {
  const reExport = prepared.model.exports.find(
    (exp) =>
      exp.kind === "re-export" &&
      exp.exportedName === exportName &&
      exp.specifier !== undefined,
  );
  if (!reExport?.specifier) {
    return undefined;
  }

  const resolution = await ctx.resolver.resolve(
    reExport.specifier,
    prepared.index.filePath,
  );
  // VT-304: a declaration-only resolution must never be chased as though
  // it were a real re-export target -- treated the same as "unresolved"
  // here, not as a resolved file to index.
  if (resolution.kind !== "resolved") {
    return undefined;
  }

  ctx.onDiscoverFile(resolution.resolvedFileName);
  const targetFile = ctx.ensurePrepared(resolution.resolvedFileName);
  if (!targetFile) {
    return undefined;
  }

  const originalName = reExport.localName ?? exportName;
  const directTarget = targetFile.exportNameToNodeId.get(originalName);
  if (directTarget) {
    return directTarget;
  }

  return resolveReExportChain(targetFile, originalName, ctx, visited);
}

/**
 * The CommonJS half of {@link resolveReExportChain} (RWF-004a; see
 * docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 5's R-5a). Assembling
 * `module.exports` out of `require()`d sibling files is the dominant
 * authoring pattern for any CommonJS package past trivial size (qs,
 * semver, debug); before this, a call reaching such an export always fell
 * to an honest but imprecise `unresolved_target` edge even though the real
 * implementation was one statically-known hop away.
 *
 * Two forwarding rules, both exactly Node's own semantics:
 *
 * 1. A NAMED re-export (`exports.foo = require("./lib").foo`) forwards
 *    only `foo`, and forwards it to whichever name it actually selected
 *    over there (`exports.foo = require("./lib").bar` forwards to `bar`).
 *    When it selected NO name at all (`exports.foo = require("./lib")`,
 *    the dominant real-world shape — qs's
 *    `module.exports = { stringify: stringify }` over
 *    `var stringify = require("./stringify")`), `foo` IS that module's
 *    whole exported value, so it forwards to the target's canonical
 *    `"default"` export — exactly what Node binds there.
 * 2. A WHOLE-MODULE re-export (`module.exports = require("./lib")`) makes
 *    this module's export namespace *be* the other module's, so any
 *    requested name is looked up under the same name over there. The
 *    narrower `module.exports = require("./lib").foo` form forwards only
 *    the module's own default value, hence only `exportName === "default"`.
 *
 * A file that has its own named export for `exportName` which this
 * relation cannot attribute (rule 1's `commonJsReExport` is absent — a
 * dynamic specifier, a conditional, a chained alias, a locally-defined
 * value) deliberately stops here rather than falling through to rule 2:
 * that own binding shadows any forwarded namespace at runtime, so
 * forwarding anyway would resolve to a value the module does not actually
 * export under that name.
 */
async function resolveCommonJsReExport(
  prepared: FileGraphData,
  exportName: string,
  ctx: WalkContext,
  visited: Set<string>,
): Promise<GraphNodeId | undefined> {
  const own = prepared.model.exports.find(
    (exp) =>
      exp.syntax === "commonjs" &&
      exp.kind === "named" &&
      exp.exportedName === exportName,
  );
  if (own) {
    const origin = own.commonJsReExport;
    return origin === undefined
      ? undefined
      : followCommonJsReExport(
          prepared,
          origin.specifier,
          origin.importedName ?? "default",
          ctx,
          visited,
        );
  }

  const whole = prepared.model.exports.find(
    (exp) =>
      exp.syntax === "commonjs" &&
      exp.kind === "default" &&
      exp.commonJsReExport !== undefined,
  );
  const origin = whole?.commonJsReExport;
  if (!origin) {
    return undefined;
  }

  if (origin.importedName === undefined) {
    return followCommonJsReExport(
      prepared,
      origin.specifier,
      exportName,
      ctx,
      visited,
    );
  }

  return exportName === "default"
    ? followCommonJsReExport(
        prepared,
        origin.specifier,
        origin.importedName,
        ctx,
        visited,
      )
    : undefined;
}

/**
 * Resolves one CommonJS re-export hop and continues the chase in the
 * target file, wherever Node's own resolution of that hop's specifier
 * actually lands — including inside a DIFFERENT installed package
 * (RWF-004b; RWB-08's `debug`'s `exports.humanize = require('ms')`).
 *
 * RWF-004a shipped this relation gated on both sides belonging to the
 * exact same canonical PackageInstance. That gate was scoping, never a
 * soundness requirement, and it is what RWF-004b removes: a façade package
 * whose export IS another package's callable
 * (`exports.parse = require("vuln-pkg").parse`) is the same statically
 * known, single-valued binding as the sibling-file form, differing only in
 * where the specifier resolves to. Refusing it produced an honest but
 * imprecise `unresolved_target`, and with it an UNKNOWN, for the dominant
 * real-world wrapper/façade shape.
 *
 * The invariant the gate was mistakenly credited with — never attributing
 * a target to the wrong installed instance — is upheld instead by what it
 * was always actually upheld by: **resolver relativity**. The specifier is
 * resolved FROM the file that physically contains the `require()`
 * (`prepared.index.filePath`), so `require("vuln-pkg")` inside
 * `app/node_modules/wrapper/index.js` reaches
 * `app/node_modules/wrapper/node_modules/vuln-pkg` when that nested
 * install exists and `app/node_modules/vuln-pkg` only when it does not —
 * exactly Node's own answer, never a search for an installed package by
 * name or version. Every node this function returns is keyed by that
 * resolved file's real path, and package identity is derived downstream
 * from that path alone by `identifyModule` (verdict.ts's
 * `graphPackageInstances`/`resolveTargetNodes`), this codebase's single
 * identity authority. Two installs sharing a name AND a version at
 * different paths therefore remain distinct instances end to end, and a
 * symlinked (pnpm/workspace/`file:`) install compares equal to its
 * physical target because that authority realpaths it — neither fact
 * depends on anything computed here. This function deliberately performs
 * NO package-identity test of its own: a second identity opinion at this
 * layer is precisely the parallel source of truth SDD-v0.2.md § 5
 * forbids.
 *
 * Nothing else about the chase changes. The caller's `visited` set still
 * bounds it — a cross-package cycle (`pkg-a` -> `pkg-b` -> `pkg-a`)
 * terminates on the repeated (file, export name) hop and yields
 * `unresolved_target`, not recursion — and a hop is still only ever taken
 * from an explicit, statically-literal `CommonJsReExportOrigin`, so
 * a dynamic specifier, a conditional assignment or a reassigned alias
 * still produces no origin and no hop at all.
 *
 * Returns `undefined` for every non-hop outcome (unresolved specifier,
 * builtin, declaration-only resolution — the same VT-304 discipline as the
 * ESM half — or a file that could not be indexed or that a resource limit
 * stopped this graph from preparing), which leaves the caller's existing
 * `unresolved_target` edge and its downstream UNKNOWN exactly as they were.
 */
async function followCommonJsReExport(
  prepared: FileGraphData,
  specifier: string,
  targetExportName: string,
  ctx: WalkContext,
  visited: Set<string>,
): Promise<GraphNodeId | undefined> {
  const resolution = await ctx.resolver.resolve(
    specifier,
    prepared.index.filePath,
  );
  // Same VT-304 discipline as the ESM half: a declaration-only resolution
  // is not a runtime implementation and must never be chased.
  if (resolution.kind !== "resolved") {
    return undefined;
  }

  ctx.onDiscoverFile(resolution.resolvedFileName);
  const targetFile = ctx.ensurePrepared(resolution.resolvedFileName);
  if (!targetFile) {
    return undefined;
  }

  const direct = targetFile.exportNameToNodeId.get(targetExportName);
  if (direct) {
    return direct;
  }

  return resolveReExportChain(targetFile, targetExportName, ctx, visited);
}

/**
 * Resolves a bare-identifier call (`fn()`) to the real target it calls
 * when `fn` is a parameter of the enclosing named function, and that
 * function's own file passes a resolvable function reference at the
 * matching argument position (see SDD-v0.2.md § 7.1, VT-210):
 *
 * ```js
 * function invoke(fn) {
 *   fn();
 * }
 * invoke(vulnerable);
 * ```
 *
 * Deliberately "lightweight," not general points-to/data-flow analysis
 * (an explicit MVP non-goal, SDD-v0.2.md § 16): single-hop (the argument
 * expression itself must be a plain identifier, not a further level of
 * indirection), same-file only (searches `prepared.index.sourceFile`'s
 * whole AST for call sites of the enclosing function, not other files --
 * see below for why), and first-match-wins if the enclosing function is
 * called from more than one site with different resolvable values.
 *
 * Same-file, whole-file search rather than "resolve as edges are
 * discovered": `invoke`'s own body (containing `fn()`) sits *earlier* in
 * the file than `main()`'s call site (`invoke(vulnerable)`) in the exact
 * shape above, and call-graph traversal visits nodes in textual order --
 * a single forward pass would reach `fn()` before ever having seen the
 * call site that explains what `fn` holds. Searching the already-fully-
 * parsed file (not just what traversal has walked so far) sidesteps that
 * ordering problem entirely, at the cost of only finding same-file
 * callers.
 */
async function resolveHigherOrderCallTarget(
  callee: ts.Identifier,
  call: ts.CallExpression,
  prepared: FileGraphData,
  ctx: WalkContext,
): Promise<GraphNodeId | undefined> {
  const enclosing = ts.findAncestor(call, isFunctionLike);
  if (!enclosing || !ts.isFunctionDeclaration(enclosing) || !enclosing.name) {
    return undefined;
  }

  const paramIndex = enclosing.parameters.findIndex(
    (p) => ts.isIdentifier(p.name) && p.name.text === callee.text,
  );
  if (paramIndex === -1) {
    return undefined;
  }

  const functionName = enclosing.name.text;
  const candidateArgs: ts.Identifier[] = [];

  function collectCallSites(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === functionName
    ) {
      const arg = node.arguments[paramIndex];
      if (arg && ts.isIdentifier(arg)) {
        candidateArgs.push(arg);
      }
    }
    ts.forEachChild(node, collectCallSites);
  }
  collectCallSites(prepared.index.sourceFile);

  for (const arg of candidateArgs) {
    const binding = await bindCallee(
      arg,
      prepared.model,
      ctx.resolver,
      prepared.index.filePath,
    );

    if (binding.kind === "resolved") {
      ctx.onDiscoverFile(binding.target.modulePath);
      const targetFile = ctx.ensurePrepared(binding.target.modulePath);
      const targetNodeId = targetFile?.exportNameToNodeId.get(
        binding.target.exportedName,
      );
      if (targetNodeId) {
        return targetNodeId;
      }
      continue;
    }

    const local = findLocalFunctionNodeId(arg, prepared);
    if (local) {
      return local;
    }
  }

  return undefined;
}

/** The value of an object literal's `propertyName` property (`{ propertyName: value }` or shorthand `{ propertyName }`), or `undefined`. Computed property names are intentionally not evaluated -- see module-model.ts's `unpackObjectLiteralExports` for the identical scoping decision on the export side. */
function findObjectLiteralPropertyValue(
  obj: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.Expression | undefined {
  for (const property of obj.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === propertyName
    ) {
      return property.initializer;
    }
    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === propertyName
    ) {
      return property.name;
    }
  }
  return undefined;
}

interface DestructuredBindingSource {
  readonly source: ts.Identifier;
  readonly propertyName: string;
}

/**
 * Finds a same-file `const { originalName: name } = source;` (or
 * shorthand `const { name } = source;`) destructuring `name` out of a
 * plain-identifier `source`, or `undefined`. `const`-only and
 * single-property-source-must-be-a-plain-identifier, matching
 * {@link resolveSingleAssignmentValue}'s own scoping.
 */
function findDestructuredBindingSource(
  name: string,
  sourceFile: ts.SourceFile,
): DestructuredBindingSource | undefined {
  let found: DestructuredBindingSource | undefined;
  function visit(node: ts.Node): void {
    if (found) {
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      isConstDeclaration(node)
    ) {
      const source = node.initializer;
      for (const element of node.name.elements) {
        if (
          element.dotDotDotToken ||
          !ts.isIdentifier(element.name) ||
          element.name.text !== name
        ) {
          continue;
        }
        const propertyNameNode = element.propertyName ?? element.name;
        if (
          ts.isIdentifier(propertyNameNode) ||
          ts.isStringLiteralLike(propertyNameNode)
        ) {
          found = { source, propertyName: propertyNameNode.text };
        }
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

/**
 * The statically-known string/numeric key of an element access
 * (`obj[key]`), when the key expression is itself a literal or a
 * same-file `const` binding initialized to one (VT-217, SDD-v0.2.md
 * § 7.1's computed-key follow-on) -- e.g.
 * `const KEY = "vulnerable"; fns[KEY]`. `undefined` for anything else (a
 * parameter, a function call, a runtime value) -- a genuinely dynamic key
 * stays unresolved exactly as before.
 */
function resolveElementAccessKey(
  access: ts.ElementAccessExpression,
  sourceFile: ts.SourceFile,
): string | number | undefined {
  const direct = literalValue(access.argumentExpression);
  if (direct !== undefined) {
    return direct;
  }
  if (ts.isIdentifier(access.argumentExpression)) {
    const value = resolveSingleAssignmentValue(
      access.argumentExpression.text,
      sourceFile,
    );
    return value ? literalValue(value) : undefined;
  }
  return undefined;
}

/**
 * Unwraps a type assertion (`expr as T`, `expr satisfies T`), non-null
 * assertion (`expr!`), or parenthesization around `expr` (VT-217). None of
 * these have any runtime effect -- `const fns = lib as unknown as X;`
 * makes `fns` and `lib` the exact same value, not a "second alias hop" in
 * any meaningful sense, just type-checker-only decoration erased at
 * compile time (confirmed against the real ADV2-042 fixture,
 * tests/adversarial-v2/, which wraps its own aliased receiver this way).
 */
function unwrapTypeOnlyExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
    } else if (ts.isNonNullExpression(current)) {
      current = current.expression;
    } else if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

/**
 * Resolves an element/property access's own receiver (`fns` in
 * `fns[KEY]`/`fns.member`) through at most one hop of same-file `const`
 * aliasing, unwrapping any type-only wrapper (see
 * {@link unwrapTypeOnlyExpression}) around the aliased value -- so
 * `const fns = lib as X;` is recognized as `fns` simply *being* `lib`, not
 * a second layer of indirection. Returns `expr` unchanged when it isn't a
 * plain identifier, or resolves to nothing (e.g. it's already the direct
 * import reference itself, which needs no further resolution here).
 */
function resolveReceiverExpression(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
): ts.Expression {
  if (!ts.isIdentifier(expr)) {
    return expr;
  }
  const value = resolveSingleAssignmentValue(expr.text, sourceFile);
  return value ? unwrapTypeOnlyExpression(value) : expr;
}

/**
 * Resolves a value expression a local alias ultimately points to -- a
 * plain identifier or a property access -- via the exact same import/
 * local-declaration machinery `classifyCall` already uses for a real
 * callee, since by this point the expression IS effectively being called.
 *
 * An element access with a statically-known key (VT-217, see
 * {@link resolveElementAccessKey}) is first rewritten into the equivalent
 * property access -- `fns[KEY]` where `KEY` is a same-file `const`
 * literal is an ordinary property access written with computed-member
 * syntax, not a genuinely dynamic lookup -- and resolved the same way
 * from there on, with its own receiver also resolved through
 * {@link resolveReceiverExpression}.
 */
async function resolveAliasedValue(
  value: ts.Expression,
  prepared: FileGraphData,
  ctx: WalkContext,
): Promise<GraphNodeId | undefined> {
  let resolved = value;
  if (ts.isElementAccessExpression(value)) {
    const key = resolveElementAccessKey(value, prepared.index.sourceFile);
    if (key === undefined) {
      return undefined;
    }
    const receiver = resolveReceiverExpression(
      value.expression,
      prepared.index.sourceFile,
    );
    resolved = ts.factory.createPropertyAccessExpression(receiver, String(key));
  }

  if (!ts.isIdentifier(resolved) && !ts.isPropertyAccessExpression(resolved)) {
    return undefined;
  }

  const binding = await bindCallee(
    resolved,
    prepared.model,
    ctx.resolver,
    prepared.index.filePath,
  );

  if (binding.kind === "resolved") {
    ctx.onDiscoverFile(binding.target.modulePath);
    const targetFile = ctx.ensurePrepared(binding.target.modulePath);
    if (!resolvesToUnrelatedConstructor(resolved, binding, targetFile)) {
      return targetFile?.exportNameToNodeId.get(binding.target.exportedName);
    }
  }

  return ts.isIdentifier(value)
    ? findLocalFunctionNodeId(value, prepared)
    : undefined;
}

/**
 * Resolves a call whose callee is a same-file `const` binding that simply
 * aliases an already-resolvable value, rather than being a genuinely new
 * declaration (VT-214, SDD-v0.2.md § 7.1's local-alias-flow follow-on to
 * VT-210): a plain reassignment (`const doIt = vulnerable; doIt();`), an
 * object-literal property holding one
 * (`const o = { run: vulnerable }; o.run();`), or a destructured rename
 * off a namespace/default import (`const { vulnerable: v } = lib; v();`).
 *
 * Deliberately narrow, matching VT-210's own scope (SDD-v0.2.md § 16):
 * `const`-only (see {@link resolveSingleAssignmentValue}), single-hop (the
 * aliased-to value itself must resolve via an existing mechanism -- never
 * a further level of aliasing), and same-file.
 */
async function resolveLocalAlias(
  callee: ts.Expression,
  prepared: FileGraphData,
  ctx: WalkContext,
): Promise<GraphNodeId | undefined> {
  const sourceFile = prepared.index.sourceFile;

  if (ts.isPropertyAccessExpression(callee)) {
    if (!ts.isIdentifier(callee.expression)) {
      return undefined;
    }
    const receiverValue = resolveSingleAssignmentValue(
      callee.expression.text,
      sourceFile,
    );
    if (!receiverValue || !ts.isObjectLiteralExpression(receiverValue)) {
      return undefined;
    }
    const propertyValue = findObjectLiteralPropertyValue(
      receiverValue,
      callee.name.text,
    );
    return propertyValue
      ? resolveAliasedValue(propertyValue, prepared, ctx)
      : undefined;
  }

  if (!ts.isIdentifier(callee)) {
    return undefined;
  }

  const directValue = resolveSingleAssignmentValue(callee.text, sourceFile);
  if (directValue) {
    return resolveAliasedValue(directValue, prepared, ctx);
  }

  const destructured = findDestructuredBindingSource(callee.text, sourceFile);
  if (destructured) {
    const synthetic = ts.factory.createPropertyAccessExpression(
      destructured.source,
      destructured.propertyName,
    );
    return resolveAliasedValue(synthetic, prepared, ctx);
  }

  return undefined;
}

/**
 * Resolves a call to the exactly-one inline function-expression/arrow
 * argument it passes, when nothing else already accounted for this call
 * (VT-213, SDD-v0.2.md § 7.1). Handles the extremely common built-in
 * higher-order pattern `arr.map(() => vulnerable())`,
 * `promise.then(() => vulnerable())`, etc. -- without special-casing any
 * specific method name (`.map`/`.then`/`.forEach`/...): any call whose
 * callee this graph cannot otherwise attribute, and which passes exactly
 * one inline function/arrow expression as an argument, is treated as
 * invoking that argument, since that argument is unambiguously the only
 * function value being handed to this call.
 *
 * Before this, `walkFile`'s own `forEachChild` traversal already visited
 * the inline callback's body as its own function scope (`source-index.ts`
 * already indexes it as a `"callback"`-kind function) and recorded any
 * calls made from *within* it correctly -- but nothing connected the call
 * *site* to that callback's own node, so it was reachable only as a graph
 * component disconnected from its actual caller.
 *
 * Deliberately narrow, matching VT-210's own scope (SDD-v0.2.md § 16):
 * exactly one inline function/arrow argument, never a named reference
 * (`arr.map(vulnerable)` -- that's local-alias/value-flow territory, a
 * different problem, see VT-210/VT-214) and never when more than one
 * inline callback argument is present (e.g.
 * `promise.then(onFulfilled, onRejected)`) -- picking one over the other
 * without more information would be a guess, not a resolution.
 */
function resolveInlineCallbackArgument(
  call: ts.CallExpression,
  prepared: FileGraphData,
): GraphNodeId | undefined {
  const inlineCallbacks = call.arguments.filter(
    (arg) => ts.isFunctionExpression(arg) || ts.isArrowFunction(arg),
  );
  if (inlineCallbacks.length !== 1) {
    return undefined;
  }
  const [callback] = inlineCallbacks;
  if (!callback) {
    return undefined;
  }
  const location = toSourceLocation(prepared.index.sourceFile, callback);
  return prepared.functionNodeIdByLocation.get(locationKey(location));
}

/** A numeric or string literal's own value, or `undefined` for anything else -- including a negated numeric literal (`-1`). */
function literalValue(expr: ts.Expression): string | number | undefined {
  if (ts.isNumericLiteral(expr)) {
    return Number(expr.text);
  }
  if (ts.isStringLiteralLike(expr)) {
    return expr.text;
  }
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return -Number(expr.operand.text);
  }
  return undefined;
}

/**
 * Evaluates `expr` to a statically-known `true`/`false`, or `undefined`
 * when its runtime value can't be determined this way (see SDD-v0.2.md
 * § 9, VT-211). Deliberately narrow -- literal `true`/`false`, negation,
 * parenthesization, and literal-vs-literal equality/inequality
 * comparisons on numbers/strings -- not general constant folding or
 * control-flow analysis (an explicit MVP non-goal, SDD-v0.2.md § 16). Any
 * condition that depends on a variable, parameter, or function call (the
 * overwhelming majority of real code) correctly returns `undefined`,
 * leaving it exactly as conservative as before this task: both branches
 * still count as reachable.
 */
function evaluateConstantBoolean(expr: ts.Expression): boolean | undefined {
  if (ts.isParenthesizedExpression(expr)) {
    return evaluateConstantBoolean(expr.expression);
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.ExclamationToken
  ) {
    const inner = evaluateConstantBoolean(expr.operand);
    return inner === undefined ? undefined : !inner;
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    const isEquality =
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken;
    const isInequality =
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken;
    if (isEquality || isInequality) {
      const left = literalValue(expr.left);
      const right = literalValue(expr.right);
      if (left === undefined || right === undefined) {
        return undefined;
      }
      return isEquality ? left === right : left !== right;
    }
  }
  return undefined;
}

/**
 * The innermost node of `root`'s own subtree whose span contains
 * `position`, or `root` itself if none of its children do. `root` must
 * have parent pointers set (see `ts.createSourceFile`'s own
 * `setParentNodes` argument) for `getChildren`/`getStart`/`getEnd` to work.
 */
function findNodeAtPosition(root: ts.Node, position: number): ts.Node {
  for (const child of root.getChildren()) {
    if (position >= child.getStart() && position < child.getEnd()) {
      return findNodeAtPosition(child, position);
    }
  }
  return root;
}

/**
 * Resolves `instance.method()` (or `ClassName.staticMethod()`) to the real
 * class method it calls, using the TypeScript type checker to determine
 * the receiver's own apparent type (see SDD-v0.2.md § 7.3, VT-208) --
 * something no purely syntactic name/import-based matching can do, since
 * nothing about the identifier `instance` itself names the class `Lib`.
 * Also resolves a member INHERITED from a base class, not just one the
 * receiver's own class declares directly (VT-216): a locally-defined
 * subclass with no override of its own (`class MySub extends Base {}`)
 * still resolves `instance.vulnerableMethod()` to `Base`'s real
 * declaration, since the checker's own apparent-type/property resolution
 * already walks the heritage chain. Returns `undefined` (the caller falls
 * through to the generic `unsupported_construct` edge) whenever the
 * receiver's type can't be resolved to exactly one concrete method
 * declaration -- an `any`-typed receiver, an interface with no located
 * implementation, a union of multiple classes producing more than one
 * candidate declaration, and so on.
 *
 * `call-graph.ts`'s own traversal walks a lightweight, standalone-parsed
 * AST (`indexSourceFileFromDisk`, no binder/checker), deliberately kept
 * separate from a full `ts.Program` for performance (SDD's own
 * performance requirements). `getTypeAtLocation` needs a node from the
 * *program's* own bound AST, not this standalone one, so this bridges the
 * two by position: the receiver's already-known line/column (from the
 * standalone parse) locates the equivalent node in the program's parse of
 * the exact same source text -- both parses produce identical positions
 * for identical syntax, so this is a safe, if slightly indirect, way to
 * avoid switching the whole traversal onto the program's AST just for
 * this one case.
 */
function resolveInstanceMethod(
  callee: ts.PropertyAccessExpression,
  prepared: FileGraphData,
  ctx: WalkContext,
): GraphNodeId | undefined {
  const program = ctx.getProgram();
  if (!program) {
    return undefined;
  }

  const programSourceFile = program.getSourceFile(prepared.index.filePath);
  if (!programSourceFile) {
    return undefined;
  }

  const receiverLocation = toSourceLocation(
    prepared.index.sourceFile,
    callee.expression,
  );
  if (
    receiverLocation.line === undefined ||
    receiverLocation.column === undefined
  ) {
    return undefined;
  }

  let receiverNode: ts.Node;
  try {
    const position = programSourceFile.getPositionOfLineAndCharacter(
      receiverLocation.line - 1,
      receiverLocation.column - 1,
    );
    receiverNode = findNodeAtPosition(programSourceFile, position);
  } catch {
    return undefined;
  }

  const checker = program.getTypeChecker();
  let methodDecl: ts.MethodDeclaration | undefined;
  try {
    // checker.getPropertyOfType (rather than manually scanning the
    // receiver's own classDecl.members, the pre-VT-216 approach) is what
    // makes this resolve both a static member off a class reference
    // (`ClassName.member()`, the receiver's type is `typeof ClassName`)
    // and an INHERITED instance member (`instance.member()` where
    // `member` is declared on a base class, not the receiver's own class)
    // for free: the checker's own apparent-type resolution already walks
    // the full static/instance and heritage-clause distinctions that a
    // raw AST member scan does not (see VT-216, SDD-v0.2.md § 7.3's known
    // gap). Exactly one real method declaration is required -- a union
    // type can produce more than one distinct declaration for the same
    // property name, and picking one over another there would be a
    // guess, not a resolution (mirrors the pre-VT-216 behavior of
    // bailing out on "a union of multiple classes").
    const type = checker.getTypeAtLocation(receiverNode);
    const property = checker.getPropertyOfType(type, callee.name.text);
    const methodDeclarations = property?.declarations?.filter(
      (d): d is ts.MethodDeclaration => ts.isMethodDeclaration(d),
    );
    methodDecl =
      methodDeclarations?.length === 1 ? methodDeclarations[0] : undefined;
  } catch {
    return undefined;
  }
  if (!methodDecl) {
    return undefined;
  }

  const methodFile = methodDecl.getSourceFile().fileName;
  const methodLocation = toSourceLocation(
    methodDecl.getSourceFile(),
    methodDecl,
  );

  ctx.onDiscoverFile(methodFile);
  const targetFile = ctx.ensurePrepared(methodFile);
  return targetFile?.functionNodeIdByLocation.get(locationKey(methodLocation));
}

interface WalkContext {
  readonly edges: CallEdge[];
  readonly resolver: ModuleResolver;
  readonly ensurePrepared: (filePath: string) => FileGraphData | undefined;
  readonly onDiscoverFile: (filePath: string) => void;
  /**
   * Lazily builds (and memoizes) a real `ts.Program` for VT-208's
   * instance-method resolution (SDD-v0.2.md § 7.3), or `undefined` when no
   * {@link TsProject} was supplied to `buildCallGraph` (every caller that
   * predates VT-208). Never called unless a property-access call this
   * graph cannot otherwise attribute is actually encountered, and built at
   * most once per `buildCallGraph` invocation regardless of how many such
   * calls occur -- this is real type-checking, meaningfully more expensive
   * than the lightweight standalone parsing used everywhere else in this
   * file, so it must never run unconditionally.
   */
  readonly getProgram: () => ts.Program | undefined;
}

/**
 * True when `binding`'s resolved export name is itself a class's
 * constructor, but `callee`/`value` is a property access with a real
 * trailing chain beyond the bare import reference -- i.e. `bindCallee`'s
 * own chain-ignoring shortcut for named imports (see its doc comment) has
 * matched the wrong thing: `ClassName.member()` /
 * `new ClassName.Member()` is not a call to, or construction of,
 * `ClassName` itself.
 *
 * Guards against a resolved-but-wrong edge, which is strictly worse than
 * an honest `unresolved_target`: a real-looking edge to an unrelated node
 * with no outgoing edges of its own can make a reachability search
 * conclude confidently, and wrongly, `unreachable`. VT-215's
 * implicit-constructor synthesis made a bare class name resolve
 * successfully far more often, which is what turned this from a latent,
 * unexercised gap in `bindCallee`'s own design into an actually-reachable
 * false NOT_AFFECTED (confirmed via the independent v2 adversarial suite,
 * ADV2-021 -- `Lib.staticDangerous()` was resolving to `Lib`'s own,
 * newly-synthesized, edge-less constructor node instead of staying
 * unresolved).
 *
 * Resolving static/inherited member access correctly is VT-216's own,
 * separate, not-yet-implemented task; this guard only prevents the wrong,
 * confident answer in the meantime, restoring the pre-VT-215
 * `unresolved_target`/UNKNOWN outcome for exactly this shape.
 */
function resolvesToUnrelatedConstructor(
  callee: ts.Expression,
  binding: SymbolBindingResolved,
  targetFile: FileGraphData | undefined,
): boolean {
  if (!ts.isPropertyAccessExpression(callee) || !targetFile) {
    return false;
  }
  return targetFile.index.functions.some(
    (fn) =>
      fn.kind === "constructor" && fn.name === binding.target.exportedName,
  );
}

/**
 * Classifies and (when possible) resolves one call expression into a
 * {@link CallEdge} (see docs/SDD.md § 18, § 3.1's VT-201 completeness
 * invariant). Returns `undefined` only when the callee is a known ambient
 * global/builtin (see {@link KNOWN_GLOBAL_IDENTIFIERS}) — never merely
 * because resolution failed. Every other visited call, including one
 * bound to a local parameter/variable this binder cannot trace (a
 * function value flowing through an argument, a method call on a
 * locally-constructed instance), still produces an explicit
 * `unknown(unsupported_construct)` edge rather than silently vanishing:
 * before VT-201, such calls disappeared entirely, which let
 * `analyzeReachability` mistake "we never modeled this construct" for
 * "this genuinely calls nothing" and report a false NOT_AFFECTED (see
 * ADV-019/ADV-030's completion reports).
 */
async function classifyCall(
  call: ts.CallExpression,
  from: GraphNodeId,
  prepared: FileGraphData,
  ctx: WalkContext,
): Promise<CallEdge | undefined> {
  const location = toSourceLocation(prepared.index.sourceFile, call);
  const callee = call.expression;

  // VT-307b: checked before bindCallee -- none of these shapes are
  // ordinary imports, and several are rooted in an identifier
  // (`module`, `process`, `globalThis`, `Function`) that the known-global
  // fallback further below would otherwise silently swallow with no edge
  // at all. Since VT-307c-fix-3 the classification itself lives in
  // loader-constructs.ts, shared verbatim with ModuleLoadClosure's own
  // per-file scan so the two layers can never disagree about what counts
  // as a module loader; only the edge SHAPE is decided here.
  const loaderReason = classifyClosureWideningCall(call, prepared);
  if (loaderReason) {
    return {
      from,
      type: LOADER_EDGE_TYPE[loaderReason] ?? "direct",
      resolution: {
        kind: "unknown",
        reason: loaderReason,
        potentialTargets: [],
      },
      location,
    };
  }

  if (isStaticRequireCall(call)) {
    // A static require("literal") is import setup, already captured in
    // the module model; it is not itself a meaningful "call into" target.
    return undefined;
  }

  const binding = await bindCallee(
    callee,
    prepared.model,
    ctx.resolver,
    prepared.index.filePath,
  );

  if (binding.kind === "resolved") {
    ctx.onDiscoverFile(binding.target.modulePath);
    const targetFile = ctx.ensurePrepared(binding.target.modulePath);

    if (!resolvesToUnrelatedConstructor(callee, binding, targetFile)) {
      const targetNodeId = targetFile?.exportNameToNodeId.get(
        binding.target.exportedName,
      );

      if (targetNodeId) {
        return {
          from,
          type: "import",
          resolution: { kind: "resolved", target: targetNodeId },
          location,
        };
      }

      // VT-209: not a local definition, but the target file might itself
      // re-export this name from somewhere else -- chase it before giving up.
      if (targetFile) {
        const chased = await resolveReExportChain(
          targetFile,
          binding.target.exportedName,
          ctx,
          new Set(),
        );
        if (chased) {
          return {
            from,
            type: "import",
            resolution: { kind: "resolved", target: chased },
            location,
          };
        }
      }

      return {
        from,
        type: "import",
        resolution: {
          kind: "unknown",
          reason: "unresolved_target",
          potentialTargets: [],
        },
        location,
      };
    }
  }

  if (binding.kind === "ambiguous") {
    return {
      from,
      type: "direct",
      resolution: {
        kind: "unknown",
        reason: binding.reason,
        potentialTargets: [],
      },
      location,
    };
  }

  if (binding.kind === "unresolved_module") {
    return {
      from,
      type: "import",
      resolution: {
        kind: "unknown",
        reason: "unresolved_module",
        potentialTargets: [],
      },
      location,
    };
  }

  if (binding.kind === "declaration_only") {
    // VT-304: the specifier resolved only to a TypeScript declaration file
    // -- never indexed as a module (a `.d.ts` has no executable bodies to
    // index), so this must not fabricate a "resolved, zero-edge" region.
    // See isClosureWideningReason's own doc comment for why this reason is
    // closure-widening.
    return {
      from,
      type: "import",
      resolution: {
        kind: "unknown",
        reason: "declaration_only_resolution",
        potentialTargets: [],
      },
      location,
    };
  }

  // Not an import: a direct, same-file call is still worth an edge.
  const localTarget = findLocalFunctionNodeId(callee, prepared);
  if (localTarget) {
    return {
      from,
      type: "direct",
      resolution: { kind: "resolved", target: localTarget },
      location,
    };
  }

  // VT-201: neither an import nor a locally-declared function/method by
  // name -- e.g. a function value flowing through a parameter
  // (`invoke(fn)` calling `fn()`) or a method call on a
  // locally-constructed instance (`instance.method()`). Silently
  // returning `undefined` here (pre-VT-201 behavior) let the vulnerable
  // dependency vanish from the graph entirely rather than being flagged
  // uncertain. Known ambient globals/builtins are the sole exception —
  // they can never be a vulnerable-rule target, and flagging every
  // `console.log()` this way would make almost every real scan degrade to
  // UNKNOWN.
  const root = rootIdentifierOf(callee);
  if (root && isKnownGlobalIdentifier(root)) {
    return undefined;
  }

  // VT-208: a method call on a receiver this binder can't attribute by
  // name/import might still be resolvable via the real TypeScript type
  // checker (SDD-v0.2.md § 7.3) -- e.g. `instance.vulnerableMethod()`
  // where `instance` is a locally-constructed class instance. Attempted
  // only here, after every cheaper syntactic path has already failed.
  if (ts.isPropertyAccessExpression(callee)) {
    const methodTarget = resolveInstanceMethod(callee, prepared, ctx);
    if (methodTarget) {
      return {
        from,
        type: "method",
        resolution: { kind: "resolved", target: methodTarget },
        location,
      };
    }
  }

  // VT-210: a bare-identifier call on a parameter (`fn()` inside
  // `function invoke(fn) { fn(); }`) might still be resolvable by finding
  // where `invoke` itself is called with a known function reference (see
  // SDD-v0.2.md § 7.1). Attempted last, after every other resolution path
  // has already failed.
  if (ts.isIdentifier(callee)) {
    const higherOrderTarget = await resolveHigherOrderCallTarget(
      callee,
      call,
      prepared,
      ctx,
    );
    if (higherOrderTarget) {
      return {
        from,
        type: "callback",
        resolution: { kind: "resolved", target: higherOrderTarget },
        location,
      };
    }
  }

  // VT-214: the callee itself (or its receiver, for a property access)
  // might be a same-file `const` binding that simply aliases an
  // already-resolvable value -- `const doIt = vulnerable; doIt();`,
  // `const o = { run: vulnerable }; o.run();`, or a destructured rename
  // off a namespace import (see SDD-v0.2.md § 7.1). Attempted after every
  // cheaper syntactic path has already failed.
  const aliasTarget = await resolveLocalAlias(callee, prepared, ctx);
  if (aliasTarget) {
    return {
      from,
      type: ts.isPropertyAccessExpression(callee) ? "method" : "direct",
      resolution: { kind: "resolved", target: aliasTarget },
      location,
    };
  }

  // VT-213: a call this graph still cannot attribute might pass exactly
  // one inline function/arrow-function argument (see SDD-v0.2.md § 7.1) --
  // e.g. `arr.map(() => vulnerable())`, `promise.then(() => vulnerable())`.
  // Attempted last, after every other resolution path has already failed.
  const callbackTarget = resolveInlineCallbackArgument(call, prepared);
  if (callbackTarget) {
    return {
      from,
      type: "callback",
      resolution: { kind: "resolved", target: callbackTarget },
      location,
    };
  }

  // VT-305 (RWF-007): a Node builtin (`fs.readFile(...)`, `path.basename`,
  // ...) is a known external runtime module, not uncertainty -- it must
  // never fabricate an `unsupported_construct` edge merely because it has
  // no local source file to attribute the call to. Deliberately checked
  // here, AFTER the inline-callback fallback above (not alongside
  // `isKnownGlobalIdentifier`'s earlier check): unlike ambient globals,
  // builtin methods very commonly take a real callback argument
  // (`fs.readFile(file, callback)`) whose own call-graph connection VT-213
  // must still get a chance to make; only once every real resolution
  // avenue has failed does this fall back to "no edge, known operation" --
  // mirroring `isKnownGlobalIdentifier`'s own treatment, never
  // `unsupported_construct`.
  if (binding.kind === "builtin") {
    return undefined;
  }

  return {
    from,
    type: ts.isPropertyAccessExpression(callee) ? "method" : "direct",
    resolution: {
      kind: "unknown",
      reason: "unsupported_construct",
      potentialTargets: [],
    },
    location,
  };
}

/**
 * Classifies and (when possible) resolves one `new` construction into a
 * {@link CallEdge}, mirroring {@link classifyCall} (see docs/SDD.md § 18,
 * § 3.1). Before VT-201, `NewExpression` nodes were never visited by the
 * call graph at all -- not resolved, not flagged unknown, simply invisible
 * -- so `new VulnerableClass()` could never be found reachable no matter
 * how directly it was called (see ADV-020's completion report). Every
 * visited construction now produces an edge: resolved when the
 * constructed class is attributable to an import or local declaration,
 * `unknown(unsupported_construct)` otherwise, unless the callee is a known
 * ambient global constructor (`new Map()`, `new Date()`, ...), which stays
 * without an edge exactly as before. Full class-name -> constructor-node
 * resolution accuracy (matching an exported class name to its own
 * constructor's graph node) is VT-207's job, not this task's — VT-201
 * only guarantees the construct is never silent.
 */
async function classifyNew(
  node: ts.NewExpression,
  from: GraphNodeId,
  prepared: FileGraphData,
  ctx: WalkContext,
): Promise<CallEdge | undefined> {
  const location = toSourceLocation(prepared.index.sourceFile, node);
  const callee = node.expression;

  // VT-307b: `new Function(...)` -- see classifyCall's identical check and
  // classifyClosureWideningCall's own doc comment. Checked before
  // bindCallee/the known-global fallback for the same reason. For a `new`
  // expression the shared classifier skips its call-only forms entirely,
  // so this stays exactly the `classifyLoaderConstruct` dispatch it was.
  const loaderReason = classifyClosureWideningCall(node, prepared);
  if (loaderReason) {
    return {
      from,
      type: "constructor",
      resolution: {
        kind: "unknown",
        reason: loaderReason,
        potentialTargets: [],
      },
      location,
    };
  }

  const binding = await bindCallee(
    callee,
    prepared.model,
    ctx.resolver,
    prepared.index.filePath,
  );

  if (binding.kind === "resolved") {
    ctx.onDiscoverFile(binding.target.modulePath);
    const targetFile = ctx.ensurePrepared(binding.target.modulePath);

    if (!resolvesToUnrelatedConstructor(callee, binding, targetFile)) {
      const targetNodeId = targetFile?.exportNameToNodeId.get(
        binding.target.exportedName,
      );

      if (targetNodeId) {
        return {
          from,
          type: "constructor",
          resolution: { kind: "resolved", target: targetNodeId },
          location,
        };
      }

      // VT-209: see classifyCall's identical handling above.
      if (targetFile) {
        const chased = await resolveReExportChain(
          targetFile,
          binding.target.exportedName,
          ctx,
          new Set(),
        );
        if (chased) {
          return {
            from,
            type: "constructor",
            resolution: { kind: "resolved", target: chased },
            location,
          };
        }
      }

      return {
        from,
        type: "constructor",
        resolution: {
          kind: "unknown",
          reason: "unresolved_target",
          potentialTargets: [],
        },
        location,
      };
    }
  }

  if (binding.kind === "ambiguous") {
    return {
      from,
      type: "constructor",
      resolution: {
        kind: "unknown",
        reason: binding.reason,
        potentialTargets: [],
      },
      location,
    };
  }

  if (binding.kind === "unresolved_module") {
    return {
      from,
      type: "constructor",
      resolution: {
        kind: "unknown",
        reason: "unresolved_module",
        potentialTargets: [],
      },
      location,
    };
  }

  if (binding.kind === "declaration_only") {
    // VT-304: see the equivalent branch in classifyCall for why this must
    // not fabricate a resolved, zero-edge region.
    return {
      from,
      type: "constructor",
      resolution: {
        kind: "unknown",
        reason: "declaration_only_resolution",
        potentialTargets: [],
      },
      location,
    };
  }

  // Not an import: a locally-declared class constructed by name is still
  // worth an edge when it can be attributed (mirrors classifyCall's local
  // function lookup).
  const localTarget = findLocalFunctionNodeId(callee, prepared);
  if (localTarget) {
    return {
      from,
      type: "constructor",
      resolution: { kind: "resolved", target: localTarget },
      location,
    };
  }

  const root = rootIdentifierOf(callee);
  if (root && isKnownGlobalIdentifier(root)) {
    return undefined;
  }

  // VT-305 (RWF-007): see the equivalent, more fully-explained check in
  // classifyCall -- a Node builtin is a known external module, never
  // `unsupported_construct`.
  if (binding.kind === "builtin") {
    return undefined;
  }

  return {
    from,
    type: "constructor",
    resolution: {
      kind: "unknown",
      reason: "unsupported_construct",
      potentialTargets: [],
    },
    location,
  };
}

/**
 * Emits one `"module_load"` edge per DISTINCT specifier `prepared`'s own
 * file imports/requires -- independent of whether any call ever binds to
 * the resulting value (VT-307a, RWF-002's own prerequisite). This is the
 * module-load-reachability half of graph construction, deliberately kept
 * separate from {@link classifyCall}'s call-reachability edges: a plain
 * `import "pkg"` (or `require("pkg")` with its result discarded) still
 * executes `pkg`'s top-level code, and `ModuleModel.imports` records that
 * specifier (as a `"side-effect"` binding -- see module-model.ts) whether
 * or not it's ever called. Before this, a module was only discovered as a
 * side effect of a *successful call binding* into it (`onDiscoverFile` was
 * only ever invoked from inside `classifyCall`/`classifyNew`/
 * `resolveReExportChain`/`resolveInstanceMethod`), so a module that is
 * genuinely loaded but never called into (or whose only call site the
 * binder can't attribute) was invisible to the graph entirely.
 *
 * A `"module_load"` edge is added to `ctx.edges` alongside, never instead
 * of, whatever call edges the same specifier's bindings independently
 * produce elsewhere in this file's walk -- the two answer different
 * questions ("does loading this module load that one?" vs. "does this
 * call reach that function?") and neither should be inferred from the
 * other (see {@link CallEdgeType}'s own doc comment).
 *
 * Resolver-kind handling (mirrors symbol-binder.ts's own dispatch, VT-304/
 * VT-305):
 * - `"resolved"` (a real runtime file): a resolved edge to that file's own
 *   `<module>` node, and the file is queued for its own walk exactly as a
 *   call-discovered file already is.
 * - `"declaration"`: an `unknown(declaration_only_resolution)` edge --
 *   same closure-widening treatment `bindCallee` already gives a call
 *   through a declaration-only import (VT-304).
 * - `"unresolved"`: an `unknown(unresolved_module)` edge -- same as an
 *   unresolved call-bound specifier.
 * - `"builtin"`: no edge at all (VT-305) -- a builtin has no local module
 *   node to load, and is not an uncertainty.
 *
 * If the resolved target file can't actually be prepared (unreadable/
 * unparsable, or a configured resource limit was already reached -- see
 * `ensurePrepared`), no edge is emitted for that specifier: fabricating a
 * `"resolved"` edge to a module node that was never registered would be
 * worse than an honest gap, and `scan.ts`'s own `graphTruncated` signal
 * already forces every finding to UNKNOWN when a limit caused a real
 * omission (VT-202) -- this mirrors how {@link resolveReExportChain}
 * already gives up silently on the same failure rather than fabricating
 * a destination.
 */
async function emitModuleLoadEdges(
  prepared: FileGraphData,
  ctx: WalkContext,
): Promise<void> {
  const bySpecifier = new Map<
    string,
    (typeof prepared.model.imports)[number]
  >();
  for (const imp of prepared.model.imports) {
    if (!bySpecifier.has(imp.specifier)) {
      bySpecifier.set(imp.specifier, imp);
    }
  }

  for (const [specifier, imp] of bySpecifier) {
    const resolution = await ctx.resolver.resolve(
      specifier,
      prepared.index.filePath,
    );

    if (resolution.kind === "builtin") {
      continue;
    }

    if (resolution.kind === "unresolved") {
      ctx.edges.push({
        from: prepared.moduleNodeId,
        type: "module_load",
        resolution: {
          kind: "unknown",
          reason: "unresolved_module",
          potentialTargets: [],
        },
        location: imp.location,
      });
      continue;
    }

    if (resolution.kind === "declaration") {
      ctx.edges.push({
        from: prepared.moduleNodeId,
        type: "module_load",
        resolution: {
          kind: "unknown",
          reason: "declaration_only_resolution",
          potentialTargets: [],
        },
        location: imp.location,
      });
      continue;
    }

    ctx.onDiscoverFile(resolution.resolvedFileName);
    const targetPrepared = ctx.ensurePrepared(resolution.resolvedFileName);
    if (!targetPrepared) {
      continue;
    }

    ctx.edges.push({
      from: prepared.moduleNodeId,
      type: "module_load",
      resolution: {
        kind: "resolved",
        target: targetPrepared.moduleNodeId,
      },
      location: imp.location,
    });
  }
}

async function walkFile(
  prepared: FileGraphData,
  ctx: WalkContext,
): Promise<void> {
  await emitModuleLoadEdges(prepared, ctx);

  const stack: GraphNodeId[] = [prepared.moduleNodeId];

  async function visit(node: ts.Node): Promise<void> {
    let pushed = false;

    if (isFunctionLike(node)) {
      const nodeId = prepared.functionNodeIdByLocation.get(
        locationKey(toSourceLocation(prepared.index.sourceFile, node)),
      );
      if (nodeId) {
        stack.push(nodeId);
        pushed = true;
      }
    }

    if (ts.isCallExpression(node)) {
      const from = stack[stack.length - 1];
      if (from) {
        const edge = await classifyCall(node, from, prepared, ctx);
        if (edge) {
          ctx.edges.push(edge);
        }
      }
    }

    if (ts.isNewExpression(node)) {
      const from = stack[stack.length - 1];
      if (from) {
        const edge = await classifyNew(node, from, prepared, ctx);
        if (edge) {
          ctx.edges.push(edge);
        }
      }
    }

    if (ts.isIfStatement(node)) {
      // VT-211 (SDD-v0.2.md § 9): the condition itself always executes,
      // whatever it evaluates to, and may contain calls of its own -- it
      // is always visited. Only a provably-constant condition changes
      // which branch(es) get visited; anything else (a variable,
      // parameter, or function call -- the overwhelming majority of real
      // conditions) still visits both, unchanged from before this task.
      await visit(node.expression);
      const constantValue = evaluateConstantBoolean(node.expression);
      if (constantValue === true) {
        await visit(node.thenStatement);
      } else if (constantValue === false) {
        if (node.elseStatement) {
          await visit(node.elseStatement);
        }
      } else {
        await visit(node.thenStatement);
        if (node.elseStatement) {
          await visit(node.elseStatement);
        }
      }
      return;
    }

    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    for (const child of children) {
      await visit(child);
    }

    if (pushed) {
      stack.pop();
    }
  }

  await visit(prepared.index.sourceFile);
}

export interface BuildCallGraphOptions {
  /** Files to start building the graph from (see TASK-019 Entrypoints for how these will eventually be selected). */
  readonly entryFiles: readonly string[];
  readonly resolver: ModuleResolver;
  /**
   * Resource limits (see docs/SDD.md § 26's `analysis.limits`, § 28-29's
   * hardening requirement to bound analysis of an adversarial/pathological
   * target project). All optional and unbounded by default, so every
   * existing caller that doesn't pass them keeps its current behavior.
   * Once a limit is reached, on-demand discovery of further files stops —
   * already-queued/in-progress work still completes, so this bounds
   * unbounded growth rather than guaranteeing an exact cutoff.
   */
  readonly maxFiles?: number;
  readonly maxGraphNodes?: number;
  readonly maxAnalysisSeconds?: number;
  /**
   * The loaded project (see ts-project.ts), enabling VT-208's instance-
   * method resolution (SDD-v0.2.md § 7.3) via a real, lazily-built
   * `ts.Program`/type checker. Optional and unused by default -- every
   * caller that omits it (as every caller predating VT-208 does) keeps
   * producing an honest `unknown(unsupported_construct)` edge for a method
   * call this graph can't otherwise attribute, exactly as before.
   */
  readonly project?: TsProject;
  /**
   * Accepted, and deliberately unused (RWF-004b).
   *
   * RWF-004a's same-package CommonJS re-export rule asked this graph to
   * answer "which installed package instance does this file belong to?"
   * for both sides of every re-export hop, and needed the scan's
   * dependency-provenance registry (see `domain/resolved-target.ts`'s
   * `buildKnownPackageRoots`) to answer it for a LINKED install. RWF-004b
   * removed that same-instance gate — see {@link followCommonJsReExport}
   * — so this graph no longer forms a package-identity opinion at all:
   * every node it emits is keyed by a resolved file path, and identity is
   * derived from that path downstream by the single authority
   * (`identifyModule`, via verdict.ts/module-load-closure.ts), which
   * receives the registry directly from the scan.
   *
   * Kept on this interface purely so existing callers (`cli/scan.ts` and
   * the suites that mirror it) keep compiling and keep passing the scan's
   * real registry along; it can never change this graph's output. Removing
   * it is a separate cleanup, not part of RWF-004b.
   */
  readonly knownPackageRoots?: KnownPackageRoots;
}

/**
 * Builds the initial call graph (see docs/SDD.md § 18) starting from
 * `entryFiles`, following resolved imports on demand: a file discovered
 * only through another file's import is indexed and walked too, so
 * `import`-typed edges can reach across module/package boundaries (e.g.
 * into `node_modules`). Already-visited files are never re-walked, which
 * also makes this safe against import cycles.
 */
export async function buildCallGraph(
  options: BuildCallGraphOptions,
): Promise<CallGraph> {
  const nodes = new Map<GraphNodeId, GraphNode>();
  const fileData = new Map<string, FileGraphData>();
  const walked = new Set<string>();
  const edges: CallEdge[] = [];
  const queue: string[] = [...options.entryFiles];

  const startTime = Date.now();
  const maxFiles = options.maxFiles ?? Infinity;
  const maxGraphNodes = options.maxGraphNodes ?? Infinity;
  const maxAnalysisMs = (options.maxAnalysisSeconds ?? Infinity) * 1000;

  function withinLimits(): boolean {
    return (
      walked.size < maxFiles &&
      nodes.size < maxGraphNodes &&
      Date.now() - startTime < maxAnalysisMs
    );
  }

  function registerNode(node: GraphNode): void {
    if (!nodes.has(node.id)) {
      nodes.set(node.id, node);
    }
  }

  function ensurePrepared(filePath: string): FileGraphData | undefined {
    const cached = fileData.get(filePath);
    if (cached) {
      return cached;
    }
    // Gated here — the single choke point every caller (this file's own
    // onDiscoverFile below, and classifyCall's own direct ensurePrepared
    // call to look up a resolved target's exportNameToNodeId) goes
    // through — rather than in each caller individually, so a limit
    // reached mid-walk can never be bypassed by whichever call site
    // happens to run first.
    if (!withinLimits()) {
      return undefined;
    }
    const prepared = prepareFile(filePath, registerNode);
    if (prepared) {
      fileData.set(filePath, prepared);
    }
    return prepared;
  }

  let program: ts.Program | undefined;
  let programAttempted = false;

  function getProgram(): ts.Program | undefined {
    if (!programAttempted) {
      programAttempted = true;
      const project = options.project;
      if (project) {
        try {
          // Rooted at entryFiles, not just project.fileNames: the latter
          // is empty for any project with no tsconfig.json at all (a
          // common case, including most of this file's own test
          // fixtures), which would otherwise silently produce a
          // zero-root-file program that can never resolve anything.
          // entryFiles are guaranteed non-empty and, by construction,
          // reach every file the call graph itself will ever walk via
          // imports -- ts.createProgram follows those same imports to
          // build the rest of the program, same as `tsc` itself. Combined
          // with project.fileNames too, in case a relevant file is only
          // reachable through tsconfig's own "include", not a resolved
          // import chain.
          const rootFiles = new Set([
            ...options.entryFiles,
            ...project.fileNames,
          ]);
          // maxNodeModuleJsDepth defaults to 0: TypeScript will resolve a
          // plain-.js node_modules import's *specifier* but declines to
          // parse/include the file itself for type acquisition, leaving
          // its type as `any` -- confirmed directly (VT-208's own
          // investigation) against a real vulnerable-package-shaped
          // fixture with no .d.ts of its own, exactly the common case
          // this analyzer targets. Set generously rather than left at the
          // default: the existing maxFiles/maxGraphNodes/maxAnalysisSeconds
          // limits already bound the overall analysis, so this doesn't
          // need its own small ceiling.
          const compilerOptions: ts.CompilerOptions = {
            ...project.rawCompilerOptions,
            maxNodeModuleJsDepth: 100,
          };
          program = ts.createProgram(
            [...rootFiles],
            compilerOptions,
            ts.createCompilerHost(compilerOptions, true),
          );
        } catch {
          // Target-project tsconfig/source data can be arbitrarily broken
          // (see docs/SDD.md § 29); VT-208's resolution is a best-effort
          // enhancement, not a requirement -- fall back to the
          // unsupported_construct edge every earlier caller already
          // produces rather than aborting the whole scan.
          program = undefined;
        }
      }
    }
    return program;
  }

  const ctx: WalkContext = {
    edges,
    resolver: options.resolver,
    ensurePrepared,
    onDiscoverFile: (filePath) => {
      const prepared = ensurePrepared(filePath);
      if (!prepared) {
        return;
      }
      if (!walked.has(filePath)) {
        queue.push(filePath);
      }
    },
    getProgram,
  };

  while (queue.length > 0) {
    if (!withinLimits()) {
      break;
    }

    const filePath = queue.shift();
    if (!filePath || walked.has(filePath)) {
      continue;
    }
    walked.add(filePath);

    const prepared = ensurePrepared(filePath);
    if (!prepared) {
      continue;
    }

    await walkFile(prepared, ctx);
  }

  return { nodes: [...nodes.values()], edges };
}
