import { Suspense } from 'react';
import { lazyPart } from '../lib/lazyPart';

// The note and its text load only when chips run short, so the entry chunk stays as it was (tests/bundle-check.mjs).
const Hint = lazyPart(() => import('./Refill').then((m) => m.RefillHint));

/** The free refill note for low-balance notices (components/Refill.tsx); nothing shows until it has loaded. */
export function RefillHintLazy({ className }: { className?: string }) {
  return (
    <Suspense fallback={null}>
      <Hint className={className} />
    </Suspense>
  );
}
