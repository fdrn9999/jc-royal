import type { ReportDto, ReportReason, ReportStatus, ReportTarget } from '@jc/types';
import { Badge, Button, Empty, formatDate, Input, Panel } from '@jc/ui';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useT, type Key } from '../i18n';
import { contentStatusLabel, userStatusLabel } from '../labels';
import { errText, useAdmin, useData } from '../lib';


export const REASON: Record<ReportReason, Key> = { spam: 'reasonSpam', abuse: 'reasonAbuse', inappropriate: 'reasonInappropriate', cheating: 'reasonCheating', other: 'reasonOther' };
const TARGET: Record<ReportTarget, Key> = { post: 'targetPost', comment: 'targetComment', player: 'targetPlayer', dm: 'targetDm' };
export const STATUS: Record<ReportStatus, Key> = { open: 'statusOpen', resolved: 'statusResolved', dismissed: 'statusDismissed' };

/** What the server captured when the report was filed. */
function Evidence({ r }: { r: ReportDto }) {
  const { t, locale } = useT();
  const ctx = r.context;
  if (!ctx) return <p className="text-xs text-ink-400">{t('none')}</p>;
  if (ctx.kind === 'dm') {
    return (
      <div className="flex flex-col gap-2 text-sm" data-testid="report-dm">
        <div className="text-xs text-ink-400">
          {t('dmParties')}:{' '}
          <Link to={`/users/${ctx.senderId}`} className="text-gold-300 hover:underline">{r.target.nickname}</Link> →{' '}
          <Link to={`/users/${ctx.recipientId}`} className="text-ink-100 hover:underline">{ctx.recipientId === r.reporter.id ? r.reporter.nickname : ctx.recipientId}</Link>
        </div>
        <div>
          <div className="mb-1 text-xs text-ink-400">{t('dmMessage')} · {formatDate(ctx.at, locale)}</div>
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-ink-950/60 p-2 text-ink-100" data-testid="report-content">{ctx.body}</p>
        </div>
        {ctx.earlier.length > 0 && (
          <div>
            <div className="mb-1 text-xs text-ink-400">{t('dmEarlier')}</div>
            <ul className="flex flex-col gap-0.5 rounded bg-ink-950/60 p-2 text-xs">
              {ctx.earlier.map((m) => (
                <li key={m.id} className="break-words">
                  <span className="mr-2 font-mono text-ink-400">{formatDate(m.at, locale)}</span>
                  {m.body}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
  if (ctx.kind === 'player') {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <Link to={`/tables/${ctx.tableId}`} className="text-gold-300 hover:underline">{ctx.tableName || ctx.tableId}</Link>
          {ctx.handId && ctx.handNumber !== null && (
            <Link to={`/hands/${ctx.handId}`} className="text-gold-300 hover:underline" data-testid="report-hand">{t('handN', { n: ctx.handNumber })}</Link>
          )}
          {ctx.basis && <Badge tone={ctx.basis === 'present' ? 'green' : 'blue'}>{t(ctx.basis === 'present' ? 'basisPresent' : 'basisHistory')}</Badge>}
        </div>
        {ctx.overlap && (
          <div className="text-xs text-ink-300" data-testid="report-overlap">
            {t('overlap')}: {formatDate(ctx.overlap.from, locale)} – {formatDate(ctx.overlap.to, locale)}
          </div>
        )}
        {ctx.sharedHands && ctx.sharedHands.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="text-ink-400">{t('sharedHands')}:</span>
            {ctx.sharedHands.map((h) => (
              <Link key={h.id} to={`/hands/${h.id}`} className="text-gold-300 hover:underline">#{h.number}</Link>
            ))}
          </div>
        )}
        <div>
          <div className="mb-1 text-xs text-ink-400">{t('recentChat')}</div>
          {ctx.chat.length === 0 ? (
            <p className="text-xs text-ink-400">{t('none')}</p>
          ) : (
            <ul className="flex flex-col gap-0.5 rounded bg-ink-950/60 p-2 text-xs" data-testid="report-chat">
              {ctx.chat.map((l, i) => (
                <li key={i} className="break-words">
                  <span className="mr-2 font-mono text-ink-400">{formatDate(l.at, locale)}</span>
                  {l.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 rounded bg-ink-950/60 p-2 text-sm">
      {ctx.kind === 'post' && <div className="font-semibold text-ivory">{ctx.title}</div>}
      <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-ink-100" data-testid="report-content">{ctx.body}</p>
      {r.contentStatus && (
        <div className="text-xs text-ink-400">
          {t('contentNow')}: <Badge tone={r.contentStatus === 'visible' ? 'green' : 'red'}>{contentStatusLabel(t, r.contentStatus)}</Badge>
        </div>
      )}
    </div>
  );
}

function ReportItem({ r, onDone }: { r: ReportDto; onDone: (msg: string) => void }) {
  const { t, locale } = useT();
  const { api } = useAdmin();
  const [note, setNote] = useState('');
  const [hide, setHide] = useState(false);
  const [busy, setBusy] = useState(false);
  const canHide = r.targetType !== 'player' && r.contentStatus === 'visible';
  async function close(status: 'resolved' | 'dismissed') {
    setBusy(true);
    try {
      const res = await api<{ closed: number }>(`/api/admin/reports/${r.id}`, { body: { status, note: note.trim() || undefined, hideContent: canHide && hide && status === 'resolved' ? true : undefined } });
      onDone(t('reportsClosed', { n: res.closed }));
    } catch (e) {
      onDone(errText(e, t));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="flex flex-col gap-3 py-4" data-testid="report-item">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="blue">{t(TARGET[r.targetType])}</Badge>
        <Badge tone="gold">{t(REASON[r.reason])}</Badge>
        <Badge tone={r.status === 'open' ? 'red' : r.status === 'resolved' ? 'green' : 'neutral'}>{t(STATUS[r.status])}</Badge>
        <span className="ml-auto text-xs text-ink-400">{t('receivedAt')} {formatDate(r.createdAt, locale)}</span>
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-ink-400">{t('reportedUser')}</dt>
          <dd className="flex items-center gap-1.5">
            <Link to={`/users/${r.target.id}`} className="font-semibold text-gold-300 hover:underline">{r.target.nickname}</Link>
            {r.target.status !== 'active' && <Badge tone="red">{userStatusLabel(t, r.target.status)}</Badge>}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-ink-400">{t('reporter')}</dt>
          <dd><Link to={`/users/${r.reporter.id}`} className="text-ink-100 hover:underline">{r.reporter.nickname}</Link></dd>
        </div>
      </dl>
      {r.priorReports.total > 0 && (
        <Link to={`/reports?status=all&userId=${r.target.id}`} className="self-start text-xs text-[#f0a0a2] hover:underline" data-testid="report-prior">
          {t('priorReports', { total: r.priorReports.total, resolved: r.priorReports.resolved })}
        </Link>
      )}
      {r.detail && <p className="whitespace-pre-wrap break-words border-l-2 border-gold-500/40 pl-3 text-sm text-ink-100">{r.detail}</p>}
      <div>
        <div className="mb-1 text-xs font-semibold text-ink-300">{t('evidence')}</div>
        <Evidence r={r} />
      </div>
      {r.status === 'open' ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={t('noteOptional')} aria-label={t('note')} />
          {canHide && (
            <label className="flex shrink-0 items-center gap-1.5 text-sm">
              <input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} data-testid="report-hide" />
              {t('hideContent')}
            </label>
          )}
          <div className="flex shrink-0 gap-2">
            <Button size="sm" onClick={() => close('resolved')} loading={busy} data-testid="report-resolve">{t('resolve')}</Button>
            <Button size="sm" variant="outline" onClick={() => close('dismissed')} disabled={busy} data-testid="report-dismiss">{t('dismiss')}</Button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-ink-400">
          {t('handledBy', { name: r.handledBy?.nickname ?? '—', time: r.handledAt ? formatDate(r.handledAt, locale) : '—' })}
          {r.note && <span className="ml-2 text-ink-200">· {r.note}</span>}
        </p>
      )}
    </li>
  );
}

export function ReportsPage() {
  const { t } = useT();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'open';
  const userId = params.get('userId');
  const reporterId = params.get('reporterId');
  const q = new URLSearchParams({ status, ...(userId ? { userId } : {}), ...(reporterId ? { reporterId } : {}) });
  const { data, error, reload } = useData<{ items: ReportDto[]; openCount: number }>(`/api/admin/reports?${q}`);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v === null) next.delete(k);
    else next.set(k, v);
    setParams(next);
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-extrabold">{t('reports')}</h1>
        {data && <Badge tone={data.openCount ? 'red' : 'neutral'}>{t('openReports', { n: data.openCount })}</Badge>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {userId && (
            <button className="rounded-full bg-gold-500/15 px-3 py-1 text-xs font-semibold text-gold-300" onClick={() => set('userId', null)} data-testid="report-user-filter">
              {t('reportedUser')}: {data?.items[0]?.target.nickname ?? userId} ✕
            </button>
          )}
          {reporterId && (
            <button className="rounded-full bg-gold-500/15 px-3 py-1 text-xs font-semibold text-gold-300" onClick={() => set('reporterId', null)} data-testid="report-reporter-filter">
              {t('reporterFilter')}: {data?.items[0]?.reporter.nickname ?? reporterId} ✕
            </button>
          )}
          <select value={status} onChange={(e) => set('status', e.target.value)} className="h-10 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm" aria-label={t('status')} data-testid="report-status">
            <option value="open">{t('statusOpen')}</option>
            <option value="resolved">{t('statusResolved')}</option>
            <option value="dismissed">{t('statusDismissed')}</option>
            <option value="all">{t('statusAll')}</option>
          </select>
        </div>
      </div>
      {msg && <p className="text-sm text-gold-300" role="status">{msg}</p>}
      {error && <Empty>{error}</Empty>}
      <Panel>
        {data && data.items.length === 0 ? (
          <Empty>{t('noReports')}</Empty>
        ) : (
          <ul className="divide-y divide-white/5">
            {data?.items.map((r) => (
              <ReportItem
                key={r.id}
                r={r}
                onDone={(m) => {
                  setMsg(m);
                  void reload();
                }}
              />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
