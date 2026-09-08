"use strict";
// Every object-literal element form carrying the SAME computed key, each
// evaluated in isolation, so the claim "a computed key is object-
// construction time whatever the element is" is a measurement rather than
// an assertion.
//
// The last few are the controls: the identical call in positions the
// language genuinely defers (a method body, a never-called function), and
// -- distinctly, and NOT a control for "safe" -- the same call written as
// an ORDINARY property's VALUE, which this rule does not claim and which
// still throws, because unlike a class's instance field an object literal
// has no per-instance deferral at all.

function bail() {
  throw new Error("bail");
}

const forms = [
  ["{ [bail()]: 1 }  (PropertyAssignment)", () => ({ [bail()]: 1 })],
  ["{ [bail()]() {} }  (MethodDeclaration)", () => ({ [bail()]() {} })],
  ["{ get [bail()]() {} }  (GetAccessor)", () => ({ get [bail()]() {} })],
  [
    "{ set [bail()](v) {} }  (SetAccessor)",
    () => ({
      set [bail()](v) {},
    }),
  ],
  [
    "{ async [bail()]() {} }  (async method)",
    () => ({ async [bail()]() {} }),
  ],
  [
    "{ *[bail()]() {} }  (generator method)",
    () => ({ *[bail()]() {} }),
  ],
  ["{ [(bail())]: 1 }  (parenthesized)", () => ({ [(bail())]: 1 })],
  ["{ [bail?.()]: 1 }  (optional call)", () => ({ [bail?.()]: 1 })],
  [
    "CONTROL  { x: bail() }  (ORDINARY VALUE -- NOT deferred, unlike a class instance field)",
    () => ({ x: bail() }),
  ],
  [
    "CONTROL  { m() { bail(); } }  (method BODY -- deferred until called)",
    () => ({ m() { bail(); } }),
  ],
  [
    "CONTROL  { get x() { bail(); } }  (getter BODY -- deferred until read)",
    () => ({ get x() { bail(); } }),
  ],
  [
    "CONTROL  object literal in an uncalled function",
    () => {
      function configure() {
        return { [bail()]: 1 };
      }
      return configure;
    },
  ],
  [
    "CONTROL  object literal nested inside a class INSTANCE field",
    () =>
      class {
        field = { [bail()]: 1 };
      },
  ],
];

function report() {
  for (const [label, define] of forms) {
    let outcome;
    try {
      define();
      outcome = "completed";
    } catch (err) {
      outcome = "THREW at construction time: " + err.message;
    }
    console.log("  " + label.padEnd(72) + " -> " + outcome);
  }
}

// Computed keys evaluate in SOURCE order, and an abrupt one stops the keys
// (and later property VALUES) after it -- no intra-literal control flow
// needed to see it.
function reportOrder() {
  const seen = [];
  const safe = () => {
    seen.push("safe-key");
    return "a";
  };
  const later = () => {
    seen.push("later-key");
    return "c";
  };
  const boom = () => {
    seen.push("bail");
    throw new Error("bail");
  };
  const dangerousValue = () => {
    seen.push("VALUE -- must never run");
    return "danger";
  };
  try {
    const o = {
      [safe()]: 1,
      [boom()]: dangerousValue(),
      [later()]: 3,
    };
    void o;
  } catch {
    // expected
  }
  console.log("  keys/values actually evaluated, in order: " + seen.join(", "));
}

module.exports = { report, reportOrder };
