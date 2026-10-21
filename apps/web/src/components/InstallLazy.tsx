import { Suspense } from 'react';
import { offerVisible, useInstall } from '../lib/install';
import { lazyPart } from '../lib/lazyPart';

// The offer, the steps and their text load only when the offer shows or the settings open, so the entry chunk stays as it was (tests/bundle-check.mjs).
const Offer = lazyPart(() => import('./Install').then((m) => m.InstallOffer));
const Settings = lazyPart(() => import('./Install').then((m) => m.InstallSettings));

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
