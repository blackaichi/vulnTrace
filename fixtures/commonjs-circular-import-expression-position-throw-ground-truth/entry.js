"use strict";
let aLoadError;
let aExports;
try {
  aExports = require("./a");
} catch (err) {
  aLoadError = err;
}

console.log("\n=== after require('./a') ===");
console.log(
  "a.js load threw:",
  aLoadError ? aLoadError.message : "(did not throw)",
);
console.log("a.js's own export (safeOp) observed by entry.js:", aExports);

const b = require("./b");
console.log("\n=== cyclic observer b.js ===");
console.log("b.js retained the DANGEROUS export:", b.retained.name);

const result = b.retained("payload-from-entrypoint");
console.log("\n=== calling the retained dangerous export ===");
console.log("vulnerable sink executed, result:", result);

console.log("\n=== conditional / deferred control ===");
// The NEGATIVE control, run in the same process: the identical
// always-throwing helper in a logical RIGHT operand, an arrow body and a
// default parameter. None runs during module evaluation, so c.js completes
// and its LATER (safe) export really is the value it publishes.
const c = require("./c");
console.log(
  "c.js exported:",
  c.name,
  "(safeOp -- no conditional/deferred position called bail())",
);
console.log(
  "c.js's callback throws only when called:",
  (() => {
    try {
      c.runCallback();
      return "(did not throw -- UNEXPECTED)";
    } catch (err) {
      return err.message;
    }
  })(),
);
console.log(
  "c.js's default parameter throws only when the argument is omitted:",
  (() => {
    try {
      c.runDefault();
      return "(did not throw -- UNEXPECTED)";
    } catch (err) {
      return err.message;
    }
  })(),
);

console.log("\n=== every expression position, measured ===");
const positions = require("./positions");
positions.report();

console.log("\n=== evaluation order, measured ===");
positions.reportOrder();

console.log("\n=== re-requiring ./a after its throw ===");
try {
  require("./a");
  console.log("require('./a') succeeded (UNEXPECTED)");
} catch (err) {
  console.log("require('./a') re-threw deterministically:", err.message);
  console.log(
    "-> safeOp is NEVER the module's exported value on this code path.",
  );
}
