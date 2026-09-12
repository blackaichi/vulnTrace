"use strict";

// Reaches the WORKSPACE twinlib by relative path, the only way to address
// it from here: it has no node_modules link of its own. Same name, same
// version as the installed copy the sibling consumer reaches; different
// canonical root, different implementation, different instance.
const workspaceTwin = require("../../twinlib");

module.exports.handle = function handle(input) {
  return workspaceTwin.safe(input);
};
