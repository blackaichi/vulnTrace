import type { UncertaintyCategory } from "../../src/domain/uncertainty.js";

/**
 * THE BINDING-FORM GRAMMAR SWEEP -- every binding form against every
 * authority mechanism.
 *
 * WHY THIS FILE EXISTS. Four consecutive audits found the same defect
 * class: a LOCAL IDENTIFIER'S TEXT reaching an authoritative attribution.
 * RWF-043 (the same-name function matcher), RWF-045 (destructured source
 * selected by text), RWF-046 (require provenance by name), and RWF-046a
 * (the `propertyName ?? name` fallback applied to an ARRAY element, so
 * `const [, run] = require("pkg")` resolved to `pkg#run`). The last of
 * those was INTRODUCED BY THE FIX FOR THE PREVIOUS ONE and passed every
 * gate. It was found only when a human enumerated the binding grammar by
 * hand, and that enumeration existed in no committed file.
 *
 * This is that enumeration, committed. A shape nobody thought of now
 * fails a cell instead of surviving to an audit.
 *
 * WHY DATA RATHER THAN TEST FILES. The precedent is
 * `src/testing/foundation-invariants.ts`: a document drifts silently, a
 * data structure does not. A new binding form is a row here; a new
 * authority mechanism is a column here; neither is a new test file. The
 * driver asserts that the FULL cross-product is accounted for, so a row
 * added without thinking about one of the mechanisms fails the suite
 * rather than quietly covering seven eighths of the grammar.
 *
 * WHAT A CELL MAY ASSERT. Exactly two things, and the types below make
 * the third unrepresentable:
 *
 *   - an EXACT target: `<module path>#<declaration name>`, which names
 *     the exact export, the exact install (two twins are two paths) and
 *     the exact declaration in one string;
 *   - UNKNOWN under a NAMED reason from `domain/uncertainty.ts`'s
 *     six-category taxonomy.
 *
 * "Does not crash" and "returns something" are not expressible. Neither
 * is the harness's own `no-edge` / `ambiguous` / `no-probe` degeneracy:
 * those exist as OBSERVATIONS so a cell whose probe vanished says so,
 * and the driver asserts no expectation is ever written as one.
 *
 * HOW EXPECTATIONS WERE AUTHORED. From JavaScript semantics, never from
 * the analyzer's output. Each row states its own DETERMINACY -- whether
 * the language itself proves the reference denotes exactly one value --
 * and each column states which selections its container actually holds.
 * {@link expectationFor} composes those two facts and nothing else. Where
 * a cell disagrees with current behaviour, the disagreement is recorded
 * in {@link KNOWN_DISAGREEMENTS} with the correct expectation left
 * standing; the wrong answer is NEVER promoted into the expectation.
 */

// ---------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------

export type Expectation =
  | { readonly kind: "exact"; readonly target: string }
  | {
      readonly kind: "unknown";
      readonly reason: string;
      readonly category: UncertaintyCategory;
    };

export function formatExpectation(e: Expectation): string {
  return e.kind === "exact" ? `EXACT ${e.target}` : `UNKNOWN ${e.reason}`;
}

// ---------------------------------------------------------------------
// Selections -- WHICH member of the column's container a row picks out
// ---------------------------------------------------------------------

/**
 * What the binding form selects, stated as a path through the value the
 * column supplies. This is a fact about the SYNTAX, independent of any
 * mechanism: `const { api: { run: t } } = X` selects `X.api.run` whatever
 * `X` is.
 */
export type Selection =
  /** The bound name IS the column's callable. */
  | { readonly kind: "whole" }
  | { readonly kind: "property"; readonly name: string }
  | { readonly kind: "index"; readonly index: number }
  | {
      readonly kind: "property-of-property";
      readonly outer: string;
      readonly inner: string;
    }
  | {
      readonly kind: "index-of-property";
      readonly outer: string;
      readonly index: number;
    }
  | {
      readonly kind: "property-of-index";
      readonly index: number;
      readonly inner: string;
    }
  /** The form binds no single member: a rest, a key iteration, an empty pattern. */
  | { readonly kind: "nothing" };

// ---------------------------------------------------------------------
// Columns -- the authority mechanisms
// ---------------------------------------------------------------------

export interface EmitContext {
  /** An expression that IS the callable / constructible / module object. */
  readonly callable: string;
  /** An object expression whose members are callables. */
  readonly container: string;
  /** An array expression whose elements are callables, where the mechanism has one. */
  readonly arrayContainer: string | undefined;
  /** How this mechanism invokes a bound value. */
  invoke(expression: string): string;
}

export interface AuthorityMechanism {
  readonly id: string;
  readonly title: string;
  /** The remediation / task that owns this mechanism. */
  readonly owner: string;
  readonly esm: boolean;
  /** Statements every cell in this column emits before the row's own. */
  readonly prelude: readonly string[];
  readonly context: EmitContext;
  /** The graph node whose outgoing edge the cell observes. */
  readonly probeName: string;
  /**
   * The `DynamicCallReason` a refusal in THIS column's call shape
   * carries. It is a property of the call shape (bare identifier,
   * member access, `new`), not of the binding, which is why it lives on
   * the column.
   */
  readonly refusal: {
    readonly reason: string;
    readonly category: UncertaintyCategory;
  };
  /**
   * The exact target a CORRECT resolution of `selection` names, or
   * `undefined` when this mechanism's value genuinely holds no such
   * member -- a namespace object has no element 0, `pkg.api` has no
   * `.api`, and a class called without `new` reaches nothing at all.
   *
   * This encodes what the FIXTURE CONTAINS, never what the analyzer
   * currently does.
   */
  exactFor(selection: Selection): string | undefined;
  readonly note: string;
}

