const { dangerousOp } = require("vt2-vuln-lib");

module.exports.main = function main() {
  return dangerousOp();
};
