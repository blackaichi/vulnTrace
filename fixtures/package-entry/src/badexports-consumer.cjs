// The package's own public entry is unresolvable (`exports` names a file
// that is not there). This consumer reaches the SIBLING by an explicit
// relative file path -- which real Node allows, because a relative path
// request never consults `exports` -- so the sibling is genuinely loaded
// and genuinely reachable. Binding `badexports-lib#vulnerable` to it would
// be a false AFFECTED: that file is not what the package publishes.
const sibling = require("../node_modules/badexports-lib/index.js");

module.exports = function main(input) {
  return sibling.vulnerable(input);
};
