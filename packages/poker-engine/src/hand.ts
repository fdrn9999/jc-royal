/**
 * Adapter around poker-engine-ts for one hand of No-Limit Hold'em.
 *
 * poker-engine-ts is the single rule authority: legality, turn order, street
 * advancement, showdown and pot settlement all come from SessionManager. This
 * adapter only does what the engine leaves to its host:
 *   - builds the session (seats, button, blinds, CSPRNG-shuffled deck),
 *   - deals hole cards and records the posted blinds as `post-blind` turns
 *     (see docs/ENGINE_NOTES.md — the engine's bootstrap omits them),
 *   - maps UI actions to engine intents and enforces intent idempotency,
 *   - projects per-viewer views that never leak hidden cards,
 *   - persists / restores the event log.
 */
import type { ActionType, Card, HandResultView, HandStage, HandView, LegalOption, PotView, TableCue } from '@jc/types';
import {
  ENGINE_VERSION,
  SessionManager,
  collectFoldedPlayers,
  dealHoleCards,
  deriveRoundComputation,
  partitionShowdownByVisibility,
  selectDecisionContext,
  toSnapshotEnvelope,
  type PlayerAction,
  type PlayerOption,
  type SessionConfig,
  type SnapshotEnvelope,
  type TableSnapshot,
  type TurnEvent,
  type TurnEventEnvelope,
  type TurnIntent,
} from 'poker-engine-ts';
import { assertValidDeck, secureShuffledDeck } from './deck';

export type MaxSeats = 2 | 6 | 9;

export interface HandSeat {
  playerId: string;
  seatIndex: number;
  stack: number;
  displayName: string;
}

export interface HandRules {
  maxSeats: MaxSeats;
  smallBlind: number;
  bigBlind: number;
  turnMs: number;
}

export interface StartHandParams {
  handId: string;
  rules: HandRules;
  seats: HandSeat[];
  buttonSeat: number;
  now: number;
  /** Test-only fixed deck. Production callers must omit it. */
  deck?: readonly Card[];
}

interface PersistedSession {
  sessionId: string;
  config: SessionConfig;
  runtimeContext: SessionManager['session']['runtimeContext'];
  initialSnapshot: SnapshotEnvelope<TableSnapshot>;
  events: TurnEventEnvelope[];
  metrics: SessionManager['session']['metrics'];
  channels: SessionManager['session']['channels'];
}

export interface PersistedHand {
  v: 1;
  handId: string;
  rules: HandRules;
  buttonSeat: number;
  startedAt: number;
  turnStartedAt: number;
  seats: HandSeat[];
  appliedIntents: string[];
  session: PersistedSession;
}

export interface ActionRequest {
  type: ActionType;
  /** bet/raise: street total ("to"). */
  amount?: number;
}

export type ActResult =
  | { ok: true; cues: TableCue[] }
  | { ok: false; code: 'hand_over' | 'duplicate' | 'not_your_turn' | 'illegal_action'; reason: string };

export interface HandPlayerRecord {
  playerId: string;
  seatIndex: number;
  holeCards: Card[];
  stackStart: number;
  stackEnd: number;
  net: number;
  won: number;
  rankClass: string | null;
  rankValue: number | null;
  bestFive: Card[] | null;
  wentToShowdown: boolean;
  /** The hole cards were face up for the table at showdown (false for folded hands and mucked losing hands). */
  shown: boolean;
}

export interface PublicActionRecord {
  seatIndex: number;
  playerId: string;
  stage: HandStage;
  type: ActionType | 'post-sb' | 'post-bb' | 'timeout-fold' | 'timeout-check';
  /** Chips put in by this action. */
  amount: number;
  at: number;
}

export interface HandRecord {
  handId: string;
  startedAt: number;
  endedAt: number;
  board: Card[];
  potTotal: number;
  engineVersion: string;
  players: HandPlayerRecord[];
  actions: PublicActionRecord[];
}

export interface SeatHandInfo {
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  stack: number;
  streetBet: number;
  lastAction: { type: ActionType; amount: number } | null;
  holeCards: Card[] | null;
}

