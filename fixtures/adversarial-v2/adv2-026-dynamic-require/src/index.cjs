module.exports.main = function main(modName) {
  const lib = require(modName);
  return lib.dangerousOp();
};
