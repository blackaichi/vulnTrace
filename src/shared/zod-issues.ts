import type { ZodError } from "zod";

/** A single validation issue, formatted for a human-readable, actionable error message. */
export interface ZodIssueSummary {
  readonly path: string;
  readonly message: string;
}

function formatZodPath(path: readonly (string | number)[]): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") {
      return `${acc}[${segment}]`;
    }
    return acc ? `${acc}.${segment}` : segment;
  }, "");
}

/**
 * Converts a Zod validation error into path-formatted issue summaries
 * (e.g. `analysis.include[0]`), shared by every module that validates
 * external input with Zod (see AGENTS.md: "Validate all external input").
 */
export function summarizeZodError(error: ZodError): ZodIssueSummary[] {
  return error.issues.map((issue) => ({
    path: formatZodPath(issue.path),
    message: issue.message,
  }));
}
