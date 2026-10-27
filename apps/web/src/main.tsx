import { Button, Logo, Spinner } from '@jc/ui';
import { lazy, StrictMode, Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, Outlet, useLocation, useRouteError } from 'react-router';
// The react-dom build of the provider: it honours `flushSync` on a navigation (the hand filters use it).
import { RouterProvider } from 'react-router/dom';
import { startAcademySync } from './academy/sync';
import { AppShell } from './components/AppShell';
import './index.css';
import { AuthProvider, useAuth } from './lib/auth';
import { I18nProvider, initialLocale, loadLocale, useI18n } from './lib/i18n';
import { startInstallWatch } from './lib/install';
import { applyInitialTheme, closeAccount, openAccount, setSyncState } from './lib/prefs';
import { startPresence } from './lib/presence';
import { followPushTaps } from './lib/push-nav';
import { reportWebError, watchWebErrors } from './lib/webErrors';
import { LoginPage, ResetPage } from './pages/Auth';
import { LobbyPage } from './pages/Lobby';

applyInitialTheme();
// Before the browser can offer its install prompt, so the lobby and settings can hand it on.
startInstallWatch();

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
    C = lazy<ComponentType>(() =>
      loadAcademy().then(
        (m) => ({ default: m[page] }),
        (error: unknown) => ({ default: () => <ReloadFor error={error} /> }),
      ),
    );
    academyPages.set(page, C);
  }
  return (
    <Suspense fallback={<Splash />}>
      <C />
    </Suspense>
  );
}

/** The full policy texts are long and rarely read, so they load on demand like the Academy (and, like it, see ReloadFor). */
const LegalPage = lazy<ComponentType<{ kind: 'privacy' | 'terms' }>>(() =>
  import('./pages/Legal').then(
    (m) => ({ default: m.LegalPage }),
    (error: unknown) => ({ default: () => <ReloadFor error={error} /> }),
  ),
);
function Legal({ kind }: { kind: 'privacy' | 'terms' }) {
  return (
    <Suspense fallback={<Splash />}>
      <LegalPage kind={kind} />
    </Suspense>
  );
}

/**
 * In place of a page whose code would not load (after a deploy the files a page opened before it named are gone): online,
 * the page loads again, from the deploy, at most once a minute; else the error shows. Only once it is on screen: a load
 * that fails after someone went on to another page (a table) reloads nothing there.
 */
function ReloadFor({ error }: { error: unknown }): ReactNode {
  // Decided once as it comes on screen: the reload below marks the minute, which must not turn it into the error meanwhile.
  const [reload, setReload] = useState(() => {
    try {
      return navigator.onLine && Date.now() - Number(sessionStorage.getItem('jc.reloadedFor') ?? 0) > 60_000;
    } catch {
      return false; // no storage: the error shows
    }
  });
  useEffect(() => {
    if (!reload) return;
    try {
      sessionStorage.setItem('jc.reloadedFor', String(Date.now()));
    } catch {
      setReload(false); // the minute cannot be marked (storage full): the error shows rather than risk a loop
      return;
    }
    location.reload();
  }, [reload]);
  if (!reload) throw error;
  return <Splash />;
}

/** My page (with the statistics), the board, friends and messages are away from the lobby and the table, so they load on demand too. */
function onDemand<M extends Record<string, unknown>>(load: () => Promise<M>, name: keyof M & string) {
  const C = lazy<ComponentType>(() =>
    load().then(
      (m) => ({ default: m[name] as ComponentType }),
      (error: unknown) => ({ default: () => <ReloadFor error={error} /> }),
    ),
  );
  return (
    <Suspense fallback={<Splash />}>
      <C />
    </Suspense>
  );
}
const loadMe = () => import('./pages/Me');
const loadHands = () => import('./pages/Hands');
const loadBoard = () => import('./pages/Board');
const loadMaintenance = () => import('./pages/Maintenance');
const loadFriends = () => import('./pages/Friends');
const loadMessages = () => import('./pages/Messages');
const loadTournaments = () => import('./pages/Tournaments');
/** Sign-up (its fields, consent and e-mail check) is opened once per member, so it is not in the first screen's code either. */
const loadRegister = () => import('./pages/Register');
/** The advanced (GTO) course is its own chunk: the beginner academy never fetches it. */
const loadGto = () => import('./academy/gto/routes');

