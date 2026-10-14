import { Logo, Spinner } from '@jc/ui';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import { AppShell } from './components/AppShell';
import './index.css';
import { AuthProvider, useAuth } from './lib/auth';
import { I18nProvider, useI18n } from './lib/i18n';
import { applyInitialTheme } from './lib/prefs';
import { LoginPage, RegisterPage, ResetPage } from './pages/Auth';
import { BoardPage, PostEditorPage, PostPage } from './pages/Board';
import { LobbyPage } from './pages/Lobby';
import { MessagesPage } from './pages/Messages';
import { HandDetailPage, MePage } from './pages/Me';
import { TablePage } from './pages/Table';

applyInitialTheme();

function Splash() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4" style={{ background: 'var(--t-bg)' }}>
      <Logo size={88} />
      <Spinner className="text-gold-400" />
    </div>
  );
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
  { path: '/table/:id', element: <RequireAuth><TablePage /></RequireAuth> },
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
      { path: '/me', element: <MePage /> },
      { path: '/me/hands/:id', element: <HandDetailPage /> },
      { path: '/board', element: <BoardPage /> },
      { path: '/board/write', element: <PostEditorPage /> },
      { path: '/board/:id', element: <PostPage /> },
      { path: '/board/:id/edit', element: <PostEditorPage /> },
      { path: '/messages', element: <MessagesPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </I18nProvider>
  </StrictMode>,
);
