/**
 * Table bots' accounts and chips (docs/STATUS.md "서버 봇").
 *
 * A bot is a `users` row with is_bot = 1 that cannot sign in. It plays with chips like everybody: a buy-in debits its
 * wallet and opens a table session, a cash-out credits it back, all through the ledger. When its wallet is short of a
 * buy-in, the bot fund issues the difference first as a `bot_fund` ledger row, counted in `bot_fund.issued` in the same
 * transaction and refused once that would pass the policy's fund limit. Nothing a bot wins or loses is created or
 * removed outside the ledger, so the bots' result against members is always
 *   (bot wallets + chips bots hold at tables) − bot_fund.issued.
 *
 * Both writes are keyed by the table session (`botfund:` / `buyin:`), so a retry after a crash never issues or debits
 * twice; chips issued for a buy-in that then did not happen stay in the bot's wallet for its next one.
 */
import { applyLedger } from '@jc/db';
import { BOT_BUY_IN_BB, BOT_LEVELS, BOT_STYLES, type BotLevel, type BotProfile, type BotStyle } from '@jc/types';
import { buyIn } from './settlement';

export interface BotAccount {
  id: string;
  nickname: string;
  balance: number;
  /** What an administrator set for this bot (bot_profiles); null: it follows each table it sits at. */
  profile: BotProfile | null;
}

/** A bot_profiles row as the room uses it: a value this build does not know follows the table (or the default), as if unset. */
export function profileOf(r: { level?: unknown; style?: unknown; buyInBb?: unknown } | null | undefined): BotProfile | null {
  if (!r) return null;
  const bb = Number(r.buyInBb);
  return {
    level: BOT_LEVELS.includes(r.level as BotLevel) ? (r.level as BotLevel) : null,
    style: BOT_STYLES.includes(r.style as BotStyle) ? (r.style as BotStyle) : null,
    buyInBb: r.buyInBb != null && Number.isInteger(bb) && bb >= BOT_BUY_IN_BB.min && bb <= BOT_BUY_IN_BB.max ? bb : null,
  };
}

/** The settings of these bots, in one D1 call (bots with none are absent). */
export async function readBotProfiles(d1: D1Database, ids: string[]): Promise<Map<string, BotProfile>> {
  if (!ids.length) return new Map();
  const { results } = await d1
    .prepare(`SELECT bot_id AS id, level, style, buy_in_bb AS buyInBb FROM bot_profiles WHERE bot_id IN (${ids.map((_, i) => `?${i + 1}`).join(', ')})`)
    .bind(...ids)
    .all<{ id: string; level: unknown; style: unknown; buyInBb: unknown }>();
  return new Map(results.map((r) => [r.id, profileOf(r)!]));
}

/** `p`'s answer, or a rejection once `ms` passed without one (an answer after that is dropped). */
export function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export type BotEventKind = 'join' | 'leave' | 'fund_exhausted' | 'join_failed' | 'action_failed';

/** Why a bot could not sit: bots were switched off, the fund or the service-wide count is used up, or the bot got busy. */
export type BotRefusal = 'policy_off' | 'fund_exhausted' | 'max_bots' | 'busy';

const POLICY = `SELECT %s FROM bot_policies ORDER BY version DESC LIMIT 1`;
const policy = (col: string) => POLICY.replace('%s', col);

/** Bots seated at any table now (few rows: bot accounts are reused, so there are about as many as ever sat at once). */
const SEATED_BOTS = `SELECT COUNT(*) FROM users b WHERE b.is_bot = 1 AND b.status = 'active'
  AND EXISTS (SELECT 1 FROM table_sessions s WHERE s.user_id = b.id AND s.status = 'seated')`;

const NAME_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * An idle bot account — active and seated nowhere — other than those in `exclude` (bots this room holds a seat for),
 * preferring the one with the most chips so the fund issues as little as possible; or a new account. Two rooms may pick
 * the same bot at once: the buy-in guard seats it at one of them and the other gets 'busy'.
 */
export async function pickBot(d1: D1Database, exclude: string[]): Promise<BotAccount> {
  const marks = exclude.map((_, i) => `?${i + 1}`).join(', ');
  const r = await d1
    .prepare(
      `SELECT u.id, u.nickname, u.balance, p.bot_id AS profiled, p.level, p.style, p.buy_in_bb AS buyInBb FROM users u LEFT JOIN bot_profiles p ON p.bot_id = u.id
        WHERE u.is_bot = 1 AND u.status = 'active'${exclude.length ? ` AND u.id NOT IN (${marks})` : ''}
         AND NOT EXISTS (SELECT 1 FROM table_sessions s WHERE s.user_id = u.id AND s.status = 'seated')
       ORDER BY u.balance DESC LIMIT 1`,
    )
    .bind(...exclude)
    .first<{ id: string; nickname: string; balance: number; profiled: string | null; level: unknown; style: unknown; buyInBb: unknown }>();
  return r ? { id: r.id, nickname: r.nickname, balance: Number(r.balance), profile: r.profiled ? profileOf(r) : null } : createBot(d1);
}