export function buildSessionConfig(rules: HandRules): SessionConfig {
  return {
    tableVariant: 'texas-holdem',
    bettingStructure: 'no-limit',
    maxSeats: rules.maxSeats,
    startingStack: 0,
    blindSchedule: [{ level: 1, smallBlind: rules.smallBlind, bigBlind: rules.bigBlind }],
    antePolicy: { type: 'none' },
    personaPolicy: { defaultStyle: 'balanced' },
    ruleSet: {
      streets: ['preflop', 'flop', 'turn', 'river', 'showdown'],
      postingOrder: ['small-blind', 'big-blind'],
      minRaisePolicy: 'double-last-bet',
      showdownOrdering: 'high-card',
      cardDistribution: { holeCardsPerPlayer: 2, burnPerStreet: [1, 1, 1], communityReveal: [0, 3, 1, 1] },
    },
    evaluationPolicy: { engine: 'lookup-table', evaluatorId: 'default', supportsHiLo: false, cacheSize: 1024 },
    autoAdvance: true,
  };
}

function blindTurn(playerId: string, blind: 'small' | 'big', amount: number, stackAfter: number, at: number): TurnEvent {
  return {
    id: `blind-${blind}`,
    actor: playerId,
    action: { type: 'post-blind', blind, amount },
    legalOptions: [],
    stackBefore: stackAfter + amount,
    stackAfter,
    contribution: amount,
    timestamp: at,
    metadata: { engineVersion: ENGINE_VERSION, availableActionsAtDecision: [] },
  };
}

function boardOf(s: TableSnapshot): Card[] {
  const c = s.cards.community;
  return [...(c.flop ?? []), ...(c.turn ? [c.turn] : []), ...(c.river ? [c.river] : [])] as Card[];
}

function mapActionType(a: PlayerAction): ActionType | null {
  switch (a.type) {
    case 'fold':
    case 'check':
    case 'call':
    case 'bet':
    case 'raise':
      return a.type;
    case 'all-in':
      return 'allin';
    case 'timeout':
      return a.fallback;
    default:
      return null;
  }
}

export class HandEngine {
  private constructor(
    private manager: SessionManager,
    private meta: Omit<PersistedHand, 'session' | 'v'>,
    private readonly clock: { now: number },
  ) {}

  // ---------------------------------------------------------------- lifecycle

  static start(p: StartHandParams): HandEngine {
    if (p.seats.length < 2) throw new Error('a hand needs at least two players');
    if (p.seats.some((s) => !Number.isSafeInteger(s.stack) || s.stack <= 0)) throw new Error('seated stacks must be positive integers');
    const deck = p.deck ? [...p.deck] : secureShuffledDeck();
    assertValidDeck(deck);
    const config = buildSessionConfig(p.rules);
    const clock = { now: p.now };
    const opts = { now: () => clock.now };
    const created = SessionManager.create(
      config,
      p.seats.map((s) => ({ playerId: s.playerId, seatIndex: s.seatIndex, stack: s.stack, displayName: s.displayName })),
      { deck, buttonIndex: p.buttonSeat, sessionId: p.handId, timestamp: p.now, perTurnMs: p.rules.turnMs, ...opts },
    );
    const base = created.session;
    const init = base.initialSnapshot;

    // Deal two cards each, starting left of the button.
    const order = [...p.seats].sort((a, b) => a.seatIndex - b.seatIndex);
    const firstLeft = order.findIndex((s) => s.seatIndex > init.hand.buttonSeat);
    const rotated = firstLeft <= 0 ? order : [...order.slice(firstLeft), ...order.slice(0, firstLeft)];
    const dealt = dealHoleCards(base, rotated.map((s) => s.playerId)).session;

    // Record the forced bets the bootstrap already took from the stacks.
    const posted = init.pots.main.contributions;
    const stackOf = (id: string) => init.seating.seats.find((s) => s.occupant?.playerId === id)?.stack ?? 0;
    const turns: TurnEvent[] = [];
    const sb = init.hand.blinds.smallBlind;
    const bb = init.hand.blinds.bigBlind;
    if ((posted[sb.playerId] ?? 0) > 0) turns.push(blindTurn(sb.playerId, 'small', posted[sb.playerId]!, stackOf(sb.playerId), p.now));
    if ((posted[bb.playerId] ?? 0) > 0) turns.push(blindTurn(bb.playerId, 'big', posted[bb.playerId]!, stackOf(bb.playerId), p.now));
    const round0 = init.hand.bettingRounds[0]!;
    // A blind that empties a stack is an all-in, not an elimination: the
    // bootstrap marks such seats `leaving` + pendingEliminations, which drops
    // them from the engine's active players and freezes street advancement.
    // Represent them exactly like an all-in made by action.
    const initialSnapshot: TableSnapshot = {
      ...init,
      seating: { ...init.seating, seats: init.seating.seats.map((s) => (s.occupant && s.status === 'leaving' ? { ...s, status: 'occupied' as const } : s)) },
      flags: { ...init.flags, pendingEliminations: [] },
      cards: dealt.activeSnapshot.cards,
      hand: { ...init.hand, bettingRounds: [{ ...round0, turns }] },
    };

    const manager = SessionManager.resume(
      {
        sessionId: base.id,
        config: base.config,
        runtimeContext: base.runtimeContext,
        initialSnapshot: toSnapshotEnvelope(initialSnapshot),
        events: [],
        metrics: base.metrics,
        channels: base.channels,
      },
      opts,
    );
    return new HandEngine(
      manager,
      {
        handId: p.handId,
        rules: p.rules,
        buttonSeat: init.hand.buttonSeat,
        startedAt: p.now,
        turnStartedAt: p.now,
        seats: p.seats.map((s) => ({ ...s })),
        appliedIntents: [],
      },
      clock,
    );
  }

