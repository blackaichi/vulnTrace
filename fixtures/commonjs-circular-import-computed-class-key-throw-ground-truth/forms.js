"use strict";
// Every class-element form carrying the SAME computed key, each evaluated
// in isolation, so the claim "a computed key is class-definition time
// whatever the element is" is a measurement rather than an assertion.
//
// The last four are the controls: the same call in the positions the
// language genuinely defers.

function bail() {
  throw new Error("bail");
}

const forms = [
  ["static [bail()] = 1", () => class { static [bail()] = 1; }],
  ["[bail()] = 1", () => class { [bail()] = 1; }],
  ["[bail()]() {}", () => class { [bail()]() {} }],
  ["static [bail()]() {}", () => class { static [bail()]() {} }],
  ["get [bail()]() {}", () => class { get [bail()]() {} }],
  ["set [bail()](v) {}", () => class { set [bail()](v) {} }],
  ["async [bail()]() {}", () => class { async [bail()]() {} }],
  ["*[bail()]() {}", () => class { *[bail()]() {} }],
  ["[(bail())] = 1  (parenthesized)", () => class { [(bail())] = 1; }],
  ["[bail?.()] = 1  (optional call)", () => class { [bail?.()] = 1; }],
  [
    "class declaration, not expression",
    () => {
      class C {
        [bail()] = 1;
      }
      return C;
    },
  ],
  ["CONTROL  x = bail()      (instance field VALUE)", () => class { x = bail(); }],
  ["CONTROL  m() { bail(); } (method BODY)", () => class { m() { bail(); } }],
  ["CONTROL  get x() { bail(); }", () => class { get x() { bail(); } }],
  [
    "CONTROL  class in an uncalled function",
    () => {
      function configure() {
        return class {
          [bail()] = 1;
        };
      }
      return configure;
    },
  ],
  [
    "CONTROL  nested class inside an instance field",
    () =>
      class {
        field = class {
          [bail()] = 1;
        };
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
      outcome = "THREW at definition time: " + err.message;
    }
    console.log("  " + label.padEnd(46) + " -> " + outcome);
  }
}

// Computed keys evaluate in DECLARATION ORDER, and an abrupt one stops the
// keys after it -- no intra-class control flow needed to see it.
function reportOrder() {
  const seen = [];
  const safe = () => {
    seen.push("safe");
    return "a";
  };
  const later = () => {
    seen.push("later");
    return "c";
  };
  const boom = () => {
    seen.push("bail");
    throw new Error("bail");
  };
  try {
    class C {
      [safe()] = 1;
      [boom()] = 2;
      [later()] = 3;
    }
  } catch {
    // expected
  }
  console.log("  keys actually evaluated, in order: " + seen.join(", "));
}

module.exports = { report, reportOrder };
