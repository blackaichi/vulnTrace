const Url = require("url-parse");

// Vulnerable constructor reached directly on caller-supplied input
// (GHSA-8v38-pw62-9cw2 / CVE-2022-0639, improper input validation --
// the entire parse runs inside the Url constructor body itself, so
// `new Url(rawUrl)` alone reproduces the bug regardless of what a
// downstream allowlist check later does with the result).
const ALLOWED_HOSTS = new Set(["api.internal.example"]);

function isAllowedWebhook(rawUrl) {
  const parsed = new Url(rawUrl);
  return ALLOWED_HOSTS.has(parsed.hostname);
}

module.exports = { isAllowedWebhook };