const LOCAL_SOURCE_PRELUDE = [
  "function tRun() {}",
  "function tAlpha() {}",
  "function tNum1() {}",
  "function tApiRun() {}",
  "function tZero() {}",
  "function tOne() {}",
  "function tTwo() {}",
  "function tDeep0() {}",
  "function tArr0Run() {}",
  "const objSrc = {",
  "  run: tRun,",
  "  alpha: tAlpha,",
  "  1: tNum1,",
  "  api: { run: tApiRun },",
  "  deep: [tDeep0],",
  "};",
  "const arrSrc = [tZero, tOne, tTwo];",
  "const arrSrcObj = [{ run: tArr0Run }, tOne];",
];

/**
 * The local-value container's own contents, shared by the two
 * local-source columns.
 *
 * `<self>` stands for the cell's OWN file, which the driver substitutes:
 * each cell is a separate entry file in one shared project, and a local
 * target is a declaration in that file. Writing the literal file name
 * here would make the oracle depend on the driver's naming scheme.
 */
function localExactFor(selection: Selection): string | undefined {
  switch (selection.kind) {
    case "whole":
      return "<self>#tRun";
    case "property":
      return selection.name === "run"
        ? "<self>#tRun"
        : selection.name === "alpha"
          ? "<self>#tAlpha"
          : selection.name === "1"
            ? "<self>#tNum1"
            : undefined;
    case "index":
      return ["<self>#tZero", "<self>#tOne", "<self>#tTwo"][selection.index];
    case "property-of-property":
      return selection.outer === "api" && selection.inner === "run"
        ? "<self>#tApiRun"
        : undefined;
    case "index-of-property":
      return selection.outer === "deep" && selection.index === 0
        ? "<self>#tDeep0"
        : undefined;
    case "property-of-index":
      return selection.index === 0 && selection.inner === "run"
        ? "<self>#tArr0Run"
        : undefined;
    case "nothing":
      return undefined;
  }
}

/**
 * A module-object container's contents, for the three columns whose
 * values are the loud fixture package's own exports. `member` selects
 * which export a resolution should name -- the callee columns name the
 * bound export itself, the member-access column always names `execute`.
 */
function moduleExactFor(
  modulePath: string,
  selection: Selection,
  member: ((exported: string) => string) | undefined,
): string | undefined {
  const name = (exported: string): string =>
    `${modulePath}#${member ? member(exported) : exported}`;
  switch (selection.kind) {
    case "whole":
      return name("run");
    case "property":
      return selection.name === "run"
        ? name("run")
        : selection.name === "alpha"
          ? name("alpha")
          : selection.name === "1"
            ? name("_n1")
            : undefined;
    case "property-of-property":
      return selection.outer === "api" && selection.inner === "run"
        ? name("apiRun")
        : undefined;
    case "index-of-property":
      return selection.outer === "deep" && selection.index === 0
        ? name("deep0")
        : undefined;
    // A module object is not iterable and has no element 0: an array
    // pattern over it THROWS before any call happens. There is no
    // correct target, which is precisely what makes these cells the
    // RWF-046a probe -- a resolution here is a fabrication, and the loud
    // fixture guarantees the fabrication lands on a real export rather
    // than vanishing into `unresolved_target`.
    case "index":
    case "property-of-index":
    case "nothing":
      return undefined;
  }
}

const UNSUPPORTED = "unmodeled_construct" as const;

