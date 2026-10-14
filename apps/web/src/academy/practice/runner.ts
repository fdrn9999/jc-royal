/**
 * Offline practice hand. Runs the real HandEngine in the browser with a fixed
 * deck and scripted opponents, and projects the same TableView the
 * multiplayer server sends, so the real table UI renders it. No network, no
 * wallet, no hand history: everything lives in this object.
 */
import { HandEngine, stackedDeck } from '@jc/poker-engine';
import type { ActionType, LegalOption, SeatView, TableCue, TableView } from '@jc/types';
import type { CueEvent } from '../../game/useTableSocket';
import type { Scenario } from './scenarios';

export const HERO_ID = 'you';
export const botId = (seat: number) => `bot${seat}`;

export type HeroCheck = { ok: true } | { ok: false; reason: 'not-your-turn' | 'illegal' | 'off-script' };

/** Occupied seats in dealing order: clockwise, starting left of the button. */
export function dealSeats(sc: Pick<Scenario, 'seats' | 'button'>): number[] {
  const sorted = sc.seats.map((s) => s.index).sort((a, b) => a - b);
  const first = sorted.findIndex((i) => i > sc.button);
  return first <= 0 ? sorted : [...sorted.slice(first), ...sorted.slice(0, first)];
}

export class PracticeSession {
  readonly engine: HandEngine;
  private botQueues: Map<number, { type: ActionType; amount?: number }[]>;
  private heroStep = 0;
  private clock = 1_000;
  private cueSeq = 0;
  cues: CueEvent[] = [];
  /** Hero decisions made, in order (for completion checks). */
  heroLog: { type: ActionType; amount?: number }[] = [];

