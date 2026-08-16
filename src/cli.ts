#!/usr/bin/env node

/**
 * CLI entrypoint (see docs/SDD.md § 25). Command implementations live in
 * `src/cli/`; this file only wires the real process argv/exit-code
 * boundary, so `runCli` itself stays testable without spawning a process.
 */
import { runCli } from "./cli/run.js";

export { runCli } from "./cli/run.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runCli(process.argv.slice(2));
}
