import { parseFlags } from "./args.js";
import { errorMessage } from "./errors.js";
import { type CliIo, defaultIo } from "./io.js";
import { runRulesValidateCommand } from "./rules-validate.js";
import { runScanCommand } from "./scan.js";
import { runVersionCommand } from "./version.js";

const SUPPORTED_FORMATS = new Set(["json"]);

const USAGE =
  "vulntrace: usage: vulntrace <command> [options]\n" +
  "  vulntrace scan <path> [--format json] [--cve <id>] [--config <file>] [--pretty]\n" +
  "  vulntrace rules validate <file>\n" +
  "  vulntrace version\n";

/**
 * Parses argv and dispatches to one of the three commands required by
 * docs/SDD.md § 25. Returns the process exit code (see docs/SDD.md § 25's
 * exit-code table; each command owns its own success/failure mapping —
 * this function only owns command dispatch and up-front usage validation).
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo,
): Promise<number> {
  const { positionals, flags } = parseFlags(argv);
  const [command, sub] = positionals;

  if (command === "version") {
    return runVersionCommand(io);
  }

  if (command === "rules" && sub === "validate") {
    const filePathArg = positionals[2];
    if (!filePathArg) {
      io.stderr("vulntrace: usage: vulntrace rules validate <file>\n");
      return 2;
    }
    return runRulesValidateCommand({ filePathArg, io });
  }

  if (command === "scan") {
    const projectPathArg = positionals[1];
    if (!projectPathArg) {
      io.stderr(
        "vulntrace: usage: vulntrace scan <path> [--format json] [--cve <id>]\n",
      );
      return 2;
    }

    const format = flags.format;
    if (
      format !== undefined &&
      (typeof format !== "string" || !SUPPORTED_FORMATS.has(format))
    ) {
      io.stderr(
        'vulntrace: unsupported --format value (only "json" is supported)\n',
      );
      return 2;
    }

    const cve = flags.cve;
    if (cve !== undefined && typeof cve !== "string") {
      io.stderr("vulntrace: --cve requires a value\n");
      return 2;
    }

    const config = flags.config;
    if (config !== undefined && typeof config !== "string") {
      io.stderr("vulntrace: --config requires a value\n");
      return 2;
    }

    try {
      return await runScanCommand({
        projectPathArg,
        configPathOverride: config,
        cveFilter: cve,
        pretty: flags.pretty === true,
        io,
      });
    } catch (error) {
      // A defensive backstop: every known failure mode inside
      // runScanCommand is already caught and mapped to a specific exit
      // code. Anything that still escapes here is unexpected, so it is
      // reported (never silently swallowed — see AGENTS.md) as an analysis
      // failure rather than crashing the process with a raw stack trace.
      io.stderr(`vulntrace: unexpected failure: ${errorMessage(error)}\n`);
      return 3;
    }
  }

  io.stderr(USAGE);
  return 2;
}
