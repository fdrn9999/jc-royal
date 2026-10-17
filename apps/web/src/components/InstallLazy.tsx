import { lazy, Suspense } from 'react';
import { offerVisible, useInstall } from '../lib/install';

// The offer, the steps and their text load only when the offer shows or the settings open, so the entry chunk stays as it was (tests/bundle-check.mjs).
const Offer = lazy(() => import('./Install').then((m) => ({ default: m.InstallOffer })));
const Settings = lazy(() => import('./Install').then((m) => ({ default: m.InstallSettings })));

/** The lobby's install offer (components/Install.tsx), only where it applies; nothing shows until it has loaded. */
export function InstallOfferLazy() {
  const s = useInstall();
  if (!offerVisible(s, Date.now())) return null;
  return (
    <Suspense fallback={null}>
      <Offer />
    </Suspense>
  );
}

/** The settings section (components/Install.tsx). */
export function InstallSettingsLazy() {
  return (
    <Suspense fallback={null}>
      <Settings />
    </Suspense>
  );
}
