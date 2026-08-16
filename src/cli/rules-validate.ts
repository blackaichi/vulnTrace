import path from "node:path";
import { indexRulesByVulnerabilityId, loadRuleFile } from "../rules/index.js";
import { errorMessage } from "./errors.js";
import { type CliIo, defaultIo } from "./io.js";

export interface RunRulesValidateOptions {
  readonly filePathArg: string;
  readonly io?: CliIo;
}

/**
 * `vulntrace rules validate <file>` (see docs/SDD.md § 25). Loading a rules
 * file already validates it against `schemas/symbol-rule.schema.json`
 * (src/rules/rule-loader.ts); this command's own job is only to surface
 * that result as a pass/fail CLI outcome.
 */
export function runRulesValidateCommand(
  options: RunRulesValidateOptions,
): number {
  const io = options.io ?? defaultIo;
  const filePath = path.resolve(options.filePathArg);

  try {
    const rules = loadRuleFile(filePath);
    indexRulesByVulnerabilityId(rules);
    io.stdout(
      `vulntrace: ${options.filePathArg} is valid (${rules.length} rule${
        rules.length === 1 ? "" : "s"
      }).\n`,
    );
    return 0;
  } catch (error) {
    io.stderr(`vulntrace: ${errorMessage(error)}\n`);
    return 2;
  }
}
