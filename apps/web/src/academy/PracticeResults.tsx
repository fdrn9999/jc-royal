/**
 * The free practice's results (FreePracticePage "결과"): the hero's decisions of the chosen topic with the arithmetic of
 * the moment, the habits that came back, and the hero's own HUD over the session, each linked to the course page on
 * it. Figures are math, habits rules of thumb; no solver is behind any of it, so nothing here is called right or wrong.
 * Read from the session in the page's memory only (practice/review.ts): it ends with the practice.
 */
import { cardLabel, inHoleOrder } from '@jc/ui';
import { Link } from 'react-router';
import { KindTag } from '../game/AnalysisTag';
import { oddsRatio } from '../game/potOdds';
import { HudFigures } from '../game/SeatHud';
import { callPrice, sprOf } from '../game/strategy';
import { useI18n, type MsgKey } from '../lib/i18n';
import { describeCurrent, l, useTr, type L } from './content';
import type { FreeSession } from './practice/free';
import { CHEAP_FOLD_NEED, DRAW_FOLD_NEED, repeatedPatterns, SHORT_STACK_BB, type PatternId, type PracticeTopic } from './practice/review';

/** What each topic drills, where it is studied, and whether the table is dealt for it or it is gathered as it comes. */
export const TOPICS: Record<PracticeTopic, { name: L; about: L; to: string; study: L }> = {
  free: { name: l('자유', 'Free play'), about: l('주제 없이 모든 결정을 돌아봅니다.', 'Every decision, no topic.'), to: '/academy/gto', study: l('고급 과정', 'The advanced course') },
  preflop: { name: l('프리플랍', 'Preflop'), about: l('플랍 전의 결정: 오픈, 콜, 폴드.', 'Decisions before the flop: open, call or fold.'), to: '/academy/gto/position?step=1', study: l('자리마다 다른 오픈 레인지', 'Opening ranges by seat') },
  threeBet: { name: l('3Bet 대응', 'Facing a 3-bet'), about: l('내 오픈 레이즈가 다시 레이즈(3Bet)를 맞은 결정.', 'Your open raise raised again (a 3-bet).'), to: '/academy/gto/ranges?step=1', study: l('13×13 레인지 매트릭스', 'The 13×13 range matrix') },
  bbDefense: { name: l('블라인드 방어', 'Big blind defence'), about: l('매 핸드 빅 블라인드에 앉아, 오픈 레이즈 하나를 마주한 결정을 봅니다.', 'You post the big blind every hand; the decisions facing one open raise.'), to: '/academy/gto/hands?id=bb-86s', study: l('빅 블라인드 방어 예시', 'A big blind defence example') },
  cbet: { name: l('CBet 대응', 'Facing a c-bet'), about: l('프리플랍 레이저가 플랍에 먼저 베팅(CBet)한 결정.', 'The preflop raiser bets the flop (a c-bet).'), to: '/academy/gto/mdf?step=0', study: l('최소 방어 빈도(MDF)', 'Minimum defence frequency') },
  turn: { name: l('턴 의사결정', 'Turn decisions'), about: l('턴에서 한 결정.', 'Decisions on the turn.'), to: '/academy/gto/streets?step=0', study: l('턴: 계속 베팅할까', 'Turn: keep betting?') },
  river: { name: l('리버 의사결정', 'River decisions'), about: l('리버에서 한 결정.', 'Decisions on the river.'), to: '/academy/gto/streets?step=1', study: l('리버: 얇은 밸류', 'River: thin value') },
  shortStack: {
    name: l('숏스택 플레이', 'Short stack'),
    about: l(`매 핸드 ${SHORT_STACK_BB}BB로 시작합니다. 유효 스택 ${SHORT_STACK_BB}BB 이하의 결정을 봅니다.`, `You start every hand with ${SHORT_STACK_BB} BB; decisions ${SHORT_STACK_BB} BB deep or less.`),
    to: '/academy/gto/sizing?step=3',
    study: l('SPR과 프로텍션', 'SPR and protection'),
  },
  headsUp: { name: l('헤즈업', 'Heads-up'), about: l('봇 한 명과 일대일. 상대 수는 1로 고정됩니다.', 'One on one against a single bot.'), to: '/academy/gto/position?step=0', study: l('정보와 주도권', 'Information and control') },
};

