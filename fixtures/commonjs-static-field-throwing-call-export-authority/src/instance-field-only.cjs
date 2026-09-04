// A third entrypoint whose reachable region contains NO ambiguous export:
// it requires the INSTANCE-field module and never the static-field one.
//
// The instance-field control is scanned from here for the same reason the
// Family C control is scanned from `stable-only.cjs` --
// `reachableSubgraphComplete` is a property of the whole scanned subgraph,
// so a control sharing an entrypoint with the deliberately-ambiguous
// module would come back UNKNOWN for that module's reason and prove
// nothing about its own.
require("fixture-lib/instance-field");

module.exports = function main(input) {
  return "main:" + input;
};
