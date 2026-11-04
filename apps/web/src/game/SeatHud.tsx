/**
 * A seat's HUD, inside the card a tap or click on the seat opens (docs/SOCIAL.md "테이블 HUD"): nothing is drawn over the table, so no
 * card, stack, button, blind, bet, turn mark or action button is ever covered. VPIP, PFR, 3-bet and the sample first;
 * opened, every ratio's hands and the rest. A dash where there was no chance (never 0%), gold under 30 hands.
 * The figures come from the server behind the card's gate (GET /api/players/:id/hud), or, at a practice table, from
 * the browser's own count of that session. Loaded on demand, so the text lives here.
 */
import { HUD_DAYS, HUD_HANDS, type HudScope, type HudStatsDto, type PlayerHudDto, type StatRatio } from '@jc/types';
import { ChevronDownIcon, createTranslator, cx, formatChips, Spinner } from '@jc/ui';
import { useEffect, useState } from 'react';
import { aggressionFactor, pct, SMALL_RATIO } from '../components/PlayStats';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';

const ko = {
  title: 'HUD',
  'scope.cash': '일반 테이블',
  'scope.tournament': '토너먼트',
  'scope.practice': '이번 연습',
  sample: '표본',
  hands: '핸드',
  bot: '봇 기록',
  more: '자세히',
  less: '접기',
  threeBet: '3Bet',
  foldTo3Bet: '3Bet 폴드',
  cbet: 'CBet',
  foldToCbet: 'CBet 폴드',
  af: 'AF',
  wtsd: 'WTSD',
  wsd: 'W$SD',
  small: '금색: 분모 {n}핸드 미만, 참고값',
  counted: '3Bet·CBet·AF는 이 통계가 생긴 뒤 기록된 {n}핸드에서 셉니다.',
  window: '최근 {days}일 중 가장 최근 {max}핸드까지를 셉니다. 칩과 손익, 카드는 보이지 않습니다.',
  windowPractice: '이 연습에서 플레이한 핸드만 셉니다. 연습은 기록으로 남지 않습니다.',
  hidden: '이 회원은 통계를 공개하지 않습니다.',
  none: '이 종류의 테이블에서 기록된 핸드가 없습니다.',
  failed: 'HUD를 불러오지 못했습니다.',
  retry: '다시 시도',
};
const en: Record<keyof typeof ko, string> = {
  title: 'HUD',
  'scope.cash': 'Ordinary tables',
  'scope.tournament': 'Tournaments',
  'scope.practice': 'This practice',
  sample: 'Sample',
  hands: 'hands',
  bot: 'Bot record',
  more: 'Details',
  less: 'Less',
  threeBet: '3Bet',
  foldTo3Bet: 'Fold to 3Bet',
  cbet: 'CBet',
  foldToCbet: 'Fold to CBet',
  af: 'AF',
  wtsd: 'WTSD',
  wsd: 'W$SD',
  small: 'Gold: under {n} hands behind it, indicative',
  counted: '3Bet, CBet and AF count the {n} hands recorded since they were added.',
  window: 'Counts up to the latest {max} hands of the last {days} days. Never chips, results or cards.',
  windowPractice: 'Counts this practice’s hands only. Practice is never recorded.',
  hidden: 'This member keeps their statistics private.',
  none: 'No hands recorded at this kind of table.',
  failed: 'The HUD did not load.',
  retry: 'Try again',
};
const tr = createTranslator({ ko, en });

export type HudKind = HudScope | 'practice';

/** One figure: its name and the share (a dash with no chance), and opened, the hands behind it. */
function Cell({ label, ratio, testid, open }: { label: string; ratio: StatRatio; testid: string; open: boolean }) {
  const small = ratio.of > 0 && ratio.of < SMALL_RATIO;
  return (
    <div className="min-w-0" data-testid={testid} data-small={small}>
      <dt className="truncate text-[11px] text-ink-400">{label}</dt>
      <dd className={cx('font-mono text-base font-semibold tabular-nums', small ? 'text-gold-300' : 'text-ivory')}>{pct(ratio.n, ratio.of)}</dd>
      {open && (
        <dd className="font-mono text-[11px] tabular-nums text-ink-400">
          {formatChips(ratio.n)}/{formatChips(ratio.of)}
        </dd>
      )}
    </div>
  );
}

/**
 * The figures themselves, from the server or a practice session's count. Closed, the least a small screen needs:
 * VPIP, PFR, 3-bet and the sample; opened, each ratio's hands, the later figures and what is counted.
 */