  static restore(data: PersistedHand, now: number): HandEngine {
    // Replay with the clock pinned to the last recorded event so time-derived
    // fields (street advancement deadlines) rebuild byte-for-byte.
    const lastEvent = data.session.events.at(-1)?.event.timestamp ?? data.startedAt;
    const clock = { now: lastEvent };
    const manager = SessionManager.resume(
      {
        sessionId: data.session.sessionId,
        config: data.session.config,
        runtimeContext: data.session.runtimeContext,
        initialSnapshot: data.session.initialSnapshot,
        events: data.session.events,
        metrics: data.session.metrics,
        channels: data.session.channels,
      },
      { now: () => clock.now },
    );
    const { session: _s, v: _v, ...meta } = data;
    clock.now = now;
    return new HandEngine(manager, meta, clock);
  }

  persist(): PersistedHand {
    const s = this.manager.session;
    return {
      v: 1,
      ...this.meta,
      appliedIntents: [...this.meta.appliedIntents],
      session: {
        sessionId: s.id,
        config: s.config,
        runtimeContext: s.runtimeContext,
        initialSnapshot: toSnapshotEnvelope(s.initialSnapshot),
        events: this.manager.eventLog as TurnEventEnvelope[],
        metrics: s.metrics,
        channels: s.channels,
      },
    };
  }

  // ---------------------------------------------------------------- queries

  get handId() {
    return this.meta.handId;
  }
  get snapshot(): TableSnapshot {
    return this.manager.session.activeSnapshot;
  }
  get stage(): HandStage {
    return this.snapshot.hand.stage as HandStage;
  }
  get isSettled(): boolean {
    return this.snapshot.hand.stage === 'settled';
  }
  get buttonSeat() {
    return this.meta.buttonSeat;
  }
  get startingSeats(): readonly HandSeat[] {
    return this.meta.seats;
  }
  /** Engine snapshot version; increases with every accepted event. */
  get version(): number {
    return this.snapshot.index;
  }

  actorId(): string | null {
    if (this.isSettled) return null;
    return selectDecisionContext(this.manager.session).actor ?? null;
  }

  seatOf(playerId: string): number | null {
    return this.snapshot.seating.seats.find((s) => s.occupant?.playerId === playerId)?.index ?? null;
  }

  deadline(): number | null {
    return this.actorId() ? this.meta.turnStartedAt + this.meta.rules.turnMs : null;
  }

  private currentRoundContributions(): Map<string, number> {
    const round = this.snapshot.hand.bettingRounds.at(-1);
    if (!round || round.stage !== this.snapshot.hand.stage) return new Map();
    return deriveRoundComputation(round).contributions;
  }

  private engineOptions(playerId: string): PlayerOption[] {
    const d = selectDecisionContext(this.manager.session);
    if (d.actor !== playerId) return [];
    return d.availableActions.filter((o) => !o.disabled);
  }

