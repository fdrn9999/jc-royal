import { Button, Logo, PasswordInput, Spinner } from '@jc/ui';
import { lazy, StrictMode, Suspense, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, NavLink, Outlet, RouterProvider, useLocation } from 'react-router';
import { setLocale, useT, type Key } from './i18n';
import './index.css';
import { roleLabel } from './labels';
import { AdminProvider, hasGrant, useAdmin } from './lib';
import { keepJumps, Modal } from './ui';
import { LoginPage } from './pages/Login';

/**
 * In place of a page whose code would not load (after a deploy the files the console opened with are gone): online, the
 * console loads again, from the deploy, at most once a minute; else the error shows (the member site's ReloadFor).
 */
function ReloadFor({ error }: { error: unknown }): ReactNode {
  // Decided once as it comes on screen: the reload below marks the minute, which must not turn it into the error meanwhile.
  const [reload, setReload] = useState(() => {
    try {
      return navigator.onLine && Date.now() - Number(sessionStorage.getItem('jc.admin.reloadedFor') ?? 0) > 60_000;
    } catch {
      return false; // no storage: the error shows
    }
  });
  useEffect(() => {
    if (!reload) return;
    try {
      sessionStorage.setItem('jc.admin.reloadedFor', String(Date.now()));
    } catch {
      setReload(false); // the minute cannot be marked (storage full): the error shows rather than risk a loop
      return;
    }
    location.reload();
  }, [reload]);
  if (!reload) throw error;
  return <PageLoading />;
}

function PageLoading() {
  return <div className="flex justify-center py-16"><Spinner className="text-gold-400" /></div>;
}

/** In a page's place, under the console's header and menu, when it broke or its code would not load (ReloadFor). */
function PageError() {
  const { t } = useT();
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 p-5 text-sm" data-testid="page-error">
      <p>{t('pageLoadError')}</p>
      <Button size="sm" onClick={() => location.reload()}>{t('pageReload')}</Button>
    </div>
  );
}

/** A page whose code loads when it is first opened: the console's first screen does not carry every page (1.29 MB in one file before). */
function page<M extends Record<string, unknown>>(load: () => Promise<M>, name: keyof M & string) {
  return lazy<ComponentType>(() =>
    load().then(
      (m) => ({ default: m[name] as ComponentType }),
      (error: unknown) => ({ default: () => <ReloadFor error={error} /> }),
    ),
  );
}
const loadCommunity = () => import('./pages/Community');
const loadOps = () => import('./pages/Ops');
const loadEconomy = () => import('./pages/Economy');
const loadTournaments = () => import('./pages/Tournaments');
const loadConsole = () => import('./pages/Console');
const BoardAdminPage = page(loadCommunity, 'BoardAdminPage');
const MessagesAdminPage = page(loadCommunity, 'MessagesAdminPage');
const ReportsPage = page(() => import('./pages/Reports'), 'ReportsPage');
const SecurityPage = page(() => import('./pages/Security'), 'SecurityPage');
const BrandPage = page(() => import('./pages/Brand'), 'BrandPage');
const ServicePage = page(() => import('./pages/Service'), 'ServicePage');
const SocialPage = page(() => import('./pages/Social'), 'SocialPage');
const StatsPage = page(() => import('./pages/Stats'), 'StatsPage');
const ControlCenterPage = page(() => import('./pages/ControlCenter'), 'ControlCenterPage');
const OpsPage = page(loadOps, 'OpsPage');
const OpsIncidentPage = page(loadOps, 'OpsIncidentPage');
const DashboardPage = page(() => import('./pages/Dashboard'), 'DashboardPage');
const EconomyPage = page(loadEconomy, 'EconomyPage');
const ReconcilePage = page(loadEconomy, 'ReconcilePage');
const RefillPage = page(() => import('./pages/Refill'), 'RefillPage');
const BotsPage = page(() => import('./pages/Bots'), 'BotsPage');
const TimeBankPage = page(() => import('./pages/TimeBank'), 'TimeBankPage');
const TournamentsPage = page(loadTournaments, 'TournamentsPage');
const TournamentTemplatesPage = page(loadTournaments, 'TournamentTemplatesPage');
const TournamentDetailPage = page(loadTournaments, 'TournamentDetailPage');
const ReferralsPage = page(() => import('./pages/Referrals'), 'ReferralsPage');
const AuditPage = page(() => import('./pages/Audit'), 'AuditPage');
const AcademyStatsPage = page(loadConsole, 'AcademyStatsPage');
const HandDetailPage = page(loadConsole, 'HandDetailPage');
const HandsPage = page(loadConsole, 'HandsPage');
const LedgerPage = page(loadConsole, 'LedgerPage');
const TableDetailPage = page(loadConsole, 'TableDetailPage');
const TablesPage = page(loadConsole, 'TablesPage');
const UserDetailPage = page(loadConsole, 'UserDetailPage');
const UsersPage = page(loadConsole, 'UsersPage');

