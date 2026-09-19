/**
 * CELLS WHERE CURRENT BEHAVIOUR DISAGREES WITH WHAT SHOULD HAPPEN.
 *
 * A row here NEVER changes a cell's expectation. `matrix.ts` still states
 * the correct answer, derived from JavaScript semantics, and the report
 * still prints it. This table records, as DATA, the answer the analyzer
 * actually gives today, so that:
 *
 *   - the sweep is a standing instrument rather than a permanently red
 *     suite. An AGREEING cell that regresses fails, and a DISAGREEING
 *     cell that drifts to some third answer fails too. A suite that is
 *     already red cannot report the next defect, and reporting the next
 *     defect is the entire reason this file exists;
 *   - fixing the analyzer FAILS the cell -- `observed` stops matching --
 *     which is the signal to delete the row, never to edit it;
 *   - the classification and the reproduction are committed rather than
 *     re-derived by the next auditor.
 *
 * THE DEPARTURE FROM tests/adversarial/v1|v2, STATED PLAINLY. Those
 * suites let a disagreeing scenario simply fail, and are read by a human
 * as a research record. This one is a gate. The protection that
 * convention gives -- never pinning a wrong answer AS THE EXPECTATION --
 * is preserved exactly: `observed` is labelled as the defect's current
 * shape, lives in a different file from the oracle, and is never
 * consulted by `expectationFor`. Nothing here could make an unsound
 * answer read as correct.
 *
 * WHAT THE FIRST SWEEP FOUND. 264 cells, 175 agreeing, 89 disagreeing,
 * and every single disagreement in the same direction: the analyzer
 * REFUSES where the language names a target. No cell produced a wrong
 * EXACT. There is no class A, B or C finding on this base -- the
 * text-authority defect class that RWF-043, RWF-045, RWF-046 and
 * RWF-046a each closed does not reproduce anywhere in the grammar.
 *
 * That negative result is only meaningful because the instrument's own
 * controls prove a fabrication WOULD have been visible: every local name
 * the matrix baits with (`probeTarget`, `run`, `sibling`, `rest`, `key`,
 * `KEY`) is a real, reachable export of every fixture package, as is the
 * positional bait `"1"`, and two installs of one package are two
 * distinct observations. Without those controls "no fabrication" would
 * be indistinguishable from "the fixtures were silent", which is exactly
 * how the RWF-046 array hole survived a green suite.
 */

/**
 * The three recurring classes the four preceding audits produced, plus
 * the honest case.
 */
export type DisagreementClass =
  /**
   * WRONG BINDING IDENTITY -- a local identifier's TEXT reached an
   * authoritative attribution. RWF-043, RWF-045, RWF-046 and RWF-046a
   * were all this. A live soundness defect, and the thing this sweep
   * exists to catch.
   */
  | "A"
  /**
   * CORRECT BINDING, WRONG RUNTIME-VALUE SEMANTICS -- the right
   * declaration, but a value the program never holds there: a rest
   * element read as the property that shares its name, a for-in key
   * called as a function, a class entered without `new`.
   */
  | "B"
  /**
   * MULTI-VALUED PROVENANCE COLLAPSED TO ONE VALUE -- a default, a
   * conditional write, several disagreeing call sites.
   */
  | "C"
  /**
   * HONEST, DELIBERATE UNKNOWN -- the analyzer refuses a shape whose
   * correct answer it could in principle name. Sound, imprecise, and
   * the direction this engine is permitted to fail in.
   */
  | "honest-unknown";

/**
 * A family of cells that disagree for ONE reason.
 *
 * Grouping is not cosmetic. 89 individually-worded rows would be 89
 * chances for the same finding to be described two ways, and the
 * question the next task must answer -- which MECHANISM is
 * under-instrumented -- is a question about families, not cells.
 */
export interface DisagreementGroup {
  readonly id: string;
  readonly class: DisagreementClass;
  /**
   * Whether the repository already states this boundary somewhere a
   * reader would find it. `false` marks a gap this sweep DISCOVERED:
   * sound, but unstated, and therefore able to change without anyone
   * noticing.
   */
  readonly documented: boolean;
  /** The remediation or SDD section that owns the boundary. */
  readonly owner: string;
  readonly why: string;
}

export interface KnownDisagreement {
  readonly form: string;
  readonly mechanism: string;
  readonly group: string;
  /**
   * What the analyzer produces TODAY, in the driver's observation
   * format (`EXACT <module>#<name>` or `UNKNOWN <reason>`). Pinned so
   * drift in either direction fails the cell.
   */
  readonly observed: string;
}

