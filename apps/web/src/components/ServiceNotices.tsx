import type { NoticeKind } from '@jc/types';
import { useState } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../lib/i18n';
import { serverNow, useService, when } from '../lib/service';

const DAY = 86_400_000;
const HIDDEN_KEY = 'jc.notices.hidden';
const TONE: Record<NoticeKind, string> = {
  urgent: 'bg-danger/15 text-[#f3b0b2]',
  maintenance: 'bg-gold-500/15 text-gold-300',
  general: 'bg-white/[0.06] text-ink-100',
};
const ORDER: Record<NoticeKind, number> = { urgent: 0, maintenance: 1, general: 2 };

function hiddenIds(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Service notices across the top of the page, in the reader's language: maintenance under way or due within a day
 * first, then urgent, maintenance and general notices. Only general notices can be dismissed (remembered on this
 * device). `compact` (the table) shows urgent and maintenance notices only: the table shows maintenance itself.
 */
export function ServiceNotices({ compact = false, boardLinks = true }: { compact?: boolean; boardLinks?: boolean }) {
  const st = useService();
  const { t, locale } = useI18n();
  const [hidden, setHidden] = useState(hiddenIds);
  const [open, setOpen] = useState<string | null>(null);
  if (!st) return null;
  const now = serverNow();
  const en = locale === 'en';
  const rows: { id: string; tone: string; title: string; body: string | null; to?: string; close?: boolean }[] = [];
  const m = st.maintenance;
  if (m && !compact && m.endsAt > now && m.startsAt - now <= DAY) {
    rows.push({
      id: 'maintenance',
      tone: TONE.maintenance,
      title: m.startsAt <= now ? t('svc.maintNow', { end: when(m.endsAt, locale) }) : t('svc.maintSoon', { start: when(m.startsAt, locale), end: when(m.endsAt, locale) }),
      body: en ? m.messageEn : m.messageKo,
      to: '/maintenance',
    });
  }
  for (const n of [...st.notices].sort((a, b) => ORDER[a.kind] - ORDER[b.kind])) {
    // A dismissal holds only while the notice is general: one raised to urgent or maintenance shows again.
    if (n.startsAt > now || (n.endsAt !== null && n.endsAt <= now) || (n.kind === 'general' && hidden.includes(n.id)) || (compact && n.kind === 'general')) continue;
    rows.push({ id: n.id, tone: TONE[n.kind], title: en ? n.titleEn : n.titleKo, body: en ? n.bodyEn : n.bodyKo, to: boardLinks && n.postId ? `/board/${n.postId}` : undefined, close: n.kind === 'general' });
  }
  if (!rows.length) return null;
  function dismiss(id: string) {
    // Only ids still listed are kept, so the list does not grow.
    const next = [...hidden.filter((h) => st!.notices.some((n) => n.id === h)), id];
    setHidden(next);
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
    } catch {
      /* private mode: hidden for this visit only */
    }
  }
  return (
    <div role="region" aria-label={t('svc.region')} data-testid="service-banner">
      {rows.map((r) => (
        <div key={r.id} className={`flex items-start gap-2 px-4 py-2 text-sm ${r.tone}`} data-testid={`notice-${r.id}`}>
          <div className="mx-auto flex min-w-0 max-w-7xl flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <strong className="font-semibold">{r.title}</strong>
            {r.body && (
              <button type="button" className={`min-w-0 text-left opacity-90 ${open === r.id ? 'whitespace-pre-line' : 'line-clamp-1'}`} onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                {r.body}
              </button>
            )}
            {r.to && (
              <Link to={r.to} className="text-xs font-semibold underline underline-offset-2">
                {t('svc.more')}
              </Link>
            )}
          </div>
          {r.close && (
            <button type="button" className="jc-tap -my-1 shrink-0 rounded-full px-2 text-lg leading-none opacity-70 hover:opacity-100" onClick={() => dismiss(r.id)} aria-label={t('common.close')}>
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
