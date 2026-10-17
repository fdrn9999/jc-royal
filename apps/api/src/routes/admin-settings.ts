/**
 * Members' account settings, for diagnosing sync problems (lib/settings.ts). Mounted inside the admin router: an admin
 * session, the admin origin and the permission table's rule are already applied.
 *
 * - Administrators see the revision, epoch, how many settings and favourite tables the account has, when it changed and
 *   when its devices last synced, and the last reset: never a value, and nothing to edit.
 * - A reset (password, reason, preview) puts every synced setting and favourite back to the defaults and raises the
 *   epoch, so each device drops what it had not saved and none can upload the old settings again (a device's settings
 *   from before sync are only taken while the epoch is 0). It is allowed when the account never saved any, to stop a
 *   device's old settings from being taken. Settings kept on each device (sound, recent tables) are not touched.
 * - It can be undone (password, reason, preview) for SETTINGS_RESTORE_MS while the member has changed nothing since;
 *   that raises the epoch again. Both name the revision the administrator was looking at: a change meanwhile is a
 *   conflict (409 settings_changed, with the current state).
 * - The member is told in their language, once per reset or restore (the message is written in the same batch, only
 *   if the change was); it doesn't carry the administrator's reason, which stays in the audit log.
 */
import { SETTINGS_RESTORE_MS, SETTINGS_SCHEMA_VERSION, type AdminSettingsDiagDto } from '@jc/types';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { audit } from '../lib/audit';
import { fail, isPreview, parseBody } from '../lib/http';
import { notices } from '../lib/notices';
import { can } from '../lib/permissions';
import { pushMuckEverywhere } from '../lib/room';
import { countSettings, diagnose, favList, parseFav, parsePrefs, resetInfo, toState, type SettingsRow } from '../lib/settings';

const ReasonSchema = z.string().trim().min(2).max(200);
/** `rev`: the revision the administrator was looking at. */
const ActionSchema = z.object({ reason: ReasonSchema, rev: z.number().int().min(0) });
const PreviewSchema = ActionSchema.partial({ reason: true });

interface Member {
  nickname: string;
  role: string;
  status: string;
  locale: string;
  isBot: number;
}

async function load(c: Context<AppEnv>, id: string) {
  const db = c.env.DB;
  const [m, s] = await db.batch([
    db.prepare('SELECT nickname, role, status, locale, is_bot AS isBot FROM users WHERE id = ?1').bind(id),
    db
      .prepare(
        `SELECT s.prefs, s.fav, s.rev, s.epoch, s.schema_version, s.updated_at, s.synced_at, s.reset_at, s.reset_by, s.reset_rev, s.prev, s.restored_at,
                b.nickname AS reset_by_nickname
           FROM user_settings s LEFT JOIN users b ON b.id = s.reset_by WHERE s.user_id = ?1`,
      )
      .bind(id),
  ]);
  const member = (m!.results as Member[])[0];
  if (!member) fail(404, 'not_found', 'user not found');
  const row = ((s!.results as (SettingsRow & { reset_by_nickname: string | null })[])[0] ?? null) as (SettingsRow & { reset_by_nickname: string | null }) | null;
  const now = Date.now();
  const diag: AdminSettingsDiagDto = diagnose(
    { nickname: member.nickname, role: member.role, status: member.status },
    row,
    row?.reset_by ? { id: row.reset_by, nickname: row.reset_by_nickname } : null,
    now,
  );
  return { member, row, diag, now };
}

/** Who may be reset or restored by this administrator (a refused request is audited by auditFailures). */
function guard(c: Context<AppEnv>, id: string, member: Member) {
  if (id === c.var.user!.id) fail(400, 'bad_request', 'change your own settings in the game instead');
  if (member.status === 'deleted') fail(404, 'not_found', 'user not found');
  if (member.isBot) fail(409, 'bot_account', 'table bot accounts are managed from the bots page');
  if (member.role !== 'user' && !can(c.var.user!.role, 'admins.manage')) fail(403, 'forbidden', 'only a super admin can reset or restore the settings of administrators');
}

