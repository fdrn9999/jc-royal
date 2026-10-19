/**
 * Advanced GTO Academy: the interactive tools a lesson step names (GtoToolKind). Each one recomputes as the learner
 * changes its inputs, writes the formula out with the numbers put in, and says how exact the result is and under which
 * model. Pure arithmetic from ./math: no engine, no network, no solver.
 */
import type { Card } from '@jc/types';
import { Button, cx } from '@jc/ui';
import { useMemo, useState } from 'react';
import { l, useTr, type L } from '../content';
import { cardText, calcSteps } from './explain';
import { CardPicker, CardsView, classInfo, Note, Num, Out, RangeGrid, Slider, Steps, ToolBox, G } from './parts';
import {
  alpha,
  balancedBluffs,
  bluffShare,
  combosOf,
  comboCount,
  evBluff,
  evCall,
  geometric,
  mdf,
  num,
  OPEN_RANGES,
  OPEN_SEATS,
  outsExact,
  outsRule,
  parseRange,
  potBetsToAllIn,
  potOdds,
  potOddsRatio,
  rangeCombos,
  share,
  signed,
  sizedBet,
  spr,
  texture,
  TOTAL_COMBOS,
  valuePerBluff,
  type OpenSeat,
} from './math';
import type { GtoToolKind } from './types';
import { STREET_WALK } from './walk';

const T = {
  pot: l('팟 (베팅 전)', 'Pot (before the bet)'),
  bet: l('베팅', 'Bet'),
  stack: l('유효 스택', 'Effective stack'),
  call: l('콜 금액', 'To call'),
  finalPot: l('콜 뒤 최종 팟', 'Final pot after the call'),
  need: l('필요 에퀴티', 'Required equity'),
  ratio: l('팟 오즈', 'Pot odds'),
  mdf: l('최소 방어 빈도(MDF)', 'Minimum defence frequency (MDF)'),
  alpha: l('블러프 손익분기 폴드율(알파)', 'Bluff break-even fold rate (alpha)'),
  bluffShare: l('균형 블러프 비율', 'Balanced bluff share'),
  closeModel: l('이 콜로 베팅이 끝나고 더 이상 돈이 들어가지 않는다고 본 값입니다. 실제로는 이후 베팅과 에퀴티 실현 정도에 따라 달라집니다.', 'Assumes the call ends the betting and no more money goes in. In play, later bets and how much equity you realise change it.'),
  riverModel: l('리버에서 베팅 한 번, 콜하는 쪽은 블러프만 이기는 핸드를 가진다고 본 값입니다.', 'Assumes one river bet and a caller who holds only bluff-catchers.'),
};

function useTool() {
  return useTr();
}

// ------------------------------------------------------------------ foundations: indifference

