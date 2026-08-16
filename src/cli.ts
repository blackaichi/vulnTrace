#!/usr/bin/env node

/**
 * Bootstrap CLI entrypoint.
 *
 * Command surface (`scan`, `rules validate`, `version`) is implemented in a
 * later task (see docs/SDD.md § 25). This entrypoint only proves the
 * TypeScript -> CLI build pipeline works end to end.
 */
export function main(): number {
  console.log(
    "vulntrace: bootstrap CLI entrypoint (commands not yet implemented)",
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
