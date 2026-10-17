/**
 * Free practice table: no script, rule-based bots, hand after hand. Uses the
 * real TableScene + ActionBar like the guided scenarios; nothing leaves the browser.
 */
import { sound } from '@jc/audio';
import type { ActionType, TableView } from '@jc/types';
import { Button, cx, formatChips, Modal } from '@jc/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ActionHelp, CurrentHandPill } from '../../game/BeginnerAids';
import { ActionBar } from '../../game/ActionBar';
import { TableScene, useBoxSize, useStackRoom, useTableLayout } from '../../game/TableScene';
import { useAuth } from '../../lib/auth';
import { useI18n, type MsgKey } from '../../lib/i18n';
import { l, useTr } from '../content';
import { HandRankingChart } from '../HandChart';
import { FreeSession, type FreeConfig } from '../practice/free';
import { track } from '../sync';
import { UI } from '../ui';

const T = {
  title: l('자유 연습', 'Free practice'),
  sub: l('정해진 정답 없이 직접 판단해 플레이합니다. 상대는 규칙 기반 봇이며, 연습 칩만 사용합니다.', 'No script: make your own decisions against rule-based bots, with practice chips only.'),
  opponents: l('상대 수', 'Opponents'),
  style: l('상대 성향', 'Opponent style'),
  tight: l('신중함 (타이트)', 'Careful (tight)'),
  loose: l('공격적 (루즈)', 'Aggressive (loose)'),
  mixed: l('섞어서', 'Mixed'),
  start: l('시작', 'Start'),
  next: l('다음 핸드', 'Next hand'),
  hands: l('핸드 {n}', 'Hand {n}'),
  net: l('연습 손익', 'Practice net'),
  you: l('승리!', 'You win!'),
  lost: l('상대 승리', 'Opponent wins'),
  folded: l('폴드했습니다', 'You folded'),
  over: l('핸드 종료', 'Hand over'),
  settings: l('설정', 'Setup'),
  fault: l('연습 진행 중 문제가 생겼습니다. 새 핸드로 다시 시작해 주세요.', 'Something went wrong in this practice hand. Please start a new one.'),
  restart: l('새로 시작', 'Restart'),
};