/** Menu entries with the feature switches whose pages they open (any one; none: every administrator). */
const NAV: [string, Key, string[]][] = [
  ['/', 'dashboard', ['dashboard']],
  ['/control-center', 'controlCenter', ['tables']],
  ['/ops', 'opsLog', ['tables']],
  ['/stats', 'opsStats', ['stats']],
  ['/users', 'users', ['members']],
  ['/tables', 'tables', ['tables']],
  ['/bots', 'botsNav', ['bots']],
  ['/tournaments', 'tournamentsNav', ['tournaments']],
  ['/referrals', 'referralNav', ['referral']],
  ['/academy', 'academy', ['stats']],
  ['/hands', 'hands', ['hands']],
  ['/ledger', 'ledger', ['ledger']],
  ['/economy', 'economy', ['economy', 'refill']],
  ['/reports', 'reports', ['reports']],
  ['/board', 'board', ['board']],
  ['/messages', 'messages', ['messages']],
  ['/service', 'service', ['notices', 'maintenance']],
  ['/reconcile', 'reconcile', ['reconcile']],
  ['/audit', 'audit', []],
  ['/security', 'security', []],
];

/**
 * The password asked again before a sensitive change (every one goes through here: lib.tsx's api). What was typed is
 * sent once and forgotten: cleared when it is sent and whenever the prompt closes, however it closed, so the prompt
 * opens again empty, with the password hidden.
 */
function ReauthModal() {
  const { t } = useT();
  const { reauthPrompt } = useAdmin();
  const [pw, setPw] = useState('');
  useEffect(() => {
    if (!reauthPrompt.open) setPw('');
  }, [reauthPrompt.open]);
  const submit = () => {
    if (!pw) return;
    reauthPrompt.confirm(pw);
    setPw('');
  };
  return (
    <Modal
      open={reauthPrompt.open}
      onClose={reauthPrompt.cancel}
      title={t('reauth')}
      footer={
        <>
          <Button variant="ghost" onClick={reauthPrompt.cancel}>{t('cancel')}</Button>
          <Button disabled={!pw} onClick={submit} data-testid="reauth-confirm">{t('confirm')}</Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-ink-200">{t('reauthHint')}</p>
      <PasswordInput
        autoComplete="current-password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && submit()}
        aria-label={t('password')}
        showLabel={t('showPassword')}
        hideLabel={t('hidePassword')}
        data-testid="reauth-password"
      />
      {reauthPrompt.error && <p className="mt-2 text-sm text-danger" role="alert">{reauthPrompt.error}</p>}
    </Modal>
  );
}

/**
 * Shown while the browser is offline, or while the API cannot be reached (the last request failed before any answer).
 * What the pages show stays as last loaded; it clears by itself with the next answer or when the browser is back.
 */
function ConnectionBanner() {
  const { t } = useT();
  const { net } = useAdmin();
  if (!net.offline && !net.unreachable) return null;
  return (
    <div role="alert" className="border-b border-danger/40 bg-danger/15 px-4 py-2 text-center text-sm text-[#f3b0b2]" data-testid="conn-banner">
      {t(net.offline ? 'connOffline' : 'connUnreachable')}
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { t, locale } = useT();
  const { me, logout } = useAdmin();
  // The control center fills a wide screen (its grid and the table opened beside it); every other page keeps the column.
  const wide = useLocation().pathname === '/control-center' ? 'max-w-[1920px]' : 'max-w-7xl';
  // The header's height (its menu wraps, the connection banner comes and goes) as --shell-h: a pinned result and a
  // jump link's panel stop under it.
  const header = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = header.current;
    if (!el) return;
    const keep = () => document.documentElement.style.setProperty('--shell-h', `${el.offsetHeight}px`);
    keep();
    const ro = new ResizeObserver(keep);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A jump link's panel stays where it landed while the panels above it load.
  useEffect(() => keepJumps(), []);
  return (
    <div className="min-h-dvh" style={{ background: 'var(--t-bg)' }}>
      <header ref={header} className="sticky top-0 z-30 border-b border-gold-500/10 bg-ink-950/90 backdrop-blur">
        <div className={`mx-auto flex h-14 ${wide} items-center gap-3 px-4`}>
          <Logo size={30} />
          <span className="hidden whitespace-nowrap font-display text-sm font-bold tracking-[0.2em] jc-gold-text sm:inline">JC ROYAL</span>
          <span className="rounded bg-danger/20 px-1.5 py-0.5 text-[10px] font-bold text-[#f0a0a2]">ADMIN</span>
          <span className="ml-auto truncate text-xs text-ink-300">{me?.user.nickname} · {roleLabel(t, me?.user.role)}</span>
          <button className="shrink-0 whitespace-nowrap text-xs text-ink-300" onClick={() => setLocale(locale === 'ko' ? 'en' : 'ko')}>{locale === 'ko' ? 'EN' : '한국어'}</button>
          <Button size="sm" variant="ghost" onClick={logout}>{t('logout')}</Button>
        </div>
        <nav className={`mx-auto flex ${wide} gap-1 overflow-x-auto px-4 pb-2 md:flex-wrap`}>
          {NAV.filter(([, , g]) => g.length === 0 || g.some((x) => hasGrant(me, x))).map(([to, k]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `shrink-0 rounded-full px-3 py-1 text-sm font-semibold ${isActive ? 'bg-gold-500/15 text-gold-300' : 'text-ink-300 hover:text-ivory'}`}>
              {t(k)}
            </NavLink>
          ))}
        </nav>
        <ConnectionBanner />
      </header>
      <main className={`mx-auto ${wide} px-4 py-6`}>
        <Suspense fallback={<PageLoading />}>{children}</Suspense>
      </main>
      <ReauthModal />
    </div>
  );
}

/** The first page: the dashboard, or where to look when it is switched off for this administrator. */
function Home() {
  const { t } = useT();
  const { me } = useAdmin();
  if (hasGrant(me, 'dashboard')) return <DashboardPage />;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-white/10 p-5 text-sm" data-testid="home-off">
      <h1 className="text-xl font-extrabold">{t('dashboard')}</h1>
      <p className="text-ink-300">{t('homeOff')}</p>
      <NavLink to="/security" className="text-gold-300 hover:underline">{t('secMine')} →</NavLink>
    </div>
  );
}

