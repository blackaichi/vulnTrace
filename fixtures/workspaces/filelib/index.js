"use strict";

// A `file:` dependency, NOT a workspace member: it sits outside every
// `workspaces` pattern. It is reachable only because the install
// materialized a node_modules symlink to it, which is exactly the
// authority P1-A4 relies on -- never the `file:` specifier itself.
function vulnerable(input) {
  return "filelib/index.js:vulnerable:" + String(input);
}

module.exports = { vulnerable };
