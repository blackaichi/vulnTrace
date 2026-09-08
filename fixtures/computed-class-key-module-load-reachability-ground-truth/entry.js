"use strict";

// RWF-023 runtime ground truth. Run with `node entry.js`.
//
// This is a plain Node.js program, not a VulnTrace fixture -- it is never
// scanned. Its whole job is to settle, in a real engine, which of the
// shapes RWF-023 touches actually execute during module evaluation, so
// that the analyzer's expectations are measured against the language
// rather than against a reading of the specification.
//
// Everything below is ASSERTED, not printed. A wrong answer fails the
// process; the table at the end is a record of a run that already passed.

const assert = require("node:assert/strict");
const path = require("node:path");
const danger = require("./danger");

const results = {};

function probe(name, fn) {
  danger.reset();
  let threw = null;
  try {
    fn();
  } catch (error) {
    threw = error.constructor.name;
  }
  results[name] = { sinks: danger.calls(), threw };
}

function key(tag) {
  return () => {
    danger.explode(tag);
    return "k" + tag;
  };
}

// ---------------------------------------------------------------------
// Group 1 -- the eight computed-key ELEMENT FORMS.
// Every one of these is evaluated by ClassDefinitionEvaluation.
// ---------------------------------------------------------------------
probe("instance field key", () => { const k = key("f1"); class C { [k()] = 1; } });
probe("static field key", () => { const k = key("f2"); class C { static [k()] = 1; } });
probe("instance method key", () => { const k = key("f3"); class C { [k()]() {} } });
probe("static method key", () => { const k = key("f4"); class C { static [k()]() {} } });
probe("getter key", () => { const k = key("f5"); class C { get [k()]() { return 1; } } });
probe("setter key", () => { const k = key("f6"); class C { set [k()](v) {} } });
probe("async method key", () => { const k = key("f7"); class C { async [k()]() {} } });
probe("generator method key", () => { const k = key("f8"); class C { *[k()]() {} } });

// ---------------------------------------------------------------------
// Group 2 -- key EXPRESSION shapes and class POSITIONS.
// ---------------------------------------------------------------------
probe("class expression", () => { const k = key("e1"); const C = class { [k()]() {} }; });
probe("parenthesized key", () => { const k = key("e2"); class C { [(k())]() {} } });
probe("nested call key", () => { const k = key("e3"); class C { [String(k())]() {} } });
probe("sequence key", () => { const k = key("e4"); class C { [(k(), "x")]() {} } });
probe("template key", () => { const k = key("e5"); class C { [`x${k()}`]() {} } });
probe("logical-or key", () => { const k = key("e6"); class C { [k() || "x"]() {} } });
probe("conditional key (taken)", () => { const k = key("e7"); class C { [true ? k() : "x"]() {} } });
probe("conditional top-level class", () => { const k = key("e8"); if (true) { class C { [k()]() {} } } });
probe("object-literal nested class", () => { const k = key("e9"); const o = { C: class { [k()]() {} } }; });
probe("object-literal method key", () => { const k = key("e10"); const o = { [k()]() {} }; });

// ---------------------------------------------------------------------
// Group 3 -- heritage interaction.
// ---------------------------------------------------------------------
probe("valid heritage + key", () => {
  const k = key("h1");
  class Base {}
  class C extends Base { [k()]() {} }
});
probe("invalid heritage + key", () => {
  const k = key("h2");
  const makeInvalid = () => 1;
  class C extends makeInvalid() { [k()]() {} }
});

// ---------------------------------------------------------------------
// Group 4 -- class-definition-time hosts for a NESTED class.
// A static field initializer and a static block both run during class
// definition, so the class each holds really is defined at module load.
// ---------------------------------------------------------------------
probe("nested class in STATIC field", () => {
  const k = key("d1");
  class Outer { static inner = class Inner { [k()]() {} }; }
});
probe("nested class in STATIC block", () => {
  const k = key("d2");
  class Outer { static { class Inner { [k()]() {} } this.inner = Inner; } }
});

// ---------------------------------------------------------------------
// Group 5 -- the DEFERRED negative controls. None of these run.
// ---------------------------------------------------------------------
probe("class in uncalled function", () => { const k = key("n1"); function c() { class C { [k()]() {} } return C; } });
probe("class in uncalled arrow", () => { const k = key("n2"); const c = () => { class C { [k()]() {} } return C; }; });
probe("class in uninvoked callback", () => { const k = key("n3"); function never(cb) { return typeof cb; } never(function () { class C { [k()]() {} } }); });
probe("class in method body", () => { const k = key("n4"); class O { m() { class C { [k()]() {} } return C; } } });
probe("class in getter body", () => { const k = key("n5"); class O { get g() { class C { [k()]() {} } return C; } } });
probe("class in constructor body", () => { const k = key("n6"); class O { constructor() { class C { [k()]() {} } this.c = C; } } });
probe("nested class in INSTANCE field", () => { const k = key("n7"); class O { field = class Inner { [k()]() {} }; } });
probe("object literal in INSTANCE field", () => { const k = key("n8"); class O { literal = { [k()]() {} }; } });
probe("class in method param default", () => { const k = key("n9"); class O { m(x = class P { [k()]() {} }) { return x; } } });
probe("class in setter param default", () => { const k = key("n10"); class O { set s(v = class P { [k()]() {} }) { this.v = v; } } });
probe("method body danger call", () => { class O { m() { danger.explode("n11"); } } });
probe("instance field VALUE danger call", () => { class O { field = danger.explode("n12"); } });
probe("getter body danger call", () => { class O { get g() { return danger.explode("n13"); } } });