export function FreePracticePage() {
  const tr = useTr();
  const [cfg, setCfg] = useState<FreeConfig | null>(null);
  const [draft, setDraft] = useState<FreeConfig>({ bots: 2, style: 'mixed' });
  const [round, setRound] = useState(0);
  if (cfg) return <FreeTable key={round} cfg={cfg} onSetup={() => setCfg(null)} onRestart={() => setRound((r) => r + 1)} />;
  const pill = (on: boolean) => cx('jc-tap min-h-11 rounded-full border px-4 text-sm font-semibold', on ? 'border-gold-400 bg-gold-500/15 text-gold-300' : 'border-white/10 text-ink-200');
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-6" data-testid="free-setup">
      <Link to="/academy/practice" className="jc-tap -ml-2 self-start rounded-lg px-2 py-2 text-sm text-ink-300 hover:text-ivory">
        ← {tr(UI.back)}
      </Link>
      <h1 className="font-display text-xl font-bold tracking-[0.08em] text-gold-300">{tr(T.title)}</h1>
      <p className="text-sm text-ink-300">{tr(T.sub)}</p>
      <div className="jc-panel flex flex-col gap-4 p-4">
        <div>
          <div className="mb-2 text-xs font-bold uppercase tracking-wider text-ink-300">{tr(T.opponents)}</div>
          <div className="flex gap-2">
            {([1, 2, 5] as const).map((n) => (
              <button key={n} className={pill(draft.bots === n)} aria-pressed={draft.bots === n} onClick={() => setDraft({ ...draft, bots: n })} data-bots={n}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 text-xs font-bold uppercase tracking-wider text-ink-300">{tr(T.style)}</div>
          <div className="flex flex-wrap gap-2">
            {(['tight', 'loose', 'mixed'] as const).map((s) => (
              <button key={s} className={pill(draft.style === s)} aria-pressed={draft.style === s} onClick={() => setDraft({ ...draft, style: s })}>
                {tr(T[s])}
              </button>
            ))}
          </div>
        </div>
        <Button size="lg" onClick={() => setCfg(draft)} data-testid="free-start">
          {tr(T.start)} →
        </Button>
      </div>
    </div>
  );
}

function FreeTable({ cfg, onSetup, onRestart }: { cfg: FreeConfig; onSetup: () => void; onRestart: () => void }) {
  const tr = useTr();
  const { t } = useI18n();
  const { me } = useAuth();
  const session = useRef<FreeSession | null>(null);
  if (!session.current) session.current = new FreeSession(cfg, me?.nickname ?? 'You');
  const s = session.current;
  const [view, setView] = useState<TableView>(() => s.view());
  const [cues, setCues] = useState(s.cues);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState(false);
  const [chart, setChart] = useState(false);
  const [areaRef, area] = useBoxSize<HTMLDivElement>();
  const layout = useTableLayout(area, view.table.maxSeats, 0, { me: true, footer: true });
  const room = useStackRoom('');
  const reducedMotion = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);
  // The table turns the hands over before it shows who won: the bar and the net wait for it (the next hand does not).
  const [resultShown, setResultShown] = useState(true);
  const [net, setNet] = useState(s.net);

  useEffect(() => sound.installAutoUnlock(), []);
  useEffect(() => track({ kind: 'scenario', id: 'free', phase: 'start' }), []);
  const refresh = useCallback(() => {
    setView(s.view());
    setCues([...s.cues]);
  }, [s]);
  const guard = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        // A broken practice state must never freeze the screen: stop the loop and offer a restart.
        console.error('[practice] free play stopped', e);
        setFault(true);
      } finally {
        refresh();
        setBusy(false);
      }
    },
    [refresh],
  );

  useEffect(() => {
    if (busy || fault || s.settled || s.isHeroTurn()) return;
    const h = setTimeout(() => void guard(() => s.step()), reducedMotion ? 300 : 750);
    return () => clearTimeout(h);
  }, [view, busy, fault, s, guard, reducedMotion]);

  const onAct = (type: ActionType, amount?: number) => void guard(() => s.heroAct(type, amount));
  const hero = view.seats.find((x) => x.seatIndex === 0);
  const result = view.hand?.result;
  const outcome = !s.settled || !result ? null : hero?.state === 'folded' ? 'folded' : result.winners.some((w) => w.seatIndex === 0) ? 'you' : 'lost';
  const told = outcome === 'folded' || resultShown;
  useEffect(() => {
    if (!s.settled || resultShown) setNet(s.net);
  }, [view, resultShown, s]);

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden" style={{ background: 'var(--t-bg)' }} data-testid="free-table">
      <header className="jc-game-surface z-40 flex h-14 shrink-0 items-center gap-2 border-b border-gold-500/10 bg-ink-950/70 px-3 backdrop-blur-md">
        <Link to="/academy/practice" className="jc-tap grid size-10 place-items-center rounded-lg text-ink-200" aria-label={tr(UI.back)}>
          ←
        </Link>
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-ivory">{tr(T.title)}</div>
          <div className="truncate font-mono text-[11px] text-gold-300">
            {tr(T.hands, { n: s.hands })} <span className="hidden sm:inline">· {t(`stage.${view.hand?.stage ?? 'preflop'}` as MsgKey)}</span> · {tr(T.net)} <span data-testid="free-net">{net >= 0 ? '+' : ''}{formatChips(net)}</span>
          </div>
        </div>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setChart(true)}>
            {t('table.handChart')}
          </Button>
          <Button size="sm" variant="outline" onClick={onSetup}>
            {tr(T.settings)}
          </Button>
        </div>
      </header>
      <div ref={room.colRef} className="jc-game-surface relative flex min-h-0 flex-1 flex-col">
        <div ref={areaRef} className="relative mx-2 mt-2 flex min-h-0 flex-1 items-center justify-center sm:mx-6" style={room.style}>
          <TableScene s={view} layout={layout} mySeat={0} canSit={false} onSit={() => {}} nextIn={null} cues={cues} consumeCues={(up) => (s.consumeCues(up), setCues([...s.cues]))} reducedMotion={reducedMotion} onResultShown={setResultShown} />
        </div>
        <div ref={room.stackRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:items-end sm:px-6 sm:pb-6">
          {fault && (
            <div className="jc-panel pointer-events-auto flex w-full max-w-md flex-col gap-2 border-danger/50 p-4" role="alert" data-testid="practice-fault">
              <p className="text-sm text-[#f3c3c4]">{tr(T.fault)}</p>
              <Button onClick={onRestart}>{tr(T.restart)}</Button>
            </div>
          )}
          {!fault && view.hand && !s.settled && <CurrentHandPill s={view} />}
          {!fault && outcome && (
            <div className="jc-panel jc-pop pointer-events-auto flex w-full max-w-md items-center justify-between gap-3 p-3" data-testid="free-result">
              <span className={cx('font-bold', told && outcome === 'you' ? 'text-gold-300' : 'text-ink-200')} role="status" data-testid="free-outcome">
                {tr(told ? T[outcome] : T.over)}
              </span>
              <Button onClick={() => void guard(async () => s.newHand())} data-testid="free-next">
                {tr(T.next)} →
              </Button>
            </div>
          )}
          {!fault && s.isHeroTurn() && (
            <>
              <ActionHelp s={view} />
              <ActionBar state={view} onAct={onAct} busy={busy} />
            </>
          )}
        </div>
      </div>
      <Modal open={chart} onClose={() => setChart(false)} title={t('table.handChart')}>
        <HandRankingChart compact />
      </Modal>
    </div>
  );
}
