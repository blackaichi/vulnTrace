// A third entrypoint reaching ONLY the negative-control module, so the
// control asserts what it claims to: a module full of alias, wrapper,
// object-member and shadow invocations -- none of which RWF-028 may prove
// -- still has an attributable whole-module export and still supports a
// COMPLETE Family C proof.
require("fixture-lib/valid");

module.exports = function main(input) {
  return "main:" + input;
};