/**
 * The table (its scene, layout, cues and controls) loads on demand as well, so sign-in and the lobby come up sooner.
 * Signed in, it is fetched once the browser is idle after the first screen, so a table seldom waits for it.
 */
const loadTable = () => import('./pages/Table');
function PrefetchTable() {
  useEffect(() => {
    const go = () => void loadTable().catch(() => {});
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(go, { timeout: 5000 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(go, 2000);
    return () => clearTimeout(id);
  }, []);
  return null;
}

/** Keeps Academy progress in sync with the server while someone is signed in. */
function AcademySync() {
  const { me } = useAuth();
  useEffect(() => (me ? startAcademySync(me.id) : undefined), [me?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** Tells friends this member is here while signed in (lib/presence.ts); signed out, or another account, it stops. */
function PresenceSync() {
  const { me } = useAuth();
  useEffect(() => (me ? startPresence(me.id) : undefined), [me?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/**
 * Push notifications in this browser (lib/push.ts): the service worker is told who is signed in. Loaded only once the
 * sign-in is known, and does nothing where pushes were never turned on. (A tapped push: followPushTaps below.)
 */
function PushSync() {
  const { me, loading } = useAuth();
  const id = me?.id ?? null;
  useEffect(() => {
    if (loading) return;
    let gone = false;
    let stop: (() => void) | undefined;
    import('./lib/push').then(
      (m) => {
        if (!gone) stop = m.startPush(id);
      },
      () => undefined,
    );
    return () => {
      gone = true;
      stop?.();
    };
  }, [id, loading]);
  return null;
}

/**
 * The account's settings and favourite tables while someone is signed in (prefs.ts); signed out, or another account,
 * the previous one's leave the screen. The sync loads on demand: the settings already apply from this device meanwhile.
 */
function SettingsSync() {
  const { me, loading, refresh } = useAuth();
  const id = me?.id;
  useEffect(() => {
    if (loading) return;
    if (!id) {
      closeAccount();
      return;
    }
    openAccount(id);
    let gone = false;
    let stop: (() => void) | undefined;
    import('./lib/settings-sync').then(
      (m) => {
        if (!gone) stop = m.startSettingsSync(id, () => void refresh().catch(() => {}));
      },
      () => setSyncState('error'),
    );
    return () => {
      gone = true;
      stop?.();
      closeAccount();
    };
  }, [id, loading]); // eslint-disable-line react-hooks/exhaustive-deps
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

/**
 * In place of a page that broke, or whose code would not load again within the minute (ReloadFor): says so, with a way
 * to load it again, rather than the router's bare error text.
 */
function RouteError() {
  const { t } = useI18n();
  const error = useRouteError();
  useEffect(() => {
    console.error('[route] the page broke', error);
    reportWebError();
  }, [error]);
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center" style={{ background: 'var(--t-bg)' }} role="alert" data-testid="route-error">
      <Logo size={64} />
      <p className="text-sm text-ink-200">{t('common.error')}</p>
      <Button variant="outline" onClick={() => location.reload()} data-testid="route-error-retry">
        {t('common.retry')}
      </Button>
    </div>
  );
}

const router = createBrowserRouter([
  {
    errorElement: <RouteError />,
    children: [
      { path: '/login', element: <GuestOnly><LoginPage /></GuestOnly> },
      { path: '/register', element: <GuestOnly>{onDemand(loadRegister, 'RegisterPage')}</GuestOnly> },
      { path: '/reset', element: <ResetPage /> },
      // Public: sign-up links here before anyone has an account.
      { path: '/privacy', element: <Legal kind="privacy" /> },
      { path: '/terms', element: <Legal kind="terms" /> },
      // Public as well: sign-in may be paused while it runs.
      { path: '/maintenance', element: onDemand(loadMaintenance, 'MaintenancePage') },
      { path: '/table/:id', element: <RequireAuth>{onDemand(loadTable, 'TableRoute')}</RequireAuth> },
      { path: '/academy/practice/free', element: <RequireAuth><Academy page="FreePracticePage" /></RequireAuth> },
      { path: '/academy/practice/:id', element: <RequireAuth><Academy page="PracticeTablePage" /></RequireAuth> },
      {
        element: (
          <RequireAuth>
            <PrefetchTable />
            <AppShell>
              <Outlet />
            </AppShell>
          </RequireAuth>
        ),
        children: [
          { path: '/', element: <LobbyPage /> },
          { path: '/me', element: onDemand(loadMe, 'MePage') },
          { path: '/me/hands', element: onDemand(loadHands, 'HandsPage') },
          { path: '/me/hands/:id', element: onDemand(loadMe, 'HandDetailPage') },
          { path: '/tournaments', element: onDemand(loadTournaments, 'TournamentsPage') },
          { path: '/tournaments/:id', element: onDemand(loadTournaments, 'TournamentPage') },
          { path: '/board', element: onDemand(loadBoard, 'BoardPage') },
          { path: '/board/write', element: onDemand(loadBoard, 'PostEditorPage') },
          { path: '/board/:id', element: onDemand(loadBoard, 'PostPage') },
          { path: '/board/:id/edit', element: onDemand(loadBoard, 'PostEditorPage') },
          { path: '/messages', element: onDemand(loadMessages, 'MessagesPage') },
          { path: '/friends', element: onDemand(loadFriends, 'FriendsPage') },
          { path: '/friends/settings', element: onDemand(loadFriends, 'FriendSettingsPage') },
          { path: '/friends/:userId', element: onDemand(loadFriends, 'ConversationPage') },
          { path: '/academy', element: <Academy page="AcademyPage" /> },
          { path: '/academy/cards', element: <Academy page="CardsLesson" /> },
          { path: '/academy/hands', element: <Academy page="HandsLesson" /> },
          { path: '/academy/holdem', element: <Academy page="HoldemLesson" /> },
          { path: '/academy/actions', element: <Academy page="ActionsLesson" /> },
          { path: '/academy/practice', element: <Academy page="PracticeListPage" /> },
          { path: '/academy/progress', element: <Academy page="ProgressPage" /> },
          { path: '/academy/review', element: <Academy page="ReviewPage" /> },
          {
            path: '/academy/gto',
            element: onDemand(loadGto, 'GtoLayout'),
            children: [
              { index: true, element: onDemand(loadGto, 'GtoHome') },
              { path: 'quiz', element: onDemand(loadGto, 'GtoQuizPage') },
              { path: 'hands', element: onDemand(loadGto, 'GtoHandsPage') },
              { path: 'glossary', element: onDemand(loadGto, 'GtoGlossaryPage') },
              { path: 'review', element: onDemand(loadGto, 'GtoReviewPage') },
              { path: ':module', element: onDemand(loadGto, 'GtoModulePage') },
            ],
          },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
]);
// From the start, before the sign-in is known: a tapped push that brought this window forward opens its page here.
followPushTaps((url) => void router.navigate(url));

watchWebErrors();

// English is a separate chunk: load it first for someone who chose it, so the first screen is not Korean.
const render = () =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider>
        <AuthProvider>
          <AcademySync />
          <SettingsSync />
          <PresenceSync />
          <PushSync />
          <RouterProvider router={router} />
        </AuthProvider>
      </I18nProvider>
    </StrictMode>,
  );
loadLocale(initialLocale()).then(render, render);