export const AUTHORITY_MECHANISMS: readonly AuthorityMechanism[] = [
  {
    id: "direct-call",
    title: "direct call binding",
    owner: "RWF-043 / P1-B3b",
    esm: false,
    prelude: LOCAL_SOURCE_PRELUDE,
    context: {
      callable: "tRun",
      container: "objSrc",
      arrayContainer: "arrSrc",
      invoke: (e) => `${e}()`,
    },
    probeName: "probe",
    refusal: { reason: "unsupported_callee_binding", category: UNSUPPORTED },
    exactFor: localExactFor,
    note:
      "The mechanism RWF-043 corrected: a bare-identifier call whose " +
      "callee is a same-file declaration. Everything here is local, so a " +
      "wrong answer is a wrong DECLARATION rather than a wrong install.",
  },
  {
    id: "require-provenance",
    title: "require provenance",
    owner: "RWF-046 / RWF-046a",
    esm: false,
    prelude: [],
    context: {
      callable: 'require("pkg").run',
      container: 'require("pkg")',
      arrayContainer: undefined,
      invoke: (e) => `${e}()`,
    },
    probeName: "probe",
    refusal: { reason: "unsupported_callee_binding", category: UNSUPPORTED },
    exactFor: (s) => moduleExactFor("node_modules/pkg/index.js", s, undefined),
    note:
      "The only mechanism swept before this instrument existed. The " +
      'binding is initialized directly from `require("literal")`, which ' +
      "is the path `resolveImportProvenanceDeclaration` owns.",
  },
  {
    id: "destructuring-bridge",
    title: "destructuring source bridge",
    owner: "RWF-045",
    esm: false,
    prelude: ['const mod = require("pkg");'],
    context: {
      callable: "mod.run",
      container: "mod",
      arrayContainer: undefined,
      invoke: (e) => `${e}()`,
    },
    probeName: "probe",
    refusal: { reason: "unsupported_callee_binding", category: UNSUPPORTED },
    exactFor: (s) => moduleExactFor("node_modules/pkg/index.js", s, undefined),
    note:
      "One hop further out than the require column: the initializer is a " +
      "plain identifier that is itself a module binding, which is the " +
      "bridge RWF-045 rebuilt on binding-element identity.",
  },
  {
    id: "higher-order-parameter",
    title: "VT-210 higher-order parameter",
    owner: "VT-210",
    esm: false,
    prelude: [...LOCAL_SOURCE_PRELUDE, "function invoke(fn) {", "  fn();", "}"],
    context: {
      callable: "tRun",
      container: "objSrc",
      arrayContainer: "arrSrc",
      invoke: (e) => `invoke(${e})`,
    },
    probeName: "invoke",
    refusal: { reason: "unsupported_callee_binding", category: UNSUPPORTED },
    exactFor: localExactFor,
    note:
      "The row's binding becomes the ARGUMENT at `invoke`'s single call " +
      "site, and the observed edge is the one leaving `invoke` itself. " +
      "This asks whether VT-210's 'every call site must name one thing' " +
      "rule holds across the whole binding grammar, not just plain " +
      "identifiers.",
  },
  {
    id: "esm-import",
    title: "ESM import binding",
    owner: "SDD § 17",
    esm: true,
    prelude: [
      'import * as ns from "pkg";',
      'import { run as importedRun } from "pkg";',
    ],
    context: {
      callable: "importedRun",
      container: "ns",
      arrayContainer: undefined,
      invoke: (e) => `${e}()`,
    },
    probeName: "probe",
    refusal: { reason: "unsupported_callee_binding", category: UNSUPPORTED },
    exactFor: (s) => moduleExactFor("node_modules/pkg/index.js", s, undefined),
    note:
      "The ESM half of the convergence SDD § 17 requires: " +
      "`import { v } from 'foo'; v()` and `const { v } = require('foo'); " +
      "v()` must reach the same target. A namespace object is not " +
      "iterable, so array patterns over it have no correct target.",
  },
  {
    id: "class-construct",
    title: "class construct authority (new)",
    owner: "P1-B3b § 11",
    esm: false,
    prelude: [
      "class Thing { constructor() {} }",
      "class Other { constructor() {} }",
      "const classSrc = {",
      "  run: Thing,",
      "  alpha: Other,",
      "  1: Thing,",
      "  api: { run: Thing },",
      "  deep: [Thing],",
      "};",
      "const classArr = [Thing, Other];",
      "const classArrObj = [{ run: Thing }, Other];",
    ],
    context: {
      callable: "Thing",
      container: "classSrc",
      arrayContainer: "classArr",
      invoke: (e) => `new ${e}()`,
    },
    probeName: "probe",
    refusal: { reason: "unsupported_callee_binding", category: UNSUPPORTED },
    exactFor: (s) => {
      switch (s.kind) {
        case "whole":
          return "<self>#Thing";
        case "property":
          return s.name === "run"
            ? "<self>#Thing"
            : s.name === "alpha"
              ? "<self>#Other"
              : s.name === "1"
                ? "<self>#Thing"
                : undefined;
        case "index":
          return ["<self>#Thing", "<self>#Other"][s.index];
        case "property-of-property":
          return s.outer === "api" && s.inner === "run"
            ? "<self>#Thing"
            : undefined;
        case "index-of-property":
          return s.outer === "deep" && s.index === 0
            ? "<self>#Thing"
            : undefined;
        case "property-of-index":
          return s.index === 0 && s.inner === "run"
            ? "<self>#Thing"
            : undefined;
        case "nothing":
          return undefined;
      }
    },
    note:
      "A class reached through each binding form and CONSTRUCTED. The " +
      "constructor is genuinely entered, so an exact target is the " +
      "correct answer wherever the binding proves one class.",
  },
  {
    id: "class-call",
    title: "class construct authority (call, no new)",
    owner: "P1-B3b § 11",
    esm: false,
    prelude: [
      "class Thing { constructor() {} }",
      "class Other { constructor() {} }",
      "const classSrc = {",
      "  run: Thing,",
      "  alpha: Other,",
      "  1: Thing,",
      "  api: { run: Thing },",
      "  deep: [Thing],",
      "};",
      "const classArr = [Thing, Other];",
      "const classArrObj = [{ run: Thing }, Other];",
    ],
    context: {
      callable: "Thing",
      container: "classSrc",
      arrayContainer: "classArr",
      invoke: (e) => `${e}()`,
    },
    probeName: "probe",
    refusal: { reason: "unsupported_callee_binding", category: UNSUPPORTED },
    // EVERY cell in this column has no correct target, whatever the
    // binding form proves. `Thing()` without `new` throws a TypeError in
    // ClassDefinitionEvaluation's caller, before one statement of the
    // constructor body runs, so an edge into that constructor describes
    // an execution that provably cannot happen. This is the regression
    // B3b's first implementation shipped and an audit caught; the column
    // exists so it cannot come back through a binding form nobody tried.
    exactFor: () => undefined,
    note:
      "The negative half of the same mechanism, swept across the whole " +
      "grammar. Exact binding identity does not by itself make a value " +
      "callable, and this column is where that claim is enforced.",
  },
  {
    id: "member-on-bound-module",
    title: "member access on a bound module",
    owner: "SDD § 17 / RWF-047 adjacency",
    esm: false,
    prelude: [
      "const modSrc = {",
      '  run: require("pkg"),',
      '  alpha: require("pkg-a"),',
      '  1: require("pkg-b"),',
      '  api: { run: require("inner") },',
      '  deep: [require("outer")],',
      "};",
      'const modArr = [require("pkg"), require("pkg-a")];',
      'const modArrObj = [{ run: require("twin") }, require("pkg-a")];',
    ],
    context: {
      callable: 'require("pkg")',
      container: "modSrc",
      arrayContainer: "modArr",
      invoke: (e) => `${e}.execute()`,
    },
    probeName: "probe",
    refusal: { reason: "unsupported_receiver_binding", category: UNSUPPORTED },
    exactFor: (s) => {
      const of = (p: string): string => `node_modules/${p}/index.js#execute`;
      switch (s.kind) {
        case "whole":
          return of("pkg");
        case "property":
          return s.name === "run"
            ? of("pkg")
            : s.name === "alpha"
              ? of("pkg-a")
              : s.name === "1"
                ? of("pkg-b")
                : undefined;
        case "index":
          return [of("pkg"), of("pkg-a")][s.index];
        case "property-of-property":
          return s.outer === "api" && s.inner === "run"
            ? of("inner")
            : undefined;
        case "index-of-property":
          return s.outer === "deep" && s.index === 0 ? of("outer") : undefined;
        case "property-of-index":
          return s.index === 0 && s.inner === "run" ? of("twin") : undefined;
        case "nothing":
          return undefined;
      }
    },
    note:
      "Each binding form holds a whole MODULE OBJECT and a member is " +
      "called on it. Every slot holds a DIFFERENT package, so a wrong " +
      "answer here is a wrong PackageInstance and not merely a wrong " +
      "name -- the observation format spells the install path.",
  },
];

