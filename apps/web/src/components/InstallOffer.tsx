/**
 * The lobby's offer to install (lib/install.ts), drawn with the lobby: loaded after it, the panel landed above quick play
 * and pushed it down under a finger already on its way. Only its own few lines live here; the steps and the settings
 * section, with the rest of the text, load on demand from Install.tsx.
 */
import { Button, createTranslator, Logo, Modal } from '@jc/ui';
import { Suspense, useEffect, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { hideInstallOffer, LATER_MS, offerVisible, promptInstall, SNOOZE_MS, useInstall } from '../lib/install';
import { lazyPart } from '../lib/lazyPart';

export const offerKo = {
  offerTitle: 'JC ROYAL을 앱으로 설치',
  offerBody: '홈 화면 아이콘으로 바로 열고, 주소창 없는 전체 화면으로 플레이할 수 있습니다. 설치 방법은 설정에서도 다시 볼 수 있습니다.',
  offerInApp: '지금은 다른 앱 안의 브라우저라 설치할 수 없습니다. Safari나 Chrome에서 열면 앱으로 설치할 수 있습니다.',
  installNow: '설치하기',
  howTo: '설치 방법',
  later: '나중에',
  snooze: '30일 동안 보지 않기',
  promptDismissed: '설치하지 않았습니다. 나중에 설정이나 브라우저 메뉴에서 다시 설치할 수 있습니다.',
  guideTitle: '앱으로 설치하는 방법',
  close: '닫기',
} as const;

export const offerEn: Record<keyof typeof offerKo, string> = {
  offerTitle: 'Install JC ROYAL as an app',
  offerBody: 'Open it straight from your home screen and play full screen without the address bar. The steps are also in Settings.',
  offerInApp: "This is a browser inside another app, which can't install. Open the site in Safari or Chrome to install it.",
  installNow: 'Install',
  howTo: 'How to install',
  later: 'Later',
  snooze: "Don't show for 30 days",
  promptDismissed: 'Not installed. You can install it later from Settings or your browser menu.',
  guideTitle: 'How to install the app',
  close: 'Close',
};

const translate = createTranslator({ ko: offerKo, en: offerEn });

// Phones get a 40px tap target; wider screens keep the compact size.
export const TAP = 'h-10! sm:h-8!';

/** The browser's install dialog, and what to say when it was closed without installing. */
export function usePrompt() {
  const [note, setNote] = useState<'promptDismissed' | null>(null);
  const run = async (fallback: () => void) => {
    setNote(null);
    const r = await promptInstall();
    if (r === 'dismissed') setNote('promptDismissed');
    else if (r === 'unavailable') fallback();
  };
  return [run, note] as const;
}

export function Note({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="status" className="text-xs text-gold-300" data-testid="install-note">
      {text}
    </p>
  );
}

type Guide = (typeof import('./Install'))['InstallGuide'];
let guide: Guide | undefined;
const loadGuide = () => import('./Install').then((m) => (guide = m.InstallGuide));
const LazyGuide = lazyPart(loadGuide);

/** In the page (never over a table or a game, never a dialog of its own), only while offerVisible() says so. */
export function InstallOffer() {
  const s = useInstall();
  if (!offerVisible(s, Date.now())) return null;
  return <Offer />;
}

function Offer() {
  const tr = translate(useI18n().locale);
  const s = useInstall();
  const [open, setOpen] = useState(false);
  const [Steps, setSteps] = useState(() => guide);
  const [run, note] = usePrompt();
  const inApp = s.platform === 'in-app-ios' || s.platform === 'in-app-android';
  // The steps load while the offer shows and then render directly, so the dialog opens with them in it (through React.lazy
  // it would open empty and fill a moment later). Opened before they arrive, LazyGuide waits for them and reports a failure.
  useEffect(() => {
    if (!Steps) loadGuide().then((C) => setSteps(() => C), () => undefined);
  }, [Steps]);
  return (
    <section className="jc-panel flex flex-col gap-3 border-gold-500/25 p-4" aria-labelledby="install-offer-title" data-testid="install-offer">
      <div className="flex items-start gap-3">
        <Logo size={40} className="shrink-0" />
        <div className="min-w-0">
          <h2 id="install-offer-title" className="font-bold text-ivory">
            {tr('offerTitle')}
          </h2>
          <p className="mt-0.5 text-xs text-ink-300">{tr(inApp ? 'offerInApp' : 'offerBody')}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {s.canPrompt ? (
          <Button size="sm" className={TAP} onClick={() => run(() => setOpen(true))} data-testid="install-offer-prompt">
            {tr('installNow')}
          </Button>
        ) : (
          <Button size="sm" className={TAP} onClick={() => setOpen(true)} data-testid="install-offer-guide">
            {tr('howTo')}
          </Button>
        )}
        <Button size="sm" variant="ghost" className={TAP} onClick={() => hideInstallOffer(LATER_MS)} data-testid="install-later">
          {tr('later')}
        </Button>
        <Button size="sm" variant="ghost" className={TAP} onClick={() => hideInstallOffer(SNOOZE_MS)} data-testid="install-snooze">
          {tr('snooze')}
        </Button>
      </div>
      <Note text={note && tr(note)} />
      <Modal open={open} onClose={() => setOpen(false)} title={tr('guideTitle')} closeLabel={tr('close')}>
        {Steps ? (
          <Steps />
        ) : (
          <Suspense fallback={null}>
            <LazyGuide />
          </Suspense>
        )}
      </Modal>
    </section>
  );
}
