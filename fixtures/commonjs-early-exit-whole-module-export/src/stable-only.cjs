// A third entrypoint whose reachable region contains NO ambiguous export
// at all: it never requires either early-exit module. The Family C
// positive control is scanned from here so that it proves what it claims
// to -- that an UNCONDITIONAL whole-module export with no abrupt
// completion above it is still attributable and still supports a negative
// proof -- rather than riding on whatever uncertainty the RWF-015 modules
// contribute.
require("fixture-lib/stable");

module.exports = function main(input) {
  return "main:" + input;
};
