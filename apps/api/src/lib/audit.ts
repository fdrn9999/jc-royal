import { schema } from '@jc/db';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { HttpError, isPreview } from './http';
import { matchedRoute } from './permissions';
import { clientIp } from './rate-limit';

/** One admin_audit_log row. `failed`: an attempt that was refused or broke off. */
export async function audit(c: Context<AppEnv>, action: string, target?: { type: string; id: string }, detail?: unknown, outcome: 'ok' | 'failed' = 'ok') {
  await c.var.db.insert(schema.adminAuditLog).values({
    id: crypto.randomUUID(),
    actorId: c.var.user?.id ?? 'anonymous',
    action,
    targetType: target?.type ?? null,
    targetId: target?.id ?? null,
    detail: detail === undefined ? null : JSON.stringify(detail),
    ip: clientIp(c),
    outcome,
  });
  c.set('audited', true);
}

/** The audit page counts matches up to this many (a count over the whole log would read all of it). */
export const AUDIT_COUNT_CAP = 10_000;

export interface AuditQuery {
  actor?: string;
  /** Exact, or `family.*` for every action starting `family.`. */
  action?: string;
  outcome?: 'ok' | 'failed';
  targetType?: string;
  targetId?: string;
  from?: number;
  to?: number;
  /** Text found in the detail, or a target id. */
  q?: string;
  /** Entries older than the last one shown: its time and id (entries can share a millisecond). */
  before?: number;
  beforeId?: string;
  limit: number;
  /** Count the matches (the first page). */
  count: boolean;
}

type AuditRow = {
  id: string;
  action: string;
  outcome: 'ok' | 'failed';
  actorId: string;
  actorNickname: string | null;
  actorRole: string | null;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  detail: string | null;
  ip: string | null;
  createdAt: number;
};

/**
 * One page of the audit log, newest first by (time, id). Each filter can use an index: actor (audit_actor_idx), action
 * (audit_action_idx), failed attempts (audit_failed_idx), target (audit_target_idx), time (audit_created_idx). An
 * action family is a range on audit_action_idx, so every row of the family is read and sorted; the text search reads
 * every row in the other filters' range. A member or table target is shown by its nickname or name.
 */
