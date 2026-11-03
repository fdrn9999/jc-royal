/**
 * Free practice table: no script, bots, hand after hand. Uses the real TableScene + ActionBar like the guided
 * scenarios; nothing leaves the browser. Set up with a topic, the academy's beginner bots or the tables' own at a
 * level and style, the stacks and the blinds; the results (../PracticeResults.tsx) and each bot's HUD over the
 * session open from the table, and end with it.
 */
import { sound } from '@jc/audio';
import { BOT_LEVELS, BOT_STYLES, type ActionType, type SeatView, type TableView } from '@jc/types';
import { ArrowLeftIcon, Button, cx, formatChips, HandRanksIcon, Modal } from '@jc/ui';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ActionHelp, CurrentHandPill } from '../../game/BeginnerAids';
import { ActionBar } from '../../game/ActionBar';
import { TableScene, useAreaSize, useStackRoom, useTableLayout } from '../../game/TableScene';
import { wonFrom } from '../../game/won';
import { BOT_LEVEL_LABEL } from '../../components/MemberName';
import { useAuth } from '../../lib/auth';
import { useBack } from '../../lib/back';
import { useI18n, type MsgKey } from '../../lib/i18n';
import { l, useTr } from '../content';
import { HandRankingChart } from '../HandChart';
import { PracticeResults, TOPICS } from '../PracticeResults';
import { FREE_BLIND_OPTIONS, FREE_BLINDS, FREE_STACK_BB, FreeSession, type FreeConfig } from '../practice/free';
import { PRACTICE_TOPICS, SHORT_STACK_BB } from '../practice/review';
import { HudFigures } from '../../game/SeatHud';
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
  results: l('결과', 'Results'),
  resultsTitle: l('연습 결과', 'Practice results'),
  topic: l('연습 주제', 'Topic'),
  huOnly: l('헤즈업은 상대 1명으로 고정됩니다.', 'Heads-up is always one opponent.'),
  level: l('봇 난이도', 'Bot level'),
  beginner: l('입문', 'Beginner'),
  beginnerAbout: l('아카데미의 단순한 규칙 기반 봇입니다.', 'The academy’s simple rule-based bots.'),
  tableAbout: l('일반 테이블의 봇과 같은 판단 코드가 이 브라우저에서 돌아갑니다. 봇은 자기 카드와 모두에게 공개된 정보만 봅니다.', 'The same decision code as the tables’ bots, run in this browser. A bot sees only its own cards and what is public.'),
  auto: l('자동 (봇마다)', 'Auto (each its own)'),
  stack: l('시작 스택', 'Starting stack'),
  shortNote: l('숏스택 주제에서는 내 스택이 매 핸드 {n}BB로 시작합니다.', 'With the short stack topic you start every hand with {n} BB.'),
  blinds: l('블라인드', 'Blinds'),
  practiceBot: l('연습 봇', 'Practice bot'),
  beginnerBot: l('입문 봇 · {style}', 'Beginner bot · {style}'),
  botAbout: l('이 브라우저에서 돌아가는 연습 봇입니다. 자기 카드와 모두에게 공개된 정보만 보고 행동하며, 연습 칩만 씁니다. 회원이 아니며 기록으로 남지 않습니다.', 'A practice bot run in this browser: it acts on its own cards and what is public only, with practice chips. Not a member, never recorded.'),
  fault: l('연습 진행 중 문제가 생겼습니다. 새 핸드로 다시 시작해 주세요.', 'Something went wrong in this practice hand. Please start a new one.'),
  restart: l('새로 시작', 'Restart'),
  toStudy: l('학습으로 돌아가기', 'Back to the lesson'),
};

