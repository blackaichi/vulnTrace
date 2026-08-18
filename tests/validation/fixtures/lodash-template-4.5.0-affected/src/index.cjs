const template = require("lodash.template");

// Renders a user-supplied template string. This genuinely reaches
// lodash.template's real, exported function -- the exact function named
// in GHSA-35jh-r3h4-6jhm / CVE-2021-23337 (code injection via crafted
// "imports" option key names).
function render(userTemplate, data) {
  return template(userTemplate)(data);
}

module.exports = { render };
