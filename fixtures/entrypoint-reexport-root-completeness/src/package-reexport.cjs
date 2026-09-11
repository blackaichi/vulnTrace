// P0-Z BLOCKER FORM B7 -- the entrypoint re-exports the VULNERABLE PACKAGE
// itself.
//
// The sharpest form: an importer of this entrypoint receives
// `dangerousOp` directly. Certifying absence here would deny reachability
// for a callable the entrypoint literally hands out.
module.exports = require("fixture-lib");
