// `require("subpathonly-lib")` would throw ERR_PACKAGE_PATH_NOT_EXPORTED --
// the package has no "." entry. Only its declared subpaths are importable.
const get = require("subpathonly-lib/get");

module.exports = function main(input) {
  return get.vulnerable(input);
};
