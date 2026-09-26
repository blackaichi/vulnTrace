/**
 * THE "CALLED" CONVENTION.
 *
 * Every real-Node oracle reproduction in docs/audits/ (2026-09-premise-
 * sweep-round-1/2, 2026-09-independent-audit) marks a fixture function
 * with a one-line `hit(name)` call so the SAME source that real Node
 * executes also produces ground truth as a plain stdout line: `CALLED
 * <name>`. This module is that convention, extracted once so every case
 * built on this harness measures ground truth the same way instead of
 * each later task re-inventing its own print statement.
 *
 * `VT_SILENT` suppresses the marker for a probe run (e.g. the loud-fixture
 * check) that only cares whether a name IS a function, not whether it was
 * called.
 */

/** Prepended to a CommonJS or ESM fixture file that calls {@link hitCall}. */
export const HIT_HELPER_SOURCE =
  'function hit(n){ if (!process.env.VT_SILENT) console.log("CALLED " + n); }\n';

/** The source text of a call that marks `name` as having run. */
export function hitCall(name: string): string {
  return `hit(${JSON.stringify(name)});`;
}

/** A minimal named function declaration that marks itself as called, then returns `value`. */
export function hitFunction(name: string, value: string): string {
  return `function ${name}(x){ ${hitCall(name)} return ${value}; }\n`;
}

const CALLED_LINE = /^CALLED (.+)$/;

/** Every name marked by {@link hitCall} in a real run's captured stdout. */
export function parseCalledMarkers(stdout: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = CALLED_LINE.exec(line.trim());
    if (match) {
      names.add(match[1]!);
    }
  }
  return names;
}
