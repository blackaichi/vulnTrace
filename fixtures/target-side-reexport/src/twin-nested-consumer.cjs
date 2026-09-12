// Reaches ONLY the nested twin-lib instance, through wrapper-lib.
const wrapper = require("wrapper-lib");

module.exports = function main(input) {
  return wrapper.run(input);
};