export const DISAGREEMENT_GROUPS: readonly DisagreementGroup[] = [
  {
    id: "non-identifier-key",
    class: "honest-unknown",
    documented: true,
    owner: "RWF-046a shape boundary / RWF-045 bridge",
    why:
      "The destructuring shape boundary admits a key only when it is an " +
      "identifier or a string literal. A numeric-literal key and a computed " +
      "key -- even one whose value is a same-file `const` string literal, " +
      "which is the shape VT-217 already resolves for element access -- both " +
      "name a property JavaScript resolves to exactly one value, and both are " +
      "refused. Sound and imprecise. RWF-046a's stated rationale for the " +
      'numeric case, "a numeric key names no export", is not accurate: ' +
      '`module.exports = { ["1"]: f }` is a real export named "1" and this ' +
      "suite's own control reaches it. The refusal is right; the reason given " +
      "for it is not.",
  },
  {
    id: "array-pattern-positional",
    class: "honest-unknown",
    documented: true,
    owner: "RWF-045 / RWF-046a shape boundary",
    why:
      "An array pattern binds by POSITION, and no authority path models " +
      "positions. Where the source really is an array -- a local array " +
      "literal, an array of classes, an array of module objects -- the " +
      "language proves exactly one element and the analyzer still refuses. " +
      "This is the bought side of RWF-046a's trade: the boundary was stated " +
      "as the property proof itself rather than as the counterexample, which " +
      "costs these edges and buys the refusal of `const [, run] = " +
      'require("pkg")`.',
  },
  {
    id: "nested-pattern",
    class: "honest-unknown",
    documented: true,
    owner: "RWF-045 / RWF-046a shape boundary",
    why:
      "A nested pattern makes the real member path two hops (`X.api.run`, " +
      "`X.deep[0]`), and no binding models a member path. Refusing keeps it " +
      "UNKNOWN rather than mis-attributing it to `X.run`, which both RWF-045 " +
      "and RWF-046a name explicitly. The fixture makes `api.run` a DISTINCT " +
      "function, so the cell would have caught that mis-attribution had it " +
      "happened.",
  },
  {
    id: "vt210-single-hop",
    class: "honest-unknown",
    documented: true,
    owner: "VT-210 / SDD-v0.2.md 16",
    why:
      "VT-210 is explicitly single-hop and same-file: the argument at the " +
      "enclosing function's call site must itself be a plain identifier this " +
      "analyzer can name. A destructured local, a second parameter hop and a " +
      "member expression each fail that, and the whole question is refused " +
      "rather than sampled -- which is the RWF-043 lesson, since an arbitrary " +
      "pick among real candidates displaces the honest `unknown` blocker.",
  },
  {
    id: "receiver-has-no-destructuring-bridge",
    class: "honest-unknown",
    documented: false,
    owner: "RWF-045, callee path only",
    why:
      "The RWF-045 destructuring bridge exists only on the CALLEE path. " +
      '`resolveNamedReceiverBinding` requires `binding.kind === "value"`, and ' +
      "a destructured name resolves to the `destructuring` cause instead, so " +
      "`const { run } = mods; run.execute()` is refused while its " +
      "callee-position twin `const { run } = mod; run()` resolves. Sound, and " +
      "a mechanism-level asymmetry that no existing test states.",
  },
  {
    id: "class-static-field",
    class: "honest-unknown",
    documented: false,
    owner: "P1-B3 14 (adjacent)",
    why:
      "A static class field is not modeled as a binding: `Holder.probeTarget` " +
      "is a member access whose receiver is a class declaration, and the " +
      "receiver path admits only an object literal or a reference. P1-B3 14 " +
      "withholds class and instance modeling, so this sits inside a stated " +
      "boundary -- but the STATIC case needs no instance modeling at all, and " +
      "it is not separately stated.",
  },
  {
    id: "local-object-literal-destructuring",
    class: "honest-unknown",
    documented: false,
    owner: "RWF-045 bridge / VT-214 receiver path",
    why:
      "Destructuring from a local object literal is refused (`const { run } = " +
      "objSrc; run()`), while member access on the SAME literal resolves " +
      "(`const x = objSrc; x.run()`, via `findObjectLiteralPropertyValue`). " +
      "The bridge synthesizes `objSrc.run` and hands it to " +
      "`resolveAliasedValue`, which places a value through the IMPORT " +
      "machinery only; the object-literal member lookup the receiver path " +
      "owns is never reached. Sound, asymmetric, unstated.",
  },
  {
    id: "require-call-member-alias",
    class: "honest-unknown",
    documented: false,
    owner: "symbol-binder bindCallee",
    why:
      '`const probeTarget = require("pkg").run; probeTarget()` is refused, ' +
      'while the two-step `const mod = require("pkg"); const probeTarget = ' +
      "mod.run; probeTarget()` resolves. The alias value is a property access " +
      "whose receiver is the `require` CALL rather than an identifier, so " +
      "`bindCallee` reaches neither an import binding nor a local " +
      "declaration. Sound, and the asymmetry is unstated.",
  },
  {
    id: "vt210-no-construct",
    class: "honest-unknown",
    documented: false,
    owner: "VT-210 / P1-B3b 11",
    why:
      "VT-210's higher-order rescue resolves CALLS only. `function probe(p) { " +
      "new p(); } probe(Thing)` stays UNKNOWN although the language proves " +
      "`p` is `Thing` at its single call site. `nodeIdForBoundDeclaration` is " +
      "construct-aware; the higher-order path is never consulted for a `new` " +
      "expression. Sound; the missing direction is unstated.",
  },
];

