/**
 * Integrity signs: pairs of members whose cash-table hands together look like chips passed on purpose, highest band
 * first, each with the hands to look at. A sign is a case for an operator, never a finding: opening a review files a
 * report in the queue with the evidence, and anything that follows is decided there by an administrator who read it.
 */
import { INTEGRITY_DAYS, type IntegrityDto, type IntegrityRisk, type IntegritySignal, type ReportContext } from '@jc/types';
import { Badge, Button, Empty, formatChips, formatDate, Panel } from '@jc/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { REASONS } from '../adminTemplates';
import { useT, type Key } from '../i18n';
import { userStatusLabel } from '../labels';
import { ApiError, errText, useAdmin, useData } from '../lib';
import { AdminReasonField } from '../templateFields';
import { Feedback, LoadError, Modal, type Note } from '../ui';

export const SIGNAL: Record<IntegritySignal, Key> = { flow: 'sigFlow', dumps: 'sigDumps', network: 'sigNetwork' };
export const RISK: Record<IntegrityRisk, Key> = { low: 'riskLow', medium: 'riskMedium', high: 'riskHigh' };
export const RISK_TONE: Record<IntegrityRisk, 'neutral' | 'gold' | 'red'> = { low: 'neutral', medium: 'gold', high: 'red' };

type Pair = IntegrityDto['pairs'][number];
type Member = Pair['fromUser'];

function Who({ m }: { m: Member }) {
  const { t } = useT();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Link to={`/users/${m.id}`} className="font-semibold text-gold-300 hover:underline">{m.nickname ?? m.id}</Link>
      {m.status && m.status !== 'active' && <Badge tone="red">{userStatusLabel(t, m.status)}</Badge>}
      {m.openReports > 0 && (
        <Link to={`/reports?userId=${m.id}`} className="text-xs text-ink-300 hover:underline">{t('integrityOpenReports', { n: m.openReports })}</Link>
      )}
    </span>
  );
}

