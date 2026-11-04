/**
 * A member's profile card (/players/:id) and the season leaderboard (/leaderboard), both read from the server as it
 * lets them out (apps/api/src/routes/players.ts): achievements and statistics only as the member chose, never chips.
 * Loaded on demand, so the text lives here.
 */
import {
  ACHIEVEMENTS,
  LEADERBOARD,
  previousSeason,
  seasonOf,
  type AchievementCode,
  type LeaderboardDto,
  type LeaderboardRowDto,
  type PlayerCardDto,
  type StatRatio,
} from '@jc/types';
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, createTranslator, cx, Empty, LockIcon, MedalIcon, Panel, SettingsIcon } from '@jc/ui';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { isGone, LoadFailed, Loading } from '../components/Loading';
import { MemberName } from '../components/MemberName';
import { Avatar } from '../components/Social';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';

const ko = {
  card: '프로필',
  joined: '{date} 가입',
  selfNote: '다른 회원에게 보이는 내 카드입니다. 업적과 통계를 보일지는 공개 범위에서 정합니다.',
  privacy: '공개 범위',
  onlyMe: '나만 보임',
  notFound: '볼 수 없는 회원입니다.',
  achievements: '업적',
  achievementsCount: '업적 {n}/{of}',
  achievementsHidden: '이 회원은 업적을 공개하지 않습니다.',
  achievementsNote: '업적은 서버가 기록한 핸드와 토너먼트로만 정해지며 칩 보상은 없습니다. 메이드 핸드는 테이블에 공개된 카드만 셉니다.',
  notYet: '아직',
  challenges: '도전과제 {n}회 완료 · 진행 점수 {p}',
  stats: '통계',
  statsHidden: '이 회원은 통계를 공개하지 않습니다.',
  hands: '플레이한 핸드',
  tournamentWins: '토너먼트 우승',
  noSample: '표본 없음',
  'a.first_hand': '첫 핸드',
  'a.first_hand.d': '처음으로 핸드를 플레이했다',
  'a.first_win': '첫 승리',
  'a.first_win.d': '처음으로 팟을 땄다',
  'a.full_house': '풀하우스',
  'a.full_house.d': '풀하우스를 테이블에 공개했다',
  'a.quads': '포카드',
  'a.quads.d': '포카드를 테이블에 공개했다',
  'a.straight_flush': '스트레이트 플러시',
  'a.straight_flush.d': '스트레이트 플러시를 테이블에 공개했다',
  'a.hands_100': '100핸드',
  'a.hands_100.d': '핸드 100개를 플레이했다',
  'a.tournament_win': '토너먼트 우승',
  'a.tournament_win.d': '처음으로 토너먼트에서 우승했다',
  'a.streak_7': '7일 연속',
  'a.streak_7.d': '7일 연속으로 접속했다',
  'a.challenges_10': '도전과제 10개',
  'a.challenges_10.d': '도전과제를 10번 완료했다',
  board: '시즌 리더보드',
  season: '{season} 시즌',
  prev: '이전 시즌',
  next: '다음 시즌',
  rules: '무료 토너먼트 성적으로만 순위를 매깁니다(칩이나 플레이 시간은 보지 않음). 회원 {humans}명 이상이 끝까지 치른 토너먼트만 세고, {min}회 이상 치르면 순위에 오릅니다. 점수는 함께 끝까지 치른 상대 중 앞선 비율이며, 적은 판수로 높은 점수가 나오지 않게 보정합니다.',
  rank: '순위',
  player: '회원',
  played: '토너먼트',
  wins: '우승',
  score: '점수',
  mine: '내 기록',
  unranked: '순위 전 ({n}/{min}회)',
  empty: '이 시즌에 순위에 오른 회원이 아직 없습니다.',
  hidden: '리더보드에 나를 표시하지 않도록 설정했습니다.',
  rankedOf: '순위에 오른 회원 {n}명',
};
const en: typeof ko = {
  card: 'Profile',
  joined: 'Joined {date}',
  selfNote: 'This is your card as other members see it. Whether achievements and stats show is up to your privacy settings.',
  privacy: 'Privacy',
  onlyMe: 'Only you',
  notFound: 'This player cannot be shown.',
  achievements: 'Achievements',
  achievementsCount: 'Achievements {n}/{of}',
  achievementsHidden: 'This player keeps their achievements private.',
  achievementsNote: 'Achievements come only from the hands and tournaments the server recorded, and carry no chips. Made hands count only when shown at the table.',
  notYet: 'Not yet',
  challenges: 'Challenges completed: {n} · progress points {p}',
  stats: 'Stats',
  statsHidden: 'This player keeps their stats private.',
  hands: 'Hands played',
  tournamentWins: 'Tournament wins',
  noSample: 'No sample',
  'a.first_hand': 'First hand',
  'a.first_hand.d': 'Played a first hand',
  'a.first_win': 'First win',
  'a.first_win.d': 'Won a first pot',
  'a.full_house': 'Full house',
  'a.full_house.d': 'Showed a full house',
  'a.quads': 'Four of a kind',
  'a.quads.d': 'Showed four of a kind',
  'a.straight_flush': 'Straight flush',
  'a.straight_flush.d': 'Showed a straight flush',
  'a.hands_100': '100 hands',
  'a.hands_100.d': 'Played 100 hands',
  'a.tournament_win': 'Tournament win',
  'a.tournament_win.d': 'Won a first tournament',
  'a.streak_7': '7-day streak',
  'a.streak_7.d': 'Played on 7 days in a row',
  'a.challenges_10': 'Ten challenges',
  'a.challenges_10.d': 'Completed ten challenges',
  board: 'Season leaderboard',
  season: 'Season {season}',
  prev: 'Previous season',
  next: 'Next season',
  rules: 'Ranked on free tournament results only (never chips or time played). A tournament counts when at least {humans} members finished it, and you are ranked after {min}. The score is the share of the other finishers you finished ahead of, adjusted so a few tournaments cannot give a high score.',
  rank: 'Rank',
  player: 'Player',
  played: 'Tournaments',
  wins: 'Wins',
  score: 'Score',
  mine: 'You',
  unranked: 'Not ranked yet ({n}/{min})',
  empty: 'Nobody is ranked in this season yet.',
  hidden: 'You chose not to appear on the leaderboard.',
  rankedOf: '{n} players ranked',
};
const translate = createTranslator({ ko, en });

