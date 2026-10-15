import { Button, Input, Logo, Spinner } from '@jc/ui';
import { StrictMode, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, NavLink, Outlet, RouterProvider } from 'react-router';
import { setLocale, useT, type Key } from './i18n';
import './index.css';
import { roleLabel } from './labels';
import { AdminProvider, useAdmin } from './lib';
import { Modal } from './ui';
import { BoardAdminPage, MessagesAdminPage } from './pages/Community';
import { LoginPage } from './pages/Login';
import { ReportsPage } from './pages/Reports';
import { SecurityPage } from './pages/Security';
import { ServicePage } from './pages/Service';
import { StatsPage } from './pages/Stats';
import { DashboardPage } from './pages/Dashboard';
import { EconomyPage, ReconcilePage } from './pages/Economy';
import { AuditPage } from './pages/Audit';
import { AcademyStatsPage, HandDetailPage, HandsPage, LedgerPage, TableDetailPage, TablesPage, UserDetailPage, UsersPage } from './pages/Console';

const NAV: [string, Key][] = [
  ['/', 'dashboard'],
  ['/stats', 'opsStats'],
  ['/users', 'users'],
  ['/tables', 'tables'],
  ['/academy', 'academy'],
  ['/hands', 'hands'],
  ['/ledger', 'ledger'],
  ['/economy', 'economy'],
  ['/reports', 'reports'],
  ['/board', 'board'],
  ['/messages', 'messages'],
  ['/service', 'service'],
  ['/reconcile', 'reconcile'],
  ['/audit', 'audit'],
  ['/security', 'security'],
];

function ReauthModal() {
  const { t } = useT();
  const { reauthPrompt } = useAdmin();
  const [pw, setPw] = useState('');
  return (
    <Modal
      open={reauthPrompt.open}
      onClose={reauthPrompt.cancel}
      title={t('reauth')}
      footer={
        <>
          <Button variant="ghost" onClick={reauthPrompt.cancel}>{t('cancel')}</Button>
          <Button disabled={!pw} onClick={() => { reauthPrompt.confirm(pw); setPw(''); }} data-testid="reauth-confirm">{t('confirm')}</Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-ink-200">{t('reauthHint')}</p>
      <Input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pw && (reauthPrompt.confirm(pw), setPw(''))} aria-label={t('password')} />
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
  return (
    <div className="min-h-dvh" style={{ background: 'var(--t-bg)' }}>
      <header className="sticky top-0 z-30 border-b border-gold-500/10 bg-ink-950/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
          <Logo size={30} />
          <span className="hidden whitespace-nowrap font-display text-sm font-bold tracking-[0.2em] jc-gold-text sm:inline">JC ROYAL</span>
          <span className="rounded bg-danger/20 px-1.5 py-0.5 text-[10px] font-bold text-[#f0a0a2]">ADMIN</span>
          <span className="ml-auto truncate text-xs text-ink-300">{me?.user.nickname} · {roleLabel(t, me?.user.role)}</span>
          <button className="shrink-0 whitespace-nowrap text-xs text-ink-300" onClick={() => setLocale(locale === 'ko' ? 'en' : 'ko')}>{locale === 'ko' ? 'EN' : '한국어'}</button>
          <Button size="sm" variant="ghost" onClick={logout}>{t('logout')}</Button>
        </div>
        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-2 md:flex-wrap">
          {NAV.map(([to, k]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `shrink-0 rounded-full px-3 py-1 text-sm font-semibold ${isActive ? 'bg-gold-500/15 text-gold-300' : 'text-ink-300 hover:text-ivory'}`}>
              {t(k)}
            </NavLink>
          ))}
        </nav>
        <ConnectionBanner />
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      <ReauthModal />
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
      { path: '/', element: <DashboardPage /> },
      { path: '/stats', element: <StatsPage /> },
      { path: '/users', element: <UsersPage /> },
      { path: '/users/:id', element: <UserDetailPage /> },
      { path: '/tables', element: <TablesPage /> },
      { path: '/tables/:id', element: <TableDetailPage /> },
      { path: '/hands', element: <HandsPage /> },
      { path: '/hands/:id', element: <HandDetailPage /> },
      { path: '/ledger', element: <LedgerPage /> },
      { path: '/economy', element: <EconomyPage /> },
      { path: '/reconcile', element: <ReconcilePage /> },
      { path: '/audit', element: <AuditPage /> },
      { path: '/security', element: <SecurityPage /> },
      { path: '/academy', element: <AcademyStatsPage /> },
      { path: '/reports', element: <ReportsPage /> },
      { path: '/board', element: <BoardAdminPage /> },
      { path: '/messages', element: <MessagesAdminPage /> },
      { path: '/service', element: <ServicePage /> },
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
