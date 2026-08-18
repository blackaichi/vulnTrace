# Security Policy

VulnTrace is a static analysis tool: it parses and models target
JavaScript/TypeScript projects but never executes their code or runs their
package lifecycle scripts (see `docs/adr/0004-no-code-execution.md` and
`docs/THREAT-MODEL.md`). Reports of a violation of that boundary, or of any
other vulnerability in VulnTrace itself, are welcome.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting instead of a public
issue: open the **Security** tab on this repository and select
**Report a vulnerability**, or go directly to
https://github.com/blackaichi/vulnTrace/security/advisories/new.

Include:

- the affected version/commit,
- a minimal reproduction (ideally a target fixture that triggers the issue),
- the observed vs. expected behavior.

There is currently no fixed SLA — this is a small, actively developed
project — but reports will be acknowledged and triaged as soon as possible.
