// The BRACKET RE-EXPORT, found while fixing the literal-bracket blocker.
//
// Modeling bracket keys alone would have reopened the original defect in a
// new shape: this write gains an export binding, but its value comes from
// ./impl.cjs, so it must ALSO keep its `commonJsReExport` provenance or
// `isForeignOriginExport` would not recognise it and root derivation would
// report COMPLETE again. Both mirrors share one predicate for that reason.
module.exports["run"] = require("./impl.cjs").run;
