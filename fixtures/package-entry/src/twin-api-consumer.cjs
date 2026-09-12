const aliasApi = require("twin-alias/api");
require("twin-lib/api");

module.exports = function main(input) {
  return aliasApi.vulnerable(input);
};
