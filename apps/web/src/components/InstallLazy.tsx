import { Suspense } from 'react';
import { lazyPart } from '../lib/lazyPart';

// The steps and their text load only when the settings open, so the entry chunk stays as it was (tests/bundle-check.mjs).
// The lobby's offer is not here: it draws with the lobby (InstallOffer.tsx).
const Settings = lazyPart(() => import('./Install').then((m) => m.InstallSettings));

/** The settings section (components/Install.tsx). */
export function InstallSettingsLazy() {
  return (
    <Suspense fallback={null}>
      <Settings />
    </Suspense>
  );
}