  /** Legal options for a player, normalised so bet/raise/all-in amounts are street totals. */
  legalOptions(playerId: string): LegalOption[] {
    if (this.stackOf(playerId) === 0) return [];
    const opts = this.engineOptions(playerId);
    const out: LegalOption[] = [];
    for (const o of opts) {
      switch (o.type) {
        case 'fold':
          out.push({ type: 'fold' });
          break;
        case 'check':
          out.push({ type: 'check' });
          break;
        case 'call':
          out.push({ type: 'call', amount: o.amount });
          break;
        case 'bet':
          out.push({ type: 'bet', min: o.min, max: o.max });
          break;
        case 'raise':
          out.push({ type: 'raise', min: o.min, max: o.max });
          break;
        case 'all-in':
          out.push({ type: 'allin', amount: o.amount });
          break;
      }
    }
    return out;
  }

  totalChips(): number {
    const s = this.snapshot;
    return s.seating.seats.reduce((a, x) => a + x.stack, 0) + s.pots.main.amount + s.pots.sides.reduce((a, p) => a + p.amount, 0) + s.pots.rake;
  }

  startingChips(): number {
    return this.meta.seats.reduce((a, s) => a + s.stack, 0);
  }

  /** Whether an action with this intent id was applied (of the last 500 kept). */
  hasApplied(intentId: string): boolean {
    return this.meta.appliedIntents.includes(intentId);
  }

  // ---------------------------------------------------------------- commands

  async act(playerId: string, req: ActionRequest, intentId: string, now: number): Promise<ActResult> {
    if (this.isSettled) return { ok: false, code: 'hand_over', reason: 'hand is already settled' };
    if (this.meta.appliedIntents.includes(intentId)) return { ok: false, code: 'duplicate', reason: 'intent already applied' };
    const actor = this.actorId();
    if (actor !== playerId || this.isStalled()) return { ok: false, code: 'not_your_turn', reason: 'not your turn' };

    const opts = this.engineOptions(playerId);
    const find = <T extends PlayerOption['type']>(t: T) => opts.find((o) => o.type === t) as Extract<PlayerOption, { type: T }> | undefined;
    const contribution = this.currentRoundContributions().get(playerId) ?? 0;
    const allIn = find('all-in');
    let requested: PlayerAction | null = null;

    switch (req.type) {
      case 'fold':
        if (find('fold')) requested = { type: 'fold' };
        break;
      case 'check':
        if (find('check')) requested = { type: 'check' };
        break;
      case 'call': {
        const call = find('call');
        if (call) requested = { type: 'call', amount: call.amount };
        break;
      }
      case 'bet':
      case 'raise': {
        const win = find(req.type);
        const to = req.amount;
        if (to === undefined || !Number.isSafeInteger(to)) break;
        if (allIn && to === allIn.amount) {
          requested = this.allInAction(allIn.amount, contribution);
        } else if (win && to >= win.min && to <= win.max) {
          requested = req.type === 'bet' ? { type: 'bet', amount: to - contribution } : { type: 'raise', amount: to - contribution, to };
        }
        break;
      }
      case 'allin':
        if (allIn) requested = this.allInAction(allIn.amount, contribution);
        break;
    }
    if (!requested) return { ok: false, code: 'illegal_action', reason: `${req.type} is not legal now` };
    return this.submit(playerId, requested, intentId, now);
  }

  /**
   * True when the hand is not settled but no player can make a real decision:
   *  - nobody is to act (the engine evaluates auto-runout only after an event), or
   *  - the engine's actor has no chips behind (put all-in by a blind). The engine
   *    would offer that player fold/check; folding an all-in hand is never a
   *    legitimate choice, so such turns are resolved by the server, or
   *  - the engine names an actor but offers no enabled option (e.g. heads-up
   *    when the big blind is all-in for less than the small blind).
   */
  isStalled(): boolean {
    if (this.isSettled) return false;
    const actor = this.actorId();
    if (actor === null) return true;
    return this.stackOf(actor) === 0 || this.engineOptions(actor).length === 0;
  }

  private stackOf(playerId: string): number {
    return this.snapshot.seating.seats.find((s) => s.occupant?.playerId === playerId)?.stack ?? 0;
  }

