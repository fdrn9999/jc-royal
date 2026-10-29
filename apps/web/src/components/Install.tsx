/**
 * Installing JC ROYAL as an app (lib/install.ts): the steps for each kind of device and the settings section. Loaded on
 * demand — while the lobby's offer (InstallOffer.tsx) shows or when the settings open (InstallLazy.tsx) — so its text
 * lives here rather than in the entry chunk.
 */
import { Button, createTranslator, cx, formatDate } from '@jc/ui';
import { useId, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { guideOsOf, isSnoozed, showInstallOffer, useInstall, type GuideOs } from '../lib/install';
import { copyText, siteUrl } from '../lib/share';
import { Note, offerEn, offerKo, TAP, usePrompt } from './InstallOffer';

const ko = {
  ...offerKo,
  promptHint: '브라우저의 설치 창이 열립니다. 여기서 설치되지 않으면 아래 방법을 따라 주세요.',
  guideIntro: '앱 스토어 없이 브라우저에서 홈 화면에 추가해 앱처럼 쓸 수 있습니다. 기기·브라우저·버전에 따라 메뉴 이름과 위치가 다르고, 설치를 지원하지 않는 브라우저도 있습니다.',
  inApp: "카카오톡·네이버·인스타그램처럼 다른 앱 안에서 연 화면에서는 설치할 수 없습니다. 화면 위나 아래의 메뉴에서 '다른 브라우저로 열기'(또는 'Safari로 열기'·'기본 브라우저로 열기')를 누르거나, 주소를 복사해 Safari·Chrome에 붙여 넣어 주세요.",
  copyAddress: '주소 복사',
  copied: '주소를 복사했습니다.',
  copyFailed: '복사하지 못했습니다. 주소창을 길게 눌러 직접 복사해 주세요.',
  osLabel: '기기 종류',
  'os.ios': 'iPhone·iPad',
  'os.android': 'Android',
  'os.desktop': '컴퓨터',
  'ios.title': 'Safari',
  'ios.1': 'Safari에서 jc-royal.site를 엽니다.',
  'ios.2': '공유 버튼(네모에서 위로 향한 화살표)을 누릅니다. 주소창 옆에 없으면 ⋯ 버튼 안에 있습니다.',
  'ios.3': "'홈 화면에 추가'를 누릅니다. 보이지 않으면 목록을 내리거나 '더 보기'를 누릅니다.",
  'ios.4': "'웹 앱으로 열기'가 보이면 켜 둔 채로 둡니다(iOS 26 이상).",
  'ios.5': "'추가'를 누르면 홈 화면에 JC ROYAL 아이콘이 생깁니다.",
  'ios.other': "Chrome·Edge 같은 다른 브라우저도 iOS 16.4 이상에서는 공유 메뉴에 '홈 화면에 추가'가 있을 수 있습니다. 없으면 Safari로 열어 주세요.",
  'android.1': 'Chrome에서 jc-royal.site를 엽니다.',
  'android.2': '오른쪽 위 ⋮ 메뉴를 누릅니다.',
  'android.3': "'앱 설치' 또는 '홈 화면에 추가'를 누릅니다.",
  'android.4': "'설치'(또는 '추가')를 눌러 확인합니다.",
  'android.other': "다른 브라우저는 메뉴에서 '홈 화면에 추가'나 '앱 설치'를 찾아 주세요. 설치를 지원하지 않는 브라우저도 있습니다.",
  'samsung.title': '삼성 인터넷',
  'samsung.1': '아래쪽 ≡ 메뉴를 누릅니다.',
  'samsung.2': "'현재 페이지 추가'(또는 '페이지 추가')를 누르고 '홈 화면'을 고릅니다.",
  'samsung.3': "'추가'를 눌러 확인합니다.",
  'samsung.note': '주소창에 설치 아이콘이 보이면 그것을 눌러도 됩니다. 버전에 따라 메뉴 이름과 위치가 다를 수 있습니다.',
  'desktop.title': 'Chrome·Edge',
  'desktop.1': "주소창 오른쪽의 설치 아이콘을 누르거나, 메뉴(⋮ 또는 ⋯)에서 'JC ROYAL 설치'·'앱으로 설치' 같은 항목을 고릅니다.",
  'desktop.2': "'설치'를 누르면 JC ROYAL이 자기 창으로 열리고, 시작 메뉴나 앱 목록에서 다시 열 수 있습니다.",
  'mac.title': 'Mac Safari',
  'mac.1': "파일 메뉴(또는 공유 버튼)에서 'Dock에 추가'를 고릅니다(macOS Sonoma 이상).",
  'desktop.other': 'Firefox 등 일부 브라우저는 설치를 지원하지 않거나 방법이 다릅니다.',
  noOffline: '설치해도 게임은 인터넷 연결이 있어야 하고, 게임·계정·카드 정보를 오프라인용으로 기기에 저장하지 않습니다.',
  settingsTitle: '앱으로 설치',
  'status.app': '지금 설치한 앱으로 실행 중입니다.',
  'status.installed': '이 브라우저에 설치되어 있습니다. 홈 화면이나 앱 목록에서 JC ROYAL을 열 수 있습니다.',
  'status.browser': '브라우저에서 보고 있습니다. 설치하면 홈 화면에서 바로 열고 주소창 없이 플레이할 수 있습니다.',
  showGuide: '설치 방법 보기',
  hideGuide: '설치 방법 접기',
  hiddenUntil: '로비의 설치 안내를 {date}까지 숨겼습니다.',
  showAgain: '다시 보이기',
} as const;

type Key = keyof typeof ko;

const en: Record<Key, string> = {
  ...offerEn,
  promptHint: "Your browser's install dialog opens. If it doesn't install from here, follow the steps below.",
  guideIntro: 'You can add JC ROYAL to your home screen from the browser and use it like an app, without an app store. Menu names and places differ by device, browser and version, and some browsers cannot install.',
  inApp: "Pages opened inside apps such as KakaoTalk, NAVER or Instagram can't install. Use 'Open in another browser' (or 'Open in Safari' / 'Open in default browser') in the menu at the top or bottom, or copy the address and paste it into Safari or Chrome.",
  copyAddress: 'Copy address',
  copied: 'Address copied.',
  copyFailed: "Couldn't copy. Press and hold the address bar to copy it yourself.",
  osLabel: 'Device',
  'os.ios': 'iPhone·iPad',
  'os.android': 'Android',
  'os.desktop': 'Computer',
  'ios.title': 'Safari',
  'ios.1': 'Open jc-royal.site in Safari.',
  'ios.2': "Tap the Share button (a square with an arrow pointing up). If it isn't next to the address bar, it's under the ⋯ button.",
  'ios.3': "Tap 'Add to Home Screen'. If you don't see it, scroll the list or tap 'More'.",
  'ios.4': "If 'Open as Web App' appears, leave it on (iOS 26 and later).",
  'ios.5': "Tap 'Add'. The JC ROYAL icon appears on your home screen.",
  'ios.other': "Other browsers such as Chrome or Edge may also offer 'Add to Home Screen' in their share menu on iOS 16.4 and later. If not, open the site in Safari.",
  'android.1': 'Open jc-royal.site in Chrome.',
  'android.2': 'Tap the ⋮ menu at the top right.',
  'android.3': "Tap 'Install app' or 'Add to Home screen'.",
  'android.4': "Confirm with 'Install' (or 'Add').",
  'android.other': "In other browsers, look for 'Add to Home screen' or 'Install app' in the menu. Some browsers cannot install.",
  'samsung.title': 'Samsung Internet',
  'samsung.1': 'Tap the ≡ menu at the bottom.',
  'samsung.2': "Tap 'Add page to' and choose 'Home screen'.",
  'samsung.3': "Confirm with 'Add'.",
  'samsung.note': 'If an install icon appears in the address bar, you can tap that instead. Menu names and places may differ by version.',
  'desktop.title': 'Chrome·Edge',
  'desktop.1': "Click the install icon at the right of the address bar, or choose an item such as 'Install JC ROYAL' or 'Install as app' in the menu (⋮ or ⋯).",
  'desktop.2': "Click 'Install'. JC ROYAL opens in its own window, and you can open it again from the Start menu or your app list.",
  'mac.title': 'Safari on Mac',
  'mac.1': "Choose 'Add to Dock' from the File menu or the Share button (macOS Sonoma and later).",
  'desktop.other': 'Some browsers, such as Firefox, may not install or do it differently.',
  noOffline: 'Installed or not, games need an internet connection, and no game, account or card data is kept on the device for offline use.',
  settingsTitle: 'Install as an app',
  'status.app': 'Running as the installed app.',
  'status.installed': 'Installed in this browser. Open JC ROYAL from your home screen or app list.',
  'status.browser': "You're in the browser. Installed, it opens straight from your home screen and plays without the address bar.",
  showGuide: 'Show how to install',
  hideGuide: 'Hide the steps',
  hiddenUntil: 'The lobby install banner is hidden until {date}.',
  showAgain: 'Show again',
};

const translate = createTranslator({ ko, en });
type Tr = ReturnType<typeof translate>;

function useTr(): Tr {
  return translate(useI18n().locale);
}

const OSES: GuideOs[] = ['ios', 'android', 'desktop'];

function Steps({ tr, title, steps, note, testId }: { tr: Tr; title: string; steps: Key[]; note?: Key; testId: string }) {
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <h5 className="text-sm font-bold text-ivory">{title}</h5>
      <ol className="ml-5 list-decimal space-y-1 text-ink-200 marker:text-gold-400">
        {steps.map((s) => (
          <li key={s}>{tr(s)}</li>
        ))}
      </ol>
      {note && <p className="text-xs text-ink-400">{tr(note)}</p>}
    </div>
  );
}

