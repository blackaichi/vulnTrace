// P0-Z BLOCKER FORM B2 -- export forwarding by object mutation.
//
// The module model produces NO export binding at all for this shape, so
// unlike a re-export there is nothing on the model to detect it by: before
// P0-Z it was indistinguishable from a file that exports nothing, which is
// exactly the conflation that let Family C claim a complete proof.
Object.assign(module.exports, require("./impl.cjs"));