/** The topics the table is dealt for; the others are gathered as the spots come up. */
export const DEALT_TOPICS: ReadonlySet<PracticeTopic> = new Set(['bbDefense', 'shortStack', 'headsUp']);

const PATTERN_TEXT: Record<PatternId, { name: L; why: L; to: string; study: L }> = {
  cheapFold: {
    name: l('싼 가격의 폴드', 'A cheap fold'),
    why: l(`콜에 필요한 승률이 ${CHEAP_FOLD_NEED}% 이하인 베팅에 폴드했습니다. 그 가격이면 콜할 수 있는 패가 넓어집니다.`, `You folded where a call needed ${CHEAP_FOLD_NEED}% or less; at that price many hands can call.`),
    to: '/academy/gto/math?step=0',
    study: l('팟 오즈와 필요 에퀴티', 'Pot odds and required equity'),
  },
  openLimp: {
    name: l('오픈 림프', 'Open limp'),
    why: l('아무도 레이즈하지 않은 프리플랍에서 처음 참여를 콜로 했습니다. 참여한다면 레이즈로 여는 것을 기준선으로 삼는 경우가 많습니다.', 'First in preflop, you called; the usual baseline is to come in with a raise.'),
    to: '/academy/gto/position?step=1',
    study: l('자리마다 다른 오픈 레인지', 'Opening ranges by seat'),
  },
  drawFold: {
    name: l('드로우 폴드', 'Folding a draw'),
    why: l(`플랍에서 플러시나 양방향 스트레이트 드로우로, 필요 승률 ${DRAW_FOLD_NEED}% 이하의 베팅에 폴드했습니다. 아웃츠로 남은 카드의 확률을 셈해 보세요.`, `On the flop you folded a flush or open-ended straight draw where a call needed ${DRAW_FOLD_NEED}% or less; count your outs.`),
    to: '/academy/gto/math?step=1',
    study: l('아웃츠와 2·4 규칙', 'Outs and the rule of 2 and 4'),
  },
  riverCallNoPair: {
    name: l('노 페어 리버 콜', 'River call with no pair'),
    why: l('리버에서 원 페어도 없이 콜했습니다. 블러프만 이기는 콜이 가격에 맞는지 살펴보세요.', 'You called the river with no pair; see whether a call that beats only bluffs fits the price.'),
    to: '/academy/gto/streets?step=2',
    study: l('리버: 블러프 캐치', 'River: bluff-catching'),
  },
  riverCheckStrong: {
    name: l('강한 패로 리버 체크', 'Checking back a strong river'),
    why: l('리버에서 마지막 순서로, 보드만으로 된 것이 아닌 트립스 이상을 들고 체크했습니다. 밸류 베팅을 생각해 볼 만합니다.', 'Last to act on the river, you checked trips or better the board alone did not make; a value bet is worth a thought.'),
    to: '/academy/gto/streets?step=1',
    study: l('리버: 얇은 밸류', 'River: thin value'),
  },
};

