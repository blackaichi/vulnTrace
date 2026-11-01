/** Types for `next-id.mjs` (task BL-119), for its test. */

export const SERIES: Readonly<
  Record<string, { readonly register: string; readonly width: number }>
>;

export interface NextId {
  readonly id: string;
  readonly registeredMax: number;
  readonly mentionedMax: number;
  readonly unregistered: readonly { readonly file: string; readonly number: number }[];
}

export function nextId(series: string, root?: string): NextId;
