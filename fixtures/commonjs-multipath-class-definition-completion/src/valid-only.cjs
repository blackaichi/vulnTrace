// A third entrypoint whose reachable region contains NO ambiguous export:
// it requires the multi-path NEGATIVE control and never the all-fatal
// modules.
//
// The control is scanned from here for the same reason the Family C control
// is scanned from `stable-only.cjs` -- `reachableSubgraphComplete` is a
// property of the whole scanned subgraph, so a control sharing an entrypoint
// with the deliberately ambiguous modules would come back UNKNOWN for those
// modules' reason and prove nothing about its own.
require("fixture-lib/valid-multipath");

module.exports = function main(input) {
  return "main:" + input;
};
