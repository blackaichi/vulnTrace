const fixture = require("fixture-lib");

// Required so its file and package instance are genuinely discovered by
// the call graph, and never called -- the Family C positive control.
require("fixture-lib/stable");

// The other four RWF-028 provenance shapes, each ending module evaluation
// through a different invocation form.
require("fixture-lib/member");
require("fixture-lib/wrapper");
require("fixture-lib/shadow");
require("fixture-lib/construct");

// Required so the negative-control module is discovered too. Its later
// export must REMAIN authoritative.
require("fixture-lib/valid");

module.exports = function main(input) {
  return fixture(input);
};
