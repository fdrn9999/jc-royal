import type { IntegrityRisk, IntegritySignal } from '@jc/types';

const DAY = 86_400_000;

/**
 * How the signs of chips passed on purpose between two members are read. A pair that meets them is a case for an
 * operator to look into, never a finding: nothing here suspends, freezes or blocks anyone (docs/ADMIN.md).
 */
export const INTEGRITY = {
  /** Hands the two must have been dealt together before their chips are compared. */
  minShared: 10,
  /** Big blinds that went one way between them, less what came back... */
  minFlowBb: 50,
  /** ...as this share of every chip that passed between them, at least. */
  oneWay: 0.8,
  /** A hand one gave up without a showdown for at least this many big blinds, the other the hand's only winner... */
  dumpBb: 20,
  /** ...this many times, the same one to the same other. */
  minDumps: 3,
  /** Hand rows read for the list at most (newest first); past it the period is cut short and the page says so. */
  rowCap: 60_000,
  /** Pairs listed at most. */
  maxPairs: 100,
  /** Hands kept as evidence for each pair. */
  evidence: 10,
} as const;

export type IntegrityThresholds = { [K in keyof typeof INTEGRITY]: number };

/** One player's row of one finished cash-table hand. */
export interface IntegrityRow {
  handId: string;
  tableId: string;
  handNumber: number;
  endedAt: number;
  bb: number;
  userId: string;
  net: number;
  showdown: number;
  bot: number;
}

export interface IntegrityHand {
  id: string;
  tableId: string;
  handNumber: number;
  endedAt: number;
  /** Big blinds that went from the giver to the receiver in this hand (negative: the other way). */
  bb: number;
  /** The giver gave it up without a showdown for DUMP_BB or more, the receiver its only winner. */
  dump: boolean;
}

export interface IntegrityPair {
  /** The member whose chips went over. */
  from: string;
  /** The member who received them. */
  to: string;
  /** Hands both were dealt into in the period. */
  shared: number;
  /** Big blinds from `from` to `to`, less what went back. */
  flowBb: number;
  /** Of every chip that passed between the two, the share that went from `from` to `to`. */
  oneWay: number;
  dumps: number;
  signals: IntegritySignal[];
  risk: IntegrityRisk;
  /** Hands to look at first: the dumps, then the largest flows to `to`. */
  hands: IntegrityHand[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Two signs make a pair worth a look sooner, all three sooner still; one alone is the lowest band. */
export const riskOf = (signals: readonly IntegritySignal[]): IntegrityRisk => (signals.length >= 3 ? 'high' : signals.length === 2 ? 'medium' : 'low');
const BAND: Record<IntegrityRisk, number> = { high: 0, medium: 1, low: 2 };
export const byRisk = (a: IntegrityPair, b: IntegrityPair) => BAND[a.risk] - BAND[b.risk] || b.flowBb - a.flowBb || b.dumps - a.dumps;

interface Tally {
  a: string;
  b: string;
  shared: number;
  /** Big blinds a → b and b → a. */
  ab: number;
  ba: number;
  dumpsAb: number;
  dumpsBa: number;
  hands: { h: IntegrityRow; ab: number; dump: 'ab' | 'ba' | null }[];
}

/**
 * The pairs of members whose hands together meet INTEGRITY, from every row of the hands read (table bots' rows too:
 * a bot is never one of a pair, but what it won counts when a loser's chips are shared out).
 *
 * A losing player's chips are shared out over the hand's winners by what each won, so in a hand A lost 30 big blinds,
 * B won 20 and C won 10, 20 went from A to B and 10 to C. The network sign is added by the caller (`withNetwork`).
 */
export function pairsOf(rows: readonly IntegrityRow[], t: IntegrityThresholds = INTEGRITY): IntegrityPair[] {
  const byHand = new Map<string, IntegrityRow[]>();
  for (const row of rows) {
    const hand = byHand.get(row.handId);
    if (hand) hand.push(row);
    else byHand.set(row.handId, [row]);
  }
  const tally = new Map<string, Tally>();
  for (const hand of byHand.values()) {
    const bb = hand[0]!.bb > 0 ? hand[0]!.bb : 1;
    const won = hand.reduce((s, r) => s + Math.max(0, r.net), 0);
    const winners = hand.filter((r) => r.net > 0);
    const members = hand.filter((r) => !r.bot);
    const gave = (l: IntegrityRow, w: IntegrityRow) => (l.net < 0 && w.net > 0 && won > 0 ? (-l.net * w.net) / won / bb : 0);
    const dumped = (l: IntegrityRow, w: IntegrityRow) => l.net <= -t.dumpBb * bb && !l.showdown && winners.length === 1 && winners[0] === w;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const [x, y] = members[i]!.userId < members[j]!.userId ? [members[i]!, members[j]!] : [members[j]!, members[i]!];
        const key = `${x.userId} ${y.userId}`;
        let p = tally.get(key);
        if (!p) tally.set(key, (p = { a: x.userId, b: y.userId, shared: 0, ab: 0, ba: 0, dumpsAb: 0, dumpsBa: 0, hands: [] }));
        p.shared++;
        const ab = gave(x, y);
        const ba = gave(y, x);
        const dump = dumped(x, y) ? 'ab' : dumped(y, x) ? 'ba' : null;
        p.ab += ab;
        p.ba += ba;
        if (dump === 'ab') p.dumpsAb++;
        if (dump === 'ba') p.dumpsBa++;
        if (ab || ba) p.hands.push({ h: x, ab: ab - ba, dump });
      }
    }
  }
  const out: IntegrityPair[] = [];
  for (const p of tally.values()) {
    const gross = p.ab + p.ba;
    const flowDir = p.ab >= p.ba ? 'ab' : 'ba';
    const flow = p.shared >= t.minShared && Math.abs(p.ab - p.ba) >= t.minFlowBb && gross > 0 && Math.max(p.ab, p.ba) / gross >= t.oneWay;
    const dir = flow ? flowDir : p.dumpsAb >= p.dumpsBa ? 'ab' : 'ba';
    const dumps = dir === 'ab' ? p.dumpsAb : p.dumpsBa;
    const signals: IntegritySignal[] = [];
    if (flow) signals.push('flow');
    if (dumps >= t.minDumps) signals.push('dumps');
    if (!signals.length) continue;
    const sign = dir === 'ab' ? 1 : -1;
    const hands = p.hands
      .map(({ h, ab, dump }) => ({ id: h.handId, tableId: h.tableId, handNumber: h.handNumber, endedAt: h.endedAt, bb: r1(sign * ab), dump: dump === dir }))
      .filter((h) => h.dump || h.bb > 0)
      .sort((x, y) => Number(y.dump) - Number(x.dump) || y.bb - x.bb || y.endedAt - x.endedAt)
      .slice(0, t.evidence);
    out.push({
      from: dir === 'ab' ? p.a : p.b,
      to: dir === 'ab' ? p.b : p.a,
      shared: p.shared,
      flowBb: r1(sign * (p.ab - p.ba)),
      oneWay: gross > 0 ? Math.round(((dir === 'ab' ? p.ab : p.ba) / gross) * 100) / 100 : 0,
      dumps,
      signals,
      risk: riskOf(signals),
      hands,
    });
  }
  return out.sort(byRisk);
}

