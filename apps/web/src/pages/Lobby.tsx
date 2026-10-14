import type { LobbyTableDto } from '@jc/types';
import { Badge, Button, Empty, Field, formatChips, Input, Modal, Spinner } from '@jc/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../lib/api';
import { useI18n, type MsgKey } from '../lib/i18n';

type Filter = 'all' | 'playing' | 'open' | 'empty' | 'hu' | 'six' | 'nine';
const FILTERS: Filter[] = ['all', 'playing', 'open', 'empty', 'hu', 'six', 'nine'];

function statusOf(t: LobbyTableDto): 'playing' | 'waiting' | 'empty' {
  if (t.playing) return 'playing';
  return t.seated > 0 ? 'waiting' : 'empty';
}

export function LobbyPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [tables, setTables] = useState<LobbyTableDto[] | null>(null);
  const [error, setError] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [codeFor, setCodeFor] = useState<{ table: LobbyTableDto; sit: boolean } | null>(null);
  const [code, setCode] = useState('');

  const load = useCallback(async () => {
    try {
      setTables(await api<LobbyTableDto[]>('/api/tables'));
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    void load();
    const h = setInterval(load, 5_000);
    return () => clearInterval(h);
  }, [load]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (tables ?? []).filter((tb) => {
      if (needle && !tb.name.toLowerCase().includes(needle) && !`${tb.smallBlind}/${tb.bigBlind}`.includes(needle)) return false;
      switch (filter) {
        case 'playing':
          return tb.playing;
        case 'open':
          return tb.seated < tb.maxSeats;
        case 'empty':
          return tb.seated === 0;
        case 'hu':
          return tb.maxSeats === 2;
        case 'six':
          return tb.maxSeats === 6;
        case 'nine':
          return tb.maxSeats === 9;
        default:
          return true;
      }
    });
  }, [tables, q, filter]);

  function open(tb: LobbyTableDto, sit: boolean) {
    if (tb.isPrivate && sit) {
      setCode('');
      setCodeFor({ table: tb, sit });
      return;
    }
    nav(`/table/${tb.id}${sit ? '?sit=1' : ''}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-[0.04em] jc-gold-text">{t('lobby.title')}</h1>
          <p className="mt-1 text-sm text-ink-300">{t('app.virtual')}</p>
        </div>
        <div className="flex gap-2">
          <Input placeholder={t('lobby.search')} value={q} onChange={(e) => setQ(e.target.value)} className="sm:w-64" aria-label={t('lobby.search')} />
          <Button variant="subtle" onClick={load} aria-label={t('lobby.refresh')}>
            ↻
          </Button>
        </div>
      </div>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={`shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition ${filter === f ? 'border-gold-500 bg-gold-500/15 text-gold-300' : 'border-white/10 text-ink-300 hover:text-ivory'}`}
          >
            {t(`lobby.filter.${f}` as MsgKey)}
          </button>
        ))}
      </div>

      {tables === null && !error && (
        <div className="flex justify-center py-16 text-gold-400">
          <Spinner />
        </div>
      )}
      {error && <Empty>{t('common.error')}</Empty>}
      {tables && shown.length === 0 && <Empty>{t('lobby.none')}</Empty>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((tb) => {
          const st = statusOf(tb);
          const full = tb.seated >= tb.maxSeats;
          return (
            <article key={tb.id} className="jc-panel group flex flex-col gap-4 p-5 transition hover:border-gold-500/40" data-testid="lobby-table">
              <header className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-bold text-ivory">{tb.name}</h2>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge tone={st === 'playing' ? 'green' : st === 'waiting' ? 'gold' : 'neutral'}>
                      {st === 'playing' && <span className="size-1.5 rounded-full bg-success jc-pulse-gold" />}
                      {t(`lobby.status.${st}` as MsgKey)}
                    </Badge>
                    {tb.isPrivate && <Badge tone="red">🔒 {t('lobby.private')}</Badge>}
                    {!tb.allowSpectators && <Badge>{t('lobby.noSpectate')}</Badge>}
                    {tb.entryBlocked && <Badge tone="red">{t('lobby.blocked')}</Badge>}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-2xl font-semibold text-gold-300 tabular-nums">
                    {tb.seated}
                    <span className="text-base text-ink-400">/{tb.maxSeats}</span>
                  </div>
                  <div className="text-[11px] uppercase tracking-wider text-ink-400">{t('lobby.players')}</div>
                </div>
              </header>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg bg-black/25 px-3 py-2">
                  <dt className="text-[11px] uppercase tracking-wider text-ink-400">{t('lobby.blinds')}</dt>
                  <dd className="font-mono font-semibold tabular-nums">
                    {formatChips(tb.smallBlind)} / {formatChips(tb.bigBlind)}
                  </dd>
                </div>
                <div className="rounded-lg bg-black/25 px-3 py-2">
                  <dt className="text-[11px] uppercase tracking-wider text-ink-400">{t('lobby.buyin')}</dt>
                  <dd className="font-mono font-semibold tabular-nums">
                    {formatChips(tb.minBuyIn, true)} – {formatChips(tb.maxBuyIn, true)}
                  </dd>
                </div>
              </dl>
              <div className="flex items-center justify-between text-xs text-ink-400">
                <span>{t('lobby.spectators', { n: tb.spectators })}</span>
                {tb.waitlist > 0 && <span>{t('lobby.waitlist', { n: tb.waitlist })}</span>}
              </div>
              <div className="mt-auto grid grid-cols-2 gap-2">
                <Button variant="outline" disabled={!tb.allowSpectators} onClick={() => open(tb, false)}>
                  {t('lobby.spectate')}
                </Button>
                <Button disabled={tb.entryBlocked} onClick={() => open(tb, !full)}>
                  {full ? t('lobby.full') : t('lobby.join')}
                </Button>
              </div>
            </article>
          );
        })}
      </div>

      <Modal
        open={!!codeFor}
        onClose={() => setCodeFor(null)}
        title={codeFor?.table.name ?? ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCodeFor(null)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={code.trim().length < 4} onClick={() => codeFor && nav(`/table/${codeFor.table.id}?sit=1&code=${encodeURIComponent(code.trim())}`)}>
              {t('lobby.join')}
            </Button>
          </>
        }
      >
        <Field label={t('lobby.code')} hint={t('lobby.codeHint')}>
          {(id) => <Input id={id} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />}
        </Field>
      </Modal>
    </div>
  );
}
