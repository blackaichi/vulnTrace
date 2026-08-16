/** Renders any thrown value as a message, without assuming it is an `Error`. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
