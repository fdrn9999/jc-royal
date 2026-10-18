/**
 * The free chip refill (api lib/refill.ts): the member's card on the Me page, and the short note shown where chips run
 * short (quick play, buy-in, top-up). The server decides everything — the line, the amount, the wait, whether the
 * table chips could be counted — and pays once however many tabs or retries ask; these only show its answer.
 * Loaded on demand (the Me page, or the low-balance notes), so its text lives here rather than in the entry chunk.
 */
import type { RefillClaimDto, RefillStatusDto } from '@jc/types';
import { Button, createTranslator, cx, Figure, formatChips, formatDate, Panel } from '@jc/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';

const ko = {
  title: '무료 칩 보충',
  terms: '지갑과 테이블에 있는 칩을 합쳐 {below}칩 미만이면 {amount}칩을 받을 수 있습니다. 받은 뒤에는 {wait}이 지나야 다시 받을 수 있습니다.',
  free: '광고 시청·연속 접속·베팅 없이 받을 수 있으며, 테이블 스택 충전과는 별개입니다.',
  wallet: '지갑',
  tables: '테이블',
  total: '합계',
  unchecked: '확인 전',
  line: '기준: {below} 미만',
  eligible: '지금 받을 수 있습니다.',
  claim: '{amount}칩 받기',
  paid: '{amount}칩을 받았습니다. 지갑 잔액 {balance}칩.',
  duplicate: '이 보충은 이미 지급되었습니다(다른 창이나 재시도). 한 번만 지급됩니다.',
  changed: '확인하는 사이 칩이 바뀌어 지급하지 않았습니다. 지금 상태를 다시 확인했습니다.',
  cooldown: '다음 보충은 {at}부터 받을 수 있습니다 ({left} 남음).',
  above: '지금은 칩이 기준({below}칩) 이상이라 받을 수 없습니다.',
  aboveTables: '테이블에 있는 칩까지 합치면 기준({below}칩) 이상이라 받을 수 없습니다.',
  paused: '무료 칩 보충이 운영상 잠시 중지되었습니다. 남은 대기 시간은 그대로입니다.',
  off: '지금은 무료 칩 보충을 운영하지 않습니다.',
  suspended: '이용이 제한된 계정은 무료 칩 보충을 받을 수 없습니다.',
  busy: '테이블에서 칩이 오가는 중이라 잠시 미뤘습니다. 잠시 뒤 다시 확인해 주세요.',
  unreachable: '테이블의 칩을 확인하지 못해 잠시 미뤘습니다. 잠시 뒤 다시 확인해 주세요.',
  mismatch: '좌석 정보를 맞춰 보는 중이라 잠시 미뤘습니다. 잠시 뒤 다시 확인해 주세요.',
  received: '지금까지 {n}회 받음',
  last: '마지막 {at}',
  loadFail: '무료 칩 보충 정보를 불러오지 못했습니다.',
  retry: '다시 시도',
  check: '다시 확인',
  loading: '불러오는 중…',
  hintEligible: '지금 {amount}칩을 받을 수 있습니다.',
  hintClaim: '받기',
  hintTerms: '무료 칩 보충은 지갑과 테이블 칩 합계가 {below}칩 미만일 때 받을 수 있습니다.',
  more: '자세히',
  d: '{n}일',
  h: '{n}시간',
  m: '{n}분',
} as const;