// ---------------------------------------------------------------------
// Rows -- the binding forms
// ---------------------------------------------------------------------

/**
 * Whether JavaScript ITSELF proves the reference denotes exactly one
 * value, and if not, why not. This is the only place a row's expectation
 * comes from, and every value here is a claim about the language, not
 * about VulnTrace.
 */
export type Determinacy =
  /** The language proves one value; a correct analyzer names it. */
  | { readonly kind: "single-valued" }
  /** The form admits more than one runtime value; naming one is class B or C. */
  | { readonly kind: "multi-valued"; readonly why: string }
  /** The bound value is provably NOT the callable; naming one is a fabrication. */
  | { readonly kind: "never-callable"; readonly why: string }
  /**
   * Single-valued in the language, but the value's provenance crosses a
   * modeling boundary this engine documents as out of scope. UNKNOWN is
   * the honest answer, and a resolution would be a claim the engine has
   * not earned.
   */
  | { readonly kind: "outside-scope"; readonly why: string };

export interface CellSource {
  readonly lines: readonly string[];
  /** Overrides the column's probe when the form moves the call site. */
  readonly probe?: string;
}

export interface BindingForm {
  readonly id: string;
  readonly title: string;
  readonly selection: Selection;
  readonly determinacy: Determinacy;
  emit(ctx: EmitContext): CellSource;
  /**
   * Overrides the mechanism's refusal TOKEN for this form.
   *
   * The token classifies the CALLEE SHAPE at the use site -- a bare name
   * is `unsupported_callee_binding`, a member access is
   * `unsupported_receiver_binding` -- and that shape is normally fixed
   * by the mechanism. `class-field` is the one form that changes it: its
   * bound value is reached through `Holder.probeTarget`, so the callee
   * is a member access in every mechanism that calls the bound
   * expression directly. This overrides the label only; it never changes
   * whether the cell expects EXACT or UNKNOWN.
   */
  refusalFor?(
    mechanism: AuthorityMechanism,
  ): AuthorityMechanism["refusal"] | undefined;
  /**
   * Set when this form's cells are exercised in the REFUSAL DIRECTION
   * ONLY, and why.
   *
   * A cell expecting EXACT normally has two live directions: it fails if
   * the analyzer refuses (today's disagreement), and it would fail
   * differently if the analyzer named the WRONG target. For some forms
   * the second direction is not reachable by any source spelling,
   * because the selection this form performs resolves NOWHERE in the
   * engine. Such a cell still states the right answer and still catches
   * a regression into a wrong EXACT if one ever becomes possible -- but
   * it has never been observed passing, and nothing about it has been
   * confirmed positively.
   *
   * A reader must not take those cells as fully verified, or as one
   * boundary-widening away from green. Recording it here rather than
   * only in a note means the report cannot print them as though they
   * were the same as the rest.
   */
  readonly refusalOnlyVerified?: string;
  readonly note: string;
}

/** `function probe() { <call>; }` -- the shape almost every row uses. */
function probeAround(
  declarations: readonly string[],
  call: string,
): CellSource {
  return {
    lines: [...declarations, "function probe() {", `  ${call};`, "}"],
  };
}

/** The container an array pattern destructures, falling back to the object one. */
function arrayish(ctx: EmitContext): string {
  return ctx.arrayContainer ?? ctx.container;
}

