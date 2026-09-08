const fixture = require("fixture-lib");

// Required so its file and package instance are genuinely discovered by
// the call graph, and never called -- the Family C positive control.
require("fixture-lib/stable");

// The class-EXPRESSION twin of `fixture-lib`'s own defect (returned value
// is an object literal, via a concise arrow body), expected to be exactly
// as ambiguous.
require("fixture-lib/class-expression");

// The CALLEE-IDENTITY twin: an `async` callee whose call returns a Promise.
require("fixture-lib/async-callee");

// Required so the valid-heritage control module is discovered too. Its
// later export must REMAIN authoritative.
require("fixture-lib/valid-heritage");

module.exports = function main(input) {
  return fixture(input);
};
