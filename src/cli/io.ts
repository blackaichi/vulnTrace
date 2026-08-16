/**
 * The CLI's output boundary, injectable so command implementations are
 * testable without spying on global `console`/`process.std*` (see
 * docs/SDD.md § 25).
 */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export const defaultIo: CliIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};
