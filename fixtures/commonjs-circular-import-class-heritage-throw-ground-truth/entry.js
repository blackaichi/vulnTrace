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

console.log("\n=== harmless-heritage / deferred control ===");
// The NEGATIVE control, run in the same process: heritage calls that
// RETURN NORMALLY (`extends baseFactory()`), a heritage that evaluates no
// call at all (`extends null`), and a `class ... extends bail()` defined
// inside an uncalled function. None of them aborts module evaluation, so
// c.js completes and its LATER (safe) export really is the value it
// publishes.
const c = require("./c");
console.log("c.js exported:", c.name, "(safeOp -- no class definition threw)");
console.log("c.js's harmless-heritage class:", c.C.name);
console.log(
  "c.js's `extends null` class:",
  c.N.name,
  "-- prototype is",
  Object.getPrototypeOf(c.N.prototype),
);
console.log(
  "c.js's deferred class throws only when configure() runs:",
  (() => {
    try {
      c.configure();
      return "(did not throw -- UNEXPECTED)";
    } catch (err) {
      return err.message;
    }
  })(),
);

console.log("\n=== every heritage form, measured ===");
const forms = require("./forms");
forms.report();

console.log("\n=== heritage evaluates BEFORE any class element ===");
forms.reportOrder();

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