export const BINDING_FORMS: readonly BindingForm[] = [
  // -- Whole-value forms ---------------------------------------------
  {
    id: "identifier",
    title: "plain identifier binding",
    selection: { kind: "whole" },
    determinacy: { kind: "single-valued" },
    emit: (ctx) =>
      probeAround(
        [`const probeTarget = ${ctx.callable};`],
        ctx.invoke("probeTarget"),
      ),
    note: "The baseline. Every other row is this row plus one syntactic step.",
  },
  {
    id: "object-shorthand",
    title: "object pattern, shorthand",
    selection: { kind: "property", name: "run" },
    determinacy: { kind: "single-valued" },
    emit: (ctx) =>
      probeAround([`const { run } = ${ctx.container};`], ctx.invoke("run")),
    note:
      "Local name and property name coincide, which is the one case a " +
      "text-authority defect gets RIGHT by accident -- so it proves " +
      "nothing on its own and exists to pair with `object-renamed`.",
  },
  {
    id: "object-renamed",
    title: "object pattern, renamed",
    selection: { kind: "property", name: "run" },
    determinacy: { kind: "single-valued" },
    emit: (ctx) =>
      probeAround(
        [`const { run: probeTarget } = ${ctx.container};`],
        ctx.invoke("probeTarget"),
      ),
    note:
      "The discriminating twin of `object-shorthand`: the property is " +
      "`run` and the local is `probeTarget`, and the fixture exports " +
      "BOTH, so reading the local as the export name resolves loudly to " +
      "`#probeTarget` instead of failing quietly.",
  },
  {
    id: "string-literal-key",
    title: "object pattern, string-literal key",
    selection: { kind: "property", name: "run" },
    determinacy: { kind: "single-valued" },
    emit: (ctx) =>
      probeAround(
        [`const { "run": probeTarget } = ${ctx.container};`],
        ctx.invoke("probeTarget"),
      ),
    note: "Same property as `object-renamed`, spelled so the key is a literal node.",
  },
  {
    id: "numeric-key",
    title: "object pattern, numeric key",
    selection: { kind: "property", name: "1" },
    determinacy: { kind: "single-valued" },
    emit: (ctx) =>
      probeAround(
        [`const { 1: probeTarget } = ${ctx.container};`],
        ctx.invoke("probeTarget"),
      ),
    refusalOnlyVerified:
      "A non-identifier key resolves in NO position anywhere in the " +
      "engine, so these cells have never been observed passing and " +
      "nothing about them is positively confirmed. Measured: " +
      "destructuring refuses a numeric key (the shape boundary); " +
      "element access refuses it too (`x[1]()` is " +
      "`dynamic_member_access`, not the VT-217 literal-key rewrite); " +
      "and in CommonJS the export model has no representation for one " +
      'at all -- `module.exports = { "1": f }` and `{ 1: f }` index ' +
      "nothing (RWF-049). The expected target IS a real emittable " +
      "observation -- this suite's numeric control reaches `_n1` -- but " +
      "no source spelling produces it THROUGH a numeric key.",
    note:
      "A numeric key is a STATIC property name -- `module.exports = { 1: f }` " +
      'is a real export called "1", and the fixture provides it. The ' +
      "language proves one value, so EXACT is the correct expectation " +
      "however the engine currently treats numeric keys.",
  },
  {
    id: "computed-key-variable",
    title: "object pattern, computed key (variable-valued)",
    selection: { kind: "property", name: "run" },
    determinacy: { kind: "single-valued" },
    emit: (ctx) =>
      probeAround(
        [
          'const KEY = "run";',
          `const { [KEY]: probeTarget } = ${ctx.container};`,
        ],
        ctx.invoke("probeTarget"),
      ),
    refusalOnlyVerified:
      "A computed key resolves in NO position anywhere in the engine, " +
      "so these cells have never been observed passing. Measured: " +
      "destructuring refuses a computed key (the shape boundary), and " +
      "element access refuses it too -- `x[KEY]()` with `KEY` a " +
      "same-file `const` string literal is `dynamic_member_access`, " +
      "both on a local object and on a required module, so VT-217's " +
      "documented literal-key rewrite does not in fact fire here. The " +
      "expected target is an ordinary identifier-keyed export that the " +
      "engine reaches easily by other spellings; what is unverified is " +
      "reaching it through a computed key.",
    note:
      "`KEY` is a same-file `const` initialized to a string literal, which " +
      "is exactly the shape VT-217 already resolves for element access " +
      "(`fns[KEY]`). The key is therefore statically known and the " +
      "language proves one value.",
  },
  {
    id: "computed-key-literal",
    title: "object pattern, computed key (literal-valued)",
    selection: { kind: "property", name: "run" },
    determinacy: { kind: "single-valued" },
    emit: (ctx) =>
      probeAround(
        [`const { ["run"]: probeTarget } = ${ctx.container};`],
        ctx.invoke("probeTarget"),
      ),
    refusalOnlyVerified:
      "A computed key resolves in NO position anywhere in the engine, " +
      "so these cells have never been observed passing. Measured: " +
      "destructuring refuses a computed key (the shape boundary), and " +
      "element access refuses it too -- `x[KEY]()` with `KEY` a " +
      "same-file `const` string literal is `dynamic_member_access`, " +
      "both on a local object and on a required module, so VT-217's " +
      "documented literal-key rewrite does not in fact fire here. The " +
      "expected target is an ordinary identifier-keyed export that the " +
      "engine reaches easily by other spellings; what is unverified is " +
      "reaching it through a computed key.",
    note:
      '`{ ["run"]: x }` and `{ "run": x }` are the same property named two ' +
      "ways. A different answer for the two would be describing the " +
      "parser rather than the binding.",
  },
  {
    id: "default-top-level",
    title: "object pattern, default at top level",
    selection: { kind: "property", name: "run" },
    determinacy: {
      kind: "multi-valued",
      why:
        "the default supplies a SECOND possible runtime value, and nothing " +
        "in the pattern proves which one the call reaches",
    },
    emit: (ctx) =>
      probeAround(
        [
          "function fallbackFn() {}",
          `const { run: probeTarget = fallbackFn } = ${ctx.container};`,
        ],
        ctx.invoke("probeTarget"),
      ),
    note:
      "Collapsing two possible values onto one target is class C, and it " +
      "is the shape RWF-046a's boundary refuses by name.",
  },
  {
    id: "default-nested",
    title: "object pattern, default nested",
    selection: { kind: "property-of-property", outer: "api", inner: "run" },
    determinacy: {
      kind: "multi-valued",
      why: "as `default-top-level`, one level in",
    },
    emit: (ctx) =>
      probeAround(
        [
          "function fallbackFn() {}",
          `const { api: { run: probeTarget = fallbackFn } } = ${ctx.container};`,
        ],
        ctx.invoke("probeTarget"),
      ),
    note:
      "Pairs with `nested-object-pattern`: if the nested form resolves at " +
      "all, the default must still refuse it.",
  },
  {
    id: "rest-in-object",
    title: "object pattern, rest element",
    selection: { kind: "nothing" },
    determinacy: {
      kind: "never-callable",
      why:
        "a rest element holds an OBJECT of the remaining properties, never " +
        "the property that shares its name; calling it throws",
    },
    emit: (ctx) =>
      probeAround(
        [`const { alpha, ...run } = ${ctx.container};`],
        ctx.invoke("run"),
      ),
    note:
      "The rest is deliberately spelled `run`, a name the fixture exports. " +
      "Any resolution is therefore a loud EXACT observation and a class-A " +
      "text-authority finding, not a quiet `unresolved_target`.",
  },
  {
    id: "nested-object-pattern",
    title: "nested object pattern",
    selection: { kind: "property-of-property", outer: "api", inner: "run" },
    determinacy: { kind: "single-valued" },
    emit: (ctx) =>
      probeAround(
        [`const { api: { run: probeTarget } } = ${ctx.container};`],
        ctx.invoke("probeTarget"),
      ),
    note:
      "The real member path is `X.api.run`. The fixture makes `api.run` a " +
      "genuine distinct function (`apiRun`), so a resolution that DROPS " +
      "the `api.` hop lands on `#run` and is visible as a " +
      "mis-attribution rather than as a plausible near-miss.",
  },
  {
    id: "nested-array-in-object",
    title: "nested array pattern inside an object pattern",
    selection: { kind: "index-of-property", outer: "deep", index: 0 },
    determinacy: { kind: "single-valued" },
    emit: (ctx) =>
      probeAround(
        [`const { deep: [probeTarget] } = ${ctx.container};`],
        ctx.invoke("probeTarget"),
      ),
    note:
      "`X.deep` IS a real array in every fixture, so unlike the top-level " +
      "array rows this one has a correct answer to miss.",
  },
  {
    id: "empty-pattern",
    title: "empty object pattern",
    selection: { kind: "nothing" },
    determinacy: {
      kind: "never-callable",
      why: "an empty pattern binds no name at all",
    },
    emit: (ctx) =>
      probeAround([`const {} = ${ctx.container};`], ctx.invoke("run")),
    note:
      "`run` is UNDECLARED at the call site. The cell asks whether a " +
      "destructuring that binds nothing can still lend its source's " +
      "authority to a name that merely appears nearby -- the RWF-045 " +
      "defect in its purest form.",
  },
  {
    id: "parameter-binding",
    title: "parameter binding",
    selection: { kind: "whole" },
    determinacy: { kind: "single-valued" },
    emit: (ctx) => ({
      lines: [
        "function probe(probeTarget) {",
        `  ${ctx.invoke("probeTarget")};`,
        "}",
        `probe(${ctx.callable});`,
      ],
    }),
    note:
      "One call site, one argument, so the language proves one value. " +
      "Whether the engine may say so is VT-210's question, and the answer " +
      "differs by what the argument expression is -- which is the point " +
      "of running this row against every column.",
  },
  {
    id: "destructured-parameter",
    title: "destructured parameter",
    selection: { kind: "property", name: "run" },
    determinacy: { kind: "single-valued" },
    emit: (ctx) => ({
      lines: [
        "function probe({ run: probeTarget }) {",
        `  ${ctx.invoke("probeTarget")};`,
        "}",
        `probe(${ctx.container});`,
      ],
    }),
    note: "The parameter and destructuring mechanisms composed in one binding.",
  },
  {
    id: "catch-binding",
    title: "catch binding",
    selection: { kind: "nothing" },
    determinacy: {
      kind: "never-callable",
      why:
        "a catch binding holds the THROWN value; nothing in scope makes it " +
        "the module's export",
    },
    emit: (ctx) =>
      probeAround(
        [],
        [
          "try {",
          "    throw 0;",
          "  } catch (run) {",
          `    ${ctx.invoke("run")};`,
          "  }",
        ].join("\n  "),
      ),
    note:
      "Spelled `run` on purpose. A catch binding is the cheapest way to " +
      "put an exported spelling in scope holding something that is " +
      "definitively not the export.",
  },
  {
    id: "destructured-catch",
    title: "destructured catch binding",
    selection: { kind: "nothing" },
    determinacy: {
      kind: "never-callable",
      why: "as `catch-binding`, with the pattern adding no provenance",
    },
    emit: (ctx) =>
      probeAround(
        [],
        [
          "try {",
          "    throw 0;",
          "  } catch ({ run }) {",
          `    ${ctx.invoke("run")};`,
          "  }",
        ].join("\n  "),
      ),
    note:
      "The pattern LOOKS like the destructuring the bridge owns, and its " +
      "source is the thrown value. If the bridge is selecting patterns by " +
      "shape rather than by binding identity, this is where it shows.",
  },
  {
    id: "class-field",
    title: "static class field",
    selection: { kind: "whole" },
    determinacy: { kind: "single-valued" },
    emit: (ctx) =>
      probeAround(
        [`class Holder { static probeTarget = ${ctx.callable}; }`],
        ctx.invoke("Holder.probeTarget"),
      ),
    // Every mechanism but the higher-order one calls the bound
    // expression directly, so the callee is `Holder.probeTarget` -- a
    // member access. VT-210's column instead passes it as an argument
    // and the refused callee is the bare parameter `fn`.
    refusalFor: (mechanism) =>
      mechanism.id === "higher-order-parameter"
        ? undefined
        : {
            reason: "unsupported_receiver_binding",
            category: "unmodeled_construct",
          },
    note:
      "A static field is an ordinary single-valued binding reached through " +
      "a member access on a class. The language proves the value; whether " +
      "the engine models class statics is what the cell measures.",
  },
  {
    id: "for-of-binding",
    title: "for-of binding",
    selection: { kind: "whole" },
    determinacy: {
      kind: "outside-scope",
      why:
        "the binding's value comes from the ITERATOR PROTOCOL, which this " +
        "engine does not evaluate (AGENTS.md: never execute target code)",
    },
    emit: (ctx) =>
      probeAround(
        [],
        [
          `for (const run of [${ctx.callable}]) {`,
          `    ${ctx.invoke("run")};`,
          "  }",
        ].join("\n  "),
      ),
    note:
      "Spelled `run` again. The honest answer is UNKNOWN, and a resolution " +
      "to `#run` would be text authority reaching through a loop header.",
  },
  {
    id: "for-in-binding",
    title: "for-in binding",
    selection: { kind: "nothing" },
    determinacy: {
      kind: "never-callable",
      why:
        "a for-in binding holds KEY STRINGS, never values; calling one " +
        "always throws",
    },
    emit: (ctx) =>
      probeAround(
        [],
        [
          `for (const run in ${ctx.container}) {`,
          `    ${ctx.invoke("run")};`,
          "  }",
        ].join("\n  "),
      ),
    note:
      "The sharpest bait in the sweep: the name is an exported spelling, " +
      "the source IS the module, and the value is provably a string.",
  },
  {
    id: "let-binding",
    title: "let binding, never written",
    selection: { kind: "whole" },
    determinacy: { kind: "single-valued" },
    emit: (ctx) =>
      probeAround(
        [`let probeTarget = ${ctx.callable};`],
        ctx.invoke("probeTarget"),
      ),
    note:
      "A `let` with no write anywhere in its scope holds exactly what it " +
      "was initialized with. Pinning this separately from `identifier` is " +
      "what makes the const-only asymmetries in the two bridges visible " +
      "rather than discovered.",
  },
  {
    id: "var-binding",
    title: "var binding, never written",
    selection: { kind: "whole" },
    determinacy: { kind: "single-valued" },
    emit: (ctx) =>
      probeAround(
        [`var probeTarget = ${ctx.callable};`],
        ctx.invoke("probeTarget"),
      ),
    note: "As `let-binding`, with function-scoped hoisting instead of a TDZ.",
  },
  {
    id: "reassigned-binding",
    title: "reassigned binding",
    selection: { kind: "whole" },
    determinacy: {
      kind: "multi-valued",
      why: "a write in the same scope means no single value is authoritative",
    },
    emit: (ctx) =>
      probeAround(
        [
          `let probeTarget = ${ctx.callable};`,
          "probeTarget = decoy;",
          "function decoy() {}",
        ],
        ctx.invoke("probeTarget"),
      ),
    note: "Stale provenance surviving a write is the RWF-046 fabrication shape.",
  },
  {
    id: "compound-assign-eq",
    title: "compound-assigned binding (=)",
    selection: { kind: "whole" },
    determinacy: {
      kind: "multi-valued",
      why: "as `reassigned-binding`; the write is unconditional",
    },
    emit: (ctx) =>
      probeAround(
        [
          "let probeTarget = decoy;",
          `probeTarget = ${ctx.callable};`,
          "function decoy() {}",
        ],
        ctx.invoke("probeTarget"),
      ),
    note:
      "The mirror of `reassigned-binding`: here the LAST write is the " +
      "interesting value, and a correct refusal must refuse anyway -- " +
      "order alone does not make a write safe to read through.",
  },
  {
    id: "compound-assign-or",
    title: "compound-assigned binding (||=)",
    selection: { kind: "whole" },
    determinacy: {
      kind: "multi-valued",
      why: "`||=` writes CONDITIONALLY, so two values survive to the call",
    },
    emit: (ctx) =>
      probeAround(
        [
          `let probeTarget = ${ctx.callable};`,
          "probeTarget ||= decoy;",
          "function decoy() {}",
        ],
        ctx.invoke("probeTarget"),
      ),
    note: "A conditional write is still a write; collapsing it is class C.",
  },
  {
    id: "compound-assign-nullish",
    title: "compound-assigned binding (??=)",
    selection: { kind: "whole" },
    determinacy: {
      kind: "multi-valued",
      why: "as `||=`, with a different falsy test",
    },
    emit: (ctx) =>
      probeAround(
        [
          `let probeTarget = ${ctx.callable};`,
          "probeTarget ??= decoy;",
          "function decoy() {}",
        ],
        ctx.invoke("probeTarget"),
      ),
    note:
      "Included separately because `??=` is a newer node kind, and a " +
      "write-detection pass that enumerates operators can miss exactly one.",
  },
  {
    id: "closure-deferred-write",
    title: "closure-deferred write",
    selection: { kind: "whole" },
    determinacy: {
      kind: "multi-valued",
      why:
        "a closure can run the write at any time, so the value at the call " +
        "is not decided by textual order",
    },
    emit: (ctx) =>
      probeAround(
        [
          `let probeTarget = ${ctx.callable};`,
          "function decoy() {}",
          "function later() {",
          "  probeTarget = decoy;",
          "}",
          "later;",
        ],
        ctx.invoke("probeTarget"),
      ),
    note:
      "The reason the stability rule searches the WHOLE owning scope " +
      "rather than the statements between declaration and use.",
  },

  // -- Array-pattern forms -------------------------------------------
  {
    id: "array-element-single",
    title: "array pattern, single element",
    selection: { kind: "index", index: 0 },
    determinacy: { kind: "single-valued" },
    emit: (ctx) =>
      probeAround(
        [`const [probeTarget] = ${arrayish(ctx)};`],
        ctx.invoke("probeTarget"),
      ),
    note:
      "Binds POSITION 0. Against a mechanism whose value is an array this " +
      "has a correct answer; against a module object or a namespace it has " +
      "none, because the destructuring throws before any call happens.",
  },
  {
    id: "array-element-leading-hole",
    title: "array pattern, leading hole",
    selection: { kind: "index", index: 1 },
    determinacy: { kind: "single-valued" },
    emit: (ctx) =>
      probeAround([`const [, run] = ${arrayish(ctx)};`], ctx.invoke("run")),
    note:
      "THE RWF-046a SHAPE, generalized to every mechanism. `const [, run] = " +
      'require("pkg")` binds index 1 and resolved to `pkg#run` on the ' +
      "base commit, because the local identifier's text was read as a " +
      "property name. The name is exported by every fixture, so the " +
      "fabrication is loud wherever it survives.",
  },
  {
    id: "array-element-trailing-hole",
    title: "array pattern, trailing hole",
    selection: { kind: "index", index: 0 },
    determinacy: { kind: "single-valued" },
    emit: (ctx) =>
      probeAround([`const [run, ] = ${arrayish(ctx)};`], ctx.invoke("run")),
    note:
      "The same position as `array-element-single`, written with a trailing " +
      "elision and an exported name. A pass that counts elements rather " +
      "than reading positions answers these two differently.",
  },
  {
    id: "array-element-named-sibling",
    title: "array pattern, named sibling",
    selection: { kind: "index", index: 1 },
    determinacy: { kind: "single-valued" },
    emit: (ctx) =>
      probeAround(
        [`const [run, probeTarget] = ${arrayish(ctx)};`],
        ctx.invoke("probeTarget"),
      ),
    note:
      "Index 1, with an EXPORTED name sitting at index 0. A first-match " +
      "walk over the pattern's names reaches `run` and attributes the call " +
      "to the sibling; the correct answer names position 1.",
  },
  {
    id: "rest-in-array",
    title: "array pattern, rest element",
    selection: { kind: "nothing" },
    determinacy: {
      kind: "never-callable",
      why: "an array rest binds an ARRAY of the remaining elements",
    },
    emit: (ctx) =>
      probeAround([`const [, ...run] = ${arrayish(ctx)};`], ctx.invoke("run")),
    note:
      "The array twin of `rest-in-object`, and the shape RWF-046a's own " +
      "note says a 'not an array pattern' gate would have missed.",
  },
  {
    id: "object-in-array",
    title: "object pattern inside an array pattern",
    selection: { kind: "property-of-index", index: 0, inner: "run" },
    determinacy: { kind: "single-valued" },
    emit: (ctx) =>
      probeAround(
        [
          `const [{ run: probeTarget }] = ${
            ctx.arrayContainer ? `${ctx.arrayContainer}Obj` : ctx.container
          };`,
        ],
        ctx.invoke("probeTarget"),
      ),
    note:
      "The real path is `A[0].run`. Where a mechanism supplies an array, " +
      "the fixture's element 0 is an object holding a DISTINCT callable, so " +
      "dropping either hop is visible.",
  },
];

