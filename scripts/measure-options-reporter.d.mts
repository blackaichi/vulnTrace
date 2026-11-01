/** Types for `measure-options-reporter.mjs` (task BL-120), for its test. */

export function errorText(error: {
  readonly message?: unknown;
  readonly actual?: unknown;
  readonly diff?: unknown;
}): string;

/** The parts of a vitest task this reporter reads. */
export interface ReportedTask {
  readonly type: string;
  readonly name: string;
  readonly mode?: string;
  readonly filepath?: string;
  readonly tasks?: readonly ReportedTask[];
  readonly result?: {
    readonly state?: string;
    readonly errors?: ReadonlyArray<Record<string, unknown>>;
  };
}

export default class MeasureOptionsReporter {
  onFinished(files?: readonly ReportedTask[]): void;
}