const T = {
  hands: l('핸드 {n}', '{n} hands'),
  decisions: l('결정 {n}', '{n} decisions'),
  latest: l('최근 {n}개의 결정을 보여 줍니다.', 'The latest {n} decisions.'),
  none: l('아직 플레이한 핸드가 없습니다. 핸드를 마치면 여기에 결정이 모입니다.', 'No hand played yet. Finish a hand and its decisions gather here.'),
  noneTopic: l('아직 이 주제의 상황이 나오지 않았습니다. 그 상황이 실제로 생기면 여기에 모입니다.', 'No spot of this topic has come up yet; it gathers here once one does.'),
  gathered: l('이 주제는 테이블을 바꾸지 않습니다. 그 상황이 플레이 중에 생길 때마다 모읍니다.', 'This topic does not change the table: its spots are gathered as they come up in play.'),
  figures: l('수치', 'Figures'),
  habits: l('반복된 습관', 'Habits that came back'),
  habitsNone: l('두 번 이상 반복된 습관은 아직 없습니다.', 'No habit has come back twice yet.'),
  habitsNote: l('단순한 기준으로 찾은 것이며 정답이나 오답 판정이 아닙니다. 실제 솔버 계산은 연결되어 있지 않습니다.', 'Found by simple rules of thumb, never a verdict: no solver is connected.'),
  habitHands: l('{count}회 · 핸드 {hands}', '{count} times · hands {hands}'),
  me: l('이번 연습의 내 통계', 'Your figures this practice'),
  study: l('관련 학습', 'Study'),
  hand: l('핸드 #{n}', 'Hand #{n}'),
  did: l('선택', 'Chose'),
  others: l('다른 선택지', 'Other options'),
  odds: l('팟 오즈', 'Pot odds'),
  oddsLine: l('{ratio} · 필요 승률 {need}%', '{ratio} · equity needed {need}%'),
  noCall: l('콜할 금액 없음', 'Nothing to call'),
  oddsUnsure: l('기록으로 확정할 수 없어 셈하지 않음', 'Not counted: the record leaves it uncertain'),
  spr: l('SPR', 'SPR'),
  sprLine: l('{n} (스트리트 시작)', '{n} (as the street began)'),
  sprPre: l('플랍부터 셉니다', 'Counted from the flop'),
  cards: l('내 패', 'My hand'),
  made: l('현재 핸드', 'Hand now'),
  kept: l('이 결과는 이 화면에만 있습니다. 공식 전적·지갑·칩 원장에 저장되지 않고, 연습을 나가거나 설정으로 돌아가면 사라집니다. 학습 링크를 열어도 이 연습은 끝납니다.', 'These results live on this screen only: never in your records, wallet or chip ledger, and gone once you leave the practice or go back to setup. Opening a study link ends this practice too.'),
};

/** Past this many the list shows the latest only. */
const MAX_SHOWN = 30;

