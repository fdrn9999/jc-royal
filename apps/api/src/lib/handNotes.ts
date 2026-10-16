/**
 * A member's own bookmark, tags and memo on hands they were dealt into (hand_notes), and their hand list with filters.
 * Only the member reads or writes their notes: every query is keyed by the signed-in member, no admin route reads the
 * table but the anonymous totals in operations statistics, and nothing here logs a memo or tags (errors carry ids and
 * codes only). Rows stay when emptied, so the memo revision only ever counts up; withdrawal deletes them.
 */
import { statsDay, statsIncrements, type HandNoteMetric } from '@jc/db';
import { HAND_TAGS, type HandListQuery, type HandNoteDto, type HandNoteInput, type HandSummaryDto, type HandTag, type Position } from '@jc/types';
import { HttpError } from './http';

/** Bits of the tags set to `on` in `tags`. */
export const tagBits = (tags: Partial<Record<HandTag, boolean>>, on: boolean) => HAND_TAGS.reduce((m, t, i) => (tags[t] === on ? m | (1 << i) : m), 0);
export const tagList = (bits: number): HandTag[] => HAND_TAGS.filter((_, i) => (bits & (1 << i)) !== 0);

/** A member's save on hand notes per kind, or a refused or failed one per reason. Never fails the answer. */
export async function countNote(db: D1Database, metrics: HandNoteMetric[], now = Date.now()) {
  if (!metrics.length) return;
  await db.batch(statsIncrements(db, statsDay(now), Object.fromEntries(metrics.map((m) => [m, 1])))).catch(() => undefined);
}

/** The counter of a refused or failed save. */
export function failureMetric(e: unknown): HandNoteMetric {
  const s = e instanceof HttpError ? e.status : 500;
  return s === 429 ? 'hn_fail_limit' : s === 400 ? 'hn_fail_invalid' : s === 404 ? 'hn_fail_notfound' : s === 409 ? 'hn_fail_conflict' : 'hn_fail_error';
}

interface NoteRow {
  bookmarked: number;
  tags: number;
  memo: string | null;
  rev: number;
  updated_at: number;
}
const EMPTY: HandNoteDto = { bookmarked: false, tags: [], memo: null, rev: 0, updatedAt: null };
const toNote = (r: NoteRow | null | undefined): HandNoteDto =>
  r ? { bookmarked: r.bookmarked === 1, tags: tagList(r.tags), memo: r.memo, rev: r.rev, updatedAt: r.updated_at } : EMPTY;

const NOTE_SELECT = 'SELECT bookmarked, tags, memo, rev, updated_at FROM hand_notes WHERE user_id = ?1 AND hand_id = ?2';

export async function readNote(db: D1Database, userId: string, handId: string): Promise<HandNoteDto> {
  return toNote(await db.prepare(NOTE_SELECT).bind(userId, handId).first<NoteRow>());
}

export type NoteSave = { ok: true; note: HandNoteDto } | { ok: false; code: 'not_found' } | { ok: false; code: 'note_conflict'; note: HandNoteDto };

/**
 * Saves what `input` changes, in one statement: the bookmark as sent, tags set or cleared bit by bit (so two saves of
 * different tags both land), and the memo only over the revision it was written on. Then reads the note and whether
 * the member was dealt into the hand, in the same batch, to tell a refused memo (409) from a hand that isn't theirs (404).
 */
export async function saveNote(db: D1Database, userId: string, handId: string, input: HandNoteInput, now = Date.now()): Promise<NoteSave> {
  const bookmark = input.bookmarked === undefined ? null : input.bookmarked ? 1 : 0;
  const set = input.tags ? tagBits(input.tags, true) : 0;
  const clear = input.tags ? tagBits(input.tags, false) : 0;
  const withMemo = input.memo === undefined ? 0 : 1;
  const memo = input.memo?.trim() || null;
  const [up, cur, own] = await db.batch([
    db
      .prepare(
        `INSERT INTO hand_notes (user_id, hand_id, ended_at, bookmarked, tags, memo, rev, created_at, updated_at)
         SELECT hp.user_id, hp.hand_id, hp.ended_at, coalesce(?3, 0), ?4 & ~?5, CASE WHEN ?6 = 1 THEN ?7 END, ?6, ?9, ?9
         FROM hand_players hp
         WHERE hp.user_id = ?1 AND hp.hand_id = ?2
           -- A save that started before the member withdrew writes nothing after it.
           AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND status != 'deleted')
           AND (?6 = 0 OR ?8 = 0 OR EXISTS (SELECT 1 FROM hand_notes WHERE user_id = ?1 AND hand_id = ?2))
         ON CONFLICT (user_id, hand_id) DO UPDATE SET
           bookmarked = coalesce(?3, bookmarked),
           tags = (tags | ?4) & ~?5,
           memo = CASE WHEN ?6 = 1 THEN ?7 ELSE memo END,
           rev = rev + ?6,
           updated_at = ?9
         WHERE ?6 = 0 OR rev = ?8
         RETURNING bookmarked, tags, memo, rev, updated_at`,
      )
      .bind(userId, handId, bookmark, set, clear, withMemo, memo, input.rev ?? 0, now),
    db.prepare(NOTE_SELECT).bind(userId, handId),
    db.prepare('SELECT 1 AS ok FROM hand_players WHERE user_id = ?1 AND hand_id = ?2').bind(userId, handId),
  ]);
  const saved = (up!.results as NoteRow[])[0];
  if (saved) return { ok: true, note: toNote(saved) };
  if (!own!.results.length) return { ok: false, code: 'not_found' };
  return { ok: false, code: 'note_conflict', note: toNote((cur!.results as NoteRow[])[0]) };
}

