const qs = require("qs");

// Only qs.stringify() is used -- qs.parse(), the export named in
// GHSA-hrpp-h998-j3pp / CVE-2022-24999 (prototype pollution), is never
// imported or called anywhere in this application.
function toQueryString(filters) {
  return qs.stringify(filters);
}

module.exports = { toQueryString };
