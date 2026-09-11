import { describe, expect, it } from "vitest";
import { classifyLocalBinding } from "./commonjs-reexports.js";
import { buildModuleModel } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-025b's permanent matrix: which names an assignment TARGET writes to,
 * as `collectFacts`'s `reassignedNames` records them.
 *
 * `reassignedNames` is this file's authoritative NEGATIVE provenance
 * (RWF-013b): a name in it is one `classifyLocalBinding` refuses, so no
 * CommonJS re-export origin, alias chain or function attribution may be
 * read through it. It was filled by a `ts.forEachChild(target, markAssigned)`
 * fallback that recorded EVERY identifier under an assignment target —
 * including the ones a computed key, a default initializer or an
 * element-access index merely READS. One unrelated statement anywhere in a
 * file therefore withdrew a real re-export attribution FILE-WIDE.
 *
 * The observable used throughout is `classifyLocalBinding`, which consults
 * `reassignedNames` FIRST and before any declaration-form question, so it
 * reports set membership directly and independently of `const`:
 *
 * - `"single-assignment"` — the name is NOT recorded as written to;
 * - `"refused"` — it IS.
 *
 * Every row declares `alias` identically; only the statement under test
 * differs. The twin of this matrix, for module-model.ts's own
 * reach-restricted relation, is RWF-025's
 * module-model.destructuring-assignment-target-reassignment.test.ts —
 * see the twin-comparison block at the end.
 */

let counter = 0;

/** Whether the file's reassignment facts record `alias` as written to. */
function writesAlias(statement: string): boolean {
  const source = `const alias = require("./lib").vulnerable;\nlet seen;\nlet tmp;\n${statement}\n`;
  const index = indexSourceFile(`/virtual/rwf025b-${counter++}.js`, source);
  return classifyLocalBinding(index, "alias").kind === "refused";
}

/** Whether the file's reassignment facts record an arbitrary `name` as written to. */
function writes(statement: string, name: string): boolean {
  const source = `const ${name} = require("./lib").vulnerable;\nlet seen;\nlet tmp;\n${statement}\n`;
  const index = indexSourceFile(`/virtual/rwf025b-${counter++}.js`, source);
  return classifyLocalBinding(index, name).kind === "refused";
}

describe("RWF-025b: evaluated subexpressions of an assignment target are not writes", () => {
  it("1. a computed key's bare reference is a READ", () => {
    // The defect's canonical shape: `alias` is passed to a key function.
    expect(writesAlias("({ [alias]: seen } = REGISTRY);")).toBe(false);
  });

  it("2. a computed key's nested call is a READ", () => {
    expect(writesAlias("({ [keyFor(alias)]: seen } = REGISTRY);")).toBe(false);
    expect(writesAlias("({ [outer(keyFor(alias))]: seen } = REGISTRY);")).toBe(
      false,
    );
  });

  it("3. a computed key that PERFORMS an assignment is a write", () => {
    expect(writesAlias("({ [(alias = other)]: seen } = REGISTRY);")).toBe(true);
  });

  it("4. a computed key that PERFORMS an update is a write", () => {
    expect(writesAlias("({ [alias++]: seen } = REGISTRY);")).toBe(true);
    expect(writesAlias("({ [++alias]: seen } = REGISTRY);")).toBe(true);
    expect(writesAlias("({ [alias--]: seen } = REGISTRY);")).toBe(true);
    expect(writesAlias("({ [--alias]: seen } = REGISTRY);")).toBe(true);
  });

  it("5. an element-access index's bare reference is a READ", () => {
    expect(writesAlias("REGISTRY[alias] = 1;")).toBe(false);
  });

  it("6. an element-access index's nested call is a READ", () => {
    expect(writesAlias("REGISTRY[keyFor(alias)] = 1;")).toBe(false);
    expect(writesAlias("REGISTRY[outer(keyFor(alias))] = 1;")).toBe(false);
  });

  it("7. an element-access index that PERFORMS an assignment is a write", () => {
    expect(writesAlias("REGISTRY[(alias = other)] = 1;")).toBe(true);
  });

  it("8. an element-access index that PERFORMS an update is a write", () => {
    expect(writesAlias("REGISTRY[alias++] = 1;")).toBe(true);
    expect(writesAlias("REGISTRY[++alias] = 1;")).toBe(true);
  });

  it("12. a default initializer's bare reference is a READ", () => {
    // Both destructuring default spellings: shorthand and renamed.
    expect(writesAlias("({ seen = keyFor(alias) } = REGISTRY);")).toBe(false);
    expect(writesAlias("({ x: seen = keyFor(alias) } = REGISTRY);")).toBe(
      false,
    );
    expect(writesAlias("[seen = keyFor(alias)] = VALUES;")).toBe(false);
  });

  it("13. a default initializer that PERFORMS an assignment is a write", () => {
    expect(writesAlias("({ seen = (alias = other) } = REGISTRY);")).toBe(true);
    expect(writesAlias("({ x: seen = (alias = other) } = REGISTRY);")).toBe(
      true,
    );
    expect(writesAlias("[seen = (alias = other)] = VALUES;")).toBe(true);
  });

  it("14. a nested assignment chain records every actual write and nothing else", () => {
    const statement = "REGISTRY[(tmp = (alias = other))] = 1;";
    expect(writesAlias(statement)).toBe(true);
    expect(writes(statement, "tmp")).toBe(true);
    // `other` is only ever READ, at the bottom of the same chain.
    expect(writes(statement, "other")).toBe(false);
  });

  it("15. a harmless receiver expression is a READ", () => {
    expect(writesAlias("getHolder(alias).x = 1;")).toBe(false);
    expect(writesAlias("getHolder(alias)[keyFor(alias)] = 1;")).toBe(false);
    // ...but a receiver that PERFORMS a write still counts.
    expect(writesAlias("getHolder((alias = other)).x = 1;")).toBe(true);
  });

  it("16. a compound assignment nested in an evaluated position is a write", () => {
    expect(writesAlias("REGISTRY[(alias += 1)] = 1;")).toBe(true);
    expect(writesAlias("REGISTRY[(alias -= 1)] = 1;")).toBe(true);
    expect(writesAlias("REGISTRY[(alias *= 2)] = 1;")).toBe(true);
    expect(writesAlias("({ [(alias += 1)]: seen } = REGISTRY);")).toBe(true);
  });

  it("17. a logical assignment nested in an evaluated position is a write", () => {
    expect(writesAlias("REGISTRY[(alias ||= other)] = 1;")).toBe(true);
    expect(writesAlias("REGISTRY[(alias &&= other)] = 1;")).toBe(true);
    expect(writesAlias("REGISTRY[(alias ??= other)] = 1;")).toBe(true);
  });

  it("a plain call in an evaluated position is not a write, however it is spelled", () => {
    // An arbitrary call may have arbitrary side effects; only an explicit
    // assignment or update in the AST is a write this model may claim.
    expect(writesAlias("REGISTRY[mutate()] = 1;")).toBe(false);
    expect(writesAlias("REGISTRY[alias.mutate()] = 1;")).toBe(false);
    expect(writesAlias("REGISTRY[-alias] = 1;")).toBe(false);
    expect(writesAlias("REGISTRY[!alias] = 1;")).toBe(false);
    expect(writesAlias("REGISTRY[typeof alias] = 1;")).toBe(false);
  });
});