const en: Record<keyof typeof ko, string> = {
  title: 'Free chip refill',
  terms: 'When your wallet and the chips on your tables together are below {below}, you can receive {amount} chips. After one, the next comes {wait} later.',
  free: 'No ads, login streaks or bets needed. This is separate from topping up a table stack.',
  wallet: 'Wallet',
  tables: 'Tables',
  total: 'Total',
  unchecked: 'Not checked',
  line: 'Line: below {below}',
  eligible: 'You can receive it now.',
  claim: 'Receive {amount} chips',
  paid: 'You received {amount} chips. Wallet: {balance}.',
  duplicate: 'This refill was already paid (another window or a retry). It is paid only once.',
  changed: 'Your chips changed while this was checked, so nothing was paid. The current state is shown again.',
  cooldown: 'The next refill comes at {at} ({left} left).',
  above: 'Your chips are at or above the line ({below}), so there is no refill now.',
  aboveTables: 'With the chips on your tables you are at or above the line ({below}), so there is no refill now.',
  paused: 'Free refills are paused for now. Your remaining wait stays as it is.',
  off: 'Free refills are not offered right now.',
  suspended: 'A restricted account cannot receive free refills.',
  busy: 'Chips are moving at a table, so the refill waits. Check again in a moment.',
  unreachable: 'A table could not confirm your chips, so the refill waits. Check again in a moment.',
  mismatch: 'Your seats are being reconciled, so the refill waits. Check again in a moment.',
  received: 'Refills received: {n}',
  last: 'last {at}',
  loadFail: 'Could not load the free refill.',
  retry: 'Retry',
  check: 'Check again',
  loading: 'Loading…',
  hintEligible: '{amount} chips are ready for you now.',
  hintClaim: 'Receive',
  hintTerms: 'Free refills come when your wallet and table chips together are below {below}.',
  more: 'Details',
  d: '{n}d',
  h: '{n}h',
  m: '{n}m',
};

const translate = createTranslator({ ko, en });
type Tr = ReturnType<typeof translate>;

/** A wait, in days, hours and minutes (rounded up to the minute). */
function waitText(tr: Tr, ms: number) {
  const total = Math.max(1, Math.ceil(ms / 60_000));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  return [d && tr('d', { n: d }), h && tr('h', { n: h }), m && tr('m', { n: m })].filter(Boolean).join(' ');
}

type Note = { kind: 'paid'; amount: number; balance: number } | { kind: 'duplicate' } | { kind: 'changed' } | { kind: 'error'; code: string | null };

function useRefill(onClaimed?: (c: RefillClaimDto) => void) {
  const { refresh } = useAuth();
  const [status, setStatus] = useState<RefillStatusDto | null>(null);
  // Server time minus this device's, so the wait counts down in the server's time.
  const [skew, setSkew] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const take = useCallback((s: RefillStatusDto) => {
    setStatus(s);
    setSkew(s.now - Date.now());
  }, []);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api<RefillStatusDto>('/api/me/refill');
      if (!alive.current) return;
      take(s);
      setFailed(false);
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [take]);
  useEffect(() => {
    void load();
  }, [load]);

  async function claim() {
    setClaiming(true);
    setNote(null);
    try {
      const c = await api<RefillClaimDto>('/api/me/refill', { body: {} });
      if (!alive.current) return;
      take(c.status);
      setNote(c.duplicate ? { kind: 'duplicate' } : { kind: 'paid', amount: c.amount, balance: c.balance });
      onClaimed?.(c);
    } catch (e) {
      if (!alive.current) return;
      const code = e instanceof ApiError ? e.code : null;
      const s = e instanceof ApiError ? (e.details as { status?: RefillStatusDto } | undefined)?.status : undefined;
      if (s) take(s);
      // A refusal shows as the state line (why, and when the next one comes); only the rest needs a note.
      if (code === 'refill_changed') setNote({ kind: 'changed' });
      else if (code !== 'refill_refused') setNote({ kind: 'error', code });
    } finally {
      // Whatever happened (an answer lost on the way may still have paid), the wallet shown follows the server's.
      void refresh().catch(() => undefined);
      if (alive.current) setClaiming(false);
    }
  }
  return { status, skew, failed, loading, claiming, note, load, claim };
}

/** Server time, ticking while a wait is shown. */
function useServerNow(skew: number, ticking: boolean) {
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    setNow(Date.now() + skew);
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now() + skew), 15_000);
    return () => clearInterval(id);
  }, [skew, ticking]);
  return now;
}

