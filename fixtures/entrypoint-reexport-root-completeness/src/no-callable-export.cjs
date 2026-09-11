// THE NO-EXPORT CONTROL, and the distinction that makes the fix precise.
//
// This entrypoint exports no callable at all. That is a COMPLETE answer --
// there is no root to derive and none is missing -- and it must NOT be
// confused with "a root exists but could not be derived". Before P0-Z both
// produced an empty root set; conflating them is the defect. Treating this
// one as incomplete would needlessly destroy valid Family C proofs.
const dep = require("fixture-lib");

// Read but never exported, and never called at module scope.
void dep;

module.exports = 42;
