/**
 * The member's daily and weekly challenges on the Me page (api lib/challenges.ts, docs/CHALLENGES.md). The server
 * judges them from the hands and tournaments it recorded and keeps each completion once per day or week; this only
 * shows its answer, and asking again judges again. The points are a progress figure, never chips.
 * Loaded with the Me page, so its text lives here rather than in the entry chunk.
 */
import { CHALLENGE_ACHIEVEMENT_AT, type ChallengeCode, type ChallengeDto, type ChallengesDto } from '@jc/types';
import { Badge, Button, createTranslator, cx, formatDate, Panel } from '@jc/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LoadFailed } from './Loading';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';

const ko = {
  title: '도전과제',
  day: '오늘',
  week: '이번 주',
  'p.day': '일일',
  'p.week': '주간',
  resets: '{at}에 새로 시작',
  done: '완료',
  doneAt: '{at} 완료',
  points: '+{n}점',
  progress: '{n}/{of}',
  total: '지금까지 {n}회 완료 · 진행 점수 {p}',
  achievement: '도전과제를 {at}번 완료하면 업적이 생깁니다.',
  note: '서버가 기록한 핸드와 공개 토너먼트로만 판정하며, 같은 기간에 한 번만 완료됩니다. 진행 점수는 칩이 아니고 지급되지 않습니다. 연습·아카데미는 세지 않습니다.',
  recent: '최근 완료',
  refresh: '다시 확인',
  loading: '불러오는 중…',
  'c.d_hands_10': '핸드 10회',
  'c.d_hands_10.d': '오늘 핸드 10회 플레이',
  'c.d_hands_30': '핸드 30회',
  'c.d_hands_30.d': '오늘 핸드 30회 플레이',
  'c.d_showdown_3': '쇼다운 3회',
  'c.d_showdown_3.d': '오늘 쇼다운까지 간 핸드 3회',
  'c.w_hands_100': '핸드 100회',
  'c.w_hands_100.d': '이번 주 핸드 100회 플레이',
  'c.w_days_3': '3일 플레이',
  'c.w_days_3.d': '이번 주 서로 다른 3일에 핸드 플레이',
  'c.w_tournaments_2': '토너먼트 2회',
  'c.w_tournaments_2.d': '이번 주 공개 토너먼트 2회 참가',
} as const;

const en: Record<keyof typeof ko, string> = {
  title: 'Challenges',
  day: 'Today',
  week: 'This week',
  'p.day': 'Daily',
  'p.week': 'Weekly',
  resets: 'Starts over {at}',
  done: 'Done',
  doneAt: 'Done {at}',
  points: '+{n} pts',
  progress: '{n}/{of}',
  total: 'Completed so far: {n} · progress points {p}',
  achievement: 'Completing {at} challenges gives an achievement.',
  note: 'Judged only from the hands and public tournaments the server recorded, and completed once per period. Progress points are not chips and pay nothing. Practice and the Academy do not count.',
  recent: 'Recently completed',
  refresh: 'Check again',
  loading: 'Loading…',
  'c.d_hands_10': '10 hands',
  'c.d_hands_10.d': 'Play 10 hands today',
  'c.d_hands_30': '30 hands',
  'c.d_hands_30.d': 'Play 30 hands today',
  'c.d_showdown_3': '3 showdowns',
  'c.d_showdown_3.d': 'Take 3 hands to showdown today',
  'c.w_hands_100': '100 hands',
  'c.w_hands_100.d': 'Play 100 hands this week',
  'c.w_days_3': '3 days',
  'c.w_days_3.d': 'Play hands on 3 different days this week',
  'c.w_tournaments_2': '2 tournaments',
  'c.w_tournaments_2.d': 'Play 2 public tournaments this week',
};

const translate = createTranslator({ ko, en });
type Tr = ReturnType<typeof translate>;

const name = (tr: Tr, code: ChallengeCode) => tr(`c.${code}`);

