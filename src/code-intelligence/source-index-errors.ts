/** The source file could not be read from disk. */
export class SourceFileNotFoundError extends Error {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    super(`Source file not found or unreadable: ${filePath}`, { cause });
    this.name = "SourceFileNotFoundError";
    this.filePath = filePath;
  }
}