/** The pair with the network sign added: never a sign on its own, only beside one of the others. */
export function withNetwork(p: IntegrityPair, shared: boolean): IntegrityPair {
  if (!shared || p.signals.includes('network')) return p;
  const signals: IntegritySignal[] = [...p.signals, 'network'];
  return { ...p, signals, risk: riskOf(signals) };
}

const ROW = `h.id AS handId, h.table_id AS tableId, h.hand_number AS handNumber, h.ended_at AS endedAt, t.big_blind AS bb,
             hp.user_id AS userId, hp.net AS net, hp.went_to_showdown AS showdown, u.is_bot AS bot`;
/**
 * Both members signed in from the same network in the period: compared inside D1, so no address leaves it. A shared
 * flat, office or café network does this too, which is why it only ever stands beside another sign.
 */
const network = (a: string, b: string, since: string) => `EXISTS (SELECT 1 FROM sessions s1 JOIN sessions s2 ON s2.ip = s1.ip AND s2.user_id = ${b} AND s2.kind = 'user' AND s2.last_seen_at >= ${since}
                  WHERE s1.user_id = ${a} AND s1.kind = 'user' AND s1.ip IS NOT NULL AND s1.last_seen_at >= ${since})`;
const NETWORK = network('?1', '?2', '?3');
/** The pairs of a JSON array of [from, to] that share a network, by their place in it. */
const NETWORKS = `SELECT j.key AS i FROM json_each(?1) j WHERE ${network(`json_extract(j.value, '$[0]')`, `json_extract(j.value, '$[1]')`, '?2')}`;
/** Pairs per NETWORKS statement, so one statement's bound array stays small whatever the period holds. */
const NETWORK_CHUNK = 200;

type Read<T> = D1Result<T>;
const rows = <T>(r: Read<unknown>) => (r.results ?? []) as T[];

interface UserRow {
  id: string;
  nickname: string;
  status: string;
}
interface OpenReport {
  id: string;
  userId: string;
  kind: string | null;
  partnerId: string | null;
}

/**
 * The integrity page: pairs of members whose cash-table hands of the last `days` days meet INTEGRITY, highest band
 * first, each with its evidence hands, the two members, whether they share a network and the reports open on them.
 * The network sign can move a pair up a band, so it is read for every pair found before the list is cut to
 * INTEGRITY.maxPairs; `found` says how many there were. Read when an administrator opens the page (never polled). Cost:
 * the period's hands through hands_table_idx (tables first, as the statistics do), their players by primary key,
 * newest first up to INTEGRITY.rowCap rows; then one batch for the pairs found (their networks, NETWORK_CHUNK pairs a
 * statement, the two members and the reports open on them). `rowsRead` reports what a call cost.
 */
