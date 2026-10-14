import { RANKS, type Card } from '@jc/types';
import { cx, PlayingCard } from '@jc/ui';
import { useState } from 'react';
import { useI18n } from '../../lib/i18n';
import { cardName, l, SUIT_INFO, useTr, type SuitCode } from '../content';
import { CARD_QUESTIONS, FACE_NAMES, RANK_ORDER } from '../data/cards';
import { LessonShell, QuizRunner, type LessonStep } from '../ui';

const SUITS: SuitCode[] = ['s', 'h', 'd', 'c'];

function DeckStep() {
  const tr = useTr();
  const [suit, setSuit] = useState<SuitCode>('s');
  const cards = [...RANKS].reverse().map((r) => `${r}${suit}` as Card);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-relaxed text-ink-100">
        {tr(l('포커에서 쓰는 카드 한 벌(덱)은 조커를 빼고 52장입니다. 네 가지 문양마다 A, 2~10, J, Q, K 의 13장이 있어요 (4 × 13 = 52).', 'A poker deck has 52 cards, no jokers: four suits, each with 13 cards — A, 2 to 10, J, Q, K (4 × 13 = 52).'))}
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="tablist" aria-label={tr(l('문양', 'Suits'))}>
        {SUITS.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={suit === s}
            data-suit={s}
            onClick={() => setSuit(s)}
            className={cx('jc-tap flex min-h-14 items-center gap-2 rounded-xl border px-3 py-2 text-left transition', suit === s ? 'border-gold-400 bg-gold-500/15' : 'border-white/10 bg-ink-850')}
          >
            <span className={cx('text-2xl leading-none', SUIT_INFO[s].red ? 'text-[#e0565e]' : 'text-ivory')}>{SUIT_INFO[s].glyph}</span>
            <span className="text-sm font-semibold text-ivory">{tr(SUIT_INFO[s].name)}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap justify-center gap-1.5" data-testid="suit-cards">
        {cards.map((c, i) => (
          <PlayingCard key={c} card={c} size="clamp(2.3rem,10vw,3rem)" animate="deal" style={{ animationDelay: `${i * 25}ms` }} />
        ))}
      </div>
      <p className="text-xs text-ink-400">{tr(l('빨간 문양: ♥ 하트, ♦ 다이아몬드 · 검은 문양: ♠ 스페이드, ♣ 클럽', 'Red: ♥ Hearts, ♦ Diamonds · Black: ♠ Spades, ♣ Clubs'))}</p>
    </div>
  );
}

function AnatomyStep() {
  const tr = useTr();
  const { locale } = useI18n();
  const [focus, setFocus] = useState<Card>('Qh');
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
        <div className="relative shrink-0">
          <PlayingCard card={focus} size="7rem" />
          <span className="absolute -left-2 -top-2 rounded-full bg-gold-500 px-2 py-0.5 text-[10px] font-bold text-ink-950">{tr(l('숫자 + 문양', 'rank + suit'))}</span>
        </div>
        <div className="flex flex-col gap-2 text-sm text-ink-100">
          <p>{tr(l('카드 왼쪽 위에 숫자(랭크)와 문양(수트)이 함께 적혀 있습니다. 오른쪽 아래의 큰 문양은 한눈에 알아보기 위한 표시예요.', 'The rank and suit sit together in the top-left corner; the big symbol bottom-right is for quick recognition.'))}</p>
          <p className="font-semibold text-gold-300" aria-live="polite">{cardName(focus, locale)}</p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {FACE_NAMES.map((f) => (
          <button key={f.rank} onClick={() => setFocus(`${f.rank}${focus[1]}` as Card)} className={cx('jc-tap flex items-center gap-3 rounded-xl border p-2 text-left', focus[0] === f.rank ? 'border-gold-400 bg-gold-500/10' : 'border-white/10 bg-ink-850')}>
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-ink-700 font-display text-lg font-bold text-gold-300">{f.rank}</span>
            <span>
              <span className="block text-sm font-bold text-ivory">{locale === 'ko' ? f.ko : f.en}</span>
              <span className="block text-xs text-ink-300">{tr(f.note)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function OrderStep() {
  const tr = useTr();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-100">{tr(l('홀덤에서 카드의 높고 낮음은 숫자로만 정해집니다.', "In hold'em only the rank decides which card is higher."))}</p>
      <div className="flex flex-wrap items-center justify-center gap-1" data-testid="rank-order">
        {RANK_ORDER.map((r, i) => (
          <span key={r} className="flex items-center gap-1">
            <PlayingCard card={`${r}${['s', 'h', 'd', 'c'][i % 4]}` as Card} size="clamp(2rem,7vw,2.6rem)" />
            {i < RANK_ORDER.length - 1 && <span className="text-xs text-gold-400">›</span>}
          </span>
        ))}
      </div>
      <ul className="flex flex-col gap-2 text-sm text-ink-100">
        <li className="rounded-xl border border-gold-500/20 bg-gold-500/5 p-3">
          <b className="text-gold-300">A</b> {tr(l('는 가장 높은 카드이지만, A-2-3-4-5 스트레이트에서는 1처럼 가장 낮은 카드로도 쓸 수 있습니다.', 'is the highest card, but in the A-2-3-4-5 straight it can also play as the lowest (1).'))}
          <div className="mt-2 flex gap-1">
            {(['5d', '4c', '3h', '2s', 'Ad'] as Card[]).map((c) => (
              <PlayingCard key={c} card={c} size="2rem" />
            ))}
          </div>
        </li>
        <li className="rounded-xl border border-white/10 bg-ink-850 p-3">{tr(l('문양 사이에는 우열이 없습니다. ♠A 와 ♥A 는 같은 높이입니다.', 'Suits have no order: ♠A and ♥A are exactly equal.'))}</li>
      </ul>
    </div>
  );
}

export function CardsLesson() {
  const [quizDone, setQuizDone] = useState(false);
  const steps: LessonStep[] = [
    { title: l('카드 한 벌의 구성', 'What is in a deck'), body: <DeckStep /> },
    { title: l('카드 읽는 법과 그림 카드', 'Reading a card'), body: <AnatomyStep /> },
    { title: l('카드의 높고 낮음', 'Which card is higher'), body: <OrderStep /> },
    { title: l('퀴즈: 카드를 골라 보세요', 'Quiz: pick the card'), body: <QuizRunner questions={CARD_QUESTIONS} onDone={() => setQuizDone(true)} />, locked: !quizDone },
  ];
  return <LessonShell id="cards" title={l('Lesson 1 · 플레잉카드의 기초', 'Lesson 1 · Playing card basics')} steps={steps} next={{ to: '/academy/hands', label: l('Lesson 2 · 포커 족보', 'Lesson 2 · Hand rankings') }} />;
}

