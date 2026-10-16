import { Logo, Spinner } from '@jc/ui';
import { lazy, StrictMode, Suspense, useEffect, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import { startAcademySync } from './academy/sync';
import { AppShell } from './components/AppShell';
import './index.css';
import { AuthProvider, useAuth } from './lib/auth';
import { I18nProvider, initialLocale, loadLocale, useI18n } from './lib/i18n';
import { applyInitialTheme } from './lib/prefs';
import { LoginPage, RegisterPage, ResetPage } from './pages/Auth';
import { ConversationPage, FriendSettingsPage, FriendsPage } from './pages/Friends';
import { LobbyPage } from './pages/Lobby';
import { MessagesPage } from './pages/Messages';
import { TableRoute } from './pages/Table';

applyInitialTheme();

function Splash() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4" style={{ background: 'var(--t-bg)' }}>
      <Logo size={88} />
      <Spinner className="text-gold-400" />
    </div>
  );
}

/** Academy pages share one lazy chunk so the offline engine never lands in the main bundle. */
const loadAcademy = () => import('./academy/routes');
type AcademyPageName = keyof Awaited<ReturnType<typeof loadAcademy>>;
const academyPages = new Map<AcademyPageName, ComponentType>();
function Academy({ page }: { page: AcademyPageName }) {
  let C = academyPages.get(page);
  if (!C) {
    C = lazy(() => loadAcademy().then((m) => ({ default: m[page] })));
    academyPages.set(page, C);
  }
  return (
    <Suspense fallback={<Splash />}>
      <C />
    </Suspense>
  );
}

/** The full policy texts are long and rarely read, so they load on demand like the Academy. */
const LegalPage = lazy(() => import('./pages/Legal').then((m) => ({ default: m.LegalPage })));
function Legal({ kind }: { kind: 'privacy' | 'terms' }) {
  return (
    <Suspense fallback={<Splash />}>
      <LegalPage kind={kind} />
    </Suspense>
  );
}

/** My page (with the statistics) and the board are away from the lobby and the table, so they load on demand too. */
function onDemand<M extends Record<string, unknown>>(load: () => Promise<M>, name: keyof M & string) {
  const C = lazy(() => load().then((m) => ({ default: m[name] as ComponentType })));
  return (
    <Suspense fallback={<Splash />}>
      <C />
    </Suspense>
  );
}
const loadMe = () => import('./pages/Me');
const loadBoard = () => import('./pages/Board');
const loadMaintenance = () => import('./pages/Maintenance');

/** Keeps Academy progress in sync with the server while someone is signed in. */
function AcademySync() {
  const { me } = useAuth();
  useEffect(() => (me ? startAcademySync(me.id) : undefined), [me?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Splash />;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return <>{children}</>;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <Splash />;
  if (me) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function NotFound() {
  const { t } = useI18n();
  return <div className="py-20 text-center text-ink-300">{t('notFound')}</div>;
}

const router = createBrowserRouter([
  { path: '/login', element: <GuestOnly><LoginPage /></GuestOnly> },
  { path: '/register', element: <GuestOnly><RegisterPage /></GuestOnly> },
  { path: '/reset', element: <ResetPage /> },
  // Public: sign-up links here before anyone has an account.
  { path: '/privacy', element: <Legal kind="privacy" /> },
  { path: '/terms', element: <Legal kind="terms" /> },
  // Public as well: sign-in may be paused while it runs.
  { path: '/maintenance', element: onDemand(loadMaintenance, 'MaintenancePage') },
  { path: '/table/:id', element: <RequireAuth><TableRoute /></RequireAuth> },
  { path: '/academy/practice/free', element: <RequireAuth><Academy page="FreePracticePage" /></RequireAuth> },
  { path: '/academy/practice/:id', element: <RequireAuth><Academy page="PracticeTablePage" /></RequireAuth> },
  {
    element: (
      <RequireAuth>
        <AppShell>
          <Outlet />
        </AppShell>
      </RequireAuth>
    ),
    children: [
      { path: '/', element: <LobbyPage /> },
      { path: '/me', element: onDemand(loadMe, 'MePage') },
      { path: '/me/hands/:id', element: onDemand(loadMe, 'HandDetailPage') },
      { path: '/board', element: onDemand(loadBoard, 'BoardPage') },
      { path: '/board/write', element: onDemand(loadBoard, 'PostEditorPage') },
      { path: '/board/:id', element: onDemand(loadBoard, 'PostPage') },
      { path: '/board/:id/edit', element: onDemand(loadBoard, 'PostEditorPage') },
      { path: '/messages', element: <MessagesPage /> },
      { path: '/friends', element: <FriendsPage /> },
      { path: '/friends/settings', element: <FriendSettingsPage /> },
      { path: '/friends/:userId', element: <ConversationPage /> },
      { path: '/academy', element: <Academy page="AcademyPage" /> },
      { path: '/academy/cards', element: <Academy page="CardsLesson" /> },
      { path: '/academy/hands', element: <Academy page="HandsLesson" /> },
      { path: '/academy/holdem', element: <Academy page="HoldemLesson" /> },
      { path: '/academy/actions', element: <Academy page="ActionsLesson" /> },
      { path: '/academy/practice', element: <Academy page="PracticeListPage" /> },
      { path: '/academy/progress', element: <Academy page="ProgressPage" /> },
      { path: '/academy/review', element: <Academy page="ReviewPage" /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

// English is a separate chunk: load it first for someone who chose it, so the first screen is not Korean.
const render = () =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider>
        <AuthProvider>
          <AcademySync />
          <RouterProvider router={router} />
        </AuthProvider>
      </I18nProvider>
    </StrictMode>,
  );
loadLocale(initialLocale()).then(render, render);
