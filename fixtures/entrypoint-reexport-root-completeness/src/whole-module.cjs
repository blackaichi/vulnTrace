// P0-Z BLOCKER FORM B1 -- whole-module CommonJS re-export.
//
// At runtime this entrypoint publishes `run`, and calling it reaches the
// vulnerable sink (see verify.cjs). The callable is defined in ./impl.cjs,
// so no node in THIS file can be its reachability root. Before P0-Z that
// produced zero roots, indistinguishable from a file exporting nothing,
// and Family C certified `reachableSubgraphComplete: true`.
module.exports = require("./impl.cjs");
