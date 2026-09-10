"use strict";
// Every expression POSITION RWF-026 models, plus every position it
// deliberately refuses, each evaluated in isolation under real Node, so
// the required/conditional split is a measurement rather than an
// assertion.
//
// A position is REQUIRED when the enclosing expression cannot complete
// normally without evaluating it. Required positions throw below;
// conditional and deferred ones complete.

function bail() {
  throw new Error("bail");
}

function safe() {
  return 1;
}

function safeKey() {
  return "k";
}

function sink(a, b, c) {
  return [a, b, c];
}

function tag() {
  return "tagged";
}

function Holder(a) {
  this.a = a;
}

const obj = { x: 1, k: 2 };
const flag = 0;
const truthy = 1;
const value = 1;
let z = 1;

// ---------------------------------------------------------------------
// REQUIRED positions: every one of these MUST throw.
// ---------------------------------------------------------------------
const required = [
  // A1 -- object / array / value positions
  ["A1 object property VALUE            { value: bail() }", () => ({ value: bail() })],
  ["A1 computed KEY                     { [bail()]: 1 }", () => ({ [bail()]: 1 })],
  ["A1 safe KEY + abrupt VALUE          { [safeKey()]: bail() }", () => ({ [safeKey()]: bail() })],
  ["A1 NESTED object value              { a: { b: bail() } }", () => ({ a: { b: bail() } })],
  ["A1 array element                    [bail()]", () => [bail()]],
  ["A1 array MIDDLE element             [safe(), bail(), safe()]", () => [safe(), bail(), safe()]],
  ["A1 array after a HOLE               [ , bail() ]", () => [, bail()]],
  ["A1 object spread operand            { ...bail() }", () => ({ ...bail() })],

  // A2 -- call / template / spread / access positions
  ["A2 call ARGUMENT                    sink(bail())", () => sink(bail())],
  ["A2 MULTI argument                   sink(safe(), bail(), safe())", () => sink(safe(), bail(), safe())],
  ["A2 new ARGUMENT                     new Holder(bail())", () => new Holder(bail())],
  ["A2 template substitution            `${bail()}`", () => `${bail()}`],
  ["A2 tagged template substitution     tag`${bail()}`", () => tag`${bail()}`],
  ["A2 property access RECEIVER         bail().x", () => bail().x],
  ["A2 element access INDEX             obj[bail()]", () => obj[bail()]],
  ["A2 element access RECEIVER          bail()[safeKey()]", () => bail()[safeKey()]],
  ["A2 array spread operand             [...bail()]", () => [...bail()]],
  ["A2 call spread operand              sink(...bail())", () => sink(...bail())],
  ["A2 optional chain RECEIVER          bail()?.x", () => bail()?.x],
  ["A2 optional CALL                    bail?.()", () => bail?.()],

  // A3 -- operator / assignment positions
  ["A3 sequence LEFT                    (bail(), value)", () => (bail(), value)],
  ["A3 sequence MIDDLE                  (safe(), bail(), value)", () => (safe(), bail(), value)],
  ["A3 logical || LEFT                  bail() || value", () => bail() || value],
  ["A3 logical && LEFT                  bail() && value", () => bail() && value],
  ["A3 logical ?? LEFT                  bail() ?? value", () => bail() ?? value],
  ["A3 binary LEFT                      bail() + 1", () => bail() + 1],
  ["A3 binary RIGHT                     safe() + bail()", () => safe() + bail()],
  ["A3 comparison RIGHT                 safe() === bail()", () => safe() === bail()],
  ["A3 assignment RHS                   z = bail()", () => (z = bail())],
  ["A3 compound assignment RHS          z += bail()", () => (z += bail())],
  ["A3 assignment target INDEX          obj[bail()] = value", () => (obj[bail()] = value)],
  ["A3 assignment target RECEIVER       bail().x = value", () => (bail().x = value)],
  ["A3 unary operand                    !bail()", () => !bail()],
  ["A3 typeof operand                   typeof bail()", () => typeof bail()],
  ["W  parenthesized                    ((bail()))", () => ((bail()))],

  // A4 -- statement headers
  ["A4 if CONDITION                     if (bail())", () => { if (bail()) { /* unreachable */ } }],
  ["A4 switch DISCRIMINANT              switch (bail())", () => { switch (bail()) { default: } }],
  ["A4 for INITIALIZER (declaration)    for (let i = bail();;)", () => { for (let i = bail(); ; ) { break; } }],
  ["A4 for INITIALIZER (expression)     for (bail();;)", () => { for (bail(); ; ) { break; } }],
  ["A4 for TEST                         for (; bail();)", () => { for (; bail(); ) { break; } }],
  ["A4 for-of RHS                       for (const q of bail())", () => { for (const q of bail()) { void q; } }],
  ["A4 for-in RHS                       for (const q in bail())", () => { for (const q in bail()) { void q; } }],
  ["A4 while CONDITION                  while (bail())", () => { while (bail()) { break; } }],

  // Class-definition-time positions (RWF-018/019/020, reached through the
  // same expression relation once the call is NESTED in the initializer).
  ["S  static field initializer         class { static f = sink(bail()) }", () => class { static f = sink(bail()); }],
  ["S  static block                     class { static { sink(bail()) } }", () => class { static { sink(bail()); } }],
];

