const fixture = require("fixture-lib");
const runNested = require("nested-consumer");

// The application calls the explicit alias. At runtime `parseSync` and
// `parse` are the SAME function object -- both are `registry.impl`, i.e.
// lib/parse.js's function -- so this call reaches exactly the symbol a rule
// targeting `parse` names, through the one name that is statically
// resolvable.
//
// It also drives the SECOND installed fixture-lib instance, whose own
// `parse` export is attributable and genuinely reachable. The top-level
// instance's `parse` must not borrow it.
module.exports = function main(input) {
  return [fixture.parseSync(input), runNested(input)];
};
