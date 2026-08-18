const moduleName = process.env.ADV_MODULE || "adv-vuln-lib";
const lib = require(moduleName);

module.exports = function main() {
  return lib.vulnerable();
};