  constructor(readonly scenario: Scenario) {
    this.engine = HandEngine.start({
      handId: `practice-${scenario.id}-${Date.now().toString(36)}`,
      rules: { maxSeats: scenario.size, smallBlind: scenario.blinds[0], bigBlind: scenario.blinds[1], turnMs: 600_000 },
      seats: scenario.seats.map((s) => ({ playerId: s.index === scenario.hero ? HERO_ID : botId(s.index), seatIndex: s.index, stack: s.stack, displayName: s.name })),
      buttonSeat: scenario.button,
      now: this.clock,
      deck: stackedDeck(dealSeats(scenario).map((seat) => scenario.holes[seat]!), scenario.board),
    });
    this.botQueues = new Map(Object.entries(scenario.bots).map(([seat, q]) => [Number(seat), [...q]]));
    this.push([{ kind: 'deal' }]);
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

  get stage() {
    return this.engine.stage;
  }

  heroSeat() {
    return this.scenario.hero;
  }

  isHeroTurn(): boolean {
    return !this.engine.isSettled && !this.engine.isStalled() && this.engine.actorId() === HERO_ID;
  }

  heroLegal(): LegalOption[] {
    return this.isHeroTurn() ? this.engine.legalOptions(HERO_ID) : [];
  }

  /** The scripted step the hero is on, or null when the script is finished (auto-play). */
  currentStep() {
    return this.scenario.steps[this.heroStep] ?? null;
  }

  /** Whether `type`/`amount` is what this practice step asks for. */
  checkHero(type: ActionType, amount?: number): HeroCheck {
    if (!this.isHeroTurn()) return { ok: false, reason: 'not-your-turn' };
    const legal = this.heroLegal();
    if (!legal.some((o) => o.type === type)) return { ok: false, reason: 'illegal' };
    const step = this.currentStep();
    if (!step) return { ok: true };
    const allowed = Array.isArray(step.expect) ? step.expect : [step.expect];
    if (!allowed.includes(type)) return { ok: false, reason: 'off-script' };
    if (step.minTo !== undefined && (amount ?? 0) < step.minTo && type !== 'allin') return { ok: false, reason: 'off-script' };
    return { ok: true };
  }

  async heroAct(type: ActionType, amount?: number): Promise<HeroCheck> {
    const chk = this.checkHero(type, amount);
    if (!chk.ok) return chk;
    const r = await this.engine.act(HERO_ID, { type, amount }, `hero-${this.heroLog.length}`, ++this.clock);
    if (!r.ok) return { ok: false, reason: 'illegal' };
    this.heroLog.push({ type, amount });
    if (this.currentStep()) this.heroStep++;
    this.push(r.cues);
    return { ok: true };
  }

  /** Hero action after the script ends: check when free, otherwise call. */
  autoHeroAction(): { type: ActionType } {
    return { type: this.heroLegal().some((o) => o.type === 'check') ? 'check' : 'call' };
  }

  /**
   * Advances one non-hero event: a stalled turn (all-in run-out) or a scripted
   * bot decision. Returns false when it is the hero's turn or the hand is over.
   */
  async step(): Promise<boolean> {
    if (this.engine.isSettled) return false;
    if (this.engine.isStalled()) {
      this.push(await this.engine.resolveStall(++this.clock));
      return true;
    }
    const actor = this.engine.actorId();
    if (!actor || actor === HERO_ID) return false;
    const seat = this.engine.seatOf(actor)!;
    const legal = this.engine.legalOptions(actor);
    const queued = this.botQueues.get(seat)?.shift();
    let move: { type: ActionType; amount?: number } = queued ?? { type: legal.some((o) => o.type === 'check') ? 'check' : 'call' };
    if (!legal.some((o) => o.type === move.type)) move = { type: legal.some((o) => o.type === 'check') ? 'check' : 'call' };
    const r = await this.engine.act(actor, move, `bot-${seat}-${this.clock}`, ++this.clock);
    if (!r.ok) throw new Error(`practice bot ${seat} ${move.type}: ${r.reason}`);
    this.push(r.cues);
    return true;
  }

  view(): TableView {
    const sc = this.scenario;
    return projectView(this.engine, { id: `practice-${sc.id}`, size: sc.size, blinds: sc.blinds, seats: sc.seats, hero: sc.hero }, this.heroLegal());
  }
}

export interface TableShape {
  id: string;
  size: 2 | 6 | 9;
  blinds: [number, number];
  seats: { index: number; name: string; stack: number }[];
  hero: number;
}

/** Projects an offline engine into the TableView the multiplayer server would send to the hero. */
export function projectView(e: HandEngine, sh: TableShape, heroLegal: LegalOption[]): TableView {
  const info = e.seatInfo(HERO_ID);
  const seats: SeatView[] = Array.from({ length: sh.size }, (_, i) => {
    const s = sh.seats.find((x) => x.index === i);
    if (!s) return { seatIndex: i, state: 'empty', stack: 0, streetBet: 0, connected: false, hasCards: false };
    const hi = info.get(i);
    const state: SeatView['state'] = hi?.inHand ? (hi.folded ? 'folded' : hi.allIn ? 'allin' : 'active') : 'waiting';
    return {
      seatIndex: i,
      state,
      userId: i === sh.hero ? HERO_ID : botId(i),
      nickname: s.name,
      stack: hi?.stack ?? s.stack,
      streetBet: hi?.streetBet ?? 0,
      connected: true,
      lastAction: hi?.lastAction ?? null,
      hasCards: !!hi?.inHand && !hi.folded,
      holeCards: hi?.holeCards ?? null,
    };
  });
  const hv = e.handView();
  return {
    version: hv.seq,
    table: { id: sh.id, name: 'Practice', maxSeats: sh.size, smallBlind: sh.blinds[0], bigBlind: sh.blinds[1], minBuyIn: 0, maxBuyIn: 0, turnSeconds: 600, allowSpectators: false, isPrivate: true, roomType: 'official', hostId: null },
    status: e.isSettled ? 'waiting' : 'playing',
    seats,
    hand: { ...hv, number: 1, deadline: null },
    spectatorCount: 0,
    waitlist: [],
    reservation: null,
    nextHandAt: null,
    you: { userId: HERO_ID, seatIndex: sh.hero, legal: heroLegal, sittingOut: false, leaving: false, inWaitlist: false, canSit: false, topUpQueued: null, autoRebuy: null },
  };
}
