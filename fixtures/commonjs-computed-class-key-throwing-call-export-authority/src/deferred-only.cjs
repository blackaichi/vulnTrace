// A third entrypoint whose reachable region contains NO ambiguous export:
// it requires the DEFERRED-context control and never the computed-key
// modules.
//
// The control is scanned from here for the same reason the Family C
// control is scanned from `stable-only.cjs` --
// `reachableSubgraphComplete` is a property of the whole scanned
// subgraph, so a control sharing an entrypoint with the deliberately
// ambiguous modules would come back UNKNOWN for those modules' reason and
// prove nothing about its own.
require("fixture-lib/deferred-key");

module.exports = function main(input) {
  return "main:" + input;
};
