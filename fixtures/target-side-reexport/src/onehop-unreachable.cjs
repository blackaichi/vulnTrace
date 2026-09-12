// Calls ONLY the unrelated sibling export -- the RWB-05 shape. The
// vulnerable target must still resolve exactly, and must then be proved
// unreachable rather than assumed either way.
const lib = require("onehop-lib");

module.exports = function main(input) {
  return lib.safe(input);
};
