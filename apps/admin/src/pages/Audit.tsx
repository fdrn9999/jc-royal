/**
 * The audit log: every administrator action, refused and failed attempts too, newest first. Filters live in the URL
 * (a link from a member or table opens it filtered); pages follow a cursor (the last entry's time and id), and the
 * first page counts the matches up to the API's cap. Plain administrators see their own entries (`audit.all`).
 */
import { Badge, Button, Empty, formatDate, Input, Panel } from '@jc/ui';
import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useT } from '../i18n';
import { AUDIT_FAMILIES, auditActionLabel, auditFamilyLabel, roleLabel, targetTypeLabel } from '../labels';
import { useData } from '../lib';
import { dayStart } from '../ui';
import { Table } from './Console';

interface AuditItem {
  id: string;
  action: string;
  outcome: 'ok' | 'failed';
  createdAt: number;
  actor: { id: string; nickname: string | null; role: string | null };
  target: { type: string; id: string | null; label: string | null } | null;
  detail: unknown;
  ip: string | null;
}
interface AuditPageDto {
  items: AuditItem[];
  nextBefore: number | null;
  nextBeforeId: string | null;
  /** First page only. */
  total?: number;
  totalCapped?: boolean;
  scope: 'all' | 'own';
  countCap: number;
}
type Cursor = { at: number; id: string };

const PAGE = 50;
const selectCls = 'h-10 rounded-lg border border-white/10 bg-ink-850 px-3 text-sm';
const chipCls = 'rounded-full bg-gold-500/15 px-3 py-1 text-xs font-semibold text-gold-300';
const TARGET_TYPES = ['user', 'table', 'hand', 'report', 'post', 'comment', 'notice', 'maintenance', 'reconciliation', 'batch', 'session'] as const;
const FILTER_KEYS = ['actor', 'action', 'outcome', 'targetType', 'targetId', 'from', 'to', 'q'] as const;

function detailText(d: unknown): string {
  if (d === null || d === undefined) return '';
  return typeof d === 'string' ? d : JSON.stringify(d);
}