/** Opened in KakaoTalk, NAVER, Instagram…: those cannot install, so the way out to a real browser, and the address to take along. */
function InAppNote({ tr }: { tr: Tr }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-gold-500/30 bg-gold-500/5 p-3" data-testid="install-inapp">
      <p className="text-ink-100">{tr('inApp')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className={TAP} onClick={async () => setCopied(await copyText(siteUrl('/')))} data-testid="install-copy">
          {tr('copyAddress')}
        </Button>
        <span role="status" aria-live="polite" className={cx('text-xs', copied === false ? 'text-[#f3b0b2]' : 'text-gold-300')}>
          {copied === true ? tr('copied') : copied === false ? tr('copyFailed') : ''}
        </span>
      </div>
    </div>
  );
}

/** The steps for iPhone·iPad, Android and computers, opened on this device's own; menus differ, and some browsers cannot install at all. */
export function InstallGuide() {
  const tr = useTr();
  const s = useInstall();
  const [os, setOs] = useState<GuideOs>(() => guideOsOf(s.platform));
  const [run, note] = usePrompt();
  const id = useId();
  const inApp = s.platform === 'in-app-ios' || s.platform === 'in-app-android';
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="install-guide">
      <p className="text-ink-200">{tr('guideIntro')}</p>
      {inApp && <InAppNote tr={tr} />}
      {s.canPrompt && (
        <div className="flex flex-col gap-1.5">
          <Button className="w-full" onClick={() => run(() => undefined)} data-testid="install-guide-prompt">
            {tr('installNow')}
          </Button>
          <p className="text-xs text-ink-400">{tr('promptHint')}</p>
        </div>
      )}
      <Note text={note && tr(note)} />
      <div className="grid grid-cols-3 rounded-lg border border-white/10 p-0.5" role="tablist" aria-label={tr('osLabel')}>
        {OSES.map((o) => (
          <button
            key={o}
            type="button"
            role="tab"
            id={`${id}-${o}`}
            aria-selected={os === o}
            aria-controls={`${id}-panel`}
            onClick={() => setOs(o)}
            className={cx('jc-tap min-h-10 rounded-md px-2 text-xs font-semibold', os === o ? 'bg-gold-500/20 text-gold-300' : 'text-ink-300 hover:text-ivory')}
            data-testid={`install-tab-${o}`}
          >
            {tr(`os.${o}`)}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${os}`} className="flex flex-col gap-4">
        {os === 'ios' && <Steps tr={tr} title={tr('ios.title')} steps={['ios.1', 'ios.2', 'ios.3', 'ios.4', 'ios.5']} note="ios.other" testId="install-steps-ios" />}
        {os === 'android' && (
          <>
            <Steps tr={tr} title="Chrome" steps={['android.1', 'android.2', 'android.3', 'android.4']} testId="install-steps-android" />
            <Steps tr={tr} title={tr('samsung.title')} steps={['samsung.1', 'samsung.2', 'samsung.3']} note="samsung.note" testId="install-steps-samsung" />
            <p className="text-xs text-ink-400">{tr('android.other')}</p>
          </>
        )}
        {os === 'desktop' && (
          <>
            <Steps tr={tr} title={tr('desktop.title')} steps={['desktop.1', 'desktop.2']} testId="install-steps-desktop" />
            <Steps tr={tr} title={tr('mac.title')} steps={['mac.1']} note="desktop.other" testId="install-steps-mac" />
          </>
        )}
      </div>
      <p className="text-xs text-ink-400">{tr('noOffline')}</p>
    </div>
  );
}

/** Settings: whether this is the app, the steps again, and bringing back a hidden lobby offer. */
export function InstallSettings() {
  const tr = useTr();
  const { locale } = useI18n();
  const s = useInstall();
  const [open, setOpen] = useState(false);
  const [run, note] = usePrompt();
  const status: Key = s.standalone ? 'status.app' : s.installed ? 'status.installed' : 'status.browser';
  const hidden = !s.standalone && isSnoozed(s.until, Date.now());
  // The divider comes with the section, so none shows alone while it loads.
  return (
    <>
      <div className="jc-divider" />
      <section className="flex flex-col gap-3" data-testid="settings-install">
        <h4 className="text-xs font-bold uppercase tracking-[0.14em] text-ink-300">{tr('settingsTitle')}</h4>
        <p className="text-sm text-ink-200" data-testid="install-status" data-state={s.standalone ? 'app' : s.installed ? 'installed' : 'browser'}>
          {tr(status)}
        </p>
        {!s.standalone && (
          <div className="flex flex-wrap gap-2">
            {s.canPrompt && (
              <Button size="sm" className={TAP} onClick={() => run(() => setOpen(true))} data-testid="settings-install-prompt">
                {tr('installNow')}
              </Button>
            )}
            <Button size="sm" variant="outline" className={TAP} aria-expanded={open} onClick={() => setOpen(!open)} data-testid="settings-install-guide">
              {tr(open ? 'hideGuide' : 'showGuide')}
            </Button>
          </div>
        )}
        <Note text={note && tr(note)} />
        {hidden && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-300">
            <span data-testid="install-hidden-until">{tr('hiddenUntil', { date: formatDate(s.until, locale) })}</span>
            <Button size="sm" variant="outline" className={TAP} onClick={showInstallOffer} data-testid="install-unsnooze">
              {tr('showAgain')}
            </Button>
          </div>
        )}
        {open && !s.standalone && (
          <div className="rounded-lg border border-white/10 p-3">
            <InstallGuide />
          </div>
        )}
      </section>
    </>
  );
}
