const fixture = require("fixture-lib");

// Required so its file and package instance are genuinely discovered by
// the call graph, and never called -- the Family C positive control.
require("fixture-lib/stable");

// The computed-METHOD-key twin of `fixture-lib`'s own defect, discovered
// from the same entrypoint because it is expected to be exactly as
// ambiguous.
require("fixture-lib/method-key");

// Required so the DEFERRED-context control module is discovered too. Its
// later export must REMAIN authoritative: neither an instance field's
// VALUE nor a class defined inside an uncalled function runs during module
// evaluation.
require("fixture-lib/deferred-key");

module.exports = function main(input) {
  return fixture(input);
};