export function IntegritySignals() {
  const { t, locale } = useT();
  const { api } = useAdmin();
  const [days, setDays] = useState<(typeof INTEGRITY_DAYS)[number]>(INTEGRITY_DAYS[0]);
  const { data, error, loading, reload } = useData<IntegrityDto>(`/api/admin/integrity?days=${days}`);
  const [review, setReview] = useState<{ pair: Pair; reason: string; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Note>(null);
  const confirm = async () => {
    if (!review) return;
    setBusy(true);
    try {
      await api(`/api/admin/integrity/review`, { body: { from: review.pair.from, to: review.pair.to, days, reason: review.reason.trim() } });
      setMsg({ ok: true, text: t('integrityOpened', { name: review.pair.toUser.nickname ?? review.pair.to }) });
      setReview(null);
      void reload();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'reauth_cancelled')) setReview({ ...review, error: errText(e, t) });
    } finally {
      setBusy(false);
    }
  };
  const th = data?.thresholds;
  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1" role="group" aria-label={t('econPeriod')}>
        {INTEGRITY_DAYS.map((n) => (
          <Button key={n} size="sm" variant={days === n ? 'gold' : 'outline'} aria-pressed={days === n} onClick={() => setDays(n)} data-testid={`integrity-days-${n}`}>
            {t('daysN', { n })}
          </Button>
        ))}
      </div>
      <Button size="sm" variant="subtle" onClick={() => void reload()} loading={loading}>{t('refresh')}</Button>
    </div>
  );
  if (error) return <div className="flex flex-col gap-4">{header}<LoadError error={error} onRetry={reload} /></div>;
  if (!data || !th) return <div className="flex flex-col gap-4">{header}<Empty>{t('loading')}</Empty></div>;
  return (
    <div className={`flex flex-col gap-4 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading} data-testid="integrity-signals">
      {header}
      <div className="flex flex-col gap-1 text-xs text-ink-400">
        <p>{t('integrityHint')}</p>
        <p>{t('integrityRules', { shared: th.minShared, flow: th.minFlowBb, pct: Math.round(th.oneWay * 100), dump: th.dumpBb, dumps: th.minDumps })}</p>
        {data.capped && <p className="text-gold-300" data-testid="integrity-capped">{t('integrityCapped', { from: formatDate(data.from, locale) })}</p>}
        {data.found > data.pairs.length && (
          <p className="text-gold-300" data-testid="integrity-more">{t('integrityMore', { shown: formatChips(data.pairs.length), n: formatChips(data.found) })}</p>
        )}
      </div>
      <Feedback note={msg} pin />
      <Panel>
        {data.pairs.length === 0 ? (
          <Empty>{t('integrityNone')}</Empty>
        ) : (
          <ul className="divide-y divide-white/5">
            {data.pairs.map((p) => (
              <li key={`${p.from} ${p.to}`} className="flex flex-col gap-2 py-3" data-testid="integrity-pair">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={RISK_TONE[p.risk]}>{t(RISK[p.risk])}</Badge>
                  {p.signals.map((s) => <Badge key={s} tone="blue">{t(SIGNAL[s])}</Badge>)}
                  <span className="ml-auto">
                    {p.review ? (
                      <Link to={`/reports?userId=${p.to}`} className="text-sm text-gold-300 hover:underline" data-testid="integrity-reviewing">{t('integrityReviewing')}</Link>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => setReview({ pair: p, reason: '', error: null })} data-testid="integrity-review">{t('integrityReview')}</Button>
                    )}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <Who m={p.fromUser} />
                  <span className="text-ink-400" aria-label={t('integrityTo')}>→</span>
                  <Who m={p.toUser} />
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                  <div><dt className="text-ink-400">{t('integrityShared')}</dt><dd className="font-mono">{formatChips(p.shared)}</dd></div>
                  <div><dt className="text-ink-400">{t('integrityFlow')}</dt><dd className="font-mono">{p.flowBb} BB</dd></div>
                  <div><dt className="text-ink-400">{t('integrityOneWay')}</dt><dd className="font-mono">{Math.round(p.oneWay * 100)}%</dd></div>
                  <div><dt className="text-ink-400">{t('integrityDumps')}</dt><dd className="font-mono">{formatChips(p.dumps)}</dd></div>
                </dl>
                {p.hands.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span className="text-ink-400">{t('integrityHands')}:</span>
                    {p.hands.map((h) => (
                      <Link key={h.id} to={`/hands/${h.id}`} className="text-gold-300 hover:underline" data-testid="integrity-hand">
                        #{h.handNumber} <span className="font-mono text-ink-300">{h.bb} BB{h.dump ? ` · ${t('integrityDump')}` : ''}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <p className="text-xs text-ink-400">{t('integrityRead', { hands: formatChips(data.hands), rows: formatChips(data.rowsRead), ms: data.d1Ms })}</p>
      <Modal
        open={review !== null}
        onClose={() => setReview(null)}
        title={t('integrityReview')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setReview(null)}>{t('cancel')}</Button>
            <Button variant="gold" loading={busy} disabled={!review || review.reason.trim().length < 2} onClick={() => void confirm()} data-testid="integrity-review-confirm">
              {t('confirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm">
          <p>{review && t('integrityReviewConfirm', { from: review.pair.fromUser.nickname ?? review.pair.from, to: review.pair.toUser.nickname ?? review.pair.to })}</p>
          <p className="text-xs text-ink-300">{t('integrityReviewHint')}</p>
          <AdminReasonField
            label={t('reason')}
            templates={REASONS.integrity}
            value={review?.reason ?? ''}
            onChange={(v) => review && setReview({ ...review, reason: v, error: null })}
            maxLength={300}
            testid="integrity-review-reason"
          />
          {review?.error && <p className="text-xs text-danger" role="alert">{review.error}</p>}
        </div>
      </Modal>
    </div>
  );
}

/** A review's evidence in the report queue: the pair, the signs it met when opened and the hands to look at. */
export function SignalEvidence({ ctx, target }: { ctx: Extract<ReportContext, { kind: 'signal' }>; target: string }) {
  const { t, locale } = useT();
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="report-signal">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={RISK_TONE[ctx.risk]}>{t(RISK[ctx.risk])}</Badge>
        {ctx.signals.map((s) => <Badge key={s} tone="blue">{t(SIGNAL[s])}</Badge>)}
      </div>
      <div className="text-xs text-ink-300">
        <Link to={`/users/${ctx.partnerId}`} className="text-gold-300 hover:underline">{ctx.partnerNickname}</Link> → {target} · {t('daysN', { n: ctx.days })} ({formatDate(ctx.since, locale)} –)
      </div>
      <div className="text-xs text-ink-300">
        {t('integrityShared')} {formatChips(ctx.shared)} · {t('integrityFlow')} {ctx.flowBb} BB · {t('integrityOneWay')} {Math.round(ctx.oneWay * 100)}% · {t('integrityDumps')} {formatChips(ctx.dumps)}
      </div>
      {ctx.hands.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="text-ink-400">{t('integrityHands')}:</span>
          {ctx.hands.map((h) => (
            <Link key={h.id} to={`/hands/${h.id}`} className="text-gold-300 hover:underline">
              #{h.number} <span className="font-mono text-ink-300">{h.bb} BB{h.dump ? ` · ${t('integrityDump')}` : ''}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
