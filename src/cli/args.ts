export interface ParsedFlags {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

/**
 * Splits argv into positionals and `--flag`-style options. Supports
 * `--flag=value`, `--flag value`, and boolean `--flag` (true when the next
 * token is missing or is itself another `--flag`). Deliberately minimal —
 * VulnTrace's command surface (docs/SDD.md § 25) is three commands with a
 * handful of flags, not enough to justify an external argument-parsing
 * dependency.
 */
export function parseFlags(argv: readonly string[]): ParsedFlags {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eqIndex = arg.indexOf("=");
    if (eqIndex !== -1) {
      flags[arg.slice(2, eqIndex)] = arg.slice(eqIndex + 1);
      continue;
    }

    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }

  return { positionals, flags };
}
