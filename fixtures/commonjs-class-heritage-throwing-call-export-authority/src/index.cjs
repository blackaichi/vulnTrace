const fixture = require("fixture-lib");

// Required so its file and package instance are genuinely discovered by
// the call graph, and never called -- the Family C positive control.
require("fixture-lib/stable");

// The class-EXPRESSION twin of `fixture-lib`'s own defect, discovered from
// the same entrypoint because it is expected to be exactly as ambiguous.
require("fixture-lib/class-expression");

// Required so the harmless-heritage control module is discovered too. Its
// later export must REMAIN authoritative: a heritage call that returns
// normally, `extends null`, and a class defined inside an uncalled
// function all leave module evaluation running.
require("fixture-lib/harmless-heritage");

module.exports = function main(input) {
  return fixture(input);
};
