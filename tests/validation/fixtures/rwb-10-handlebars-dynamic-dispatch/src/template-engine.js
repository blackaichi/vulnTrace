const fs = require("fs");
const path = require("path");
const Handlebars = require("handlebars");

function upperCompile(templateSource) {
  return templateSource.toUpperCase();
}

// A second, unrelated real "compiler" -- deliberately not the vulnerable
// one -- so the registry lookup below is a genuine choice between two
// real functions, not a single-entry object that would trivially resolve
// to Handlebars.compile regardless of the key.
const engines = { hbs: Handlebars.compile, upper: upperCompile };

// engineName comes from a config file read at runtime, not a literal
// string anywhere in this source -- VulnTrace cannot statically evaluate
// its value. GHSA-f2jv-r9rf-7988 / CVE-2021-23369 (RCE via template
// compilation) is in Handlebars.compile, engines.hbs -- whether THIS call
// site ever actually binds `compile` to Handlebars.compile depends on
// that unresolvable runtime value.
function renderTemplate(templateSource) {
  const configPath = path.join(__dirname, "..", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const engineName = config.templateEngine;
  const compile = engines[engineName];
  return compile(templateSource);
}

module.exports = { renderTemplate };