// ---------------------------------------------------------------------
// ASSERTIONS
// ---------------------------------------------------------------------
const MUST_RUN = [
  "instance field key", "static field key", "instance method key",
  "static method key", "getter key", "setter key", "async method key",
  "generator method key", "class expression", "parenthesized key",
  "nested call key", "sequence key", "template key", "logical-or key",
  "conditional key (taken)", "conditional top-level class",
  "object-literal nested class", "object-literal method key",
  "valid heritage + key", "invalid heritage + key",
  "nested class in STATIC field", "nested class in STATIC block",
];

const MUST_NOT_RUN = [
  "class in uncalled function", "class in uncalled arrow",
  "class in uninvoked callback", "class in method body",
  "class in getter body", "class in constructor body",
  "nested class in INSTANCE field", "object literal in INSTANCE field",
  "class in method param default", "class in setter param default",
  "method body danger call", "instance field VALUE danger call",
  "getter body danger call",
];

for (const name of MUST_RUN) {
  assert.equal(
    results[name].sinks.length,
    1,
    `"${name}": the sink MUST execute at definition time, saw ${JSON.stringify(results[name].sinks)}`,
  );
}

for (const name of MUST_NOT_RUN) {
  assert.deepEqual(
    results[name].sinks,
    [],
    `"${name}": the sink MUST NOT execute at module load, saw ${JSON.stringify(results[name].sinks)}`,
  );
}

// The RWF-022 interaction the audit turned up: with an INVALID heritage
// VALUE the computed key has ALREADY RUN by the time the class definition
// throws. The target must not be lost because a later cutoff fires.
assert.equal(
  results["invalid heritage + key"].threw,
  "TypeError",
  "an invalid heritage value must ultimately throw a TypeError",
);
assert.deepEqual(
  results["invalid heritage + key"].sinks,
  ["h2"],
  "the computed key must run BEFORE the invalid-heritage TypeError",
);

// And the valid-heritage case must NOT throw at all.
assert.equal(results["valid heritage + key"].threw, null);

// Evaluation ORDER, measured rather than assumed: heritage first, then
// computed keys in declaration order, then static blocks in their turn.
{
  danger.reset();
  const heritage = () => { danger.explode("heritage"); return class {}; };
  const first = () => { danger.explode("key1"); return "a"; };
  const second = () => { danger.explode("key2"); return "b"; };
  class Ordered extends heritage() {
    [first()]() {}
    static [second()] = 1;
    static { danger.explode("staticblock"); }
  }
  assert.deepEqual(
    danger.calls(),
    ["heritage", "key1", "key2", "staticblock"],
    "heritage -> computed keys in declaration order -> static block",
  );
}

// The KEY runs; the method BODY does not -- not at definition time, not on
// construction, only when the method is actually called.
{
  danger.reset();
  class WithBody {
    [(danger.explode("KEY"), "x")]() {
      danger.explode("BODY");
    }
  }
  assert.deepEqual(danger.calls(), ["KEY"], "the key runs, the body does not");
  const instance = new WithBody();
  assert.deepEqual(danger.calls(), ["KEY"], "constructing does not run the body");
  instance.x();
  assert.deepEqual(danger.calls(), ["KEY", "BODY"], "the body runs only on call");
}

// End to end, as a real CommonJS module load: `require()` alone reaches the
// sink, the module completes, and the key's return value really is the
// installed property name.
{
  danger.reset();
  const C = require("./subject");
  assert.deepEqual(
    danger.calls(),
    ["from-computed-key"],
    "requiring the module must reach the sink through the computed key",
  );
  assert.equal(typeof C, "function", "module evaluation must complete");
  assert.ok(
    Object.getOwnPropertyNames(C.prototype).includes("x"),
    "the key's return value must be installed as the property name",
  );
}

console.log(`node ${process.version} -- ${path.basename(__dirname)}`);
console.log("");
for (const [name, result] of Object.entries(results)) {
  const ran = result.sinks.length > 0 ? "SINK RAN " : "         ";
  console.log(`  ${ran} ${name.padEnd(36)} ${result.threw ?? ""}`);
}
console.log("");
console.log("ALL RWF-023 RUNTIME GROUND-TRUTH ASSERTIONS PASSED");