export function HudFigures({ stats, kind, bot }: { stats: HudStatsDto; kind: HudKind; bot: boolean }) {
  const { locale } = useI18n();
  const m = tr(locale);
  const [open, setOpen] = useState(false);
  const all = [stats.vpip, stats.pfr, stats.threeBet, stats.foldTo3Bet, stats.cbet, stats.foldToCbet, stats.wtsd, stats.wsd];
  const small = all.some((r) => r.of > 0 && r.of < SMALL_RATIO);
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3" data-testid="seat-hud" data-kind={kind} data-bot={bot}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-bold tracking-[0.04em] text-gold-300">{m('title')}</span>
        <span className="text-ink-300" data-testid="seat-hud-scope">{m(`scope.${kind}`)}</span>
        {bot && (
          <span className="rounded-full border border-[#8fd9cb]/40 px-2 py-0.5 font-semibold text-[#8fd9cb]" data-testid="seat-hud-bot">
            {m('bot')}
          </span>
        )}
        {/* A full-size target that takes no more height than the line. */}
        <button
          type="button"
          className="jc-tap -my-3 -mr-2 ml-auto flex min-h-11 items-center gap-1 px-2 font-semibold text-ink-300 hover:text-ivory"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          data-testid="seat-hud-more"
        >
          {m(open ? 'less' : 'more')}
          <ChevronDownIcon className={cx('size-4 text-ink-400 transition', open && 'rotate-180')} />
        </button>
      </div>
      {stats.hands === 0 ? (
        <p className="text-sm text-ink-300" data-testid="seat-hud-none">{m('none')}</p>
      ) : (
        <>
          <dl className="grid grid-cols-4 gap-2">
            <Cell label="VPIP" ratio={stats.vpip} testid="seat-hud-vpip" open={open} />
            <Cell label="PFR" ratio={stats.pfr} testid="seat-hud-pfr" open={open} />
            <Cell label={m('threeBet')} ratio={stats.threeBet} testid="seat-hud-3bet" open={open} />
            <div className="min-w-0" data-testid="seat-hud-hands">
              <dt className="truncate text-[11px] text-ink-400">{m('sample')}</dt>
              <dd className="font-mono text-base font-semibold tabular-nums text-ivory">
                {formatChips(stats.hands)}
                <span className="ml-1 font-sans text-[11px] font-normal text-ink-400">{m('hands')}</span>
              </dd>
            </div>
          </dl>
          {small && (
            <p className="text-xs text-gold-300" data-testid="seat-hud-small">
              {m('small', { n: SMALL_RATIO })}
            </p>
          )}
          {open && (
            <dl className="grid grid-cols-3 gap-2" data-testid="seat-hud-later">
              <Cell label={m('foldTo3Bet')} ratio={stats.foldTo3Bet} testid="seat-hud-fold-3bet" open />
              <Cell label={m('cbet')} ratio={stats.cbet} testid="seat-hud-cbet" open />
              <Cell label={m('foldToCbet')} ratio={stats.foldToCbet} testid="seat-hud-fold-cbet" open />
              <div className="min-w-0" data-testid="seat-hud-af">
                <dt className="text-[11px] text-ink-400">{m('af')}</dt>
                <dd className="font-mono text-base font-semibold tabular-nums text-ivory">{aggressionFactor(stats.aggression)}</dd>
                <dd className="font-mono text-[11px] tabular-nums text-ink-400">
                  {formatChips(stats.aggression.bets)}/{formatChips(stats.aggression.calls)}
                </dd>
              </div>
              <Cell label={m('wtsd')} ratio={stats.wtsd} testid="seat-hud-wtsd" open />
              <Cell label={m('wsd')} ratio={stats.wsd} testid="seat-hud-wsd" open />
            </dl>
          )}
        </>
      )}
      {open && (
        <div className="flex flex-col gap-1 text-xs leading-relaxed text-ink-400" data-testid="seat-hud-notes">
          {kind !== 'practice' && stats.hands > 0 && <p>{m('counted', { n: formatChips(stats.counted) })}</p>}
          <p>{kind === 'practice' ? m('windowPractice') : m('window', { days: HUD_DAYS, max: formatChips(HUD_HANDS) })}</p>
        </div>
      )}
    </section>
  );
}

/** A seat's HUD read from the server: the player's figures at this kind of table, or why there are none. */
export function SeatHud({ userId, scope }: { userId: string; scope: HudScope }) {
  const { locale } = useI18n();
  const m = tr(locale);
  const [hud, setHud] = useState<PlayerHudDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setHud(null);
    setFailed(false);
    api<PlayerHudDto>(`/api/players/${encodeURIComponent(userId)}/hud?scope=${scope}`)
      .then((h) => live && setHud(h))
      // Not found (blocked, withdrawn) shows as the card does: nothing to show.
      .catch((e: unknown) => live && (e instanceof ApiError && e.status === 404 ? setHud({ bot: false, scope, stats: null }) : setFailed(true)));
    return () => {
      live = false;
    };
  }, [userId, scope, attempt]);
  if (failed)
    return (
      <p className="flex items-center justify-between gap-2 text-sm text-ink-300" data-testid="seat-hud-failed">
        {m('failed')}
        <button type="button" className="jc-tap min-h-11 px-2 text-xs font-semibold text-gold-300" onClick={() => setAttempt((n) => n + 1)}>
          {m('retry')}
        </button>
      </p>
    );
  if (!hud) return <Spinner className="size-5 self-center text-gold-400" />;
  if (!hud.stats)
    return (
      <p className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm text-ink-300" data-testid="seat-hud-hidden">
        <span className="mr-2 font-bold text-gold-300">{m('title')}</span>
        {m('hidden')}
      </p>
    );
  return <HudFigures stats={hud.stats} kind={hud.scope} bot={hud.bot} />;
}