describe("RWF-025b: genuine assignment DESTINATIONS are still recorded", () => {
  it("9. a bare destructuring destination is a write", () => {
    expect(writesAlias("({ alias } = source);")).toBe(true);
    expect(writesAlias("[alias] = VALUES;")).toBe(true);
    expect(writesAlias("alias = other;")).toBe(true);
  });

  it("10. a renamed destructuring destination is a write", () => {
    expect(writesAlias("({ x: alias } = source);")).toBe(true);
  });

  it("11. a nested destructuring destination is a write", () => {
    expect(writesAlias("({ a: { b: alias } } = source);")).toBe(true);
    expect(writesAlias("({ a: [alias] } = source);")).toBe(true);
    expect(writesAlias("[[alias]] = VALUES;")).toBe(true);
    expect(writesAlias("[, alias] = VALUES;")).toBe(true);
  });

  it("rest and defaulted destinations are writes", () => {
    expect(writesAlias("({ ...alias } = source);")).toBe(true);
    expect(writesAlias("[...alias] = VALUES;")).toBe(true);
    expect(writesAlias("({ alias = fallback } = source);")).toBe(true);
    expect(writesAlias("({ x: alias = fallback } = source);")).toBe(true);
    expect(writesAlias("[alias = fallback] = VALUES;")).toBe(true);
  });

  it("a parenthesised or type-wrapped destination is still a write", () => {
    expect(writesAlias("({ x: (alias) } = source);")).toBe(true);
    expect(writesAlias("(alias) = other;")).toBe(true);
  });

  it("update and compound operators at the top level are writes", () => {
    expect(writesAlias("alias++;")).toBe(true);
    expect(writesAlias("++alias;")).toBe(true);
    expect(writesAlias("alias += 1;")).toBe(true);
    expect(writesAlias("alias ??= other;")).toBe(true);
  });

  it("a for..in / for..of loop variable with no declaration list is a write", () => {
    expect(writesAlias("for (alias of VALUES) {}")).toBe(true);
    expect(writesAlias("for (alias in REGISTRY) {}")).toBe(true);
    // ...and the ITERATED expression is not a destination.
    expect(writesAlias("for (seen of keyFor(alias)) {}")).toBe(false);
  });

  it("the destination wins even when the same name is also read in the key", () => {
    // `({ [keyFor(alias)]: alias } = source)`: the KEY reads it, the VALUE
    // position rebinds it. The roles are distinguished, not suppressed.
    expect(writesAlias("({ [keyFor(alias)]: alias } = source);")).toBe(true);
  });

  it("property MUTATION remains excluded — it changes the object, not the binding", () => {
    expect(writesAlias("alias.x = 1;")).toBe(false);
    expect(writesAlias("alias[key] = 1;")).toBe(false);
    expect(writesAlias("alias.x.y = 1;")).toBe(false);
  });

  it("a write inside a function body is still a whole-file write", () => {
    // `CommonJsFacts` is deliberately whole-file and reach-blind; this is
    // the axis on which it differs from RWF-025's module-reachable model,
    // and the difference is preserved.
    expect(writesAlias("function later() { alias = other; }")).toBe(true);
    expect(writesAlias("REGISTRY[(() => { alias = other; })()] = 1;")).toBe(
      true,
    );
    // ...but a mere READ inside one is still not a write.
    expect(writesAlias("function later() { use(alias); }")).toBe(false);
  });
});

