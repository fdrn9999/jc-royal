import { formatChips, Logo } from '@jc/ui';
import { useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import { SettingsModal } from '../game/Panels';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useUnread } from '../lib/unread';

export function LangToggle() {
  const { locale } = useI18n();
  const { chooseLocale } = useAuth();
  return (
    <div className="flex rounded-full border border-white/10 p-0.5 text-[11px] font-semibold" role="group" aria-label="language">
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
    <span className={`grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-bold leading-4 text-white ${className}`} data-testid={testId}>
      {n > 99 ? '99+' : n}
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me, logout } = useAuth();
  const { t } = useI18n();
  const nav = useNavigate();
  const { unread, dmUnread, friendRequests } = useUnread();
  const [settings, setSettings] = useState(false);
  const social = dmUnread + friendRequests;
  async function signOut() {
    setSettings(false);
    await logout();
    nav('/login');
  }
  const tab = ({ isActive }: { isActive: boolean }) => `relative py-3 text-center text-[13px] font-semibold ${isActive ? 'text-gold-300' : 'text-ink-300'}`;
  const link = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-2 text-sm font-semibold tracking-wide transition ${isActive ? 'text-gold-300' : 'text-ink-300 hover:text-ivory'}`;
  return (
    <div className="min-h-dvh" style={{ background: 'var(--t-bg)' }}>
      <header className="sticky top-0 z-40 border-b border-gold-500/10 bg-ink-950/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4">
          <Link to="/" className="shrink-0" aria-label="JC ROYAL">
            <Logo size={38} withWordmark className="[&>span]:hidden sm:[&>span]:inline" />
          </Link>
          <nav className="ml-2 hidden items-center sm:flex">
            <NavLink to="/" end className={link}>
              {t('nav.lobby')}
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
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            {me && <BalancePill amount={me.balance} />}
            {me && (
              <Link to="/messages" className="relative rounded-full p-2 text-ink-200 hover:text-ivory" aria-label={`${t('nav.messages')}${unread ? ` (${unread})` : ''}`} data-testid="inbox-link">
                <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
                <CountBadge n={unread} testId="unread-badge" className="absolute -right-0.5 -top-0.5" />
              </Link>
            )}
            <span className="hidden md:inline"><LangToggle /></span>
            <button type="button" className="rounded-full p-2 text-ink-200 hover:text-ivory" onClick={() => setSettings(true)} aria-label={t('settings.title')} data-testid="settings-open">
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            {me && (
              <button className="hidden text-sm text-ink-300 hover:text-ivory sm:inline" onClick={signOut}>
                {t('nav.logout')}
              </button>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 pb-24 pt-6 sm:pb-10">{children}</main>
      <SettingsModal open={settings} onClose={() => setSettings(false)} onLogout={me ? signOut : undefined} />
      {/* Mobile bottom navigation */}
      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-gold-500/15 bg-ink-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden">
        <NavLink to="/" end className={tab}>
          {t('nav.lobby')}
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
      </div>
    </div>
  );
}
