import { formatChips, Logo, MailIcon, SettingsIcon } from '@jc/ui';
import { useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import { SettingsModal } from '../game/Panels';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useTopOnNewPage } from '../lib/scroll';
import { useUnread } from '../lib/unread';
import { PresenceMenu } from './Presence';
import { ServiceBanner } from './ServiceBanner';

/** Links to /privacy and /terms (public pages), shown in page footers. */
export function LegalLinks({ className = '' }: { className?: string }) {
  const { t } = useI18n();
  return (
    <nav className={`flex items-center justify-center gap-3 text-[11px] text-ink-400 ${className}`} aria-label={`${t('legal.privacy')} / ${t('legal.terms')}`}>
      <Link to="/privacy" className="py-1 font-semibold hover:text-ivory">
        {t('legal.privacy')}
      </Link>
      <span aria-hidden>·</span>
      <Link to="/terms" className="py-1 hover:text-ivory">
        {t('legal.terms')}
      </Link>
    </nav>
  );
}

// Named in both languages, so someone who cannot read the page's language still finds the way to the other; and not
// "언어" / "Language", the settings dialog's language field, which this switch stays in the page under.
export function LangToggle() {
  const { locale } = useI18n();
  const { chooseLocale } = useAuth();
  return (
    <div className="flex rounded-full border border-white/10 p-0.5 text-[11px] font-semibold" role="group" aria-label="한국어 / English">
      {(['ko', 'en'] as const).map((l) => (
        <button key={l} onClick={() => chooseLocale(l)} className={`rounded-full px-2.5 py-1 transition ${locale === l ? 'bg-gold-500 text-ink-950' : 'text-ink-300 hover:text-ivory'}`} aria-pressed={locale === l}>
          {l === 'ko' ? '한국어' : 'EN'}
        </button>
      ))}
    </div>
  );
}

export function BalancePill({ amount }: { amount: number }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-gold-500/30 bg-gold-500/10 px-3 py-1 font-mono text-sm font-semibold text-gold-300 tabular-nums" data-testid="balance">
      <span className="jc-chip" style={{ ['--chip-size' as string]: '0.9rem', ['--chip-base' as string]: '#9c7414', ['--chip-face' as string]: '#c9a227' }} />
      {formatChips(amount)}
    </span>
  );
}