/** Why there is no refill now, in a sentence; null when there is one. */
function reasonText(tr: Tr, s: RefillStatusDto, at: (ms: number) => string, now: number): string | null {
  const below = formatChips(s.policy?.below ?? 0);
  switch (s.reason) {
    case null:
      return null;
    case 'off':
      return tr('off');
    case 'paused':
      return tr('paused');
    case 'suspended':
      return tr('suspended');
    case 'cooldown':
      return tr('cooldown', { at: at(s.nextAt ?? now), left: waitText(tr, (s.nextAt ?? now) - now) });
    case 'above':
      return s.wallet < (s.policy?.below ?? 0) ? tr('aboveTables', { below }) : tr('above', { below });
    case 'held':
      return tr(s.hold ?? 'unreachable');
  }
}

function NoteLine({ tr, note }: { tr: Tr; note: Note | null }) {
  const { err } = useI18n();
  if (!note) return null;
  const text = note.kind === 'paid' ? tr('paid', { amount: formatChips(note.amount), balance: formatChips(note.balance) }) : note.kind === 'error' ? err(note.code) : tr(note.kind);
  return (
    <p className={cx('text-sm', note.kind === 'paid' ? 'text-[#9fd8b6]' : note.kind === 'error' ? 'text-danger' : 'text-ink-200')} role="status" data-testid="refill-note" data-kind={note.kind}>
      {text}
    </p>
  );
}

/** The Me page's card: the terms, what counts now, and the claim (or why not, and when). */
export function RefillCard({ onClaimed }: { onClaimed?: (c: RefillClaimDto) => void }) {
  const { locale } = useI18n();
  const tr = translate(locale);
  const r = useRefill(onClaimed);
  const s = r.status;
  const cooling = s?.reason === 'cooldown';
  const now = useServerNow(r.skew, cooling);
  const due = cooling && s?.nextAt !== null && s?.nextAt !== undefined && s.nextAt <= now;
  // A wait that ended while the page was open: ask again, so the claim shows without a reload.
  const { load } = r;
  useEffect(() => {
    if (due) void load();
  }, [due, load]);
  const at = (ms: number) => formatDate(ms, locale);
  const p = s?.policy;
  const why = s ? reasonText(tr, s, at, now) : null;
  const offered = !!p && s?.reason !== 'off';

  return (
    <Panel title={tr('title')}>
      <div className="flex flex-col gap-3" data-testid="refill-card" data-reason={s ? (s.reason ?? 'eligible') : r.failed ? 'failed' : 'loading'}>
        {!s ? (
          r.failed ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-[#f3b0b2]">{tr('loadFail')}</span>
              <Button size="sm" variant="outline" loading={r.loading} onClick={() => void r.load()} data-testid="refill-retry">
                {tr('retry')}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-ink-400">{tr('loading')}</p>
          )
        ) : !offered ? (
          <p className="text-sm text-ink-300" data-testid="refill-state">
            {tr('off')}
          </p>
        ) : (
          <>
            <p className="text-sm text-ink-200" data-testid="refill-terms">
              {tr('terms', { below: formatChips(p!.below), amount: formatChips(p!.amount), wait: waitText(tr, p!.cooldownMs) })}
            </p>
            {/* On a phone a row each, the name on the left and the amount on the right (a third of the card is too narrow
                for a nine-digit wallet); three tiles from sm up. An amount too long even so wraps between digit groups. */}
            <div className="grid gap-1.5 sm:grid-cols-3 sm:gap-2 sm:text-center">
              <div className="flex items-baseline justify-between gap-3 rounded-lg bg-ink-850/80 px-3 py-2 sm:block sm:px-2">
                <div className="shrink-0 text-[11px] text-ink-400">{tr('wallet')}</div>
                <div className="min-w-0 text-right font-mono text-sm font-semibold tabular-nums sm:text-center" data-testid="refill-wallet">
                  <Figure>{formatChips(s.wallet)}</Figure>
                </div>
              </div>
              <div className="flex items-baseline justify-between gap-3 rounded-lg bg-ink-850/80 px-3 py-2 sm:block sm:px-2">
                <div className="shrink-0 text-[11px] text-ink-400">{tr('tables')}</div>
                <div className="min-w-0 text-right font-mono text-sm font-semibold tabular-nums sm:text-center" data-testid="refill-tables">
                  {s.tables === null ? <span className="font-sans text-xs font-normal text-ink-400">{tr('unchecked')}</span> : <Figure>{formatChips(s.tables)}</Figure>}
                </div>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 rounded-lg bg-ink-850/80 px-3 py-2 sm:block sm:px-2">
                <div className="shrink-0 text-[11px] text-ink-400">{tr('total')}</div>
                <div className="min-w-0 text-right font-mono text-sm font-semibold tabular-nums sm:text-center" data-testid="refill-total">
                  {s.tables === null ? '—' : <Figure>{formatChips(s.wallet + s.tables)}</Figure>}
                </div>
                <div className="w-full text-right text-[10px] text-ink-400 sm:text-center">{tr('line', { below: formatChips(p!.below) })}</div>
              </div>
            </div>
            <div
              className={cx('flex flex-col gap-2 rounded-lg border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between', s.eligible ? 'border-gold-500/40 bg-gold-500/10' : 'border-white/10 bg-ink-850/60')}
              data-testid="refill-state"
              data-reason={s.reason ?? 'eligible'}
              data-hold={s.hold ?? undefined}
            >
              <p className="text-sm text-ink-100" aria-live="polite">
                {why ?? tr('eligible')}
              </p>
              {s.eligible ? (
                <Button size="sm" className="min-h-10 shrink-0" loading={r.claiming} disabled={r.claiming} onClick={() => void r.claim()} data-testid="refill-claim">
                  {tr('claim', { amount: formatChips(p!.amount) })}
                </Button>
              ) : (
                s.reason === 'held' && (
                  <Button size="sm" variant="outline" className="shrink-0" loading={r.loading} onClick={() => void r.load()} data-testid="refill-check">
                    {tr('check')}
                  </Button>
                )
              )}
            </div>
            <NoteLine tr={tr} note={r.note} />
            <p className="text-xs text-ink-400" data-testid="refill-received">
              {tr('received', { n: s.received })}
              {s.last && ` · ${tr('last', { at: at(s.last.at) })}`}
            </p>
            <p className="text-xs text-ink-400">{tr('free')}</p>
          </>
        )}
      </div>
    </Panel>
  );
}

