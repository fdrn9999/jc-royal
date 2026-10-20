/**
 * `o` with only `keys`, in their order: a policy's or template's settings without its version and audit fields (the
 * part a conflict shows and a change compares). Typed, so a key list that leaves out a required field does not compile.
 */
export function pick<T, K extends keyof T>(o: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = o[k];
  return out;
}
