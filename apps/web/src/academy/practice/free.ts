/**
 * Free practice: hand after hand against rule-based bots, no script. Decks come
 * from the engine's CSPRNG shuffle, every legal action is accepted, stacks carry
 * over between hands and busted players are refilled with practice chips.
 * Still fully offline: no socket, wallet, ledger or hand history.
 */
import { HandEngine, nextButtonSeat } from '@jc/poker-engine';
import type { ActionType, Card, LegalOption, TableCue, TableView } from '@jc/types';
import type { CueEvent } from '../../game/useTableSocket';
import { decideBot, type BotStyle } from './bots';
import { botId, HERO_ID, projectView, type TableShape } from './runner';

export const FREE_STACK = 1000;
const BLINDS: [number, number] = [5, 10];
const BOT_NAMES = ['Mia', 'Leo', 'Ava', 'Kai', 'Noa'];

export interface FreeConfig {
  bots: 1 | 2 | 5;
  style: BotStyle | 'mixed';
}

export class FreeSession {
  engine!: HandEngine;
  shape: TableShape;
  styles = new Map<number, BotStyle>();
  button: number | null = null;
  hands = 0;
  /** Net practice chips for the hero across this session. */
  net = 0;
  cues: CueEvent[] = [];
  private cueSeq = 0;
  private clock = 1_000;
  private stacks = new Map<number, number>();
  private startStack = 0;

  constructor(cfg: FreeConfig, heroName: string, private rand: () => number = Math.random) {
    const size: 2 | 6 = cfg.bots === 1 ? 2 : 6;
    const botSeats = cfg.bots === 1 ? [1] : cfg.bots === 2 ? [2, 4] : [1, 2, 3, 4, 5];
    this.shape = {
      id: 'practice-free',
      size,
      blinds: BLINDS,
      hero: 0,
      seats: [{ index: 0, name: heroName, stack: FREE_STACK }, ...botSeats.map((i, k) => ({ index: i, name: BOT_NAMES[k]!, stack: FREE_STACK }))],
    };
    botSeats.forEach((i, k) => this.styles.set(i, cfg.style === 'mixed' ? (k % 2 ? 'loose' : 'tight') : cfg.style));
    for (const s of this.shape.seats) this.stacks.set(s.index, FREE_STACK);
    this.newHand();
  }

  /** Deals the next hand; empty stacks are refilled (practice chips only). */
  newHand() {
    for (const s of this.shape.seats) if ((this.stacks.get(s.index) ?? 0) <= 0) this.stacks.set(s.index, FREE_STACK);
    const occupied = this.shape.seats.map((s) => s.index);
    this.button = nextButtonSeat(this.button, occupied, this.shape.size);
    this.startStack = this.stacks.get(this.shape.hero)!;
    this.engine = HandEngine.start({
      handId: `free-${++this.hands}-${Date.now().toString(36)}`,
      rules: { maxSeats: this.shape.size, smallBlind: BLINDS[0], bigBlind: BLINDS[1], turnMs: 600_000 },
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
    let move = decideBot(this.styles.get(seat) ?? 'tight', { hole, board: hv.board, legal, pot: hv.potTotal, bigBlind: BLINDS[1], rand: this.rand() });
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