/** The member's auto-muck as their tables have it from the account (the default when not set). */
const muckOf = (row: SettingsRow | null) => toState(row).prefs.autoMuck?.[0] === true;

const seatedTables = async (c: Context<AppEnv>, id: string) =>
  (await c.env.DB.prepare(`SELECT COUNT(DISTINCT table_id) AS n FROM table_sessions WHERE user_id = ?1 AND status = 'seated'`).bind(id).first<{ n: number }>())?.n ?? 0;

/** The message to the member, written only when the change it tells of was (the row carries this request's marks). */
function noticeStatement(db: D1Database, id: string, kind: 'settingsReset' | 'settingsRestored', sender: string, at: number, mark: string) {
  const ko = notices('ko')[kind]();
  const en = notices('en')[kind]();
  return db
    .prepare(
      `INSERT INTO messages (id, user_id, category, title, body, sender_id, created_at)
       SELECT lower(hex(randomblob(16))), id, 'admin', CASE WHEN locale = 'en' THEN ?3 ELSE ?4 END, CASE WHEN locale = 'en' THEN ?5 ELSE ?6 END, ?2, ?7
         FROM users WHERE id = ?1 AND status != 'deleted' AND EXISTS (SELECT 1 FROM user_settings WHERE user_id = ?1 AND ${mark})`,
    )
    .bind(id, sender, en.title, ko.title, en.body, ko.body, at);
}

