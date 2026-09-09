// A third entrypoint whose reachable region contains NO ambiguous export:
// it requires only the module where `bail` is GENUINELY rebound. Scanned
// from here, that module's later export is attributable and supports a
// negative proof -- so if narrowing which identifiers an assignment target
// contributes ever dropped the genuine `({ bail } = HANDLERS)` mark, this
// entrypoint's answer would move, rather than being masked by whatever
// uncertainty the poisoned modules contribute.
require("fixture-lib/rebound");

module.exports = function main(input) {
  return "main:" + input;
};