export function PracticeResults({ s }: { s: FreeSession }) {
  const tr = useTr();
  const { t, locale } = useI18n();
  const topic = TOPICS[s.topic];
  const mine = s.decisions.filter((x) => x.topics.includes(s.topic));
  const shown = mine.slice(-MAX_SHOWN).reverse();
  const habits = repeatedPatterns(s.decisions);
  const choice = (c: string) => t(`action.${c}` as MsgKey);
  const say = (ko: string, en: string) => (locale === 'ko' ? ko : en);
  const section = 'flex flex-col gap-2';
  const heading = 'flex flex-wrap items-center gap-2 text-xs font-bold tracking-[0.08em] text-ink-300';
  const studyLink = 'jc-tap inline-flex min-h-9 items-center self-start rounded-md border border-white/10 bg-white/[0.04] px-2.5 text-[11px] font-semibold text-ink-100 hover:bg-white/10';
  return (
    <div className="flex flex-col gap-4 px-5 py-4" data-testid="free-summary">
      <div className="flex flex-col gap-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-bold text-ivory" data-testid="free-summary-topic">{tr(topic.name)}</span>
          <span className="font-mono text-xs text-ink-300">
            {tr(T.hands, { n: s.settledHands })} · <span data-testid="free-summary-count">{tr(T.decisions, { n: mine.length })}</span>
          </span>
        </p>
        <p className="text-xs text-ink-300">{tr(topic.about)}</p>
        {!DEALT_TOPICS.has(s.topic) && s.topic !== 'free' && <p className="text-xs text-ink-400">{tr(T.gathered)}</p>}
      </div>

      <section className={section} aria-label={tr(T.figures)}>
        <div className={heading}>
          {tr(T.figures)} <KindTag kind="math" tr={say} />
        </div>
        {shown.length === 0 ? (
          <p className="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-sm text-ink-300" data-testid="free-summary-empty">
            {tr(s.settledHands === 0 ? T.none : T.noneTopic)}
          </p>
        ) : (
          <>
            {mine.length > MAX_SHOWN && <p className="text-[11px] text-ink-400">{tr(T.latest, { n: MAX_SHOWN })}</p>}
            <ol className="flex flex-col gap-2">
              {shown.map((x) => {
                const d = x.d;
                const price = callPrice(d);
                const ratio = sprOf(d);
                const made = describeCurrent(d.cards, d.board, locale, t);
                const others = d.options.filter((o) => o !== d.did);
                return (
                  <li key={`${x.hand}-${d.action}`} className="flex flex-col gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] p-2.5 text-xs" data-testid="free-summary-decision" data-stage={d.stage}>
                    <p className="flex flex-wrap items-baseline gap-x-2 font-semibold text-ivory">
                      <span className="font-mono text-gold-300">{tr(T.hand, { n: x.hand })}</span>
                      <span>{t(`stage.${d.stage}` as MsgKey)}</span>
                      {d.position && <span className="text-ink-300">{d.position}</span>}
                      {d.board.length > 0 && <span className="font-mono text-ink-300">{d.board.map(cardLabel).join(' ')}</span>}
                    </p>
                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 [&>dt]:text-ink-400 [&>dd]:min-w-0 [&>dd]:break-words [&>dd]:text-ink-100">
                      {d.cards && (
                        <>
                          <dt>{tr(T.cards)}</dt>
                          <dd className="font-mono">{inHoleOrder(d.cards).map(cardLabel).join(' ')}{made && <span className="ml-2 font-sans text-ink-300">{made}</span>}</dd>
                        </>
                      )}
                      <dt>{tr(T.did)}</dt>
                      <dd className="font-semibold" data-testid="free-summary-did">
                        {choice(d.did)}
                        {others.length > 0 && <span className="ml-2 font-normal text-ink-400">({tr(T.others)}: {others.map(choice).join(' · ')})</span>}
                      </dd>
                      <dt>{tr(T.odds)}</dt>
                      <dd className="font-mono" data-testid="free-summary-odds">{price ? tr(T.oddsLine, { ratio: oddsRatio(price), need: price.need }) : tr(d.toCall === 0 ? T.noCall : T.oddsUnsure)}</dd>
                      <dt>{tr(T.spr)}</dt>
                      <dd className="font-mono" data-testid="free-summary-spr">{ratio !== null ? tr(T.sprLine, { n: ratio.toFixed(1) }) : tr(T.sprPre)}</dd>
                    </dl>
                    {x.patterns.length > 0 && (
                      <p className="flex flex-wrap items-center gap-1.5">
                        <KindTag kind="heuristic" tr={say} />
                        {x.patterns.map((p) => (
                          <span key={p} className="text-gold-300" data-testid="free-summary-pattern" data-pattern={p}>
                            {tr(PATTERN_TEXT[p].name)}
                          </span>
                        ))}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        )}
        {s.topic !== 'free' && (
          <Link className={studyLink} to={topic.to} data-testid="free-summary-topic-study">
            {tr(T.study)} · {tr(topic.study)}
          </Link>
        )}
      </section>

      <section className={section} aria-label={tr(T.habits)} data-testid="free-summary-habits">
        <div className={heading}>
          {tr(T.habits)} <KindTag kind="heuristic" tr={say} />
        </div>
        <p className="text-[11px] leading-relaxed text-ink-400">{tr(T.habitsNote)}</p>
        {habits.length === 0 ? (
          <p className="text-sm text-ink-300" data-testid="free-summary-habits-none">{tr(T.habitsNone)}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {habits.map((h) => {
              const p = PATTERN_TEXT[h.id];
              return (
                <li key={h.id} className="flex flex-col gap-1.5 rounded-lg border border-gold-500/25 bg-gold-500/[0.04] p-2.5 text-xs" data-testid="free-summary-habit" data-pattern={h.id}>
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-semibold text-gold-300">{tr(p.name)}</span>
                    <span className="font-mono text-ink-300">{tr(T.habitHands, { count: h.count, hands: h.hands.map((n) => `#${n}`).join(' ') })}</span>
                  </p>
                  <p className="leading-relaxed text-ink-200">{tr(p.why)}</p>
                  <Link className={studyLink} to={p.to}>
                    {tr(T.study)} · {tr(p.study)}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={section} aria-label={tr(T.me)}>
        <div className={heading}>{tr(T.me)}</div>
        <HudFigures stats={s.hud(s.shape.hero)} kind="practice" bot={false} />
      </section>

      <p className="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs leading-relaxed text-ink-300" data-testid="free-summary-kept">
        {tr(T.kept)}
      </p>
    </div>
  );
}