/** The kinds of change a save carried, for the counters. */
export function savedMetrics(input: HandNoteInput): HandNoteMetric[] {
  const out: HandNoteMetric[] = [];
  if (input.bookmarked !== undefined) out.push('hn_bookmark');
  if (input.tags && Object.keys(input.tags).length) out.push('hn_tag');
  if (input.memo !== undefined) out.push('hn_memo');
  return out;
}

/** A filter beyond paging was asked for (the list is then rate limited: it may read many of the member's hands). */
export const isFiltered = (q: HandListQuery) =>
  q.from !== undefined || q.to !== undefined || !!q.position || !!q.result || q.minPot !== undefined || !!q.tag || !!q.bookmarked;

interface ListRow {
  id: string;
  tableId: string;
  tableName: string;
  handNumber: number;
  endedAt: number;
  board: string;
  potTotal: number;
  bigBlind: number;
  net: number;
  won: number;
  holeCards: string;
  rankClass: string | null;
  position: Position | null;
  bookmarked: number | null;
  tags: number | null;
  hasMemo: number;
}

/**
 * The member's hands, newest first, with their notes. Read from hand_players in end order (its (user_id, ended_at)
 * index); a bookmark or tag filter reads from the member's notes instead. Position, result and pot size are checked on
 * each of the member's hands in turn, so a narrow filter can read many of them before it fills a page. Pot size is in
 * big blinds of the table's blind now, since hands don't store theirs.
 */
export async function listHands(db: D1Database, userId: string, q: HandListQuery & { limit: number; before?: number }): Promise<HandSummaryDto[]> {
  const byNote = !!q.bookmarked || !!q.tag;
  const o = byNote ? 'n' : 'hp';
  const args: unknown[] = [userId];
  const arg = (v: unknown) => `?${args.push(v)}`;
  const where = [`${o}.user_id = ?1`];
  if (q.before !== undefined) {
    const b = arg(q.before);
    where.push(q.beforeId === undefined ? `${o}.ended_at < ${b}` : `(${o}.ended_at < ${b} OR (${o}.ended_at = ${b} AND ${o}.hand_id < ${arg(q.beforeId)}))`);
  }
  if (q.from !== undefined) where.push(`${o}.ended_at >= ${arg(q.from)}`);
  if (q.to !== undefined) where.push(`${o}.ended_at < ${arg(q.to)}`);
  if (q.position) where.push(`hp.position = ${arg(q.position)}`);
  if (q.result) where.push(q.result === 'up' ? 'hp.net > 0' : q.result === 'down' ? 'hp.net < 0' : 'hp.net = 0');
  if (q.minPot !== undefined) where.push(`h.pot_total >= ${arg(q.minPot)} * t.big_blind`);
  if (q.bookmarked) where.push('n.bookmarked = 1');
  if (q.tag) where.push(`(n.tags & ${arg(1 << HAND_TAGS.indexOf(q.tag))}) != 0`);
  const from = byNote
    ? 'hand_notes n JOIN hand_players hp ON hp.user_id = n.user_id AND hp.hand_id = n.hand_id'
    : 'hand_players hp LEFT JOIN hand_notes n ON n.user_id = hp.user_id AND n.hand_id = hp.hand_id';
  const { results } = await db
    .prepare(
      `SELECT hp.hand_id AS id, h.table_id AS tableId, t.name AS tableName, h.hand_number AS handNumber, hp.ended_at AS endedAt,
         h.board, h.pot_total AS potTotal, t.big_blind AS bigBlind, hp.net, hp.won, hp.hole_cards AS holeCards,
         hp.rank_class AS rankClass, hp.position, n.bookmarked, n.tags, n.memo IS NOT NULL AS hasMemo
       FROM ${from}
       JOIN hands h ON h.id = hp.hand_id
       JOIN tables t ON t.id = h.table_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${o}.ended_at DESC, ${o}.hand_id DESC
       LIMIT ${arg(q.limit)}`,
    )
    .bind(...args)
    .all<ListRow>();
  return results.map((r) => ({
    id: r.id,
    tableId: r.tableId,
    tableName: r.tableName,
    handNumber: r.handNumber,
    endedAt: r.endedAt,
    board: JSON.parse(r.board) as string[],
    potTotal: r.potTotal,
    net: r.net,
    won: r.won,
    holeCards: JSON.parse(r.holeCards) as string[],
    rankClass: r.rankClass,
    position: r.position,
    bigBlind: r.bigBlind,
    bookmarked: r.bookmarked === 1,
    tags: tagList(r.tags ?? 0),
    hasMemo: r.hasMemo === 1,
  }));
}