  /**
   * Resolves stalled turns with zero-chip `timeout` events (fallback: check)
   * until a real decision is pending or the engine has run out and settled.
   * Returns the cues produced (without the bookkeeping action cues).
   */
  async resolveStall(now: number): Promise<TableCue[]> {
    const cues: TableCue[] = [];
    for (let guard = 0; guard < 20 && this.isStalled(); guard++) {
      const who = this.actorId() ?? this.snapshot.clock.currentActor;
      if (!who) throw new Error(`hand ${this.meta.handId} stalled without an actor at ${this.stage}`);
      const r = await this.submit(who, { type: 'timeout', fallback: 'check' }, `stall-${this.version}`, now);
      if (!r.ok) throw new Error(`could not resolve stalled hand: ${r.reason}`);
      cues.push(...r.cues.filter((cue) => cue.kind !== 'action'));
    }
    if (this.isStalled()) throw new Error(`hand ${this.meta.handId} still stalled at ${this.stage}`);
    return cues;
  }

  /** Turn timer expiry: check when free, otherwise fold. */
  async timeout(playerId: string, now: number): Promise<ActResult> {
    if (this.actorId() !== playerId) return { ok: false, code: 'not_your_turn', reason: 'not the current actor' };
    const canCheck = this.engineOptions(playerId).some((o) => o.type === 'check');
    return this.submit(playerId, { type: 'timeout', fallback: canCheck ? 'check' : 'fold' }, `timeout-${this.version}`, now);
  }

  private allInAction(toTotal: number, contribution: number): PlayerAction {
    const highest = Math.max(0, ...this.currentRoundContributions().values(), this.snapshot.hand.bettingRounds.at(-1)?.highestBet ?? 0);
    const from = highest === 0 ? 'bet' : toTotal > highest ? 'raise' : 'call';
    return { type: 'all-in', amount: toTotal - contribution, from };
  }

  private async submit(playerId: string, requested: PlayerAction, intentId: string, now: number): Promise<ActResult> {
    const before = this.snapshot;
    const startChips = this.startingChips();
    this.clock.now = now;
    const intent: TurnIntent = { id: intentId, actor: playerId, requested, issuedAt: now, origin: requested.type === 'timeout' ? 'automation' : 'ui', expectedSnapshotVersion: before.index };
    const result = await this.manager.applyIntent(intent);
    if (result.validation.kind !== 'accepted') {
      return { ok: false, code: 'illegal_action', reason: result.validation.reason };
    }
    this.meta.appliedIntents.push(intentId);
    if (this.meta.appliedIntents.length > 500) this.meta.appliedIntents.splice(0, this.meta.appliedIntents.length - 500);
    this.meta.turnStartedAt = now;
    const total = this.totalChips();
    if (total !== startChips) {
      // The engine is property-tested for conservation; if this ever fires the
      // hand must not be settled into wallets.
      throw new Error(`chip conservation violated in ${this.meta.handId}: ${total} != ${startChips}`);
    }
    return { ok: true, cues: this.cuesBetween(before, result.validation.event) };
  }

  // ---------------------------------------------------------------- projection

  private cuesBetween(before: TableSnapshot, event: TurnEvent): TableCue[] {
    const after = this.snapshot;
    const cues: TableCue[] = [];
    const seat = this.seatOf(event.actor);
    const type = mapActionType(event.action);
    if (seat !== null && type) cues.push({ kind: 'action', seatIndex: seat, type, amount: event.contribution });
    const prevBoard = boardOf(before);
    const nextBoard = boardOf(after);
    if (nextBoard.length > prevBoard.length) {
      const c = after.cards.community;
      if (!before.cards.community.flop && c.flop) cues.push({ kind: 'street', stage: 'flop', cards: [...c.flop] as Card[] });
      if (!before.cards.community.turn && c.turn) cues.push({ kind: 'street', stage: 'turn', cards: [c.turn as Card] });
      if (!before.cards.community.river && c.river) cues.push({ kind: 'street', stage: 'river', cards: [c.river as Card] });
    }
    if (after.hand.stage === 'settled' && before.hand.stage !== 'settled') {
      if (after.hand.showdown && after.hand.showdown.evaluatedHands.length > 1) cues.push({ kind: 'showdown' });
      for (const p of after.hand.payouts?.entries ?? []) {
        const s = this.seatOf(p.playerId);
        if (s !== null && p.amount > 0) cues.push({ kind: 'payout', seatIndex: s, amount: p.amount });
      }
      cues.push({ kind: 'handEnd' });
    }
    return cues;
  }

