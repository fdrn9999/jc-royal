/**
 * Free practice: hand after hand against bots, no script. Decks come from the
 * engine's CSPRNG shuffle, every legal action is accepted, stacks carry over
 * between hands and busted players are refilled with practice chips. The bots
 * are the academy's beginner ones, or the tables' own at a chosen level and
 * style (the same engine code, botView and decideBot, as the server runs them).
 * Each settled hand is reviewed for the hero and counted for the seats' HUD
 * (./review.ts). Still fully offline: no socket, wallet, ledger, hand history
 * or statistic; all of it ends with the page.
 */
import { addCounters, botView, decideBot as decideTableBot, emptyCounters, HandEngine, handCounters, handFactsOf, nextButtonSeat, styleFor, type BotLevel, type Counters } from '@jc/poker-engine';
import type { ActionType, BotStyle as TableBotStyle, BotTableStyle, Card, HudStatsDto, LegalOption, TableCue, TableView } from '@jc/types';
import type { CueEvent } from '../../game/useTableSocket';
import { decideBot, type BotStyle } from './bots';
import { hudOf, reviewHand, SHORT_STACK_BB, wonAtShowdown, type PracticeDecision, type PracticeTopic } from './review';
import { botId, HERO_ID, projectView, type TableShape } from './runner';

export const FREE_STACK = 1000;
/** The default blinds; FREE_STACK is 100 big blinds at them. */
export const FREE_BLINDS = [5, 10] as const;
export const FREE_BLIND_OPTIONS = [FREE_BLINDS, [25, 50], [100, 200]] as const;
export const FREE_STACK_BB = [20, 50, 100, 200] as const;
const BOT_NAMES = ['Mia', 'Leo', 'Ava', 'Kai', 'Noa'];

export interface FreeConfig {
  bots: 1 | 2 | 5;
  /** The academy's beginner bots' temperament, when no table level is chosen. */
  style: BotStyle | 'mixed';
  /** The tables' bots instead, at this level. */
  level?: BotLevel;
  /** Their style: one for all, or each its own as a table's 'auto' gives them. */
  tableStyle?: BotTableStyle;
  /** Starting stacks in big blinds (100 by default). */
  stackBb?: number;
  blinds?: readonly [number, number];
  /** What the session drills; headsUp deals one bot, shortStack the hero 20 big blinds each hand, bbDefense the hero the big blind each hand. */
  topic?: PracticeTopic;
}

export class FreeSession {
  engine!: HandEngine;
  shape: TableShape;
  styles = new Map<number, BotStyle>();
  /** The table bots' styles, when a level was chosen. */
  tableStyles = new Map<number, TableBotStyle>();
  readonly level: BotLevel | null;
  readonly topic: PracticeTopic;
  readonly blinds: readonly [number, number];
  button: number | null = null;
  hands = 0;
  /** Net practice chips for the hero across this session. */
  net = 0;
  cues: CueEvent[] = [];
  /** The hero's decisions in every settled hand, reviewed (./review.ts). */
  decisions: PracticeDecision[] = [];
  private cueSeq = 0;
  private clock = 1_000;
  private stacks = new Map<number, number>();
  private startStack = 0;
  private stack: number;
  private heroStart: number;
  /** Each seat's counters over the session, from the public actions and the cards shown, as a table counts them. */
  private counters = new Map<number, Counters>();
  private showdownsWon = new Map<number, number>();

  constructor(cfg: FreeConfig, heroName: string, private rand: () => number = Math.random) {
    this.level = cfg.level ?? null;
    this.topic = cfg.topic ?? 'free';
    this.blinds = cfg.blinds ?? FREE_BLINDS;
    this.stack = (cfg.stackBb ?? 100) * this.blinds[1];
    this.heroStart = this.topic === 'shortStack' ? SHORT_STACK_BB * this.blinds[1] : this.stack;
    const bots = this.topic === 'headsUp' ? 1 : cfg.bots;
    const size: 2 | 6 = bots === 1 ? 2 : 6;
    const botSeats = bots === 1 ? [1] : bots === 2 ? [2, 4] : [1, 2, 3, 4, 5];
    this.shape = {
      id: 'practice-free',
      size,
      blinds: [this.blinds[0], this.blinds[1]],
      hero: 0,
      seats: [{ index: 0, name: heroName, stack: this.heroStart }, ...botSeats.map((i, k) => ({ index: i, name: BOT_NAMES[k]!, stack: this.stack }))],
    };
    botSeats.forEach((i, k) => this.styles.set(i, cfg.style === 'mixed' ? (k % 2 ? 'loose' : 'tight') : cfg.style));
    if (this.level) for (const i of botSeats) this.tableStyles.set(i, !cfg.tableStyle || cfg.tableStyle === 'auto' ? styleFor(botId(i)) : cfg.tableStyle);
    for (const s of this.shape.seats) this.stacks.set(s.index, s.stack);
    this.newHand();
  }

