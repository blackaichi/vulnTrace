module.exports.main = function main() {
  const modName = process.env.VT2_LIB_NAME;
  const lib = require(modName);
  return lib.dangerousOp();
};
