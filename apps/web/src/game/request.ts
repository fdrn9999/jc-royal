import type { ErrorCode } from '@jc/types';

// Apart from useTableSocket.ts: the lobby's panels (in the first screen's code) need these two, and importing them from
// the hook's module put the whole table connection in the entry chunk (tests/bundle-check.mjs).

export class RequestError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
  }
}

export const rid = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/-/g, '').slice(0, 24);