export function AuditPage() {
  const { t, locale } = useT();
  const [params, setParams] = useSearchParams();
  const filterKey = FILTER_KEYS.map((k) => `${k}=${params.get(k) ?? ''}`).join('&');
  // Pages already passed, for "previous"; a new search starts again from the newest.
  const [pages, setPages] = useState<{ key: string; stack: Cursor[] }>({ key: filterKey, stack: [] });
  const stack = pages.key === filterKey ? pages.stack : [];
  const [count, setCount] = useState<{ key: string; total: number; capped: boolean } | null>(null);
  const [text, setText] = useState(params.get('q') ?? '');
  const [open, setOpen] = useState<string | null>(null);

  const q = new URLSearchParams({ paged: '1', limit: String(PAGE) });
  for (const k of ['actor', 'action', 'outcome', 'targetType', 'targetId'] as const) if (params.get(k)) q.set(k, params.get(k)!);
  const from = dayStart(params.get('from'));
  const to = dayStart(params.get('to'), true);
  if (from) q.set('from', String(from));
  if (to) q.set('to', String(to));
  const search = (params.get('q') ?? '').trim();
  if (search.length >= 2) q.set('q', search);
  const cur = stack[stack.length - 1];
  if (cur) {
    q.set('before', String(cur.at));
    q.set('beforeId', cur.id);
  }
  const { data, error, loading } = useData<AuditPageDto>(`/api/admin/audit?${q}`);
  const all = data?.scope === 'all';
  const { data: staff } = useData<{ items: { id: string; nickname: string; role: string }[] }>(all ? '/api/admin/reports/assignees' : null);

  // The count comes with the first page; later pages keep showing it. Only a newly arrived page counts: right after a
  // filter change the previous filter's page is still shown and must not be taken for the new one.
  const seen = useRef<AuditPageDto | null>(null);
  useEffect(() => {
    if (!data || data === seen.current) return;
    seen.current = data;
    if (data.total !== undefined) setCount({ key: filterKey, total: data.total, capped: !!data.totalCapped });
  }, [data, filterKey]);
  useEffect(() => setText(params.get('q') ?? ''), [params]);

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next);
    setOpen(null);
  };
  const reset = () => {
    const next = new URLSearchParams(params);
    for (const k of FILTER_KEYS) next.delete(k);
    setParams(next);
    setOpen(null);
  };
  const action = params.get('action') ?? '';
  const family = action.endsWith('.*') ? action : '';
  const actor = params.get('actor') ?? '';
  const targetId = params.get('targetId');
  const filtered = FILTER_KEYS.some((k) => params.get(k));
  const actorName = (id: string) => staff?.items.find((s) => s.id === id)?.nickname ?? data?.items.find((a) => a.actor.id === id)?.actor.nickname ?? id;
  const targetName = data?.items.find((a) => a.target?.id === targetId)?.target?.label ?? targetId;
  const shown = data?.items.length ?? 0;
  const first = stack.length * PAGE + 1;
  const total = count?.key === filterKey ? count : null;
  const textShort = text.trim().length === 1;

  return (
    <div className="flex flex-col gap-4" data-testid="audit-page">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-extrabold">{t('audit')}</h1>
        {data && <span data-testid="audit-scope"><Badge tone={all ? 'gold' : 'neutral'}>{all ? t('auditScopeAll') : t('auditScopeOwn')}</Badge></span>}
      </div>
      {data?.scope === 'own' && <p className="text-xs text-ink-400">{t('auditOwnNote')}</p>}
      <div className="flex flex-col gap-2">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!textShort) set({ q: text.trim() || null });
          }}
        >
          <Input className="min-w-0 flex-1 basis-56" placeholder={t('auditSearch')} aria-label={t('auditSearch')} value={text} maxLength={50} onChange={(e) => setText(e.target.value)} data-testid="audit-q" />
          <Button type="submit" variant="subtle" disabled={textShort}>{t('searchBtn')}</Button>
        </form>
        {textShort && <p className="text-xs text-ink-400">{t('auditSearchMin')}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <select value={family} onChange={(e) => set({ action: e.target.value })} className={selectCls} aria-label={t('auditFamily')} data-testid="audit-family">
            <option value="">{t('auditFamily')}: {t('statusAll')}</option>
            {AUDIT_FAMILIES.map((f) => <option key={f} value={`${f}.*`}>{t('auditFamily')}: {auditFamilyLabel(t, f)}</option>)}
          </select>
          <select value={params.get('outcome') ?? ''} onChange={(e) => set({ outcome: e.target.value })} className={selectCls} aria-label={t('auditOutcome')} data-testid="audit-outcome">
            <option value="">{t('auditOutcome')}: {t('statusAll')}</option>
            <option value="ok">{t('auditOutcome')}: {t('outcomeOk')}</option>
            <option value="failed">{t('auditOutcome')}: {t('outcomeFailed')}</option>
          </select>
          <select value={params.get('targetType') ?? ''} onChange={(e) => set({ targetType: e.target.value, targetId: null })} className={selectCls} aria-label={t('target')} data-testid="audit-target-type">
            <option value="">{t('target')}: {t('statusAll')}</option>
            {TARGET_TYPES.map((v) => <option key={v} value={v}>{t('target')}: {targetTypeLabel(t, v)}</option>)}
          </select>
          {all && (
            <select value={staff?.items.some((s) => s.id === actor) ? actor : ''} onChange={(e) => set({ actor: e.target.value })} className={selectCls} aria-label={t('actor')} data-testid="audit-actor">
              <option value="">{t('actor')}: {t('statusAll')}</option>
              {staff?.items.map((s) => <option key={s.id} value={s.id}>{t('actor')}: {s.nickname}</option>)}
            </select>
          )}
          <label className="flex items-center gap-1 text-xs text-ink-300">
            {t('auditFrom')}
            <input type="date" className={selectCls} value={params.get('from') ?? ''} max={params.get('to') ?? undefined} onChange={(e) => set({ from: e.target.value })} data-testid="audit-from" />
          </label>
          <label className="flex items-center gap-1 text-xs text-ink-300">
            {t('auditTo')}
            <input type="date" className={selectCls} value={params.get('to') ?? ''} min={params.get('from') ?? undefined} onChange={(e) => set({ to: e.target.value })} data-testid="audit-to" />
          </label>
        </div>
        {(action && !family) || targetId || (actor && !staff?.items.some((s) => s.id === actor)) || filtered ? (
          <div className="flex flex-wrap items-center gap-2">
            {action && !family && (
              <button className={chipCls} onClick={() => set({ action: null })} data-testid="audit-action-chip">
                {t('action')}: {auditActionLabel(t, action)} ✕
              </button>
            )}
            {targetId && (
              <button className={chipCls} onClick={() => set({ targetId: null })} data-testid="audit-target-chip">
                {t('target')}: {targetTypeLabel(t, params.get('targetType'))} {targetName} ✕
              </button>
            )}
            {actor && !staff?.items.some((s) => s.id === actor) && (
              <button className={chipCls} onClick={() => set({ actor: null })} data-testid="audit-actor-chip">
                {t('actor')}: {actorName(actor)} ✕
              </button>
            )}
            {filtered && <Button size="sm" variant="ghost" onClick={reset} data-testid="audit-reset">{t('auditReset')}</Button>}
          </div>
        ) : null}
      </div>
      {error && <Empty>{error}</Empty>}
      <Panel className={loading ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
        {data && shown === 0 ? (
          <Empty>{t('auditEmpty')}</Empty>
        ) : (
          <Table stack head={[t('time'), t('actor'), t('action'), t('target'), t('colDetail'), t('colIp')]}>
            {data?.items.map((a) => {
              const d = detailText(a.detail);
              const expanded = open === a.id;
              return (
                <Fragment key={a.id}>
                  <tr className={`max-sm:grid max-sm:grid-cols-2 max-sm:py-1.5 ${a.outcome === 'failed' ? 'bg-danger/5' : ''}`} data-testid="audit-row">
                    <td className="whitespace-nowrap px-2 py-1.5 text-xs text-ink-400 max-sm:py-0.5">{formatDate(a.createdAt, locale)}</td>
                    <td className="px-2 py-1.5 max-sm:py-0.5 max-sm:text-right">
                      {all ? (
                        <button className="text-left hover:underline" onClick={() => set({ actor: a.actor.id })} title={t('auditOnlyThis')}>{a.actor.nickname ?? a.actor.id}</button>
                      ) : (
                        <span>{a.actor.nickname ?? a.actor.id}</span>
                      )}
                      {a.actor.role && a.actor.role !== 'user' && <span className="block text-[10px] text-ink-400">{roleLabel(t, a.actor.role)}</span>}
                    </td>
                    <td className="px-2 py-1.5 text-xs max-sm:col-span-2 max-sm:py-0.5">
                      <span className="flex flex-wrap items-center gap-1">
                        <button className="text-left hover:underline" onClick={() => set({ action: a.action })} title={t('auditOnlyThis')}>{auditActionLabel(t, a.action)}</button>
                        {a.outcome === 'failed' && <Badge tone="red">{t('outcomeFailed')}</Badge>}
                      </span>
                      <span className="font-mono text-[10px] text-ink-400">{a.action}</span>
                    </td>
                    <td className="px-2 py-1.5 text-xs max-sm:col-span-2 max-sm:py-0.5">
                      {a.target ? (
                        <>
                          <span className="text-ink-400">{targetTypeLabel(t, a.target.type)}</span>{' '}
                          {a.target.id ? (
                            <button className="break-all text-left hover:underline" onClick={() => set({ targetType: a.target!.type, targetId: a.target!.id })} title={t('auditOnlyThis')}>
                              {a.target.label ?? <span className="font-mono">{a.target.id}</span>}
                            </button>
                          ) : null}
                          {a.target.id && (a.target.type === 'user' || a.target.type === 'table') && (
                            <Link to={`/${a.target.type === 'user' ? 'users' : 'tables'}/${a.target.id}`} className="ml-1 text-gold-300" aria-label={t('detail')}>→</Link>
                          )}
                        </>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </td>
                    <td className="max-w-[18rem] px-2 py-1.5 max-sm:col-span-2 max-sm:max-w-none max-sm:py-0.5">
                      {d && (
                        <button className="block w-full truncate text-left font-mono text-[11px] text-ink-300 hover:text-ink-100" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : a.id)} data-testid="audit-detail-toggle">
                          {d}
                        </button>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-xs max-sm:col-span-2 max-sm:py-0.5 max-sm:text-[10px] max-sm:text-ink-400">{a.ip}</td>
                  </tr>
                  {expanded && (
                    <tr className="max-sm:block">
                      <td colSpan={6} className="px-2 pb-3 max-sm:block">
                        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-ink-950/70 p-3 font-mono text-[11px] text-ink-200" data-testid="audit-detail">
                          {typeof a.detail === 'string' ? a.detail : JSON.stringify(a.detail, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </Table>
        )}
        {data && (shown > 0 || stack.length > 0) && (
          <nav className="mt-3 flex flex-wrap items-center justify-end gap-2" aria-label={t('audit')} data-testid="audit-pager">
            <span className="mr-auto text-xs text-ink-400" aria-live="polite">
              {total
                ? t(total.capped ? 'auditRangeCapped' : 'auditRange', { from: first, to: first + shown - 1, total: total.total })
                : t('auditRangeNoTotal', { from: first, to: first + shown - 1 })}
            </span>
            <Button size="sm" variant="outline" disabled={stack.length === 0 || loading} onClick={() => setPages({ key: filterKey, stack: stack.slice(0, -1) })} data-testid="audit-prev">{t('prevPage')}</Button>
            <Button
              size="sm"
              variant="outline"
              disabled={data.nextBefore === null || !data.nextBeforeId || loading}
              onClick={() => setPages({ key: filterKey, stack: [...stack, { at: data.nextBefore!, id: data.nextBeforeId! }] })}
              data-testid="audit-next"
            >
              {t('nextPage')}
            </Button>
          </nav>
        )}
      </Panel>
    </div>
  );
}
