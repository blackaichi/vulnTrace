// A second entrypoint whose reachable region contains NO ambiguous export
// at all: it never requires the throwing-call module. The Family C
// positive control is scanned from here so that it proves what it claims
// to -- that an UNCONDITIONAL whole-module export with no bypassing call
// above it is still attributable and still supports a negative proof --
// rather than riding on whatever uncertainty the RWF-016 module
// contributes.
require("fixture-lib/stable");

module.exports = function main(input) {
  return "main:" + input;
};
