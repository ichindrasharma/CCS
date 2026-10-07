export const ID_PREFIXES = {
  project: 'prj',
  member: 'mem',
  thread: 'thr',
  message: 'msg',
  event: 'evt',
  approval: 'apr',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** A prefixed random id, e.g. `thr_3f9c…`. 96 random bits; uses Web Crypto so it runs anywhere. */
export function newId(kind: IdKind): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${ID_PREFIXES[kind]}_${hex}`;
}
