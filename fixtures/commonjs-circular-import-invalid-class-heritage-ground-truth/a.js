"use strict";
const danger = require("./danger");
const { record } = require("./trace");

function dangerousOp(input) {
  return danger.explode(input);
}

// The RWF-022 factory. It is NOT the RWF-020 shape: it does not throw, it
// has no conditional, and it completes normally every single time. Its only
// relevant property is the CATEGORY of the value it hands back.
function notAConstructor() {
  record("notAConstructor() body entered");
  return 1;
}

function tag(name) {
  record("class element evaluated: " + name);
  return name;
}

// MEASURED, and NOT what the RWF-020 (throwing-call) fixture shows: when the
// heritage call RETURNS and the returned VALUE is what is invalid, V8 has
// already evaluated the class body's computed property KEYS by the time it
// performs the IsConstructor check. Static field initializers and static
// blocks still never run. See README.md -- this asymmetry is a real
// difference between the two families, not an artifact of this fixture.

// Publish the dangerous branch FIRST, while it is still `module.exports`...
record("a.js: publishing dangerousOp as module.exports");
module.exports = dangerousOp;

// ...then pull in a circular dependency: b.js requires US BACK, and Node's
// circular-require semantics hand it whatever module.exports currently
// holds -- the dangerous branch, since we have not reached the final (safe)
// assignment yet.
record("a.js: requiring ./b (circular back-reference to a.js)");
const b = require("./b");

// The RWF-022 shape. `notAConstructor()` is evaluated by
// ClassDefinitionEvaluation before anything else about the class, and it
// RETURNS NORMALLY -- with `1`. The class definition then fails its own
// heritage validation, because 1 is neither `null` nor a constructor, and
// throws `TypeError: Class extends value 1 is not a constructor or null`.
//
// So the module still dies here, but for a reason RWF-020 cannot see: the
// call completed. `C` is never bound and nothing after the class runs --
// which is the ONLY fact the analyzer's cutoff rests on.
record("a.js: evaluating `class C extends notAConstructor() {}`");
class C extends notAConstructor() {
  [tag("computed key -- DOES evaluate, see README")] = 1;
  static x = tag("static field -- never evaluated");
}

// Never reached on this path.
record("a.js: class C evaluated (UNREACHABLE) C=" + String(C));
function safeOp(input) {
  return "safe:" + input;
}
record("a.js: publishing safeOp (UNREACHABLE on this path)");
module.exports = safeOp;
