// P0-Z round 3 BLOCKER: an exported one-hop local alias.
//
// The export binding is modeled and a candidate exists -- but the
// candidate is `alias`, a variable, while the only callable node is
// `dangerous`. The name matched nothing, the entrypoint was rooted at
// `<module>` alone, and Family C certified completeness over a live sink.
const dep = require("fixture-lib");

function dangerous(userInput) {
  return dep.dangerousOp(userInput);
}

const alias = dangerous;

module.exports.run = alias;
