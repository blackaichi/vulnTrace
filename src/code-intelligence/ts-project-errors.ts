/**
 * The given project root does not exist or is not a directory. Distinct
 * from "no tsconfig.json found" (a normal, expected case for plain
 * JavaScript projects) — this means the input itself is invalid.
 */
export class TsProjectRootNotFoundError extends Error {
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    super(`Project root does not exist or is not a directory: ${projectRoot}`);
    this.name = "TsProjectRootNotFoundError";
    this.projectRoot = projectRoot;
  }
}