function Gate() {
  const { me, loading } = useAdmin();
  if (loading) return <div className="flex min-h-dvh items-center justify-center"><Spinner className="text-gold-400" /></div>;
  if (!me) return <LoginPage />;
  return <Shell><Outlet /></Shell>;
}

const router = createBrowserRouter([
  {
    element: <Gate />,
    children: [
      {
        errorElement: <PageError />,
        children: [
          { path: '/', element: <Home /> },
          { path: '/control-center', element: <ControlCenterPage /> },
          { path: '/ops', element: <OpsPage /> },
          { path: '/ops/alerts/:id', element: <OpsIncidentPage /> },
          { path: '/stats', element: <StatsPage /> },
          { path: '/users', element: <UsersPage /> },
          { path: '/users/:id', element: <UserDetailPage /> },
          { path: '/tables', element: <TablesPage /> },
          { path: '/tables/time-bank', element: <TimeBankPage /> },
          { path: '/tables/social', element: <SocialPage /> },
          { path: '/tables/:id', element: <TableDetailPage /> },
          { path: '/bots', element: <BotsPage /> },
          { path: '/tournaments', element: <TournamentsPage /> },
          { path: '/tournaments/templates', element: <TournamentTemplatesPage /> },
          { path: '/tournaments/:id', element: <TournamentDetailPage /> },
          { path: '/referrals', element: <ReferralsPage /> },
          { path: '/hands', element: <HandsPage /> },
          { path: '/hands/:id', element: <HandDetailPage /> },
          { path: '/ledger', element: <LedgerPage /> },
          { path: '/economy', element: <EconomyPage /> },
          { path: '/economy/refill', element: <RefillPage /> },
          { path: '/reconcile', element: <ReconcilePage /> },
          { path: '/audit', element: <AuditPage /> },
          { path: '/security', element: <SecurityPage /> },
          { path: '/academy', element: <AcademyStatsPage /> },
          { path: '/reports', element: <ReportsPage /> },
          { path: '/board', element: <BoardAdminPage /> },
          { path: '/messages', element: <MessagesAdminPage /> },
          { path: '/service', element: <ServicePage /> },
          { path: '/service/brand', element: <BrandPage /> },
        ],
      },
    ],
  },
]);

document.documentElement.dataset.theme = 'royal';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AdminProvider>
      <RouterProvider router={router} />
    </AdminProvider>
  </StrictMode>,
);