function IndifferenceTool() {
  const tr = useTool();
  const pot = 100;
  const [bet, setBet] = useState(100);
  const [bluffs, setBluffs] = useState(50);
  const [calls, setCalls] = useState(30);
  const b = bluffs / 100;
  const c = calls / 100;
  const callEv = b * (pot + bet) - (1 - b) * bet;
  const bluffEv = (1 - c) * pot - c * bet;
  const balB = bluffShare(pot, bet);
  const balC = mdf(pot, bet);
  const best = (ev: number, yes: L, no: L) => (Math.abs(ev) < 0.05 ? l('무차별: 어느 쪽이든 같음', 'Indifferent: either is the same') : ev > 0 ? yes : no);
  return (
    <ToolBox title={l('무차별 시뮬레이션 (리버, 팟 100)', 'Indifference simulation (river, pot 100)')} testid="tool-indifference">
      <div className="flex flex-wrap gap-2" role="group" aria-label={tr(T.bet)}>
        {[50, 100, 200].map((x) => (
          <Button key={x} size="sm" variant={bet === x ? 'gold' : 'subtle'} aria-pressed={bet === x} onClick={() => setBet(x)}>
            {tr(T.bet)} {x}
          </Button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Slider label={tr(l('베팅하는 쪽의 블러프 비율', 'Bettor’s bluff share'))} value={bluffs} onChange={setBluffs} min={0} max={100} format={(v) => `${v}%`} testid="ind-bluffs" />
        <Slider label={tr(l('콜하는 쪽의 콜 빈도', 'Caller’s call frequency'))} value={calls} onChange={setCalls} min={0} max={100} format={(v) => `${v}%`} testid="ind-calls" />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Out label={tr(l('블러프 캐처로 콜하는 EV', 'EV of calling with a bluff-catcher'))} value={signed(callEv)} sub={tr(best(callEv, l('콜이 이득 → 콜을 늘린다', 'Calling gains → call more'), l('폴드가 낫다 → 콜을 줄인다', 'Folding is better → call less')))} strong testid="ind-call-ev" />
        <Out label={tr(l('블러프 한 번의 EV', 'EV of one bluff'))} value={signed(bluffEv)} sub={tr(best(bluffEv, l('블러프가 이득 → 블러프를 늘린다', 'Bluffing gains → bluff more'), l('블러프가 손해 → 블러프를 줄인다', 'Bluffing loses → bluff less')))} strong testid="ind-bluff-ev" />
      </div>
      <Steps
        lines={[
          l(`콜 EV = 블러프 비율 × (팟 + 베팅) − 밸류 비율 × 베팅 = ${share(b)} × ${pot + bet} − ${share(1 - b)} × ${bet} = ${signed(callEv)}`, `Call EV = bluff share × (pot + bet) − value share × bet = ${share(b)} × ${pot + bet} − ${share(1 - b)} × ${bet} = ${signed(callEv)}`),
          l(`블러프 EV = 폴드 빈도 × 팟 − 콜 빈도 × 베팅 = ${share(1 - c)} × ${pot} − ${share(c)} × ${bet} = ${signed(bluffEv)}`, `Bluff EV = fold frequency × pot − call frequency × bet = ${share(1 - c)} × ${pot} − ${share(c)} × ${bet} = ${signed(bluffEv)}`),
          l(`균형점: 블러프 비율 ${share(balB)} (콜이 무차별), 콜 빈도 ${share(balC)} (블러프가 무차별)`, `Balance: bluff share ${share(balB)} (calling indifferent), call frequency ${share(balC)} (bluffing indifferent)`),
        ]}
      />
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        onClick={() => {
          setBluffs(Math.round(balB * 100));
          setCalls(Math.round(balC * 100));
        }}
        data-testid="ind-balance"
      >
        {tr(l('균형점으로 맞추기', 'Set both to balance'))}
      </Button>
      <Note accuracy="exact">{l('리버 베팅 한 번, 콜하는 쪽은 블러프만 이기고 베팅하는 쪽의 밸류는 콜을 받으면 항상 이긴다는 단순 모델입니다. 슬라이더는 1% 단위라 균형점에서 EV가 0에 아주 가까운 값으로 보일 수 있습니다.', 'A simple model: one river bet, the caller beats only bluffs, and the bettor’s value always wins when called. The sliders move in 1% steps, so at balance the EV can show as very close to 0.')}</Note>
    </ToolBox>
  );
}

// ------------------------------------------------------------------ ranges: matrix and combos

function MatrixTool() {
  const tr = useTool();
  const [range, setRange] = useState<Set<string>>(() => parseRange(OPEN_RANGES.CO));
  const [sel, setSel] = useState<string | null>('AKs');
  const [dead, setDead] = useState<Card[]>([]);
  const [preset, setPreset] = useState<OpenSeat | null>('CO');
  const combos = rangeCombos(range, dead);
  const full = rangeCombos(range);
  const toggle = (cls: string) => {
    setSel(cls);
    setPreset(null);
    setRange((r) => {
      const n = new Set(r);
      if (n.has(cls)) n.delete(cls);
      else n.add(cls);
      return n;
    });
  };
  return (
    <ToolBox title={l('13×13 레인지 매트릭스', '13×13 range matrix')} testid="tool-matrix">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={tr(l('예시 레인지', 'Example ranges'))}>
        {OPEN_SEATS.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={preset === s ? 'gold' : 'subtle'}
            aria-pressed={preset === s}
            onClick={() => {
              setRange(parseRange(OPEN_RANGES[s]));
              setPreset(s);
            }}
          >
            {s}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setRange(new Set());
            setPreset(null);
          }}
        >
          {tr(G.clear)}
        </Button>
      </div>
      <p className="text-xs text-ink-300">{tr(l('칸을 누르면 레인지에 넣거나 뺍니다. 대각선은 페어, 위는 수딧, 아래는 오프수딧입니다. ● 표시가 레인지 안입니다.', 'Tap a cell to add or remove it. The diagonal holds pairs, above it suited hands, below it offsuit. ● marks a hand in the range.'))}</p>
      <RangeGrid range={range} selected={sel} onCell={toggle} label={tr(l('레인지 매트릭스', 'Range matrix'))} testid="matrix-grid" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Out label={tr(l('핸드 종류', 'Hand classes'))} value={String(range.size)} sub="/ 169" />
        <Out label={tr(l('콤보', 'Combos'))} value={String(combos)} sub={dead.length ? tr(l('카드 제거 전 {n}', 'before removal {n}'), { n: full }) : `/ ${TOTAL_COMBOS}`} strong testid="matrix-combos" />
        <Out label={tr(l('전체 핸드 중 비율', 'Share of all hands'))} value={share(full / TOTAL_COMBOS)} sub={tr(l('카드 제거 전', 'before removal'))} testid="matrix-share" />
        <Out label={tr(l('선택한 핸드', 'Selected hand'))} value={sel ?? '—'} sub={sel ? `${tr(range.has(sel) ? G.inRange : G.outRange)} · ${tr(G.combos, { n: comboCount(sel, dead) })}` : undefined} testid="matrix-selected" />
      </div>
      {sel && <p className="text-xs text-ink-300" data-testid="matrix-selected-info">{classInfo(sel, tr)}{dead.length ? ` → ${tr(l('보이는 카드를 빼면', 'with the visible cards out'))} ${tr(G.combos, { n: comboCount(sel, dead) })}` : ''}</p>}
      <details className="rounded-xl border border-white/10 p-2">
        <summary className="jc-tap cursor-pointer text-sm font-semibold text-ivory">{tr(l('카드 제거: 보이는 카드 고르기', 'Card removal: pick visible cards'))}</summary>
        <div className="pt-2">
          <CardPicker value={dead} onChange={setDead} max={7} label={tr(G.picked)} testid="matrix-dead" />
        </div>
      </details>
      <Steps
        lines={[
          l('페어 6콤보 · 수딧 4콤보 · 오프수딧 12콤보, 모두 합치면 1326콤보', 'A pair is 6 combos, suited 4, offsuit 12; all hands together are 1326'),
          l(`이 레인지: ${full}콤보 ÷ 1326 = ${share(full / TOTAL_COMBOS)}`, `This range: ${full} combos ÷ 1326 = ${share(full / TOTAL_COMBOS)}`),
          ...(dead.length ? [l(`보이는 카드(${dead.map(cardText).join(' ')})를 쓰는 콤보를 빼면 ${combos}콤보`, `Without the combos that use a visible card (${dead.map(cardText).join(' ')}): ${combos}`)] : []),
        ]}
      />
      <Note accuracy="example">{l('UTG~SB 버튼은 6인 캐시·100bb·앤티 없음 기준으로 이 아카데미가 만든 학습용 예시 레인지입니다. 솔버 결과가 아니며, 실제 레인지는 스택·레이크·상대에 따라 달라집니다. 콤보 수와 비율은 정확한 계산입니다.', 'The UTG–SB buttons load this academy’s teaching example ranges for 6-max cash, 100 bb, no ante. They are not solver output, and real ranges move with stacks, rake and opponents. The combo counts and shares are exact.')}</Note>
    </ToolBox>
  );
}

function CombosTool() {
  const tr = useTool();
  const [cls, setCls] = useState('AKs');
  const [dead, setDead] = useState<Card[]>(['As']);
  const single = useMemo(() => new Set([cls]), [cls]);
  const all = combosOf(cls);
  const left = combosOf(cls, dead);
  const gone = all.filter(([a, b]) => !left.some(([x, y]) => x === a && y === b));
  return (
    <ToolBox title={l('콤보 계산기 (카드 제거)', 'Combo counter (card removal)')} testid="tool-combos">
      <p className="text-xs text-ink-300">{tr(l('매트릭스에서 핸드를 고르고, 아래에서 보이는 카드(내 핸드·보드)를 고르세요.', 'Pick a hand on the grid, then the visible cards (your hand, the board) below.'))}</p>
      <RangeGrid range={single} selected={cls} onCell={setCls} label={tr(l('핸드 고르기', 'Pick a hand'))} testid="combos-grid" />
      <CardPicker value={dead} onChange={setDead} max={7} label={tr(G.picked)} testid="combos-dead" />
      <div className="grid grid-cols-3 gap-2">
        <Out label={tr(l('전체', 'All'))} value={String(all.length)} />
        <Out label={tr(l('제거됨', 'Removed'))} value={String(gone.length)} />
        <Out label={tr(l('남은 콤보', 'Left'))} value={String(left.length)} strong testid="combos-left" />
      </div>
      <p className="break-words font-mono text-xs text-ink-200" data-testid="combos-list">
        {left.map(([a, b]) => `${cardText(a)}${cardText(b)}`).join('  ') || '—'}
      </p>
      <Steps lines={calcSteps({ kind: 'combos', hand: cls, dead })} />
      <Note accuracy="exact">{l('보이는 카드만 뺀 정확한 개수입니다. 상대가 이 핸드를 실제로 어떤 빈도로 가지는지는 그 상대의 레인지에 달려 있습니다.', 'An exact count with the visible cards taken out. How often an opponent really holds the hand depends on their range.')}</Note>
    </ToolBox>
  );
}

// ------------------------------------------------------------------ math: pot odds, EV, outs

function PotOddsTool() {
  const tr = useTool();
  const [pot, setPot] = useState(100);
  const [bet, setBet] = useState(50);
  const need = potOdds(pot, bet);
  return (
    <ToolBox title={l('팟 오즈 계산기', 'Pot odds calculator')} testid="tool-potOdds">
      <div className="grid grid-cols-2 gap-2">
        <Num label={tr(T.pot)} value={pot} onChange={setPot} testid="po-pot" />
        <Num label={tr(T.bet)} value={bet} onChange={setBet} testid="po-bet" />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Out label={tr(T.call)} value={num(bet)} />
        <Out label={tr(T.finalPot)} value={num(pot + 2 * bet)} />
        <Out label={tr(T.ratio)} value={bet > 0 ? `${num(potOddsRatio(pot, bet))} : 1` : '—'} />
        <Out label={tr(T.need)} value={share(need)} strong testid="po-need" />
      </div>
      <Steps lines={bet > 0 ? calcSteps({ kind: 'potOdds', pot, bet }) : [l('베팅이 0이면 공짜로 볼 수 있어 필요 에퀴티도 0입니다.', 'With no bet you see the next card for free: the required equity is 0.')]} />
      <Note accuracy="exact">{T.closeModel}</Note>
    </ToolBox>
  );
}

function EvTool() {
  const tr = useTool();
  const [mode, setMode] = useState<'call' | 'bluff'>('call');
  const [pot, setPot] = useState(100);
  const [bet, setBet] = useState(50);
  const [eq, setEq] = useState(30);
  const [fold, setFold] = useState(40);
  const ev = mode === 'call' ? evCall(pot, bet, eq / 100) : evBluff(pot, bet, fold / 100);
  const even = mode === 'call' ? potOdds(pot, bet) : alpha(pot, bet);
  return (
    <ToolBox title={l('기대값(EV) 계산기', 'Expected value (EV) calculator')} testid="tool-ev">
      <div className="flex gap-2" role="group" aria-label="EV">
        <Button size="sm" variant={mode === 'call' ? 'gold' : 'subtle'} aria-pressed={mode === 'call'} onClick={() => setMode('call')}>
          {tr(l('콜', 'Call'))}
        </Button>
        <Button size="sm" variant={mode === 'bluff' ? 'gold' : 'subtle'} aria-pressed={mode === 'bluff'} onClick={() => setMode('bluff')}>
          {tr(l('순수 블러프', 'Pure bluff'))}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Num label={tr(T.pot)} value={pot} onChange={setPot} testid="ev-pot" />
        <Num label={tr(T.bet)} value={bet} onChange={setBet} testid="ev-bet" />
      </div>
      {mode === 'call' ? (
        <Slider label={tr(l('가정한 내 에퀴티', 'Your assumed equity'))} value={eq} onChange={setEq} min={0} max={100} format={(v) => `${v}%`} testid="ev-eq" />
      ) : (
        <Slider label={tr(l('가정한 상대 폴드율', 'Assumed fold rate'))} value={fold} onChange={setFold} min={0} max={100} format={(v) => `${v}%`} testid="ev-fold" />
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Out label={mode === 'call' ? 'EV(call)' : 'EV(bluff)'} value={signed(ev)} strong testid="ev-value" />
        <Out label={tr(mode === 'call' ? l('폴드의 EV', 'EV of folding') : l('체크의 EV(이 모델)', 'EV of checking (this model)'))} value="0" />
        <Out label={tr(mode === 'call' ? l('본전 에퀴티', 'Break-even equity') : l('본전 폴드율', 'Break-even fold rate'))} value={share(even)} />
      </div>
      <p className="text-sm font-semibold text-ivory" data-testid="ev-verdict">
        {Math.abs(ev) < 0.05
          ? tr(l('본전: 두 선택의 기대값이 같습니다.', 'Break-even: both choices are worth the same.'))
          : ev > 0
            ? tr(mode === 'call' ? l('콜이 폴드보다 낫습니다.', 'Calling beats folding.') : l('블러프가 체크보다 낫습니다.', 'Bluffing beats checking.'))
            : tr(mode === 'call' ? l('폴드가 콜보다 낫습니다.', 'Folding beats calling.') : l('체크가 블러프보다 낫습니다.', 'Checking beats bluffing.'))}
      </p>
      <Steps lines={calcSteps(mode === 'call' ? { kind: 'evCall', pot, bet, equity: eq / 100 } : { kind: 'evBluff', pot, bet, fold: fold / 100 })} />
      <Note accuracy="estimate">
        {mode === 'call'
          ? l('에퀴티는 내가 넣은 가정값이라 결과도 그만큼만 정확합니다. 실제 에퀴티는 상대 레인지에 따라 달라지고, 이후 베팅(임플라이드 오즈)과 에퀴티 실현은 넣지 않았습니다.', 'The equity is your assumption, so the result is only as good as it. Real equity depends on the opponent’s range, and later bets (implied odds) and equity realisation are left out.')
          : l('폴드율은 가정값입니다. 블러프는 콜을 받으면 항상 지고, 체크하면 팟을 얻지 못한다(EV 0)고 단순화했습니다.', 'The fold rate is an assumption. The model has the bluff always lose when called and checking win nothing (EV 0).')}
      </Note>
    </ToolBox>
  );
}

function OutsTool() {
  const tr = useTool();
  const [outs, setOuts] = useState(9);
  const [cards, setCards] = useState<1 | 2>(2);
  const exact = outsExact(outs, cards);
  const rule = outsRule(outs, cards);
  return (
    <ToolBox title={l('아웃츠 → 에퀴티', 'Outs → equity')} testid="tool-outs">
      <Slider label={tr(l('아웃 수', 'Outs'))} value={outs} onChange={setOuts} min={0} max={21} format={(v) => String(v)} testid="outs-n" />
      <div className="flex gap-2" role="group" aria-label={tr(l('남은 카드', 'Cards to come'))}>
        <Button size="sm" variant={cards === 2 ? 'gold' : 'subtle'} aria-pressed={cards === 2} onClick={() => setCards(2)}>
          {tr(l('플랍 → 리버 (2장)', 'Flop → river (2 cards)'))}
        </Button>
        <Button size="sm" variant={cards === 1 ? 'gold' : 'subtle'} aria-pressed={cards === 1} onClick={() => setCards(1)}>
          {tr(l('턴 → 리버 (1장)', 'Turn → river (1 card)'))}
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Out label={tr(l('정확한 값', 'Exact'))} value={share(exact)} strong testid="outs-exact" />
        <Out label={tr(l(cards === 2 ? '4의 법칙' : '2의 법칙', cards === 2 ? 'Rule of 4' : 'Rule of 2'))} value={share(rule)} />
        <Out label={tr(l('차이', 'Difference'))} value={`${signed((rule - exact) * 100)}%p`} />
      </div>
      <Steps lines={calcSteps({ kind: 'outs', outs, cards })} />
      <Note accuracy="exact">{l('정확한 값은 아웃이 나오면 이기고 다른 카드로는 이기지 못한다는 가정 아래의 확률이며, 상대의 카드도 보이지 않는 카드로 셉니다. 2·4의 법칙은 어림값이라 아웃이 많을수록 실제보다 커집니다.', 'The exact value assumes every out wins and no other card does, and counts the opponent’s cards as unseen. The rule of 2 and 4 is an estimate that runs high as the outs grow.')}</Note>
    </ToolBox>
  );
}

// ------------------------------------------------------------------ position

function PositionTool() {
  const tr = useTool();
  const [seat, setSeat] = useState<OpenSeat>('BTN');
  const [hand, setHand] = useState('K9o');
  const ranges = useMemo(() => Object.fromEntries(OPEN_SEATS.map((s) => [s, parseRange(OPEN_RANGES[s])])) as Record<OpenSeat, Set<string>>, []);
  const range = ranges[seat];
  return (
    <ToolBox title={l('같은 핸드, 다른 자리', 'One hand, every seat')} testid="tool-position">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={tr(l('자리', 'Seat'))}>
        {OPEN_SEATS.map((s) => (
          <Button key={s} size="sm" variant={seat === s ? 'gold' : 'subtle'} aria-pressed={seat === s} onClick={() => setSeat(s)}>
            {s}
          </Button>
        ))}
      </div>
      <p className="text-xs text-ink-300">{tr(l('칸을 눌러 비교할 핸드를 고르세요. ● 표시가 고른 자리의 예시 오픈 레인지입니다.', 'Tap a cell to pick the hand to compare. ● marks the chosen seat’s example opening range.'))}</p>
      <RangeGrid range={range} selected={hand} onCell={setHand} label={tr(l('자리별 오픈 레인지', 'Opening range by seat'))} testid="position-grid" />
      <div className="grid grid-cols-2 gap-2">
        <Out label={tr(l('{s} 오픈 비율', '{s} opens'), { s: seat })} value={share(rangeCombos(range) / TOTAL_COMBOS)} sub={tr(G.combos, { n: rangeCombos(range) })} strong />
        <Out label={tr(l('뒤에 남은 사람', 'Players left behind'))} value={String({ UTG: 5, HJ: 4, CO: 3, BTN: 2, SB: 1 }[seat])} />
      </div>
      <div className="flex flex-col gap-1.5" data-testid="position-compare">
        <div className="text-xs font-semibold text-ink-300">{classInfo(hand, tr)}</div>
        <div className="grid grid-cols-5 gap-1">
          {OPEN_SEATS.map((s) => {
            const on = ranges[s].has(hand);
            return (
              <div key={s} className={cx('flex flex-col items-center rounded-lg border px-1 py-1.5 text-xs font-bold', on ? 'border-success/60 bg-success/10 text-success-soft' : 'border-white/10 bg-ink-850 text-ink-400')} data-seat={s} data-open={on ? '1' : '0'}>
                <span>{s}</span>
                <span aria-hidden>{on ? '✓' : '✗'}</span>
                <span className="sr-only">{tr(on ? l('오픈', 'opens') : l('폴드', 'folds'))}</span>
              </div>
            );
          })}
        </div>
      </div>
      <Note accuracy="example">{l('6인 캐시·100bb·앤티 없음, 앞에서 모두 폴드했을 때의 학습용 예시 레인지입니다(솔버 결과 아님). 뒤에 남은 사람이 적고 플랍 이후 나중에 행동할수록 넓게 오픈한다는 흐름을 보여 주기 위한 것입니다.', 'Teaching example ranges for 6-max cash, 100 bb, no ante, folded to you (not solver output). They show the trend: fewer players behind and acting later after the flop mean wider opens.')}</Note>
    </ToolBox>
  );
}

// ------------------------------------------------------------------ texture

const FLOPS: Card[][] = [
  ['Ks', '7d', '2c'],
  ['9h', '8h', '6c'],
  ['Qs', 'Js', 'Ts'],
  ['5d', '5c', 'Kh'],
  ['Ah', '4h', '3c'],
];
const TEX: Record<string, L> = {
  unpaired: l('페어 없음', 'Unpaired'),
  paired: l('페어 보드', 'Paired'),
  trips: l('같은 숫자 세 장', 'Trips'),
  rainbow: l('무지개(문양 모두 다름)', 'Rainbow'),
  twoTone: l('같은 문양 2장', 'Two-tone'),
  monotone: l('같은 문양 3장', 'Monotone'),
  connected: l('연결됨', 'Connected'),
  semi: l('조금 연결됨', 'Semi-connected'),
  disconnected: l('떨어짐', 'Disconnected'),
  high: l('높음(A–Q)', 'High (A–Q)'),
  middle: l('중간(J–8)', 'Middle (J–8)'),
  low: l('낮음(7 이하)', 'Low (7 and under)'),
  dry: l('드라이', 'Dry'),
  medium: l('중간', 'Medium'),
  wet: l('웻', 'Wet'),
};
const TEX_WHY: Record<string, L> = {
  dry: l('드로우가 적어 핸드 순위가 잘 바뀌지 않습니다. 작은 컨티뉴에이션 벳을 자주 쓰기 좋은 보드입니다.', 'Few draws, so hand rankings rarely change. A good board for frequent small continuation bets.'),
  medium: l('드로우가 조금 있습니다. 강한 핸드와 드로우를 함께 베팅하고, 사이즈는 중간쯤이 흔합니다.', 'Some draws. Strong hands and draws bet together, often at a medium size.'),
  wet: l('스트레이트·플러시 드로우가 많아 다음 카드로 순위가 자주 바뀝니다. 베팅 빈도는 낮추고 사이즈는 키우는 경향이 있습니다.', 'Many straight and flush draws, so the next card often changes the ranking. Bets tend to be less frequent and bigger.'),
};

function randomFlop(): Card[] {
  const deck: Card[] = [];
  for (const r of 'AKQJT98765432') for (const s of 'shdc') deck.push(`${r}${s}` as Card);
  const out: Card[] = [];
  while (out.length < 3) {
    const c = deck.splice(Math.floor(Math.random() * deck.length), 1)[0]!;
    out.push(c);
  }
  return out;
}

function TextureTool() {
  const tr = useTool();
  const [flop, setFlop] = useState<Card[]>(FLOPS[0]!);
  const t = flop.length === 3 ? texture(flop) : null;
  return (
    <ToolBox title={l('보드 텍스처 읽기', 'Reading board texture')} testid="tool-texture">
      <div className="flex flex-wrap gap-1.5">
        {FLOPS.map((f) => (
          <Button key={f.join('')} size="sm" variant={f.join() === flop.join() ? 'gold' : 'subtle'} onClick={() => setFlop(f)}>
            {f.map(cardText).join(' ')}
          </Button>
        ))}
        <Button size="sm" variant="outline" onClick={() => setFlop(randomFlop())} data-testid="texture-random">
          🎲 {tr(l('무작위 플랍', 'Random flop'))}
        </Button>
      </div>
      <details className="rounded-xl border border-white/10 p-2">
        <summary className="jc-tap cursor-pointer text-sm font-semibold text-ivory">{tr(l('직접 카드 고르기 (3장)', 'Pick the cards yourself (3)'))}</summary>
        <div className="pt-2">
          <CardPicker value={flop} onChange={setFlop} max={3} label={tr(l('플랍', 'Flop'))} testid="texture-picker" />
        </div>
      </details>
      {t ? (
        <>
          <CardsView cards={flop} />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="texture-result">
            <Out label={tr(l('페어', 'Pairing'))} value={tr(TEX[t.pairing]!)} />
            <Out label={tr(l('문양', 'Suits'))} value={tr(TEX[t.suits]!)} />
            <Out label={tr(l('연결', 'Connection'))} value={tr(TEX[t.connect]!)} />
            <Out label={tr(l('높이', 'Height'))} value={tr(TEX[t.height]!)} />
          </div>
          <Out label={tr(l('종합', 'Overall'))} value={`${tr(TEX[t.label]!)} (${t.wetness}/4)`} sub={tr(TEX_WHY[t.label]!)} strong testid="texture-label" />
          <Steps
            lines={[
              l(`문양 점수: ${t.suits === 'monotone' ? 2 : t.suits === 'twoTone' ? 1 : 0} (같은 문양 3장 2점, 2장 1점)`, `Suit points: ${t.suits === 'monotone' ? 2 : t.suits === 'twoTone' ? 1 : 0} (three of a suit 2, two 1)`),
              l(`연결 점수: ${t.connect === 'connected' ? 2 : t.connect === 'semi' ? 1 : 0} (세 장이 다섯 칸 안 2점, 두 장 1점)`, `Connection points: ${t.connect === 'connected' ? 2 : t.connect === 'semi' ? 1 : 0} (all three within five ranks 2, two of them 1)`),
              l(`페어 보정: ${t.pairing === 'unpaired' ? 0 : -1} (페어가 있으면 드로우가 줄어 1점 뺌)`, `Pair adjustment: ${t.pairing === 'unpaired' ? 0 : -1} (a pair means fewer draws, minus 1)`),
              l(`합계 ${t.wetness} → 0–1 드라이, 2 중간, 3–4 웻`, `Total ${t.wetness} → 0–1 dry, 2 medium, 3–4 wet`),
            ]}
          />
        </>
      ) : (
        <p className="text-sm text-ink-300">{tr(l('카드를 3장 고르세요.', 'Pick three cards.'))}</p>
      )}
      <Note accuracy="estimate">{l('점수는 이 아카데미가 보드 성격을 대략 나누려고 만든 간단한 기준입니다. 실제 판단은 두 레인지가 그 보드에 얼마나 잘 맞는지(레인지 우위·너트 우위)에 달려 있습니다.', 'The points are a simple yardstick this academy uses to sort boards roughly. A real judgement depends on how well both ranges hit the board (range and nut advantage).')}</Note>
    </ToolBox>
  );
}

// ------------------------------------------------------------------ sizing and SPR

function SizingTool() {
  const tr = useTool();
  const [pot, setPot] = useState(100);
  const [pctPot, setPctPot] = useState(66);
  const [stack, setStack] = useState(400);
  const sized = sizedBet(pot, pctPot, stack);
  const bet = sized.bet;
  const after = spr(pot + 2 * bet, Math.max(0, stack - bet));
  // The stack caps the bet: the slider and the working say what was asked for and what is really bet.
  const sliderText = (v: number) => {
    const b = sizedBet(pot, v, stack);
    return b.capped ? tr(l('{p}% → 올인 {b} (팟의 {a})', '{p}% → all-in {b} ({a} of the pot)'), { p: v, b: num(b.bet), a: share(b.of) }) : `${v}% = ${num(b.bet)}`;
  };
  return (
    <ToolBox title={l('베팅 사이즈 슬라이더', 'Bet size slider')} testid="tool-sizing">
      <div className="grid grid-cols-2 gap-2">
        <Num label={tr(T.pot)} value={pot} onChange={setPot} min={1} testid="sz-pot" />
        <Num label={tr(T.stack)} value={stack} onChange={setStack} min={0} testid="sz-stack" />
      </div>
      <Slider label={tr(l('베팅 크기 (팟 대비)', 'Bet size (of the pot)'))} value={pctPot} onChange={setPctPot} min={10} max={200} step={1} format={sliderText} testid="sz-pct" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Out label={tr(l('콜하는 쪽 필요 에퀴티', 'Caller needs'))} value={share(potOdds(pot, bet))} strong testid="sz-need" />
        <Out label="MDF" value={share(mdf(pot, bet))} />
        <Out label={tr(l('알파', 'Alpha'))} value={share(alpha(pot, bet))} />
        <Out label={tr(T.bluffShare)} value={share(bluffShare(pot, bet))} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Out label={tr(l('지금 SPR', 'SPR now'))} value={num(spr(pot, stack))} />
        <Out label={tr(l('콜받은 뒤 SPR', 'SPR after a call'))} value={num(after)} sub={tr(l('팟 {p} · 스택 {s}', 'pot {p} · stack {s}'), { p: num(pot + 2 * bet), s: num(Math.max(0, stack - bet)) })} />
      </div>
      <Steps
        lines={[
          sized.capped
            ? l(
                `베팅 = 팟 ${num(pot)} × ${pctPot}% = ${num(sized.asked)}이지만 스택이 ${num(stack)}뿐이라 ${num(bet)} 올인 (실제로는 팟의 ${share(sized.of)})`,
                `Bet = pot ${num(pot)} × ${pctPot}% = ${num(sized.asked)}, but the stack is only ${num(stack)}: all-in for ${num(bet)} (really ${share(sized.of)} of the pot)`,
              )
            : l(`베팅 = 팟 ${num(pot)} × ${pctPot}% = ${num(bet)}${sized.allIn ? ' (스택 전부)' : ''}`, `Bet = pot ${num(pot)} × ${pctPot}% = ${num(bet)}${sized.allIn ? ' (the whole stack)' : ''}`),
          l(`필요 에퀴티 = B ÷ (P + 2B) = ${share(potOdds(pot, bet))}, MDF = P ÷ (P + B) = ${share(mdf(pot, bet))}`, `Required equity = B ÷ (P + 2B) = ${share(potOdds(pot, bet))}, MDF = P ÷ (P + B) = ${share(mdf(pot, bet))}`),
          l('베팅이 커질수록 콜하는 쪽은 더 높은 에퀴티가 필요하고(덜 방어해도 되고), 베팅하는 쪽은 블러프를 더 섞을 수 있습니다.', 'The bigger the bet, the more equity the caller needs (and the less they must defend), and the more bluffs the bettor can mix in.'),
        ]}
      />
      <Note accuracy="exact">{T.riverModel}</Note>
    </ToolBox>
  );
}

function SprTool() {
  const tr = useTool();
  const [pot, setPot] = useState(12);
  const [stack, setStack] = useState(94);
  const r = spr(pot, stack);
  return (
    <ToolBox title={l('SPR과 기하급수 사이즈', 'SPR and geometric sizing')} testid="tool-spr">
      <div className="grid grid-cols-2 gap-2">
        <Num label={tr(l('플랍 팟', 'Flop pot'))} value={pot} onChange={setPot} min={1} testid="spr-pot" />
        <Num label={tr(T.stack)} value={stack} onChange={setStack} min={0} testid="spr-stack" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Out label="SPR" value={num(r)} strong testid="spr-value" />
        <Out label={tr(l('팟 크기 베팅으로 올인까지', 'Pot-size bets to all-in'))} value={num(potBetsToAllIn(pot, stack))} sub={tr(l('번 (각각 콜받을 때)', 'bets (each called)'))} />
      </div>
      <div className="flex flex-col gap-1.5" data-testid="spr-geometric">
        <div className="text-xs font-semibold text-ink-300">{tr(l('남은 스트리트에 같은 비율로 나눠 올인하려면', 'Same share of the pot each street, all-in on the last'))}</div>
        <div className="grid grid-cols-3 gap-2">
          {[1, 2, 3].map((n) => {
            const f = geometric(pot, stack, n);
            return <Out key={n} label={tr(l('{n}스트리트', '{n} street(s)'), { n })} value={share(f)} sub={tr(l('첫 베팅 {b}', 'first bet {b}'), { b: num(f * pot) })} />;
          })}
        </div>
      </div>
      <Steps
        lines={[
          ...calcSteps({ kind: 'spr', pot, stack }),
          l(`팟 크기 베팅은 콜받을 때마다 팟을 3배로 만들므로, 올인까지 log₃(1 + 2 × SPR) = ${num(potBetsToAllIn(pot, stack))}번`, `A called pot-size bet triples the pot, so it takes log₃(1 + 2 × SPR) = ${num(potBetsToAllIn(pot, stack))} of them to get all-in`),
          ...calcSteps({ kind: 'geometric', pot, stack, streets: 2 }),
        ]}
      />
      <Note accuracy="exact">{l('두 사람만 남고, 모든 베팅이 콜된다고 본 계산입니다. SPR이 낮을수록(대략 3 이하) 탑 페어 같은 핸드로도 올인이 자연스럽고, 높을수록 더 강한 핸드가 필요하다는 것은 경험칙입니다.', 'Heads-up, with every bet called. That a low SPR (about 3 or less) makes getting all-in with hands like top pair natural, and a high one asks for stronger hands, is a rule of thumb.')}</Note>
    </ToolBox>
  );
}

// ------------------------------------------------------------------ bluffing

function BluffRatioTool() {
  const tr = useTool();
  const [pot, setPot] = useState(100);
  const [bet, setBet] = useState(75);
  const [value, setValue] = useState(20);
  const bluffs = balancedBluffs(pot, bet, value);
  return (
    <ToolBox title={l('리버 블러프 비율 계산기', 'River bluff ratio calculator')} testid="tool-bluffRatio">
      <div className="grid grid-cols-3 gap-2">
        <Num label={tr(T.pot)} value={pot} onChange={setPot} testid="br-pot" />
        <Num label={tr(T.bet)} value={bet} onChange={setBet} testid="br-bet" />
        <Num label={tr(l('밸류 콤보', 'Value combos'))} value={value} onChange={setValue} testid="br-value" />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Out label={tr(l('균형 블러프 콤보', 'Balanced bluff combos'))} value={num(bluffs)} strong testid="br-bluffs" />
        <Out label={tr(T.bluffShare)} value={share(bluffShare(pot, bet))} />
        <Out label={tr(l('밸류 : 블러프', 'Value : bluff'))} value={bet > 0 ? `${num(valuePerBluff(pot, bet))} : 1` : '—'} />
        <Out label={tr(T.alpha)} value={share(alpha(pot, bet))} />
      </div>
      <Steps
        lines={[
          ...calcSteps({ kind: 'bluffCombos', pot, bet, value }),
          l(`베팅 레인지 = 밸류 ${num(value)} + 블러프 ${num(bluffs)} = ${num(value + bluffs)}콤보, 그중 블러프 ${share(bluffShare(pot, bet))}`, `Betting range = value ${num(value)} + bluffs ${num(bluffs)} = ${num(value + bluffs)} combos, ${share(bluffShare(pot, bet))} of them bluffs`),
        ]}
      />
      <Note accuracy="exact">{l('리버 베팅 한 번에서 콜하는 쪽의 블러프 캐처를 무차별하게 만드는 비율입니다. 블러프로는 상대의 콜 핸드를 막는(블로커) 핸드와, 쇼다운으로는 이기지 못하는 핸드를 고릅니다.', 'The ratio that leaves the caller’s bluff-catchers indifferent to one river bet. Pick bluffs that block the calling hands and cannot win at showdown.')}</Note>
    </ToolBox>
  );
}

// ------------------------------------------------------------------ MDF

function MdfTool() {
  const tr = useTool();
  const [pot, setPot] = useState(100);
  const [bet, setBet] = useState(100);
  return (
    <ToolBox title={l('MDF 계산기', 'MDF calculator')} testid="tool-mdf">
      <div className="grid grid-cols-2 gap-2">
        <Num label={tr(T.pot)} value={pot} onChange={setPot} testid="mdf-pot" />
        <Num label={tr(T.bet)} value={bet} onChange={setBet} testid="mdf-bet" />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Out label={tr(T.mdf)} value={share(mdf(pot, bet))} strong testid="mdf-value" />
        <Out label={tr(T.alpha)} value={share(alpha(pot, bet))} />
        <Out label={tr(T.need)} value={share(potOdds(pot, bet))} />
      </div>
      <Steps lines={[...calcSteps({ kind: 'mdf', pot, bet }), ...calcSteps({ kind: 'alpha', pot, bet }), l('MDF + 알파 = 100%: 내가 그보다 자주 폴드하면 상대는 아무 두 장으로도 블러프해서 이득을 봅니다.', 'MDF + alpha = 100%: fold more often than alpha allows and any two cards bluff at a profit.')]} />
      <Note accuracy="exact">{l('레인지 전체의 기준이며, 상대가 실제로 블러프를 얼마나 하는지는 넣지 않은 최악의 경우 기준입니다. 블러프가 적은 상대에게는 MDF보다 덜 방어해도 됩니다.', 'A yardstick for the whole range, for the worst case: it leaves out how often this opponent really bluffs. Against one who bluffs too little, defending below MDF is fine.')}</Note>
    </ToolBox>
  );
}

// ------------------------------------------------------------------ exploit

function ExploitTool() {
  const tr = useTool();
  const pot = 100;
  const [betPct, setBetPct] = useState(75);
  const [fold, setFold] = useState(60);
  const [theirBluffs, setTheirBluffs] = useState(20);
  const bet = betPct;
  const a = alpha(pot, bet);
  const need = potOdds(pot, bet);
  const bluffEv = evBluff(pot, bet, fold / 100);
  const callEv = (theirBluffs / 100) * (pot + bet) - (1 - theirBluffs / 100) * bet;
  return (
    <ToolBox title={l('가상의 상대 성향과 대응 (팟 100)', 'A hypothetical opponent and the response (pot 100)')} testid="tool-exploit">
      <Slider label={tr(l('베팅 크기', 'Bet size'))} value={betPct} onChange={setBetPct} min={25} max={150} format={(v) => `${v}`} testid="ex-bet" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-xl border border-white/10 p-3">
          <Slider label={tr(l('내 베팅에 상대가 폴드하는 비율', 'How often they fold to your bet'))} value={fold} onChange={setFold} min={0} max={100} format={(v) => `${v}%`} testid="ex-fold" />
          <Out label={tr(l('순수 블러프의 EV', 'EV of a pure bluff'))} value={signed(bluffEv)} sub={`${tr(T.alpha)} ${share(a)}`} strong testid="ex-bluff-ev" />
          <p className="text-sm font-semibold text-ivory">{fold / 100 > a + 0.005 ? tr(l('폴드가 알파보다 많다 → 블러프를 늘린다', 'They fold more than alpha → bluff more')) : fold / 100 < a - 0.005 ? tr(l('폴드가 알파보다 적다 → 블러프를 줄이고 밸류를 늘린다', 'They fold less than alpha → bluff less, value bet more')) : tr(l('알파와 같다 → 블러프는 본전', 'Equal to alpha → bluffs break even'))}</p>
        </div>
        <div className="flex flex-col gap-2 rounded-xl border border-white/10 p-3">
          <Slider label={tr(l('상대 베팅 중 블러프 비율', 'Share of bluffs in their bets'))} value={theirBluffs} onChange={setTheirBluffs} min={0} max={100} format={(v) => `${v}%`} testid="ex-their" />
          <Out label={tr(l('블러프 캐처로 콜하는 EV', 'EV of calling with a bluff-catcher'))} value={signed(callEv)} sub={`${tr(T.need)} ${share(need)}`} strong testid="ex-call-ev" />
          <p className="text-sm font-semibold text-ivory">{theirBluffs / 100 > need + 0.005 ? tr(l('블러프가 필요 에퀴티보다 많다 → 더 콜한다', 'More bluffs than the required equity → call more')) : theirBluffs / 100 < need - 0.005 ? tr(l('블러프가 필요 에퀴티보다 적다 → 더 폴드한다', 'Fewer bluffs than the required equity → fold more')) : tr(l('필요 에퀴티와 같다 → 콜은 본전', 'Equal to the required equity → calls break even'))}</p>
        </div>
      </div>
      <Steps
        lines={[
          ...calcSteps({ kind: 'evBluff', pot, bet, fold: fold / 100 }),
          l(`EV(콜) = 블러프 비율 × (P + B) − 밸류 비율 × B = ${share(theirBluffs / 100)} × ${pot + bet} − ${share(1 - theirBluffs / 100)} × ${bet} = ${signed(callEv)}`, `EV(call) = bluff share × (P + B) − value share × B = ${share(theirBluffs / 100)} × ${pot + bet} − ${share(1 - theirBluffs / 100)} × ${bet} = ${signed(callEv)}`),
        ]}
      />
      <Note accuracy="estimate">{l('상대의 빈도는 가상의 값입니다. 실제로는 표본이 작으면 우연일 수 있으니 조정을 작게 하고, 상대가 바뀌는 신호가 보이면 균형으로 돌아오세요. 블러프는 콜받으면 지고 블러프 캐처는 밸류에 진다고 단순화했습니다.', 'The opponent’s frequencies are made up. In play a small sample may be luck, so adjust a little and drift back to balance when they change. The model has bluffs lose when called and bluff-catchers lose to value.')}</Note>
    </ToolBox>
  );
}

// ------------------------------------------------------------------ streets: one hand from flop to river

const STREET: Record<string, L> = { flop: l('플랍', 'Flop'), turn: l('턴', 'Turn'), river: l('리버', 'River') };

function StreetWalkTool() {
  const tr = useTool();
  const w = STREET_WALK;
  const [i, setI] = useState(0);
  const s = w.streets[i]!;
  const need = potOdds(s.pot, s.bet);
  return (
    <ToolBox title={l('스트리트 따라가기', 'Street by street')} testid="tool-streetWalk">
      <div className="text-sm font-bold text-ivory">{tr(w.title)}</div>
      <p className="text-xs text-ink-300">{tr(w.spot)}</p>
      <ol className="flex gap-1.5" aria-label={tr(l('스트리트', 'Street'))}>
        {w.streets.map((x, k) => (
          <li key={x.street} className="flex-1">
            <button type="button" onClick={() => setI(k)} aria-current={k === i ? 'step' : undefined} className={cx('jc-tap w-full rounded-lg border px-2 py-2 text-sm font-bold', k === i ? 'border-gold-400 bg-gold-500/15 text-gold-300' : 'border-white/10 bg-ink-850 text-ink-300')} data-street={x.street}>
              {k < i ? '✓ ' : ''}
              {tr(STREET[x.street]!)}
            </button>
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-[auto_1fr] items-end gap-3">
        <CardsView cards={w.hero} label={tr(l('내 핸드', 'Your hand'))} size="clamp(2.2rem,10vw,3rem)" />
        <CardsView cards={s.board} label={tr(l('보드', 'Board'))} size="clamp(2.2rem,10vw,3rem)" />
      </div>
      <p className="text-sm text-ivory" data-testid="walk-action">{tr(s.action)}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Out label={tr(T.pot)} value={num(s.pot)} />
        <Out label={tr(s.bettor === 'hero' ? l('내 베팅', 'Your bet') : l('상대 베팅', 'Their bet'))} value={num(s.bet)} sub={`${share(s.bet / s.pot)} pot`} />
        <Out label={tr(s.bettor === 'hero' ? l('상대의 필요 에퀴티', 'They need') : T.need)} value={share(need)} strong testid="walk-need" />
        {s.outs ? <Out label={tr(l('내 에퀴티(아웃 {n}개)', 'Your equity ({n} outs)'), { n: s.outs.outs })} value={share(outsExact(s.outs.outs, s.outs.cards, s.outs.unseen))} sub={tr(l('어림셈 {r}', 'rule of thumb {r}'), { r: share(outsRule(s.outs.outs, s.outs.cards)) })} /> : <Out label={tr(l('내 핸드', 'Your hand'))} value={tr(l('너트 스트레이트', 'Nut straight'))} />}
      </div>
      <div className="rounded-xl border border-gold-500/40 bg-gold-500/10 px-3 py-2 text-sm font-bold text-gold-300" data-testid="walk-decision">
        → {tr(s.decision)}
      </div>
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-ink-100">
        {s.reasoning.map((x, k) => (
          <li key={k}>{tr(x)}</li>
        ))}
      </ol>
      <div className="flex justify-between gap-2">
        <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => setI(i - 1)}>
          ← {tr(l('이전 스트리트', 'Previous street'))}
        </Button>
        <Button size="sm" disabled={i === w.streets.length - 1} onClick={() => setI(i + 1)} data-testid="walk-next">
          {tr(l('다음 스트리트', 'Next street'))} →
        </Button>
      </div>
      {i === w.streets.length - 1 && <p className="text-sm font-semibold text-ivory">💡 {tr(w.takeaway)}</p>}
      <Note accuracy="example">{w.assumptions}</Note>
    </ToolBox>
  );
}

export function GtoTool({ kind }: { kind: GtoToolKind }) {
  switch (kind) {
    case 'indifference':
      return <IndifferenceTool />;
    case 'matrix':
      return <MatrixTool />;
    case 'combos':
      return <CombosTool />;
    case 'potOdds':
      return <PotOddsTool />;
    case 'ev':
      return <EvTool />;
    case 'outs':
      return <OutsTool />;
    case 'position':
      return <PositionTool />;
    case 'texture':
      return <TextureTool />;
    case 'sizing':
      return <SizingTool />;
    case 'spr':
      return <SprTool />;
    case 'bluffRatio':
      return <BluffRatioTool />;
    case 'streetWalk':
      return <StreetWalkTool />;
    case 'mdf':
      return <MdfTool />;
    case 'exploit':
      return <ExploitTool />;
  }
}