/** Small red counter on a nav item. */
function CountBadge({ n, testId, className = '' }: { n: number; testId?: string; className?: string }) {
  if (n <= 0) return null;
  return (
    <span className={`grid min-w-4 place-items-center rounded-full bg-danger-strong px-1 text-[10px] font-bold leading-4 text-white ${className}`} data-testid={testId}>
      {n > 99 ? '99+' : n}
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me, logout } = useAuth();
  const { t } = useI18n();
  const nav = useNavigate();
  const { unread, dmUnread, friendRequests } = useUnread(me?.id ?? '');
  const [settings, setSettings] = useState(false);
  const social = dmUnread + friendRequests;
  useTopOnNewPage();
  async function signOut() {
    setSettings(false);
    await logout();
    nav('/login');
  }
  // Six tabs share the row as evenly as their labels allow: a label never wraps or clips (a longer one takes the room
  // it needs from the shorter ones), and below 360px the labels shrink with the width, to 11px at 304px, while the tabs
  // stay 44px tall. The English labels leave 12–15% of the row spare from 304 to 360px: Linux draws the same font up to
  // 8% wider than Windows does. Should they still not fit (a wide phone font, enlarged text), the row scrolls sideways
  // instead of cutting off the last tab. The current tab says so by more than its colour: a bar along its top edge.
  const tab = ({ isActive }: { isActive: boolean }) =>
    `relative flex-1 whitespace-nowrap px-[3px] py-3 text-center text-[length:clamp(11px,3.62vw,13px)] leading-5 font-semibold ${isActive ? "text-gold-300 after:absolute after:inset-x-[18%] after:top-0 after:h-0.5 after:rounded-full after:bg-gold-400 after:content-['']" : 'text-ink-300'}`;
  const link = ({ isActive }: { isActive: boolean }) =>
    `shrink-0 whitespace-nowrap px-2 py-2 text-sm font-semibold tracking-wide transition lg:px-3 ${isActive ? 'text-gold-300' : 'text-ink-300 hover:text-ivory'}`;
  return (
    <div className="min-h-dvh" style={{ background: 'var(--t-bg)' }}>
      <header className="sticky top-0 z-40 border-b border-gold-500/10 bg-ink-950/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4">
          <Link to="/" className="shrink-0" aria-label="JC ROYAL">
            <Logo size={38} withWordmark className="[&>span]:hidden lg:[&>span]:inline" />
          </Link>
          {/* Between the phone layout and a wide window the wordmark, language switch and logout (both also in the
              settings) step aside for the six links; a window narrower still scrolls the links (a thin scrollbar for a
              mouse) rather than wrapping them. The padding keeps a focused link's outline inside the scrolling strip, and a
              link reached by Tab is brought fully into it (the browser leaves a half-hidden one as it is). */}
          <nav
            className="hidden min-w-0 scroll-px-1 items-center overflow-x-auto p-1 [scrollbar-width:thin] sm:flex lg:ml-2"
            onFocus={(e) => e.target.scrollIntoView({ block: 'nearest', inline: 'nearest' })}
            data-testid="header-nav"
          >
            <NavLink to="/" end className={link}>
              {t('nav.lobby')}
            </NavLink>
            <NavLink to="/tournaments" className={link} data-testid="nav-tournaments">
              {t('nav.tournaments')}
            </NavLink>
            <NavLink to="/academy" className={link}>
              {t('nav.academy')}
            </NavLink>
            <NavLink to="/board" className={link}>
              {t('nav.board')}
            </NavLink>
            <NavLink to="/friends" className={(a) => `${link(a)} inline-flex items-center gap-1`} data-testid="nav-friends">
              {t('nav.friends')}
              <CountBadge n={social} testId="friends-badge" />
            </NavLink>
            <NavLink to="/me" className={link}>
              {t('nav.me')}
            </NavLink>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
            {me && <BalancePill amount={me.balance} />}
            {me && (
              <Link to="/messages" className="relative rounded-full p-2 text-ink-200 hover:text-ivory" aria-label={`${t('nav.messages')}${unread ? ` (${unread})` : ''}`} data-testid="inbox-link">
                <MailIcon className="size-5" />
                <CountBadge n={unread} testId="unread-badge" className="absolute -right-0.5 -top-0.5" />
              </Link>
            )}
            {me && (
              <span className="hidden lg:inline">
                <PresenceMenu />
              </span>
            )}
            <span className="hidden xl:inline"><LangToggle /></span>
            <button type="button" className="rounded-full p-2 text-ink-200 hover:text-ivory" onClick={() => setSettings(true)} aria-label={t('settings.title')} data-testid="settings-open">
              <SettingsIcon className="size-5" />
            </button>
            {me && (
              <button className="hidden whitespace-nowrap text-sm text-ink-300 hover:text-ivory lg:inline" onClick={signOut}>
                {t('nav.logout')}
              </button>
            )}
          </div>
        </div>
      </header>
      <ServiceBanner />
      <main className="mx-auto max-w-7xl px-4 pb-6 pt-6">{children}</main>
      <footer className="mx-auto max-w-7xl px-4 pb-24 sm:pb-8">
        <LegalLinks />
      </footer>
      <SettingsModal open={settings} onClose={() => setSettings(false)} onLogout={me ? signOut : undefined} />
      {/* Mobile bottom navigation */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex overflow-x-auto border-t border-gold-500/15 bg-ink-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden">
        <NavLink to="/" end className={tab}>
          {t('nav.lobby')}
        </NavLink>
        <NavLink to="/tournaments" className={tab} data-testid="nav-tournaments-mobile">
          {t('nav.tournamentsTab')}
        </NavLink>
        <NavLink to="/academy" className={tab} data-testid="nav-academy">
          {t('nav.academy')}
        </NavLink>
        <NavLink to="/board" className={tab}>
          {t('nav.board')}
        </NavLink>
        <NavLink to="/friends" className={tab} data-testid="nav-friends-mobile">
          {t('nav.friends')}
          <CountBadge n={social} className="absolute right-[calc(50%-1.6rem)] top-1.5" />
        </NavLink>
        <NavLink to="/me" className={tab}>
          {t('nav.me')}
        </NavLink>
      </nav>
    </div>
  );
}

export function AuthLayout({ children, title }: { children: ReactNode; title: string }) {
  const { t } = useI18n();
  return (
    <div className="relative flex min-h-dvh items-center justify-center px-4 py-10" style={{ background: 'var(--t-bg)' }}>
      <div className="absolute right-4 top-4">
        <LangToggle />
      </div>
      <div className="w-full max-w-sm animate-rise">
        <div className="mb-6 overflow-hidden rounded-xl empty:hidden">
          <ServiceBanner boardLinks={false} />
        </div>
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Logo size={112} />
          <div className="font-display text-2xl font-bold tracking-[0.3em] jc-gold-text">JC ROYAL</div>
          <div className="text-xs tracking-[0.12em] text-ink-300">{t('app.tagline')}</div>
        </div>
        <div className="jc-panel p-6">
          <h1 className="mb-5 text-lg font-bold">{title}</h1>
          {children}
        </div>
        <p className="mt-6 text-center text-[11px] text-ink-400">{t('app.virtual')}</p>
        <LegalLinks className="mt-2" />
      </div>
    </div>
  );
}