/**
 * A new bot account. Its nickname `Bot-XXXX` cannot be a member's (a member's nickname has no '-'), its address is in a
 * reserved domain no mail goes to, and its password hash is not a hash at all: sign-in refuses bots before checking it.
 */
async function createBot(d1: D1Database): Promise<BotAccount> {
  for (let attempt = 0; ; attempt++) {
    const id = crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    const nickname = `Bot-${Array.from(bytes, (b) => NAME_CHARS[b % NAME_CHARS.length]).join('')}`;
    try {
      await d1
        .prepare(
          `INSERT INTO users (id, email, nickname, password_hash, role, status, balance, is_bot, friend_requests, dm_notifications)
           VALUES (?1, ?2, ?3, 'bot:no-sign-in', 'user', 'active', 0, 1, 'nobody', 0)`,
        )
        .bind(id, `bot-${id}@bots.invalid`, nickname)
        .run();
      return { id, nickname, balance: 0, profile: null };
    } catch (e) {
      // Another bot already has this name: draw again.
      if (attempt < 5 && e instanceof Error && /UNIQUE constraint failed/.test(e.message)) continue;
      throw e;
    }
  }
}

/**
 * Seats `bot` with `amount` chips: the fund tops its wallet up to the buy-in when needed, then the usual buy-in opens
 * the table session. Both are refused (nothing written) while the newest policy has bots off; the fund also when it
 * would pass its limit, and the buy-in when the bot is seated elsewhere or the service already seats `max_bots` bots.
 */
export async function botBuyIn(
  d1: D1Database,
  p: { bot: BotAccount; tableId: string; tableSessionId: string; seatIndex: number; amount: number },
): Promise<{ ok: true; funded: number } | { ok: false; code: BotRefusal }> {
  const need = p.amount - p.bot.balance;
  let funded = 0;
  if (need > 0) {
    const r = await applyLedger(
      d1,
      {
        userId: p.bot.id,
        type: 'bot_fund',
        amount: need,
        idempotencyKey: `botfund:${p.tableSessionId}`,
        tableId: p.tableId,
        refId: p.tableSessionId,
        memo: 'bot fund',
        guard: {
          sql: `is_bot = 1 AND (${policy('enabled')}) = 1 AND (SELECT issued FROM bot_fund WHERE id = 1) + ?10 <= (${policy('fund_limit')})`,
          params: [need],
        },
      },
      (ledgerId) => [
        d1
          .prepare(`UPDATE bot_fund SET issued = issued + ?1, updated_at = (unixepoch('subsec') * 1000) WHERE id = 1 AND EXISTS (SELECT 1 FROM chip_ledger WHERE id = ?2)`)
          .bind(need, ledgerId),
      ],
    );
    if (r.status === 'insufficient') return { ok: false, code: await refusal(d1, p.bot.id) };
    if (r.status === 'applied') funded = need;
  }
  const r = await buyIn(d1, {
    userId: p.bot.id,
    tableId: p.tableId,
    tableSessionId: p.tableSessionId,
    seatIndex: p.seatIndex,
    amount: p.amount,
    guard: {
      sql: `is_bot = 1 AND (${policy('enabled')}) = 1
        AND NOT EXISTS (SELECT 1 FROM table_sessions s WHERE s.user_id = ?9 AND s.status = 'seated')
        AND (${SEATED_BOTS}) < (${policy('max_bots')})`,
      params: [],
    },
  });
  if (r.ok) return { ok: true, funded };
  return { ok: false, code: r.code === 'already_seated' ? 'busy' : await refusal(d1, p.bot.id) };
}

/** Which condition refused a bot's fund or buy-in (read afterwards, so only a likely reason). */
async function refusal(d1: D1Database, botId: string): Promise<BotRefusal> {
  const r = await d1
    .prepare(
      `SELECT (${policy('enabled')}) AS enabled, (${policy('fund_limit')}) AS fundLimit, (${policy('max_bots')}) AS maxBots,
              (SELECT issued FROM bot_fund WHERE id = 1) AS issued, (${SEATED_BOTS}) AS seated,
              EXISTS (SELECT 1 FROM table_sessions s WHERE s.user_id = ?1 AND s.status = 'seated') AS busy`,
    )
    .bind(botId)
    .first<{ enabled: number | null; fundLimit: number | null; maxBots: number | null; issued: number | null; seated: number; busy: number }>();
  if (!r || Number(r.enabled) !== 1) return 'policy_off';
  if (r.busy) return 'busy';
  if (Number(r.seated) >= Number(r.maxBots ?? 0)) return 'max_bots';
  return 'fund_exhausted';
}

/** One line of the bots' operations log (admin 봇 운영). Never holds cards or anything a member wrote. */
export async function botEvent(d1: D1Database, e: { tableId: string; botId: string | null; kind: BotEventKind; code?: string | null }): Promise<void> {
  await d1
    .prepare(`INSERT INTO bot_events (id, table_id, bot_id, kind, code) VALUES (?1, ?2, ?3, ?4, ?5)`)
    .bind(crypto.randomUUID(), e.tableId, e.botId, e.kind, e.code?.slice(0, 60) ?? null)
    .run();
}
