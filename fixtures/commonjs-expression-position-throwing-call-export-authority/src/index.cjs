const fixture = require("fixture-lib");

// Required so its file and package instance are genuinely discovered by
// the call graph, and never called -- the Family C positive control.
require("fixture-lib/stable");

// The other two required-position twins of `fixture-lib`'s own defect,
// discovered from the same entrypoint because they are expected to be
// exactly as ambiguous: an object literal's property VALUE, and an `if`
// statement's CONDITION.
require("fixture-lib/object-value");
require("fixture-lib/header");

// Required so the CONDITIONAL/DEFERRED control module is discovered too.
// Its later export must REMAIN authoritative: a logical right operand, an
// arrow body, a default parameter and a class instance field are none of
// them evaluated during module evaluation.
require("fixture-lib/conditional");

// The same-name, same-version TWIN install, so package identity has to be
// resolved by install location rather than by name+version.
require("elsewhere");

module.exports = function main(input) {
  return fixture(input);
};