// ---------------------------------------------------------------------
// CONDITIONAL / DEFERRED positions: every one of these MUST complete.
// ---------------------------------------------------------------------
const refused = [
  ["logical && RIGHT                    flag && bail()", () => flag && bail()],
  ["logical || RIGHT                    truthy || bail()", () => truthy || bail()],
  ["logical ?? RIGHT                    value ?? bail()", () => value ?? bail()],
  ["conditional TRUE arm                flag ? bail() : safe()", () => (flag ? bail() : safe())],
  ["conditional FALSE arm               truthy ? safe() : bail()", () => (truthy ? safe() : bail())],
  ["logical assignment ||=              z ||= bail()", () => { let y = 1; y ||= bail(); return y; }],
  ["logical assignment &&=              z &&= bail()", () => { let y = 0; y &&= bail(); return y; }],
  ["logical assignment ??=              z ??= bail()", () => { let y = 1; y ??= bail(); return y; }],
  ["for UPDATE (body breaks first)      for (;; bail())", () => { for (;;bail()) { break; } }],
  ["do/while CONDITION (body breaks)    do { break } while (bail())", () => { do { break; } while (bail()); }],
  ["function BODY                       function f() { bail() }", () => { function f() { bail(); } return f; }],
  ["arrow BODY                          () => bail()", () => () => bail()],
  ["callback BODY                       () => sink(bail())", () => () => sink(bail())],
  ["method BODY                         ({ m() { bail() } })", () => ({ m() { bail(); } })],
  ["class INSTANCE field                class { f = bail() }", () => class { f = bail(); }],
  ["default PARAMETER                   function f(x = bail()) {}", () => { function f(x = bail()) { return x; } return f; }],
  ["returned object in uncalled fn      function f() { return { x: bail() } }", () => { function f() { return { x: bail() }; } return f; }],
  ["optional-chain guarded ARGUMENT     undefined?.m(bail())", () => undefined?.m(bail())],
  ["optional-chain guarded INDEX        undefined?.[bail()]", () => undefined?.[bail()]],
  ["caught in try/catch                 try { sink(bail()) } catch {}", () => { try { sink(bail()); } catch { /* handled */ } }],
];

function report() {
  console.log("  REQUIRED positions -- every one must THROW:");
  let requiredOk = true;
  for (const [label, run] of required) {
    let outcome;
    try {
      run();
      outcome = "completed  <-- UNEXPECTED";
      requiredOk = false;
    } catch (err) {
      outcome = "THREW: " + err.message;
    }
    console.log("    " + label.padEnd(52) + " -> " + outcome);
  }

  console.log("\n  CONDITIONAL / DEFERRED positions -- every one must COMPLETE:");
  let refusedOk = true;
  for (const [label, run] of refused) {
    let outcome;
    try {
      run();
      outcome = "completed";
    } catch (err) {
      outcome = "THREW: " + err.message + "  <-- UNEXPECTED";
      refusedOk = false;
    }
    console.log("    " + label.padEnd(52) + " -> " + outcome);
  }

  console.log(
    "\n  summary: required-all-threw=" +
      requiredOk +
      "  refused-all-completed=" +
      refusedOk,
  );
}

// Source ORDER, measured. The analyzer never needs this to be sound -- an
// abrupt REQUIRED operand anywhere means the enclosing expression cannot
// complete normally regardless of order -- but pinning it keeps the
// documented reading of each form honest.
function reportOrder() {
  function trace(label, run) {
    const seen = [];
    const ev = (name, fn) => {
      seen.push(name);
      return fn ? fn() : name;
    };
    try {
      run(ev);
    } catch {
      // expected
    }
    console.log("    " + label.padEnd(52) + " -> " + seen.join(", "));
  }

  trace("call arguments, left to right", (ev) =>
    sink(ev("before"), ev("bail", bail), ev("after")),
  );
  trace("object literal, key then value, in source order", (ev) => ({
    [ev("key1")]: ev("value1"),
    [ev("key2")]: ev("bail", bail),
    [ev("key3")]: ev("value3"),
  }));
  trace("array elements, left to right", (ev) => [
    ev("elem1"),
    ev("bail", bail),
    ev("elem2"),
  ]);
  trace("template substitutions, left to right", (ev) =>
    `${ev("sub1")}-${ev("bail", bail)}-${ev("sub2")}`,
  );
  trace("tagged template: tag, then substitutions", (ev) => {
    const t = ev("tag-expr", () => tag);
    return t`${ev("sub1")}${ev("bail", bail)}`;
  });
  trace("member receiver before property access", (ev) => ev("bail", bail).x);
  trace("element access: receiver, then index", (ev) => {
    const r = ev("receiver", () => obj);
    return r[ev("bail", bail)];
  });
  trace("sequence, left to right", (ev) => (ev("left"), ev("bail", bail), ev("right")));
  trace("logical LEFT is always evaluated", (ev) => ev("bail", bail) || ev("right"));
  trace("assignment: target reference, then RHS", (ev) => {
    const target = ev("target-obj", () => obj);
    target[ev("target-key", () => "k")] = ev("bail", bail);
  });
  trace("if: condition before either arm", (ev) => {
    if (ev("bail", bail)) {
      ev("then-arm");
    } else {
      ev("else-arm");
    }
  });
  trace("for: initializer, then test, never the body", (ev) => {
    for (let i = ev("init"); ev("bail", bail); ev("update")) {
      ev("body");
    }
  });
  trace("for-of: RHS before any iteration", (ev) => {
    for (const q of ev("bail", bail)) {
      ev("body");
      void q;
    }
  });
}

module.exports = { report, reportOrder };