// ---------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------

/**
 * The expectation for one cell, composed from exactly two facts: what
 * JavaScript proves about the binding form ({@link Determinacy}) and what
 * the mechanism's value actually holds ({@link AuthorityMechanism.exactFor}).
 *
 * Nothing about VulnTrace's current behaviour enters here. That is the
 * point: an oracle derived from the implementation cannot disagree with
 * it, and a matrix that cannot disagree finds nothing.
 */
export function expectationFor(
  form: BindingForm,
  mechanism: AuthorityMechanism,
): Expectation {
  if (form.determinacy.kind === "single-valued") {
    const target = mechanism.exactFor(form.selection);
    if (target !== undefined) {
      return { kind: "exact", target };
    }
  }
  const refusal = form.refusalFor?.(mechanism) ?? mechanism.refusal;
  return {
    kind: "unknown",
    reason: refusal.reason,
    category: refusal.category,
  };
}

/** Why a cell that is expected UNKNOWN is expected UNKNOWN, in one line. */
export function refusalRationale(
  form: BindingForm,
  mechanism: AuthorityMechanism,
): string {
  if (form.determinacy.kind !== "single-valued") {
    return form.determinacy.why;
  }
  return (
    `the ${mechanism.title} value holds no ` +
    `${describeSelection(form.selection)}, so there is no correct target`
  );
}

export function describeSelection(selection: Selection): string {
  switch (selection.kind) {
    case "whole":
      return "whole value";
    case "property":
      return `property \`${selection.name}\``;
    case "index":
      return `element ${selection.index}`;
    case "property-of-property":
      return `\`${selection.outer}.${selection.inner}\``;
    case "index-of-property":
      return `\`${selection.outer}[${selection.index}]\``;
    case "property-of-index":
      return `\`[${selection.index}].${selection.inner}\``;
    case "nothing":
      return "single bound member";
  }
}

export interface CellId {
  readonly form: string;
  readonly mechanism: string;
}

export function cellKey(form: string, mechanism: string): string {
  return `${form}|${mechanism}`;
}

/**
 * Cells deliberately NOT swept, and only where the combination is
 * SYNTACTICALLY IMPOSSIBLE. Expecting a cell to pass is never a reason to
 * be here.
 */
export const SKIPPED_CELLS: readonly {
  readonly form: string;
  readonly mechanism: string;
  readonly reason: string;
}[] = [];
