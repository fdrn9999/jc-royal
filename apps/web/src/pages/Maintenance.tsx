import { Button, Logo, Spinner } from '@jc/ui';
import { useEffect } from 'react';
import { Link } from 'react-router';
import { LangToggle, LegalLinks } from '../components/AppShell';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { refreshService, serverNow, useService, when } from '../lib/service';

/** Only this lazy page uses these lines, so they live here instead of the dictionary in the entry bundle. */
const COPY = {
  ko: {
    title: '서비스 점검 안내',
    none: '예정된 점검이 없습니다. 정상적으로 이용할 수 있습니다.',
    active: '지금 서비스 점검 중입니다.',
    scheduled: '서비스 점검이 예정되어 있습니다.',
    period: '점검 시간',
    rules: '점검 중에는 새 게임 입장과 새 핸드가 멈춥니다. 이미 진행 중이던 핸드는 끝까지 진행되며, 테이블과 지갑의 칩은 그대로 보관됩니다.',
    board: '점검 중에는 게시판 글과 댓글 쓰기도 멈춥니다. 읽기와 내 글 삭제는 그대로 할 수 있습니다.',
    login: '점검 중에는 새 로그인과 회원가입도 잠시 제한됩니다. 이미 로그인한 상태는 유지됩니다.',
    resume: '점검이 끝나면 자동으로 정상 운영이 재개되며, 이 화면도 30초마다 상태를 확인합니다.',
  },
  en: {
    title: 'Service maintenance',
    none: 'No maintenance is scheduled. Everything is running normally.',
    active: 'Maintenance is under way.',
    scheduled: 'Maintenance is scheduled.',
    period: 'Window',
    rules: 'During maintenance no one can join a game and no new hand starts. A hand already in progress plays to the end, and chips at tables and in wallets stay where they are.',
    board: 'New posts and comments on the board are paused as well. You can still read and delete your own.',
    login: 'New sign-ins and sign-ups are also paused during maintenance. If you are already signed in, you stay signed in.',
    resume: 'Play resumes on its own when maintenance ends; this page checks every 30 seconds.',
  },
};
/** Public maintenance page: when it runs, what it means for play, and that it is over once it is (checked every 30 s). */
export function MaintenancePage() {
  const st = useService();
  const { t, locale } = useI18n();
  const { me } = useAuth();
  const c = COPY[locale];
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') refreshService();
    };
    tick();
    const h = setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(h);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  const now = serverNow();
  const m = st?.maintenance && st.maintenance.endsAt > now ? st.maintenance : null;
  const active = !!m && m.startsAt <= now;
  const message = m && (locale === 'en' ? m.messageEn : m.messageKo);
  return (
    <div className="relative flex min-h-dvh items-center justify-center px-4 py-10" style={{ background: 'var(--t-bg)' }}>
      <div className="absolute right-4 top-4">
        <LangToggle />
      </div>
      <div className="w-full max-w-md animate-rise">
        <div className="flex justify-center">
          <Logo size={88} />
        </div>
        <section className="jc-panel mt-6 p-6" data-testid="maintenance-page" aria-live="polite">
          <h1 className="text-lg font-bold">{c.title}</h1>
          {!st ? (
            <Spinner className="mt-4 text-gold-400" />
          ) : !m ? (
            <p className="mt-3 text-sm text-ink-200" data-testid="maintenance-none">
              {c.none}
            </p>
          ) : (
            <>
              <p className="mt-3 font-semibold text-gold-300" data-testid="maintenance-state">
                {active ? c.active : c.scheduled}
              </p>
              <p className="mt-2 text-sm">
                <span className="text-ink-400">{c.period} </span>
                <span className="font-mono tabular-nums">
                  {when(m.startsAt, locale)} – {when(m.endsAt, locale)}
                </span>
              </p>
              {message && <p className="mt-3 whitespace-pre-line text-sm text-ink-100">{message}</p>}
              <ul className="mt-4 list-disc space-y-1.5 pl-5 text-sm text-ink-200">
                <li>{c.rules}</li>
                <li>{c.board}</li>
                {m.blockLogin && <li>{c.login}</li>}
                <li>{c.resume}</li>
              </ul>
            </>
          )}
          <Link to={me ? '/' : '/login'} className="mt-5 block">
            <Button className="w-full">{me ? t('nav.lobby') : t('auth.login')}</Button>
          </Link>
        </section>
        <LegalLinks className="mt-4" />
      </div>
    </div>
  );
}