/**
 * The note under "not enough chips": a refill to take right there, when the next one comes, or why there is none.
 * Says nothing while loading, when it fails to load, or when refills are off (the notice it sits in stands alone).
 */
export function RefillHint({ className }: { className?: string }) {
  const { locale } = useI18n();
  const tr = translate(locale);
  const r = useRefill();
  const s = r.status;
  const now = useServerNow(r.skew, s?.reason === 'cooldown');
  if (!s?.policy || s.reason === 'off' || s.reason === 'suspended') return r.note ? <NoteLine tr={tr} note={r.note} /> : null;
  const p = s.policy;
  const why = reasonText(tr, s, (ms) => formatDate(ms, locale), now);
  const text = s.eligible
    ? tr('hintEligible', { amount: formatChips(p.amount) })
    : s.reason === 'above' && s.wallet >= p.below
      ? tr('hintTerms', { below: formatChips(p.below) })
      : why;
  return (
    <div className={cx('flex flex-col gap-1.5 rounded-lg border border-white/10 bg-ink-850/70 px-3 py-2 text-sm', className)} data-testid="refill-hint" data-reason={s.reason ?? 'eligible'}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="min-w-0 flex-1 text-ink-100">
          <span className="font-semibold text-gold-300">{tr('title')}</span> · {text}
        </span>
        {s.eligible ? (
          <Button size="sm" loading={r.claiming} disabled={r.claiming} onClick={() => void r.claim()} data-testid="refill-hint-claim">
            {tr('hintClaim')}
          </Button>
        ) : (
          <Link to="/me" className="text-xs text-gold-300 underline underline-offset-2">
            {tr('more')}
          </Link>
        )}
      </div>
      <NoteLine tr={tr} note={r.note} />
    </div>
  );
}
