const ini = require("ini");

function loadModernConfig(text) {
  return JSON.parse(text);
}

// Legacy INI loader retained for a migration that already completed --
// no remaining code path calls this function. It genuinely calls the
// vulnerable ini.parse() (GHSA-qqgx-2p2h-9c37 / CVE-2020-7788, prototype
// pollution), but is unreachable from the configured entrypoint below.
function loadLegacyIniConfig(text) {
  return ini.parse(text);
}

module.exports = { loadModernConfig, loadLegacyIniConfig };
