// THE FALSE-INCOMPLETENESS CONTROL for `unresolved_export_forwarding`.
//
// These mention the export object WITHOUT putting it in a call's
// mutation-target (first-argument) position, so they publish nothing and
// must not make this entrypoint incomplete. A blanket "mentions
// module.exports anywhere" test would mark it incomplete and destroy a
// valid Family C proof.
//
// Deliberately NOT covered: a pure READ that does sit in first-argument
// position, e.g. `JSON.stringify(module.exports)`. The detector accepts
// that imprecision on purpose -- it cannot tell a reading callee from a
// mutating one, and the costs are asymmetric: over-reporting costs a
// NOT_AFFECTED that becomes UNKNOWN, while under-reporting costs a false
// NOT_AFFECTED. See `exportForwardingCalls`.
const dep = require("fixture-lib");

function run(userInput) {
  return dep.dangerousOp(userInput);
}

module.exports = { run };

// Mentions, never mutation targets.
console.log("exports are", module.exports);
const copy = { ...module.exports };
void copy;