function useText() {
  const { locale } = useI18n();
  return { tr: translate(locale), locale };
}

const pct = (r: StatRatio) => (r.of > 0 ? `${Math.round((r.n / r.of) * 1000) / 10}%` : null);

function Back({ to, label }: { to: string | number; label: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => (typeof to === 'number' ? navigate(to) : navigate(to))}
      className="grid size-10 place-items-center rounded-full text-gold-300 hover:bg-white/5"
      aria-label={label}
    >
      <ArrowLeftIcon className="size-5" />
    </button>
  );
}

function OnlyMe({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2 text-[11px] font-semibold leading-5 text-ink-300" data-testid="card-only-me">
      <LockIcon className="size-3" />
      {text}
    </span>
  );
}

/** A member's card: name, badge and the month they joined, then achievements and statistics as the member chose. */
export function PlayerCardPage() {
  const { id = '' } = useParams();
  const { tr, locale } = useText();
  const [card, setCard] = useState<PlayerCardDto | null>(null);
  const [failed, setFailed] = useState<'gone' | 'error' | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setCard(null);
    setFailed(null);
    let live = true;
    api<PlayerCardDto>(`/api/players/${encodeURIComponent(id)}/card`).then(
      (c) => live && setCard(c),
      (x) => live && setFailed(isGone(x) ? 'gone' : 'error'),
    );
    return () => {
      live = false;
    };
  }, [id, attempt]);

  const month = (ym: string) => {
    const [y, m] = ym.split('-').map(Number) as [number, number];
    return new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(Date.UTC(y, m - 1, 1));
  };
  const day = (ms: number) => new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(ms);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5" data-testid="player-card">
      <header className="flex items-center gap-2">
        <Back to={-1} label={tr('card')} />
        <h1 className="text-xl font-extrabold tracking-[0.04em] jc-gold-text">{tr('card')}</h1>
      </header>
      {!card ? (
        failed === 'gone' ? (
          <Empty>{tr('notFound')}</Empty>
        ) : failed ? (
          <LoadFailed onRetry={() => setAttempt((a) => a + 1)} testId="card-failed" />
        ) : (
          <Loading />
        )
      ) : (
        <>
          <Panel>
            <div className="flex items-center gap-4">
              <Avatar user={card.user} size="size-16 text-base" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 text-lg">
                  <MemberName name={card.user.nickname} role={card.user.role} vip={card.user.vip} badge="wide" className="font-bold text-ivory" />
                </div>
                <p className="mt-0.5 text-sm text-ink-400" data-testid="card-joined">{tr('joined', { date: month(card.joinedMonth) })}</p>
              </div>
              {card.self && (
                <Link to="/friends/settings" className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-ink-200 hover:bg-white/5" data-testid="card-privacy">
                  <SettingsIcon className="size-4" />
                  {tr('privacy')}
                </Link>
              )}
            </div>
            {card.self && <p className="mt-3 text-xs text-ink-400">{tr('selfNote')}</p>}
          </Panel>

          <Panel
            title={card.achievements ? tr('achievementsCount', { n: card.achievements.length, of: ACHIEVEMENTS.length }) : tr('achievements')}
            actions={card.self && card.privacy && !card.privacy.showAchievements ? <OnlyMe text={tr('onlyMe')} /> : undefined}
          >
            {!card.achievements ? (
              <Empty>{tr('achievementsHidden')}</Empty>
            ) : (
              <>
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="card-achievements">
                  {ACHIEVEMENTS.map((code: AchievementCode) => {
                    const got = card.achievements!.find((a) => a.code === code);
                    return (
                      <li
                        key={code}
                        className={cx('flex min-h-24 flex-col items-center justify-center gap-1 rounded-xl border px-2 py-3 text-center', got ? 'border-gold-500/40 bg-gold-500/[0.06]' : 'border-white/5 opacity-50')}
                        data-testid="card-achievement"
                        data-code={code}
                        data-earned={got ? '' : undefined}
                        title={tr(`a.${code}.d`)}
                      >
                        <MedalIcon className={cx('size-6', got ? 'text-gold-300' : 'text-ink-400')} />
                        <span className={cx('text-xs font-semibold', got ? 'text-ivory' : 'text-ink-300')}>{tr(`a.${code}`)}</span>
                        <span className="text-[11px] text-ink-400">{got ? day(got.at) : tr('notYet')}</span>
                      </li>
                    );
                  })}
                </ul>
                {card.challenges && (
                  <p className="mt-3 text-sm text-ink-200" data-testid="card-challenges">
                    {tr('challenges', { n: card.challenges.completed, p: card.challenges.points })}
                  </p>
                )}
                <p className="mt-3 text-xs text-ink-400">{tr('achievementsNote')}</p>
              </>
            )}
          </Panel>

          <Panel title={tr('stats')} actions={card.self && card.privacy && !card.privacy.showStats ? <OnlyMe text={tr('onlyMe')} /> : undefined}>
            {!card.stats ? (
              <Empty>{tr('statsHidden')}</Empty>
            ) : (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3" data-testid="card-stats">
                <Stat label={tr('hands')} value={card.stats.hands.toLocaleString()} />
                <Stat label={tr('tournamentWins')} value={card.stats.tournamentWins.toLocaleString()} />
                {(['vpip', 'pfr', 'wtsd', 'wsd'] as const).map((k) => {
                  const r = card.stats![k];
                  return <Stat key={k} label={{ vpip: 'VPIP', pfr: 'PFR', wtsd: 'WTSD', wsd: 'W$SD' }[k]} value={pct(r) ?? '–'} sub={r.of > 0 ? `${r.n}/${r.of}` : tr('noSample')} />;
                })}
              </dl>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-400">{label}</dt>
      <dd className="text-lg font-bold tabular-nums text-ivory">
        {value}
        {sub && <span className="ml-1.5 text-xs font-normal text-ink-400">{sub}</span>}
      </dd>
    </div>
  );
}

/** The season leaderboard: this month by default, earlier months with the arrows. */
export function LeaderboardPage() {
  const { tr } = useText();
  const current = seasonOf(Date.now());
  const [season, setSeason] = useState(current);
  const [board, setBoard] = useState<LeaderboardDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setBoard(null);
    setFailed(false);
    let live = true;
    api<LeaderboardDto>(`/api/leaderboard?season=${season}`).then(
      (b) => live && setBoard(b),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [season, attempt]);
  const nextOf = (s: string) => seasonOf(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)), 1) + 24 * 60 * 60_000);
  const score = (n: number) => `${(n / 10).toFixed(1)}`;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5" data-testid="leaderboard">
      <header className="flex items-center gap-2">
        <Back to="/tournaments" label={tr('board')} />
        <h1 className="text-xl font-extrabold tracking-[0.04em] jc-gold-text">{tr('board')}</h1>
      </header>
      <div className="flex items-center justify-center gap-2">
        <button type="button" className="grid size-10 place-items-center rounded-full text-gold-300 hover:bg-white/5" onClick={() => setSeason(previousSeason(season))} aria-label={tr('prev')} data-testid="board-prev">
          <ChevronLeftIcon className="size-5" />
        </button>
        <span className="min-w-36 text-center text-sm font-bold text-ivory" data-testid="board-season">{tr('season', { season })}</span>
        <button
          type="button"
          className="grid size-10 place-items-center rounded-full text-gold-300 hover:bg-white/5 disabled:opacity-30"
          onClick={() => setSeason(nextOf(season))}
          disabled={season >= current}
          aria-label={tr('next')}
        >
          <ChevronRightIcon className="size-5" />
        </button>
      </div>
      <p className="text-xs leading-relaxed text-ink-400">{tr('rules', { humans: LEADERBOARD.minHumans, min: LEADERBOARD.minTournaments })}</p>
      {!board ? (
        failed ? <LoadFailed onRetry={() => setAttempt((a) => a + 1)} testId="board-failed" /> : <Loading />
      ) : (
        <>
          {board.hidden ? (
            <p className="rounded-xl border border-white/10 px-4 py-3 text-sm text-ink-300" data-testid="board-hidden">
              {tr('hidden')}{' '}
              <Link to="/friends/settings" className="font-semibold text-gold-300 underline-offset-2 hover:underline">{tr('privacy')}</Link>
            </p>
          ) : (
            board.me && (
              <Panel title={tr('mine')}>
                <BoardRow row={board.me} score={score} tr={tr} mine />
              </Panel>
            )
          )}
          <Panel title={tr('rankedOf', { n: board.ranked })}>
            {board.rows.length === 0 ? (
              <Empty>{tr('empty')}</Empty>
            ) : (
              <ol className="-mx-2 divide-y divide-white/5" data-testid="board-rows">
                {board.rows.map((r) => (
                  <li key={r.user.id}>
                    <BoardRow row={r} score={score} tr={tr} />
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function BoardRow({ row, score, tr, mine }: { row: LeaderboardRowDto; score: (n: number) => string; tr: ReturnType<typeof translate>; mine?: boolean }) {
  return (
    <Link to={`/players/${row.user.id}`} className={cx('flex items-center gap-3 rounded-lg py-2.5 hover:bg-white/[0.03]', mine ? '' : 'px-2')} data-testid="board-row">
      <span className={cx('w-8 shrink-0 text-center text-sm font-extrabold tabular-nums', row.rank && row.rank <= 3 ? 'text-gold-300' : 'text-ink-300')}>{row.rank ?? '–'}</span>
      <Avatar user={row.user} size="size-9" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0">
          <MemberName name={row.user.nickname} role={row.user.role} vip={row.user.vip} badge className="font-semibold text-ivory" />
        </span>
        <span className="text-xs text-ink-400">
          {row.rank == null
            ? tr('unranked', { n: row.tournaments, min: LEADERBOARD.minTournaments })
            : `${tr('played')} ${row.tournaments} · ${tr('wins')} ${row.wins}`}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-base font-bold tabular-nums text-ivory">{score(row.score)}</span>
        <span className="block text-[11px] text-ink-400">{tr('score')}</span>
      </span>
    </Link>
  );
}
