const fixture = require("fixture-lib");

// Required so its file and package instance are genuinely discovered by
// the call graph, and never called -- the Family C positive control.
require("fixture-lib/stable");

// Required so the INSTANCE-field control module is discovered too. Its
// later export must REMAIN authoritative: evaluating a class definition
// does not run an instance field initializer.
require("fixture-lib/instance-field");

module.exports = function main(input) {
  return fixture(input);
};