/** A page of the advanced course, as `state.from` names it (with its step). */
const STUDY_PAGE = /^\/academy\/gto(\/[a-z-]+)?(\?[^#]*)?$/;

export function FreePracticePage() {
  const tr = useTr();
  // Opened from the end of a lesson, back goes to that lesson.
  const back = useBack(STUDY_PAGE, '/academy/practice');
  const [cfg, setCfg] = useState<FreeConfig | null>(null);
  const [draft, setDraft] = useState<FreeConfig>({ bots: 2, style: 'mixed' });
  const { t } = useI18n();
  const [round, setRound] = useState(0);
  if (cfg) return <FreeTable key={round} cfg={cfg} back={back} onSetup={() => setCfg(null)} onRestart={() => setRound((r) => r + 1)} />;
  const pill = (on: boolean) => cx('jc-tap min-h-11 rounded-full border px-4 text-sm font-semibold disabled:opacity-40', on ? 'border-gold-400 bg-gold-500/15 text-gold-300' : 'border-white/10 text-ink-200');
  const label = 'mb-2 text-xs font-bold uppercase tracking-wider text-ink-300';
  const note = 'mt-2 text-xs text-ink-400';
  const topic = draft.topic ?? 'free';
  const headsUp = topic === 'headsUp';
  const stackBb = draft.stackBb ?? 100;
  const blinds = draft.blinds ?? FREE_BLINDS;
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-6" data-testid="free-setup">
      <Link to={back.to} onClick={back.onClick} className="jc-tap -ml-2 self-start rounded-lg px-2 py-2 text-sm text-ink-300 hover:text-ivory" data-testid="free-back">
        ← {tr(back.from ? T.toStudy : UI.back)}
      </Link>
      <h1 className="font-display text-xl font-bold tracking-[0.08em] text-gold-300">{tr(T.title)}</h1>
      <p className="text-sm text-ink-300">{tr(T.sub)}</p>
      <div className="jc-panel flex flex-col gap-4 p-4">
        <div>
          <div className={label}>{tr(T.topic)}</div>
          <div className="flex flex-wrap gap-2">
            {PRACTICE_TOPICS.map((k) => (
              <button key={k} className={pill(topic === k)} aria-pressed={topic === k} onClick={() => setDraft({ ...draft, topic: k })} data-topic={k}>
                {tr(TOPICS[k].name)}
              </button>
            ))}
          </div>
          <p className={note} data-testid="free-topic-about">
            {tr(TOPICS[topic].about)}
          </p>
        </div>
        <div>
          <div className={label}>{tr(T.opponents)}</div>
          <div className="flex gap-2">
            {([1, 2, 5] as const).map((n) => {
              const on = headsUp ? n === 1 : draft.bots === n;
              return (
                <button key={n} className={pill(on)} aria-pressed={on} disabled={headsUp && n !== 1} onClick={() => setDraft({ ...draft, bots: n })} data-bots={n}>
                  {n}
                </button>
              );
            })}
          </div>
          {headsUp && <p className={note}>{tr(T.huOnly)}</p>}
        </div>
        <div>
          <div className={label}>{tr(T.level)}</div>
          <div className="flex flex-wrap gap-2">
            <button className={pill(!draft.level)} aria-pressed={!draft.level} onClick={() => setDraft({ ...draft, level: undefined })} data-level="beginner">
              {tr(T.beginner)}
            </button>
            {BOT_LEVELS.map((k) => (
              <button key={k} className={pill(draft.level === k)} aria-pressed={draft.level === k} onClick={() => setDraft({ ...draft, level: k })} data-level={k}>
                {t(BOT_LEVEL_LABEL[k])}
              </button>
            ))}
          </div>
          <p className={note}>{tr(draft.level ? T.tableAbout : T.beginnerAbout)}</p>
        </div>
        <div>
          <div className={label}>{tr(T.style)}</div>
          <div className="flex flex-wrap gap-2">
            {draft.level
              ? (['auto', ...BOT_STYLES] as const).map((s) => {
                  const on = (draft.tableStyle ?? 'auto') === s;
                  return (
                    <button key={s} className={pill(on)} aria-pressed={on} onClick={() => setDraft({ ...draft, tableStyle: s })} data-style={s}>
                      {s === 'auto' ? tr(T.auto) : t(`bot.style.${s}` as MsgKey)}
                    </button>
                  );
                })
              : (['tight', 'loose', 'mixed'] as const).map((s) => (
                  <button key={s} className={pill(draft.style === s)} aria-pressed={draft.style === s} onClick={() => setDraft({ ...draft, style: s })} data-style={s}>
                    {tr(T[s])}
                  </button>
                ))}
          </div>
        </div>
        <div>
          <div className={label}>{tr(T.stack)}</div>
          <div className="flex flex-wrap gap-2">
            {FREE_STACK_BB.map((n) => (
              <button key={n} className={pill(stackBb === n)} aria-pressed={stackBb === n} onClick={() => setDraft({ ...draft, stackBb: n })} data-stack={n}>
                {n} BB
              </button>
            ))}
          </div>
          {topic === 'shortStack' && <p className={note}>{tr(T.shortNote, { n: SHORT_STACK_BB })}</p>}
        </div>
        <div>
          <div className={label}>{tr(T.blinds)}</div>
          <div className="flex flex-wrap gap-2">
            {FREE_BLIND_OPTIONS.map((b) => {
              const on = blinds[1] === b[1];
              return (
                <button key={b[1]} className={pill(on)} aria-pressed={on} onClick={() => setDraft({ ...draft, blinds: b })} data-blinds={b[1]}>
                  {formatChips(b[0])}/{formatChips(b[1])}
                </button>
              );
            })}
          </div>
        </div>
        <Button size="lg" onClick={() => setCfg(draft)} data-testid="free-start">
          {tr(T.start)} →
        </Button>
      </div>
    </div>
  );
}

/** A practice bot's card: what plays it, and its HUD over the session, counted in the browser. */
function PracticeBot({ s, seat }: { s: FreeSession; seat: number }) {
  const tr = useTr();
  const { t } = useI18n();
  const style = s.tableStyles.get(seat);
  const beginner = s.styles.get(seat);
  return (
    <div className="flex flex-col gap-3 px-5 py-4" data-testid="free-bot">
      <div className="flex flex-col gap-1 text-sm">
        <span className="self-start rounded-full border border-[#8fd9cb]/40 px-2 py-0.5 text-xs font-semibold text-[#8fd9cb]" data-testid="free-bot-badge">
          {tr(T.practiceBot)}
        </span>
        {s.level && style ? (
          <>
            <div className="text-[#8fd9cb]" data-testid="free-bot-level">{t('bot.levelLine', { level: t(BOT_LEVEL_LABEL[s.level]) })}</div>
            <div className="text-ink-200" data-testid="free-bot-style">{t('bot.styleLine', { style: t(`bot.style.${style}` as MsgKey) })}</div>
          </>
        ) : (
          beginner && <div className="text-[#8fd9cb]" data-testid="free-bot-level">{tr(T.beginnerBot, { style: tr(T[beginner]) })}</div>
        )}
        <p className="text-xs leading-relaxed text-ink-300">{tr(T.botAbout)}</p>
      </div>
      <HudFigures stats={s.hud(seat)} kind="practice" bot />
    </div>
  );
}

function FreeTable({ cfg, back, onSetup, onRestart }: { cfg: FreeConfig; back: ReturnType<typeof useBack>; onSetup: () => void; onRestart: () => void }) {
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
  const [results, setResults] = useState(false);
  const [bot, setBot] = useState<SeatView | null>(null);
  const room = useStackRoom('');
  const [areaRef, area] = useAreaSize<HTMLDivElement>(room.style);
  const layout = useTableLayout(area, view.table.maxSeats, 0, { me: true, footer: true });
  const reducedMotion = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);
  // The table turns the hands over before it shows who won: the bar and the net wait for it (the next hand does not).
  // Told per hand and stage, so a settled hand never starts out with the word the table gave on the one before.
  const shownKey = view.hand ? `${view.hand.id}:${s.settled}` : '';
  const [shownFor, setShownFor] = useState<string | null>(null);
  const resultShown = shownFor === shownKey;
  const onResultShown = useCallback((shown: boolean) => setShownFor(shown ? shownKey : null), [shownKey]);
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
  // Chips nobody called, handed back, are no win.
  const outcome = !s.settled || !result ? null : hero?.state === 'folded' ? 'folded' : wonFrom(result).some((w) => w.seatIndex === 0) ? 'you' : 'lost';
  const told = outcome === 'folded' || resultShown;
  // Before the screen is drawn, as the table tells it: the net never lags the word by a frame.
  useLayoutEffect(() => {
    if (!s.settled || resultShown) setNet(s.net);
  }, [view, resultShown, s]);

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden" style={{ background: 'var(--t-bg)' }} data-testid="free-table">
      <header className="jc-game-surface z-40 flex h-14 shrink-0 items-center gap-2 border-b border-gold-500/10 bg-ink-950/70 px-3 backdrop-blur-md">
        <Link to={back.to} onClick={back.onClick} className="jc-tap grid size-10 place-items-center rounded-lg text-ink-200" aria-label={tr(back.from ? T.toStudy : UI.back)} data-testid="free-table-back">
          <ArrowLeftIcon className="size-5" />
        </Link>
        {/* The hand count beside the title, so the net below has the line to itself; a label gives way before a figure does. */}
        <div className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-1.5 text-sm font-bold text-ivory">
            <span className="truncate">{tr(T.title)}</span>
            <span className="shrink-0 font-mono text-[11px] font-normal text-ink-300">{tr(T.hands, { n: s.hands })}</span>
          </div>
          <div className="flex min-w-0 gap-1 font-mono text-[11px] text-gold-300">
            <span className="truncate">
              <span className="hidden sm:inline">{t(`stage.${view.hand?.stage ?? 'preflop'}` as MsgKey)} · </span>
              {tr(T.net)}
            </span>
            <span className="shrink-0" data-testid="free-net">
              {net >= 0 ? '+' : ''}
              {formatChips(net)}
            </span>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 gap-1">
          {/* An icon on a phone, as at the tables, so the net beside the title keeps its room. */}
          <Button size="icon" variant="ghost" onClick={() => setChart(true)} aria-label={t('table.handChart')} data-testid="free-chart-open">
            <HandRanksIcon className="size-5 sm:hidden" />
            <span className="hidden sm:inline">{t('table.handChart')}</span>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setResults(true)} data-testid="free-summary-open">
            {tr(T.results)}
          </Button>
          <Button size="sm" variant="outline" onClick={onSetup}>
            {tr(T.settings)}
          </Button>
        </div>
      </header>
      <div ref={room.colRef} className="jc-game-surface relative flex min-h-0 flex-1 flex-col">
        <div ref={areaRef} className="relative mx-2 mt-2 flex min-h-0 flex-1 items-center justify-center sm:mx-6" style={room.style}>
          <TableScene s={view} layout={layout} mySeat={0} canSit={false} onSit={() => {}} nextIn={null} cues={cues} consumeCues={(up) => s.consumeCues(up)} reducedMotion={reducedMotion} onResultShown={onResultShown} onSeatClick={setBot} />
        </div>
        <div ref={room.stackRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:items-end sm:px-6 sm:pb-6">
          {fault && (
            <div className="jc-panel pointer-events-auto flex w-full max-w-md flex-col gap-2 border-danger/50 p-4" role="alert" data-testid="practice-fault">
              <p className="text-sm text-danger-soft">{tr(T.fault)}</p>
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
      <Modal open={results} onClose={() => setResults(false)} title={tr(T.resultsTitle)} wide closeLabel={t('common.close')}>
        <PracticeResults s={s} />
      </Modal>
      <Modal open={!!bot} onClose={() => setBot(null)} title={bot?.nickname ?? ''} closeLabel={t('common.close')}>
        {bot && <PracticeBot s={s} seat={bot.seatIndex} />}
      </Modal>
    </div>
  );
}