export const KNOWN_DISAGREEMENTS: readonly KnownDisagreement[] = [
  // -- non-identifier-key ------------------------------------------
  {
    form: "computed-key-literal",
    mechanism: "class-construct",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "computed-key-literal",
    mechanism: "destructuring-bridge",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "computed-key-literal",
    mechanism: "direct-call",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "computed-key-literal",
    mechanism: "esm-import",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "computed-key-literal",
    mechanism: "higher-order-parameter",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "computed-key-literal",
    mechanism: "member-on-bound-module",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "computed-key-literal",
    mechanism: "require-provenance",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "computed-key-variable",
    mechanism: "class-construct",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "computed-key-variable",
    mechanism: "destructuring-bridge",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "computed-key-variable",
    mechanism: "direct-call",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "computed-key-variable",
    mechanism: "esm-import",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "computed-key-variable",
    mechanism: "higher-order-parameter",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "computed-key-variable",
    mechanism: "member-on-bound-module",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "computed-key-variable",
    mechanism: "require-provenance",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "numeric-key",
    mechanism: "class-construct",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "numeric-key",
    mechanism: "destructuring-bridge",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "numeric-key",
    mechanism: "direct-call",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "numeric-key",
    mechanism: "esm-import",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "numeric-key",
    mechanism: "higher-order-parameter",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "numeric-key",
    mechanism: "member-on-bound-module",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "numeric-key",
    mechanism: "require-provenance",
    group: "non-identifier-key",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  // -- array-pattern-positional ------------------------------------
  {
    form: "array-element-leading-hole",
    mechanism: "class-construct",
    group: "array-pattern-positional",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "array-element-leading-hole",
    mechanism: "direct-call",
    group: "array-pattern-positional",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "array-element-leading-hole",
    mechanism: "higher-order-parameter",
    group: "array-pattern-positional",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "array-element-named-sibling",
    mechanism: "class-construct",
    group: "array-pattern-positional",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "array-element-named-sibling",
    mechanism: "direct-call",
    group: "array-pattern-positional",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "array-element-named-sibling",
    mechanism: "higher-order-parameter",
    group: "array-pattern-positional",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "array-element-single",
    mechanism: "class-construct",
    group: "array-pattern-positional",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "array-element-single",
    mechanism: "direct-call",
    group: "array-pattern-positional",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "array-element-single",
    mechanism: "higher-order-parameter",
    group: "array-pattern-positional",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "array-element-trailing-hole",
    mechanism: "class-construct",
    group: "array-pattern-positional",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "array-element-trailing-hole",
    mechanism: "direct-call",
    group: "array-pattern-positional",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "array-element-trailing-hole",
    mechanism: "higher-order-parameter",
    group: "array-pattern-positional",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "object-in-array",
    mechanism: "class-construct",
    group: "array-pattern-positional",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "object-in-array",
    mechanism: "direct-call",
    group: "array-pattern-positional",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "object-in-array",
    mechanism: "higher-order-parameter",
    group: "array-pattern-positional",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  // -- nested-pattern ----------------------------------------------
  {
    form: "nested-array-in-object",
    mechanism: "class-construct",
    group: "nested-pattern",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "nested-array-in-object",
    mechanism: "destructuring-bridge",
    group: "nested-pattern",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "nested-array-in-object",
    mechanism: "direct-call",
    group: "nested-pattern",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "nested-array-in-object",
    mechanism: "esm-import",
    group: "nested-pattern",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "nested-array-in-object",
    mechanism: "higher-order-parameter",
    group: "nested-pattern",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "nested-array-in-object",
    mechanism: "member-on-bound-module",
    group: "nested-pattern",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "nested-array-in-object",
    mechanism: "require-provenance",
    group: "nested-pattern",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "nested-object-pattern",
    mechanism: "class-construct",
    group: "nested-pattern",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "nested-object-pattern",
    mechanism: "destructuring-bridge",
    group: "nested-pattern",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "nested-object-pattern",
    mechanism: "direct-call",
    group: "nested-pattern",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "nested-object-pattern",
    mechanism: "esm-import",
    group: "nested-pattern",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "nested-object-pattern",
    mechanism: "higher-order-parameter",
    group: "nested-pattern",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "nested-object-pattern",
    mechanism: "member-on-bound-module",
    group: "nested-pattern",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "nested-object-pattern",
    mechanism: "require-provenance",
    group: "nested-pattern",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  // -- vt210-single-hop --------------------------------------------
  {
    form: "destructured-parameter",
    mechanism: "class-construct",
    group: "vt210-single-hop",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "destructured-parameter",
    mechanism: "destructuring-bridge",
    group: "vt210-single-hop",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "destructured-parameter",
    mechanism: "direct-call",
    group: "vt210-single-hop",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "destructured-parameter",
    mechanism: "esm-import",
    group: "vt210-single-hop",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "destructured-parameter",
    mechanism: "higher-order-parameter",
    group: "vt210-single-hop",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "destructured-parameter",
    mechanism: "require-provenance",
    group: "vt210-single-hop",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "object-renamed",
    mechanism: "higher-order-parameter",
    group: "vt210-single-hop",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "object-shorthand",
    mechanism: "higher-order-parameter",
    group: "vt210-single-hop",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "parameter-binding",
    mechanism: "destructuring-bridge",
    group: "vt210-single-hop",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "parameter-binding",
    mechanism: "higher-order-parameter",
    group: "vt210-single-hop",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "parameter-binding",
    mechanism: "require-provenance",
    group: "vt210-single-hop",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "string-literal-key",
    mechanism: "higher-order-parameter",
    group: "vt210-single-hop",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  // -- receiver-has-no-destructuring-bridge ------------------------
  {
    form: "array-element-leading-hole",
    mechanism: "member-on-bound-module",
    group: "receiver-has-no-destructuring-bridge",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "array-element-named-sibling",
    mechanism: "member-on-bound-module",
    group: "receiver-has-no-destructuring-bridge",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "array-element-single",
    mechanism: "member-on-bound-module",
    group: "receiver-has-no-destructuring-bridge",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "array-element-trailing-hole",
    mechanism: "member-on-bound-module",
    group: "receiver-has-no-destructuring-bridge",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "destructured-parameter",
    mechanism: "member-on-bound-module",
    group: "receiver-has-no-destructuring-bridge",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "object-in-array",
    mechanism: "member-on-bound-module",
    group: "receiver-has-no-destructuring-bridge",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "object-renamed",
    mechanism: "member-on-bound-module",
    group: "receiver-has-no-destructuring-bridge",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "object-shorthand",
    mechanism: "member-on-bound-module",
    group: "receiver-has-no-destructuring-bridge",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "parameter-binding",
    mechanism: "member-on-bound-module",
    group: "receiver-has-no-destructuring-bridge",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "string-literal-key",
    mechanism: "member-on-bound-module",
    group: "receiver-has-no-destructuring-bridge",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  // -- class-static-field ------------------------------------------
  {
    form: "class-field",
    mechanism: "class-construct",
    group: "class-static-field",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "class-field",
    mechanism: "destructuring-bridge",
    group: "class-static-field",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "class-field",
    mechanism: "direct-call",
    group: "class-static-field",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "class-field",
    mechanism: "esm-import",
    group: "class-static-field",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "class-field",
    mechanism: "higher-order-parameter",
    group: "class-static-field",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "class-field",
    mechanism: "member-on-bound-module",
    group: "class-static-field",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  {
    form: "class-field",
    mechanism: "require-provenance",
    group: "class-static-field",
    observed: "UNKNOWN unsupported_receiver_binding",
  },
  // -- local-object-literal-destructuring --------------------------
  {
    form: "object-renamed",
    mechanism: "class-construct",
    group: "local-object-literal-destructuring",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "object-renamed",
    mechanism: "direct-call",
    group: "local-object-literal-destructuring",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "object-shorthand",
    mechanism: "class-construct",
    group: "local-object-literal-destructuring",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "object-shorthand",
    mechanism: "direct-call",
    group: "local-object-literal-destructuring",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "string-literal-key",
    mechanism: "class-construct",
    group: "local-object-literal-destructuring",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "string-literal-key",
    mechanism: "direct-call",
    group: "local-object-literal-destructuring",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  // -- require-call-member-alias -----------------------------------
  {
    form: "identifier",
    mechanism: "require-provenance",
    group: "require-call-member-alias",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "let-binding",
    mechanism: "require-provenance",
    group: "require-call-member-alias",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  {
    form: "var-binding",
    mechanism: "require-provenance",
    group: "require-call-member-alias",
    observed: "UNKNOWN unsupported_callee_binding",
  },
  // -- vt210-no-construct ------------------------------------------
  {
    form: "parameter-binding",
    mechanism: "class-construct",
    group: "vt210-no-construct",
    observed: "UNKNOWN unsupported_callee_binding",
  },
];