export async function searchAudit(DB: D1Database, f: AuditQuery) {
  const where: string[] = [];
  const binds: unknown[] = [];
  const add = (sql: string, ...v: unknown[]) => {
    where.push(sql);
    binds.push(...v);
  };
  if (f.actor) add('a.actor_id = ?', f.actor);
  if (f.action?.endsWith('.*')) {
    // `user.*`: from 'user.' up to 'user/' ('/' follows '.'), which an index reads as one range.
    const p = f.action.slice(0, -1);
    add('a.action >= ? AND a.action < ?', p, `${p.slice(0, -1)}/`);
  } else if (f.action) add('a.action = ?', f.action);
  // Written out (not bound), so the planner can use the partial index on failed attempts.
  if (f.outcome) where.push(`a.outcome = '${f.outcome === 'failed' ? 'failed' : 'ok'}'`);
  if (f.targetType) add('a.target_type = ?', f.targetType);
  if (f.targetId) add('a.target_id = ?', f.targetId);
  if (f.from) add('a.created_at >= ?', f.from);
  if (f.to) add('a.created_at < ?', f.to);
  if (f.q) add(`(a.detail LIKE ? ESCAPE '\\' OR a.target_id = ?)`, `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`, f.q);
  const filtered = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const page = f.before !== undefined ? '(a.created_at < ? OR (a.created_at = ? AND a.id < ?))' : null;
  const pageWhere = page ? (filtered ? `${filtered} AND ${page}` : `WHERE ${page}`) : filtered;
  const pageBinds = page ? [...binds, f.before, f.before, f.beforeId ?? ''] : binds;
  const stmts = [
    DB.prepare(
      `SELECT a.id, a.action, a.outcome, a.actor_id AS actorId, u.nickname AS actorNickname, u.role AS actorRole,
              a.target_type AS targetType, a.target_id AS targetId,
              CASE a.target_type WHEN 'user' THEN tu.nickname WHEN 'table' THEN tt.name WHEN 'tournament' THEN tn.name WHEN 'tournament_template' THEN tpl.name END AS targetLabel,
              a.detail, a.ip, a.created_at AS createdAt
         FROM admin_audit_log a
         LEFT JOIN users u ON u.id = a.actor_id
         LEFT JOIN users tu ON a.target_type = 'user' AND tu.id = a.target_id
         LEFT JOIN tables tt ON a.target_type = 'table' AND tt.id = a.target_id
         LEFT JOIN tournaments tn ON a.target_type = 'tournament' AND tn.id = a.target_id
         LEFT JOIN tournament_templates tpl ON a.target_type = 'tournament_template' AND tpl.id = a.target_id
         ${pageWhere}
        ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    ).bind(...pageBinds, f.limit + 1),
  ];
  if (f.count) stmts.push(DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM admin_audit_log a ${filtered} LIMIT ${AUDIT_COUNT_CAP + 1})`).bind(...binds));
  const [list, counted] = await DB.batch(stmts);
  const rows = (list?.results ?? []) as AuditRow[];
  const items = rows.slice(0, f.limit).map((r) => {
    let detail: unknown = null;
    try {
      detail = r.detail ? JSON.parse(r.detail) : null;
    } catch {
      detail = r.detail;
    }
    return {
      id: r.id,
      action: r.action,
      outcome: r.outcome,
      createdAt: r.createdAt,
      actor: { id: r.actorId, nickname: r.actorNickname, role: r.actorRole },
      target: r.targetType ? { type: r.targetType, id: r.targetId, label: r.targetLabel } : null,
      detail,
      ip: r.ip,
    };
  });
  const last = rows.length > f.limit ? items[items.length - 1]! : null;
  const n = (counted?.results[0] as { n: number } | undefined)?.n;
  return {
    items,
    nextBefore: last?.createdAt ?? null,
    nextBeforeId: last?.id ?? null,
    ...(n === undefined ? {} : { total: Math.min(n, AUDIT_COUNT_CAP), totalCapped: n > AUDIT_COUNT_CAP }),
  };
}

/**
 * Records an administrator's attempt that did not go through, as `<action>.failed` (the action named by the route's
 * permission rule) with the status and error code: any refusal (403, including a member whose administrator role was
 * taken away: `admin.access_denied`), and any change that failed (a non-GET request answered 400 or above). Not
 * recorded: 401 (no session, or the password must be confirmed again, which the console then asks for), reads that
 * found nothing, and a request whose route already wrote its own row (e.g. `user.chips_refused`). The row keeps no
 * request body, only whether it was a preview. A failure to write the row never changes the response.
 *
 * Registered before requireAdmin, so it sees that guard's refusal too.
 */
export const auditFailures: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const status = c.res.status;
  if (!c.var.user || c.var.audited || status < 400 || status === 401) return;
  const read = c.req.method === 'GET' || c.req.method === 'HEAD';
  if (read && status !== 403) return;
  const m = matchedRoute(c);
  if (!m && status !== 403) return;
  const err = c.error instanceof HttpError ? c.error : null;
  const denied = !m?.rule || err?.message === 'not an administrator';
  const id = m?.rule?.target ? m.params.id : undefined;
  try {
    await audit(
      c,
      denied ? 'admin.access_denied' : `${m!.rule!.action}.failed`,
      m?.rule?.target && id ? { type: m.rule.target, id } : undefined,
      {
        status,
        code: err?.code ?? (status >= 500 ? 'internal' : null),
        message: err?.message ?? null,
        route: m?.key ?? `${c.req.method} ${c.req.path}`,
        ...(!read && (await isPreview(c)) ? { preview: true } : {}),
      },
      'failed',
    );
  } catch (e) {
    console.error('failure audit not written', e);
  }
};