  private foldedSet(): Set<string> {
    return collectFoldedPlayers(this.snapshot.hand);
  }

  /** Seat-level info for a viewer. Hidden cards are never included for other players. */
  seatInfo(viewerId: string | null, autoMuck: ReadonlySet<string> = new Set()): Map<number, SeatHandInfo> {
    const s = this.snapshot;
    const folded = this.foldedSet();
    const streetBets = this.currentRoundContributions();
    const revealed = this.revealedHands(autoMuck);
    const round = s.hand.bettingRounds.at(-1);
    const out = new Map<number, SeatHandInfo>();
    for (const seat of s.seating.seats) {
      const id = seat.occupant?.playerId;
      if (!id) continue;
      const inHand = (s.cards.holeCards[id]?.length ?? 0) > 0;
      let lastAction: SeatHandInfo['lastAction'] = null;
      // During play: actions of the current street. Once settled: the final street's actions.
      if (round && (round.stage === s.hand.stage || s.hand.stage === 'settled')) {
        for (const t of round.turns) {
          if (t.actor !== id) continue;
          const mapped = mapActionType(t.action);
          if (mapped) lastAction = { type: mapped, amount: t.contribution };
        }
      }
      const own = viewerId !== null && id === viewerId;
      const cards = own || revealed.has(id) ? ((s.cards.holeCards[id] ?? null) as Card[] | null) : null;
      out.set(seat.index, {
        inHand,
        folded: folded.has(id),
        allIn: inHand && !folded.has(id) && seat.stack === 0,
        stack: seat.stack,
        streetBet: s.hand.stage === 'settled' ? 0 : (streetBets.get(id) ?? 0),
        lastAction,
        holeCards: cards ? [...cards] : null,
      });
    }
    return out;
  }

  /**
   * Players whose cards are face up for everybody: every showdown participant except a loser in `autoMuck`. Hands
   * that won chips are always shown, and so are all-in hands. When the betting ended because players were all in (at
   * most one showdown player still had chips), every hand is shown.
   */
  private revealedHands(autoMuck: ReadonlySet<string>): Set<string> {
    const sd = this.snapshot.hand.showdown;
    if (!sd || sd.evaluatedHands.length < 2) return new Set();
    const allIn = this.allInPlayers();
    const covered = sd.evaluatedHands.filter((h) => !allIn.has(h.playerId)).length;
    const muck = covered >= 2 ? [...autoMuck].filter((id) => !allIn.has(id)) : [];
    const vis = partitionShowdownByVisibility(sd, this.snapshot.hand.payouts, muck);
    return new Set(vis.revealed.map((h) => h.playerId));
  }

  /** Players who put their whole starting stack in during the hand. */
  private allInPlayers(): Set<string> {
    const put = new Map<string, number>();
    for (const round of this.snapshot.hand.bettingRounds) for (const t of round.turns) put.set(t.actor, (put.get(t.actor) ?? 0) + t.contribution);
    return new Set(this.meta.seats.filter((s) => s.stack > 0 && (put.get(s.playerId) ?? 0) >= s.stack).map((s) => s.playerId));
  }

