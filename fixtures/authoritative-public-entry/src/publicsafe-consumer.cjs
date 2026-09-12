// Calls ONLY the unrelated public name. Under real Node the dangerous
// sibling callable runs here, but it runs as `pkg.runOther` -- not as
// `pkg.vulnerable`, which is impl.js's safeImpl and is never called.
const pkg = require("publicsafe-lib");

module.exports = function main(input) {
  return pkg.runOther(input);
};