  /** Deals the next hand; empty stacks are refilled (practice chips only), the short-stack hero dealt the same 20 big blinds each time. */
  newHand() {
    for (const s of this.shape.seats) if ((this.stacks.get(s.index) ?? 0) <= 0) this.stacks.set(s.index, s.index === this.shape.hero ? this.heroStart : this.stack);
    if (this.topic === 'shortStack') this.stacks.set(this.shape.hero, this.heroStart);
    const occupied = this.shape.seats.map((s) => s.index);
    // Defending the big blind, the hero (the lowest seat) is dealt it every hand: the button two seats before it, and
    // heads-up, where the button posts the small blind, the other seat.
    this.button = this.topic === 'bbDefense' ? occupied[occupied.length === 2 ? 1 : occupied.length - 2]! : nextButtonSeat(this.button, occupied, this.shape.size);
    this.startStack = this.stacks.get(this.shape.hero)!;
    this.engine = HandEngine.start({
      handId: `free-${++this.hands}-${Date.now().toString(36)}`,
      rules: { maxSeats: this.shape.size, smallBlind: this.blinds[0], bigBlind: this.blinds[1], turnMs: 600_000 },
      seats: this.shape.seats.map((s) => ({ playerId: s.index === this.shape.hero ? HERO_ID : botId(s.index), seatIndex: s.index, stack: this.stacks.get(s.index)!, displayName: s.name })),
      buttonSeat: this.button,
      now: ++this.clock,
    });
    this.push([{ kind: 'handStart', handNumber: this.hands }, { kind: 'deal' }]);
  }

  private push(cues: TableCue[]) {
    const state = this.view();
    for (const cue of cues) this.cues.push({ id: ++this.cueSeq, cue, state });
  }

  consumeCues(upTo: number) {
    this.cues = this.cues.filter((c) => c.id > upTo);
  }

  get settled() {
    return this.engine.isSettled;
  }

  /** Hands played to the end so far, the one being played not counted. */
  get settledHands() {
    return this.hands - (this.engine.isSettled ? 0 : 1);
  }

  isHeroTurn() {
    return !this.engine.isSettled && !this.engine.isStalled() && this.engine.actorId() === HERO_ID;
  }

  heroLegal(): LegalOption[] {
    return this.isHeroTurn() ? this.engine.legalOptions(HERO_ID) : [];
  }

  private settle() {
    const v = this.engine.handView();
    const info = this.engine.seatInfo(null);
    for (const s of this.shape.seats) this.stacks.set(s.index, info.get(s.index)?.stack ?? 0);
    if (v.result) this.net += this.stacks.get(this.shape.hero)! - this.startStack;
    const rec = this.engine.record(++this.clock);
    for (const [seat, c] of handCounters(handFactsOf(rec, this.blinds[1]))) addCounters(this.countersOf(seat), c);
    for (const seat of wonAtShowdown(rec)) this.showdownsWon.set(seat, (this.showdownsWon.get(seat) ?? 0) + 1);
    this.decisions.push(...reviewHand(rec, this.shape.hero, this.hands, this.shape.size));
  }

  private countersOf(seat: number): Counters {
    let c = this.counters.get(seat);
    if (!c) this.counters.set(seat, (c = emptyCounters()));
    return c;
  }

  /** A seat's HUD over the hands of this session settled so far. */
  hud(seat: number): HudStatsDto {
    return hudOf(this.counters.get(seat) ?? emptyCounters(), this.showdownsWon.get(seat) ?? 0);
  }

  /** Any legal hero action; returns false when it was not legal (nothing is sent). */
  async heroAct(type: ActionType, amount?: number): Promise<boolean> {
    if (!this.isHeroTurn() || !this.heroLegal().some((o) => o.type === type)) return false;
    const r = await this.engine.act(HERO_ID, { type, amount }, `hero-${this.hands}-${this.clock}`, ++this.clock);
    if (!r.ok) return false;
    this.push(r.cues);
    if (this.engine.isSettled) this.settle();
    return true;
  }

  /** One bot decision or stalled-turn resolution; false when waiting for the hero or the hand is over. */
  async step(): Promise<boolean> {
    if (this.engine.isSettled) return false;
    if (this.engine.isStalled()) {
      this.push(await this.engine.resolveStall(++this.clock));
      if (this.engine.isSettled) this.settle();
      return true;
    }
    const actor = this.engine.actorId();
    if (!actor || actor === HERO_ID) return false;
    const seat = this.engine.seatOf(actor)!;
    const legal = this.engine.legalOptions(actor);
    const hv = this.engine.handView();
    const hole = (this.engine.seatInfo(actor).get(seat)?.holeCards ?? []) as Card[];
    // A table bot sees what it would at a table: its own cards, the public state, and the hero's counters (as a
    // table's bots read the members'), never another seat's cards.
    const tv = this.level ? botView(this.engine, actor, this.blinds[1]) : null;
    let move: { type: ActionType; amount?: number } =
      this.level && tv
        ? decideTableBot(this.level, tv, this.rand, { style: this.tableStyles.get(seat), stats: new Map([[this.shape.hero, this.countersOf(this.shape.hero)]]) })
        : decideBot(this.styles.get(seat) ?? 'tight', { hole, board: hv.board, legal, pot: hv.potTotal, bigBlind: this.blinds[1], rand: this.rand() });
    if (!legal.some((o) => o.type === move.type)) move = { type: legal.some((o) => o.type === 'check') ? 'check' : 'fold' };
    let r = await this.engine.act(actor, move, `bot-${seat}-${this.clock}`, ++this.clock);
    if (!r.ok) r = await this.engine.act(actor, { type: legal.some((o) => o.type === 'check') ? 'check' : 'fold' }, `bot-${seat}-${this.clock}-f`, ++this.clock);
    if (!r.ok) throw new Error(`bot ${seat}: ${r.reason}`);
    this.push(r.cues);
    if (this.engine.isSettled) this.settle();
    return true;
  }

  view(): TableView {
    const shape = { ...this.shape, seats: this.shape.seats.map((s) => ({ ...s, stack: this.stacks.get(s.index) ?? s.stack })) };
    const v = projectView(this.engine, shape, this.heroLegal());
    return { ...v, hand: v.hand && { ...v.hand, number: this.hands } };
  }

  heroStack() {
    return this.stacks.get(this.shape.hero) ?? 0;
  }
}