export async function integrity(db: D1Database, days: number, now = Date.now(), t: IntegrityThresholds = INTEGRITY) {
  const since = now - days * DAY;
  const read = await db
    .prepare(
      `SELECT ${ROW}
         FROM tables t CROSS JOIN hands h ON h.table_id = t.id AND h.ended_at >= ?1
         JOIN hand_players hp ON hp.hand_id = h.id
         JOIN users u ON u.id = hp.user_id
        WHERE t.room_type != 'tournament'
        ORDER BY h.ended_at DESC, h.id
        LIMIT ?2`,
    )
    .bind(since, t.rowCap)
    .all<IntegrityRow>();
  let hands = read.results ?? [];
  const capped = hands.length >= t.rowCap;
  // The oldest hand may have been cut part way through its players: it is left out rather than read half.
  if (capped) hands = hands.filter((r) => r.handId !== hands.at(-1)!.handId);
  const from = capped && hands.length ? hands.at(-1)!.endedAt : since;
  let rowsRead = read.meta.rows_read ?? 0;
  let found = pairsOf(hands, t);
  const users = new Map<string, UserRow>();
  const reports: OpenReport[] = [];
  if (found.length) {
    const ids = JSON.stringify([...new Set(found.flatMap((p) => [p.from, p.to]))]);
    const chunks: IntegrityPair[][] = [];
    for (let i = 0; i < found.length; i += NETWORK_CHUNK) chunks.push(found.slice(i, i + NETWORK_CHUNK));
    const results = await db.batch([
      db.prepare(`SELECT id, nickname, status FROM users WHERE id IN (SELECT value FROM json_each(?1))`).bind(ids),
      db
        .prepare(
          `SELECT id, target_user_id AS userId, json_extract(context, '$.kind') AS kind, json_extract(context, '$.partnerId') AS partnerId
             FROM reports WHERE status = 'open' AND target_user_id IN (SELECT value FROM json_each(?1))`,
        )
        .bind(ids),
      ...chunks.map((c) => db.prepare(NETWORKS).bind(JSON.stringify(c.map((p) => [p.from, p.to])), since)),
    ]);
    rowsRead += results.reduce((a, r) => a + (r.meta.rows_read ?? 0), 0);
    for (const u of rows<UserRow>(results[0]!)) users.set(u.id, u);
    reports.push(...rows<OpenReport>(results[1]!));
    const shared = new Set(chunks.flatMap((_, c) => rows<{ i: number }>(results[c + 2]!).map((r) => c * NETWORK_CHUNK + Number(r.i))));
    found = found.map((p, i) => withNetwork(p, shared.has(i))).sort(byRisk);
  }
  const pairs = found.slice(0, t.maxPairs);
  const person = (id: string) => ({ id, nickname: users.get(id)?.nickname ?? null, status: users.get(id)?.status ?? null, openReports: reports.filter((r) => r.userId === id).length });
  return {
    days,
    since,
    from,
    capped,
    hands: new Set(hands.map((r) => r.handId)).size,
    found: found.length,
    pairs: pairs.map((p) => ({
      ...p,
      fromUser: person(p.from),
      toUser: person(p.to),
      review: reports.find((r) => r.kind === 'signal' && r.userId === p.to && r.partnerId === p.from)?.id ?? null,
    })),
    rowsRead,
    thresholds: t,
  };
}

/**
 * The same reading for one pair, from the hands both were dealt into (through hp_user_idx), for a review: what the
 * report records is worked out again on the server at the moment it is opened, not taken from the page.
 */
export async function integrityPair(db: D1Database, from: string, to: string, days: number, now = Date.now()) {
  const since = now - days * DAY;
  const [read, net] = await db.batch([
    db
      .prepare(
        `SELECT ${ROW}
           FROM hand_players a
           JOIN hand_players b ON b.hand_id = a.hand_id AND b.user_id = ?2
           JOIN hands h ON h.id = a.hand_id
           JOIN tables t ON t.id = h.table_id AND t.room_type != 'tournament'
           JOIN hand_players hp ON hp.hand_id = a.hand_id
           JOIN users u ON u.id = hp.user_id
          WHERE a.user_id = ?1 AND a.ended_at >= ?3`,
      )
      .bind(from, to, since),
    db.prepare(`SELECT ${NETWORK} AS shared`).bind(from, to, since),
  ]);
  const pair = pairsOf(rows<IntegrityRow>(read!)).find((p) => (p.from === from && p.to === to) || (p.from === to && p.to === from));
  if (!pair) return null;
  return { since, pair: withNetwork(pair, !!rows<{ shared: number }>(net!)[0]?.shared) };
}