export const adminSettingsRoutes = new Hono<AppEnv>()
  .get('/users/:id/settings', async (c) => c.json((await load(c, c.req.param('id'))).diag))
  /**
   * Resets the member's synced settings and favourite tables to the defaults. `preview`: what it covers and what
   * follows, before the reason is typed. 409 settings_already_reset when the last reset still stands and nothing changed
   * since; 409 settings_changed when the revision moved on.
   */
  .post('/users/:id/settings/reset', async (c) => {
    const id = c.req.param('id');
    const preview = await isPreview(c);
    const body = await parseBody(c, preview ? PreviewSchema : ActionSchema);
    const { member, row, diag, now } = await load(c, id);
    guard(c, id, member);
    if (row && row.reset_rev !== null && row.reset_rev === row.rev) fail(409, 'settings_already_reset', 'these settings were reset and have not changed since', { settings: diag });
    if (body.rev !== diag.rev) fail(409, 'settings_changed', 'the settings changed since they were opened', { settings: diag });
    const tables = await seatedTables(c, id);
    if (preview) return c.json({ preview: true, settings: diag, seatedTables: tables, restorableMs: SETTINGS_RESTORE_MS });
    const { reason } = ActionSchema.parse(body);
    const admin = c.var.user!.id;
    const s = toState(row);
    const kept = Object.keys(s.prefs).length || Object.keys(s.fav).length ? JSON.stringify({ prefs: s.prefs, fav: s.fav }) : null;
    const db = c.env.DB;
    const [up] = await db.batch([
      db
        .prepare(
          `INSERT INTO user_settings (user_id, prefs, fav, rev, epoch, schema_version, created_at, updated_at, reset_at, reset_by, reset_rev, prev, restored_at)
           SELECT ?1, '{}', '{}', ?2 + 1, ?3 + 1, ?7, ?4, ?4, ?4, ?5, ?2 + 1, ?6, NULL
           WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1 AND status != 'deleted')
           ON CONFLICT (user_id) DO UPDATE SET
             prefs = '{}', fav = '{}', rev = excluded.rev, epoch = excluded.epoch, updated_at = excluded.updated_at,
             reset_at = excluded.reset_at, reset_by = excluded.reset_by, reset_rev = excluded.reset_rev, prev = excluded.prev, restored_at = NULL
           WHERE user_settings.rev = ?2 AND user_settings.epoch = ?3
           RETURNING rev, epoch`,
        )
        .bind(id, s.rev, s.epoch, now, admin, kept, SETTINGS_SCHEMA_VERSION),
      noticeStatement(db, id, 'settingsReset', admin, now, `rev = ${s.rev + 1} AND reset_at = ?7 AND reset_by = ?2`),
    ]);
    const done = (up!.results as { rev: number; epoch: number }[])[0];
    if (!done) fail(409, 'settings_changed', 'the settings changed while resetting', { settings: (await load(c, id)).diag });
    await countSettings(db, { ss_reset: 1 }, now);
    // The tables the member sits at take on the default auto-muck (off) when theirs was on.
    const muck = muckOf(row) ? await pushMuckEverywhere(c.env, id, false, done.rev) : null;
    await audit(c, 'settings.reset', { type: 'user', id }, {
      reason,
      before: { rev: s.rev, epoch: s.epoch, fields: diag.fields, favourites: diag.favourites },
      after: { rev: done.rev, epoch: done.epoch, fields: 0, favourites: 0 },
      restorable: kept !== null,
      muck,
    });
    return c.json({ ok: true, settings: (await load(c, id)).diag, muck });
  })
  /**
   * Undoes the last reset: the settings and favourite tables from before it come back, under a new epoch. Only within
   * SETTINGS_RESTORE_MS and while the member changed nothing since (409 settings_not_restorable otherwise).
   */
  .post('/users/:id/settings/restore', async (c) => {
    const id = c.req.param('id');
    const preview = await isPreview(c);
    const body = await parseBody(c, preview ? PreviewSchema : ActionSchema);
    const { member, row, diag, now } = await load(c, id);
    guard(c, id, member);
    if (body.rev !== diag.rev) fail(409, 'settings_changed', 'the settings changed since they were opened', { settings: diag });
    const info = resetInfo(row, now);
    if (!row || !info?.restorableUntil) fail(409, 'settings_not_restorable', 'there is no reset that can be undone', { settings: diag });
    const snap = JSON.parse(row.prev!) as { prefs?: unknown; fav?: unknown };
    const prefs = parsePrefs(JSON.stringify(snap.prefs ?? {}));
    const fav = parseFav(JSON.stringify(snap.fav ?? {}));
    const scope = { fields: Object.keys(prefs).length, favourites: favList(fav).length };
    if (preview) return c.json({ preview: true, settings: diag, restore: scope, seatedTables: await seatedTables(c, id) });
    const { reason } = ActionSchema.parse(body);
    const admin = c.var.user!.id;
    const db = c.env.DB;
    const [up] = await db.batch([
      db
        .prepare(
          `UPDATE user_settings SET prefs = ?2, fav = ?3, rev = rev + 1, epoch = epoch + 1, updated_at = ?4, reset_rev = NULL, prev = NULL, restored_at = ?4
            WHERE user_id = ?1 AND rev = ?5 AND epoch = ?6 AND reset_rev = rev AND prev IS NOT NULL
              AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND status != 'deleted')
            RETURNING rev, epoch`,
        )
        .bind(id, JSON.stringify(prefs), JSON.stringify(fav), now, row.rev, row.epoch),
      noticeStatement(db, id, 'settingsRestored', admin, now, `rev = ${row.rev + 1} AND restored_at = ?7`),
    ]);
    const done = (up!.results as { rev: number; epoch: number }[])[0];
    if (!done) fail(409, 'settings_changed', 'the settings changed while restoring', { settings: (await load(c, id)).diag });
    await countSettings(db, { ss_restore: 1 }, now);
    const on = prefs.autoMuck?.[0] === true;
    const muck = on !== muckOf(row) ? await pushMuckEverywhere(c.env, id, on, done.rev) : null;
    await audit(c, 'settings.restore', { type: 'user', id }, {
      reason,
      resetAt: info.at,
      before: { rev: row.rev, epoch: row.epoch, fields: 0, favourites: 0 },
      after: { rev: done.rev, epoch: done.epoch, ...scope },
      muck,
    });
    return c.json({ ok: true, settings: (await load(c, id)).diag, muck });
  });
