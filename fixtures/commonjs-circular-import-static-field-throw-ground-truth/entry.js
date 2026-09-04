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

console.log("\n=== instance-field control ===");
// The NEGATIVE control, run in the same process: an INSTANCE field
// initializer calling the same always-throwing helper does NOT execute
// when the class definition is evaluated. c.js therefore completes, and
// its LATER (safe) export really is the value it publishes.
const c = require("./c");
console.log("c.js exported:", c.name, "(safeOp -- the class did not throw)");
console.log(
  "c.js's instance field throws only on construction:",
  (() => {
    try {
      c.construct();
      return "(did not throw -- UNEXPECTED)";
    } catch (err) {
      return err.message;
    }
  })(),
);

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
