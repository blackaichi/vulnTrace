// P0-Z BLOCKER FORM B3 -- property re-export.
//
// This one DOES carry the exported name `run`, which is why a name is not
// evidence of a rootable callable: `run` is defined in ./impl.cjs, so a
// same-file lookup for it finds nothing (or, worse, an unrelated local
// that merely shares the text).
module.exports.run = require("./impl.cjs").run;