describe("RWF-025b: scope and shadowing", () => {
  it("inherits this model's documented by-NAME, whole-file granularity", () => {
    // `CommonJsFacts` keys reassignment by identifier TEXT, not by resolved
    // symbol, and RWF-025b deliberately does not widen or narrow that: a
    // write to a same-named INNER binding still marks the outer name.
    // That is conservative in the safe direction — it only ever REFUSES
    // attribution, never manufactures it — and is recorded as a remaining
    // limitation in tests/validation/FINDINGS.md.
    expect(writesAlias("function later(alias) { alias = other; }")).toBe(true);

    // The refusal above is over-determined, and deliberately so: a shadow
    // is also a SECOND DECLARATION of the name, which `classifyLocalBinding`
    // refuses on its own (`declarationCounts`), reassignment or not. That
    // pre-existing guard is untouched by RWF-025b.
    expect(writesAlias("function later(alias) { use(alias); }")).toBe(true);

    // What RWF-025b changes is orthogonal to scope, and is visible wherever
    // no shadow confounds it: a bare reference in an evaluated position is
    // not a write, at any nesting depth.
    expect(
      writesAlias("function later(p) { REGISTRY[keyFor(alias)] = p; }"),
    ).toBe(false);
    expect(
      writesAlias("function later(p) { ({ [keyFor(alias)]: p.seen } = R); }"),
    ).toBe(false);
  });
});

describe("RWF-025b: downstream CommonJS re-export attribution", () => {
  function originOf(source: string, exportedName: string) {
    const index = indexSourceFile(`/virtual/rwf025b-x${counter++}.js`, source);
    return buildModuleModel(index).exports.find(
      (exp) => exp.exportedName === exportedName,
    )?.commonJsReExport;
  }

  const EXPECTED = { specifier: "./lib", importedName: "vulnerable" };

  it("18. an unrelated computed-key statement no longer withdraws a real re-export origin", () => {
    const clean = `let alias = require("./lib").vulnerable;\nexports.vulnerable = alias;`;
    const poisoned = `let alias = require("./lib").vulnerable;\nlet seen;\n({ [keyFor(alias)]: seen } = REGISTRY);\nexports.vulnerable = alias;`;
    const indexed = `let alias = require("./lib").vulnerable;\nREGISTRY[keyFor(alias)] = 1;\nexports.vulnerable = alias;`;

    expect(originOf(clean, "vulnerable")).toEqual(EXPECTED);
    // Both of these used to be `undefined` — the attribution loss itself.
    expect(originOf(poisoned, "vulnerable")).toEqual(EXPECTED);
    expect(originOf(indexed, "vulnerable")).toEqual(EXPECTED);
  });

  it("a GENUINE reassignment still withdraws it — the RWF-013b guarantee", () => {
    const rebound = `let alias = require("./lib").vulnerable;\nREGISTRY[(alias = other)] = 1;\nexports.vulnerable = alias;`;
    const plainly = `let alias = require("./lib").vulnerable;\nalias = other;\nexports.vulnerable = alias;`;

    expect(originOf(rebound, "vulnerable")).toBeUndefined();
    expect(originOf(plainly, "vulnerable")).toBeUndefined();
  });

  it("19. twin comparison: the same source yields the same verdict from RWF-025's relation", () => {
    // RWF-025 (module-model.ts) and RWF-025b (this file) answer the same
    // WHAT-does-this-target-rebind question for two different relations.
    // The shapes below are the ones both must agree on; module-model's own
    // matrix asserts its side, and this row asserts they do not diverge on
    // the observable they share — export attribution.
    const readOnly = `function vulnerable() {}\nlet seen;\n({ [keyFor(vulnerable)]: seen } = REGISTRY);\nmodule.exports = { vulnerable };`;
    const written = `let vulnerable = require("./lib").vulnerable;\nREGISTRY[(vulnerable = other)] = 1;\nexports.vulnerable = vulnerable;`;

    const readOnlyIndex = indexSourceFile(
      `/virtual/rwf025b-twin-a.js`,
      readOnly,
    );
    expect(classifyLocalBinding(readOnlyIndex, "vulnerable").kind).not.toBe(
      "refused",
    );
    expect(
      buildModuleModel(readOnlyIndex).exports.find(
        (exp) => exp.exportedName === "vulnerable",
      ),
    ).toBeDefined();

    const writtenIndex = indexSourceFile(`/virtual/rwf025b-twin-b.js`, written);
    expect(classifyLocalBinding(writtenIndex, "vulnerable").kind).toBe(
      "refused",
    );
  });
});