function Item({ tr, c, at }: { tr: Tr; c: ChallengeDto; at: (ms: number) => string }) {
  const pct = Math.round((c.progress / c.target) * 100);
  return (
    <li
      className={cx('flex flex-col gap-1.5 rounded-lg border px-3 py-2.5', c.done ? 'border-gold-500/40 bg-gold-500/[0.06]' : 'border-white/5 bg-ink-850/60')}
      data-testid="challenge"
      data-code={c.code}
      data-done={c.done ? '' : undefined}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 text-sm font-semibold text-ivory">{name(tr, c.code)}</span>
        <span className="shrink-0 text-xs text-ink-400">{tr('points', { n: c.points })}</span>
      </div>
      <p className="text-xs text-ink-300">{tr(`c.${c.code}.d`)}</p>
      <div className="flex items-center gap-2">
        <div
          className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10"
          role="progressbar"
          aria-label={name(tr, c.code)}
          aria-valuenow={c.progress}
          aria-valuemin={0}
          aria-valuemax={c.target}
        >
          <div className={cx('h-full rounded-full', c.done ? 'bg-gold-300' : 'bg-gradient-to-r from-gold-600 to-gold-300')} style={{ width: `${pct}%` }} />
        </div>
        <span className="shrink-0 font-mono text-xs tabular-nums text-ink-200" data-testid="challenge-progress">
          {tr('progress', { n: c.progress, of: c.target })}
        </span>
      </div>
      {c.done && c.completedAt !== null && (
        <div>
          <Badge tone="gold">{tr('doneAt', { at: at(c.completedAt) })}</Badge>
        </div>
      )}
    </li>
  );
}

/** The Me page's card: this day's and this week's challenges, what was completed so far, and the latest ones. */
export function ChallengesCard() {
  const { locale } = useI18n();
  const tr = translate(locale);
  const [data, setData] = useState<ChallengesDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<ChallengesDto>('/api/me/challenges');
      if (!alive.current) return;
      setData(d);
      setFailed(false);
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const at = (ms: number) => formatDate(ms, locale);

  return (
    <Panel
      title={tr('title')}
      actions={
        data && (
          <Button size="sm" variant="outline" className="min-h-10" loading={loading} onClick={() => void load()} data-testid="challenges-refresh">
            {tr('refresh')}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4" data-testid="challenges">
        {!data ? (
          failed ? <LoadFailed className="py-6" onRetry={() => void load()} /> : <p className="text-sm text-ink-400">{tr('loading')}</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {data.periods.map((p) => (
                <section key={p.period} aria-labelledby={`challenges-${p.period}`} data-testid={`challenges-${p.period}`}>
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <h3 id={`challenges-${p.period}`} className="text-sm font-semibold text-ink-100">
                      {tr(p.period)}
                    </h3>
                    <span className="text-[11px] text-ink-400">{tr('resets', { at: at(p.endsAt) })}</span>
                  </div>
                  <ul className="flex flex-col gap-2">
                    {data.items
                      .filter((c) => c.period === p.period)
                      .map((c) => (
                        <Item key={c.code} tr={tr} c={c} at={at} />
                      ))}
                  </ul>
                </section>
              ))}
            </div>
            <div className="flex flex-col gap-1 text-xs text-ink-400">
              <p className="text-sm text-ink-200" data-testid="challenges-total">
                {tr('total', { n: data.completed, p: data.points })}
              </p>
              <p>{tr('achievement', { at: CHALLENGE_ACHIEVEMENT_AT })}</p>
            </div>
            {data.recent.length > 0 && (
              <details className="text-sm" data-testid="challenges-recent">
                <summary className="min-h-10 cursor-pointer py-2 text-ink-200">{tr('recent')}</summary>
                <ul className="divide-y divide-white/5">
                  {data.recent.map((r) => (
                    <li key={`${r.code}-${r.completedAt}`} className="flex items-baseline justify-between gap-3 py-2">
                      <span className="min-w-0">
                        <span className="text-ink-100">{name(tr, r.code)}</span> <span className="text-xs text-ink-400">{tr(`p.${r.period}`)}</span>
                      </span>
                      <span className="shrink-0 text-xs text-ink-400">
                        {at(r.completedAt)} · {tr('points', { n: r.points })}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p className="text-xs text-ink-400">{tr('note')}</p>
          </>
        )}
      </div>
    </Panel>
  );
}