  handView(autoMuck: ReadonlySet<string> = new Set()): HandView {
    const s = this.snapshot;
    const seatIdx = (id: string) => this.seatOf(id);
    const pots: PotView[] = [s.pots.main, ...s.pots.sides]
      .filter((p) => p.amount > 0)
      .map((p) => ({ id: p.id, amount: p.amount, eligibleSeats: p.eligiblePlayers.map(seatIdx).filter((x): x is number => x !== null) }));
    const actor = this.actorId();
    let result: HandResultView | null = null;
    if (this.isSettled) {
      const revealed = this.revealedHands(autoMuck);
      result = {
        winners: (s.hand.payouts?.entries ?? [])
          .filter((e) => e.amount > 0)
          .map((e) => ({ seatIndex: seatIdx(e.playerId) ?? -1, amount: e.amount, potIds: [...e.potIds] })),
        showdown: (s.hand.showdown?.evaluatedHands ?? [])
          .filter((h) => revealed.has(h.playerId))
          .map((h) => ({
            seatIndex: seatIdx(h.playerId) ?? -1,
            cards: [...(s.cards.holeCards[h.playerId] ?? [])] as Card[],
            rankClass: h.rankClass as never,
            bestFive: [...h.bestFive] as Card[],
          })),
      };
    }
    const sbId = s.hand.blinds.smallBlind.playerId;
    const bbId = s.hand.blinds.bigBlind.playerId;
    return {
      id: this.meta.handId,
      number: 0,
      seq: this.version,
      stage: s.hand.stage as HandStage,
      buttonSeat: this.meta.buttonSeat,
      sbSeat: seatIdx(sbId),
      bbSeat: seatIdx(bbId),
      board: boardOf(s),
      pots,
      potTotal: this.isSettled ? (s.hand.payouts?.entries ?? []).reduce((a, e) => a + e.amount, 0) : pots.reduce((a, p) => a + p.amount, 0),
      actorSeat: actor ? seatIdx(actor) : null,
      deadline: this.deadline(),
      result,
    };
  }

  /** Final per-hand record for persistence/statistics. Only valid once settled. `autoMuck` as for `handView`. */
  record(now: number, autoMuck: ReadonlySet<string> = new Set()): HandRecord {
    if (!this.isSettled) throw new Error('hand not settled');
    const s = this.snapshot;
    const revealed = this.revealedHands(autoMuck);
    const payouts = new Map<string, number>();
    for (const e of s.hand.payouts?.entries ?? []) payouts.set(e.playerId, (payouts.get(e.playerId) ?? 0) + e.amount);
    const sd = new Map((s.hand.showdown?.evaluatedHands ?? []).map((h) => [h.playerId, h]));
    const showdownCount = s.hand.showdown?.evaluatedHands.length ?? 0;
    const players: HandPlayerRecord[] = this.meta.seats.map((seat) => {
      const end = s.seating.seats.find((x) => x.occupant?.playerId === seat.playerId)?.stack ?? 0;
      const ev = sd.get(seat.playerId);
      return {
        playerId: seat.playerId,
        seatIndex: seat.seatIndex,
        holeCards: [...(s.cards.holeCards[seat.playerId] ?? [])] as Card[],
        stackStart: seat.stack,
        stackEnd: end,
        net: end - seat.stack,
        won: payouts.get(seat.playerId) ?? 0,
        rankClass: ev && showdownCount > 1 ? ev.rankClass : null,
        rankValue: ev && showdownCount > 1 ? ev.rankValue : null,
        bestFive: ev && showdownCount > 1 ? ([...ev.bestFive] as Card[]) : null,
        wentToShowdown: !!ev && showdownCount > 1,
        shown: revealed.has(seat.playerId),
      };
    });
    const actions: PublicActionRecord[] = [];
    for (const round of s.hand.bettingRounds) {
      for (const t of round.turns) {
        const seatIndex = this.seatOf(t.actor) ?? -1;
        let type: PublicActionRecord['type'] | null = mapActionType(t.action);
        if (t.action.type === 'post-blind') type = t.action.blind === 'small' ? 'post-sb' : 'post-bb';
        if (t.action.type === 'timeout') type = t.action.fallback === 'check' ? 'timeout-check' : 'timeout-fold';
        if (type) actions.push({ seatIndex, playerId: t.actor, stage: round.stage as HandStage, type, amount: t.contribution, at: t.timestamp });
      }
    }
    return {
      handId: this.meta.handId,
      startedAt: this.meta.startedAt,
      endedAt: now,
      board: boardOf(s),
      potTotal: [...payouts.values()].reduce((a, b) => a + b, 0),
      engineVersion: ENGINE_VERSION,
      players,
      actions,
    };
  }

  /** Final stacks by player (settled hands). */
  finalStacks(): Map<string, number> {
    const m = new Map<string, number>();
    for (const seat of this.snapshot.seating.seats) if (seat.occupant) m.set(seat.occupant.playerId, seat.stack);
    return m;
  }
}
