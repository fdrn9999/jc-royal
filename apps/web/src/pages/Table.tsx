import { sound } from '@jc/audio';
import { handLabelKey, type ActionType, type Card, type TableView } from '@jc/types';
import { Button, ChipStack, cx, formatChips, Logo, PlayingCard } from '@jc/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ActionBar } from '../game/ActionBar';
import { CueLayer } from '../game/CueLayer';
import { seatLayout, POT_POINT } from '../game/layout';
import { BuyInModal, ChatPanel, SettingsModal } from '../game/Panels';
import { Seat } from '../game/Seat';
import { RequestError, useTableSocket } from '../game/useTableSocket';
import { useAuth } from '../lib/auth';
import { useI18n, type MsgKey } from '../lib/i18n';
import { usePrefs } from '../lib/prefs';

function useBoxSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 1200, h: 700 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => e && setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

function useCountdown(target: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!target) return;
    const h = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(h);
  }, [target]);
  return target ? Math.max(0, Math.ceil((target - now) / 1000)) : null;
}

export function TablePage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const code = params.get('code');
  const { t, err } = useI18n();
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const prefs = usePrefs();
  const sock = useTableSocket(id, code);
  const s = sock.state;
  const [buySeat, setBuySeat] = useState<number | null>(null);
  const [buyBusy, setBuyBusy] = useState(false);
  const [buyErr, setBuyErr] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [areaRef, area] = useBoxSize<HTMLDivElement>();
  const reducedMotion = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);

  useEffect(() => sound.installAutoUnlock(), []);
  useEffect(() => {
    document.documentElement.dataset.fourColor = prefs.fourColor ? '1' : '';
  }, [prefs.fourColor]);

  // Server errors that are not tied to a request → transient toast.
  useEffect(() => {
    if (!sock.lastError) return;
    setToast(err(sock.lastError.code));
    const h = setTimeout(() => setToast(null), 3_500);
    return () => clearTimeout(h);
  }, [sock.lastError, err]);

  // ?sit=1 from the lobby: open the buy-in dialog on the first free seat.
  useEffect(() => {
    if (!s || params.get('sit') !== '1') return;
    if (s.you.seatIndex === null && s.you.canSit) {
      const free = s.seats.find((x) => x.state === 'empty');
      if (free) setBuySeat(free.seatIndex);
    }
    params.delete('sit');
    setParams(params, { replace: true });
  }, [s, params, setParams]);

  const portrait = area.w / Math.max(1, area.h) < 0.95;
  const compact = area.w < 640;
  const anchor = s?.you.seatIndex ?? 0;
  const plateHalfPx = compact ? 60 : 76;

  // Table box: keep the felt proportions inside the available area.
  const box = useMemo(() => {
    const ratio = portrait ? 0.68 : 1.75;
    let w = area.w;
    let h = w / ratio;
    if (h > area.h) {
      h = area.h;
      w = h * ratio;
    }
    return { w, h };
  }, [area, portrait]);

  const geometry = useMemo(
    () => (s ? seatLayout(s.table.maxSeats, anchor, portrait, Math.min(45, (plateHalfPx / Math.max(1, box.w)) * 100)) : []),
    [s?.table.maxSeats, anchor, portrait, plateHalfPx, box.w], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const hand = s?.hand ?? null;
  const myTurn = !!s && !!hand && s.you.seatIndex !== null && hand.actorSeat === s.you.seatIndex && s.you.legal.length > 0;
  const nextIn = useCountdown(s?.nextHandAt ?? null);

  // Timer warning beeps on my turn.
  const lastBeep = useRef(0);
  useEffect(() => {
    if (!myTurn || !hand?.deadline) return;
    const h = setInterval(() => {
      const left = hand.deadline! - Date.now();
      if (left < 5_000 && left > 0 && Date.now() - lastBeep.current > 950) {
        lastBeep.current = Date.now();
        sound.play('timer');
      }
    }, 200);
    return () => clearInterval(h);
  }, [myTurn, hand?.deadline]);

  const winners = useMemo(() => new Map((hand?.result?.winners ?? []).map((w) => [w.seatIndex, w.amount])), [hand?.result]);
  const showdown = useMemo(() => new Map((hand?.result?.showdown ?? []).map((x) => [x.seatIndex, x])), [hand?.result]);
  const topWinner = hand?.result?.winners?.[0]?.seatIndex;
  const winningFive = topWinner !== undefined ? (showdown.get(topWinner)?.bestFive ?? []) : [];

  const onAct = useCallback((type: ActionType, amount?: number) => sock.act(type, amount), [sock]);

  async function sit(amount: number) {
    if (buySeat === null) return;
    setBuyBusy(true);
    setBuyErr(null);
    try {
      await sock.request({ t: 'sit', seatIndex: buySeat, buyIn: amount });
      setBuySeat(null);
      void refresh();
    } catch (e) {
      setBuyErr(err(e instanceof RequestError ? e.code : null));
    } finally {
      setBuyBusy(false);
    }
  }

  async function leave() {
    try {
      await sock.request({ t: 'leave' });
      void refresh();
      if (s?.you.seatIndex === null) nav('/');
    } catch (e) {
      setToast(err(e instanceof RequestError ? e.code : null));
    }
  }

  if (sock.status === 'unauthorized') {
    nav('/login', { replace: true, state: { from: `/table/${id}` } });
    return null;
  }

  const banner =
    sock.status === 'replaced'
      ? t('table.replaced')
      : sock.status === 'closed'
        ? t('table.closed')
        : sock.status === 'reconnecting'
          ? t('table.reconnecting')
          : sock.status === 'connecting' || !s
            ? t('table.connecting')
            : null;

  // Chips already gathered in the middle; after settlement they have been paid out.
  const collected = hand && hand.stage !== 'settled' ? hand.potTotal - s!.seats.reduce((a, x) => a + x.streetBet, 0) : 0;
  const mySeat = s?.you.seatIndex ?? null;
  const seated = mySeat !== null;
  const canChat = !!s && (seated || s.table.allowSpectators);

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden" style={{ background: 'var(--t-bg)' }}>
      {/* top bar */}
      <header className="z-40 flex h-14 shrink-0 items-center gap-2 border-b border-gold-500/10 bg-ink-950/70 px-3 backdrop-blur-md">
        <Link to="/" aria-label={t('nav.lobby')} className="shrink-0">
          <Logo size={32} />
        </Link>
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-ivory">{s?.table.name ?? '…'}</div>
          {s && (
            <div className="truncate font-mono text-[11px] text-ink-300">
              {formatChips(s.table.smallBlind)}/{formatChips(s.table.bigBlind)}
              {hand && ` · ${t('table.handNo', { n: hand.number })} · ${t(`stage.${hand.stage}` as MsgKey)}`}
            </div>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {seated && (
            <Button size="sm" variant="subtle" className="whitespace-nowrap px-2.5 sm:px-3" onClick={() => sock.send({ t: s!.you.sittingOut ? 'sitIn' : 'sitOut' })} data-testid="sitout-toggle" aria-label={s!.you.sittingOut ? t('table.sitIn') : t('table.sitOut')}>
              <span aria-hidden className="sm:hidden">{s!.you.sittingOut ? '▶' : '❚❚'}</span>
              <span className="hidden sm:inline">{s!.you.sittingOut ? t('table.sitIn') : t('table.sitOut')}</span>
            </Button>
          )}
          <Button size="sm" variant="ghost" className="lg:hidden" onClick={() => setChatOpen((o) => !o)}>
            💬
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSettings(true)} aria-label={t('table.settings')}>
            ⚙
          </Button>
          <Button size="sm" variant="outline" className="whitespace-nowrap px-2.5 sm:px-3" onClick={seated ? leave : () => nav('/')} data-testid="leave" aria-label={seated ? t('table.standUp') : t('table.leave')}>
            <span aria-hidden className="sm:hidden">⏏</span>
            <span className="hidden sm:inline">{seated ? t('table.standUp') : t('table.leave')}</span>
          </Button>
        </div>
      </header>

      {banner && <div className="z-40 bg-gold-500/15 px-4 py-2 text-center text-sm text-gold-300" role="status">{banner}</div>}

      <div className="flex min-h-0 flex-1">
        {/* table area */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div ref={areaRef} className="relative mx-2 mb-[6.75rem] mt-1 flex min-h-0 flex-1 items-center justify-center sm:mx-6 sm:mb-24 sm:mt-6">
            {s && (
              <div className="relative" style={{ width: box.w, height: box.h }} data-testid="table" data-portrait={portrait ? '1' : '0'}>
                {/* rail + felt */}
                <div className="absolute rounded-[50%] p-[1.2%] shadow-[0_30px_80px_rgba(0,0,0,0.7)]" style={{ inset: portrait ? '9% 11%' : '11% 9%', background: 'var(--t-rail)' }}>
                  <div className="relative size-full rounded-[50%] p-[0.6%]" style={{ background: 'var(--t-rail-inner)' }}>
                    <div className="relative size-full overflow-hidden rounded-[50%] shadow-[inset_0_6px_30px_rgba(0,0,0,0.7)]" style={{ background: 'var(--t-felt)' }}>
                      <div className="absolute inset-[9%] rounded-[50%] border" style={{ borderColor: 'var(--t-felt-line)' }} />
                      <div className="absolute inset-x-0 flex justify-center" style={{ top: portrait ? '16%' : '12%', opacity: 'var(--t-watermark-opacity)' }}>
                        <Logo size={Math.min(box.w, box.h) * 0.18} />
                      </div>
                    </div>
                  </div>
                </div>

                {/* pot + board */}
                <div className="absolute left-1/2 top-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2" style={{ top: `${POT_POINT.y + 7}%` }}>
                  <div className="flex min-h-7 items-center gap-2" data-testid="pot">
                    {collected > 0 && <ChipStack amount={collected} />}
                    {hand && hand.pots.length > 1 && hand.stage !== 'settled' && (
                      <span className="rounded-full bg-black/45 px-2 py-0.5 text-[10px] text-ink-200">{hand.pots.map((p, i) => `${i === 0 ? t('table.pot') : t('table.sidePot', { n: i })} ${formatChips(p.amount, true)}`).join(' · ')}</span>
                    )}
                  </div>
                  <div className="flex gap-1 rounded-xl bg-black/35 p-1.5 shadow-[inset_0_1px_8px_rgba(0,0,0,0.45)] sm:gap-1.5 sm:p-2" data-testid="board">
                    {Array.from({ length: 5 }, (_, i) => {
                      const c = hand?.board[i] as Card | undefined;
                      return c ? (
                        <PlayingCard key={`${hand!.id}-${c}`} card={c} size={compact ? '2.1rem' : 'clamp(2.4rem,4.2vw,3.6rem)'} animate="flip" highlight={winningFive.includes(c)} style={{ animationDelay: `${(i % 3) * 120}ms` }} />
                      ) : (
                        <div key={i} className="jc-card border border-dashed border-white/10 bg-black/10" style={{ ['--card-size' as string]: compact ? '2.1rem' : 'clamp(2.4rem,4.2vw,3.6rem)', boxShadow: 'none' }} />
                      );
                    })}
                  </div>
                  {/* Fixed-height status slot: text changes never move the board. */}
                  <div className="flex h-5 items-center text-xs tracking-[0.06em] text-ink-200/80" data-testid="table-status" aria-live="polite">
                    {!hand ? (nextIn !== null ? t('table.nextHand', { s: nextIn }) : t('table.waiting')) : hand.stage === 'settled' && nextIn !== null ? t('table.nextHand', { s: nextIn }) : null}
                  </div>
                </div>

                {/* seats, bets, dealer button */}
                {s.seats.map((seat) => {
                  const g = geometry[seat.seatIndex]!;
                  const sd = showdown.get(seat.seatIndex);
                  const label = sd ? t(`hand.${handLabelKey(sd.rankClass, sd.bestFive)}` as MsgKey) : null;
                  return (
                    <div key={seat.seatIndex}>
                      <Seat
                        seat={seat}
                        isMe={seat.seatIndex === mySeat}
                        isActor={!!hand && hand.actorSeat === seat.seatIndex && hand.stage !== 'settled'}
                        deadline={hand?.deadline ?? null}
                        turnMs={s.table.turnSeconds * 1000}
                        isDealer={hand?.buttonSeat === seat.seatIndex}
                        blind={hand && hand.stage === 'preflop' ? (hand.sbSeat === seat.seatIndex ? 'SB' : hand.bbSeat === seat.seatIndex ? 'BB' : null) : null}
                        winAmount={winners.get(seat.seatIndex) ?? null}
                        handLabel={label}
                        bestFive={sd?.bestFive ?? null}
                        newHandKey={hand?.id ?? null}
                        canSit={!seated && s.you.canSit}
                        onSit={() => setBuySeat(seat.seatIndex)}
                        compact={compact}
                        style={{ left: `${g.seat.x}%`, top: `${g.seat.y}%` }}
                      />
                      {seat.streetBet > 0 && hand?.stage !== 'settled' && (
                        <div className="absolute z-20 -translate-x-1/2 -translate-y-1/2" style={{ left: `${g.bet.x}%`, top: `${g.bet.y}%` }} data-testid={`bet-${seat.seatIndex}`}>
                          <ChipStack amount={seat.streetBet} size={compact ? '1rem' : '1.25rem'} />
                        </div>
                      )}
                    </div>
                  );
                })}

                <CueLayer cues={sock.cues} consume={sock.consumeCues} geometry={geometry} mySeat={mySeat} reducedMotion={reducedMotion} />
              </div>
            )}
          </div>

          {/* bottom: action bar / status */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:items-end sm:px-6 sm:pb-6">
            {toast && <div className="pointer-events-auto rounded-lg border border-danger/40 bg-ink-950/90 px-3 py-2 text-sm text-[#f3b0b2]" role="alert">{toast}</div>}
            {s && myTurn && (
              <>
                <div className="hidden rounded-full bg-gold-500/15 px-3 py-1 text-xs font-bold tracking-wider text-gold-300 jc-pulse-gold sm:block sm:self-end">{t('table.yourTurn')}</div>
                <ActionBar state={s} onAct={onAct} busy={sock.acting} />
              </>
            )}
            {s && !myTurn && (
              <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-white/5 bg-ink-950/80 px-3 py-2 text-sm backdrop-blur sm:self-end">
                {s.you.leaving && <span className="text-gold-300">{t('table.leavingAfterHand')}</span>}
                {!seated && <span className="text-ink-300">{t('table.spectating')}</span>}
                {!seated && s.reservation && <span className="text-gold-300">{t('table.reserved', { name: s.reservation.nickname })}</span>}
                {!seated && !s.you.canSit && s.seats.every((x) => x.state !== 'empty') && (
                  <Button size="sm" variant="outline" onClick={() => sock.send({ t: 'waitlist', join: !s.you.inWaitlist })}>
                    {s.you.inWaitlist ? t('table.leaveWaitlist') : t('table.joinWaitlist')} ({s.waitlist.length})
                  </Button>
                )}
                {!seated && s.table.isPrivate && !s.you.canSit && !code && <span className="text-ink-400">{t('table.privateSeatLocked')}</span>}
                {seated && <span className={cx('font-mono text-xs text-ink-300')}>{t('common.balance')} {formatChips(me?.balance ?? 0)}</span>}
              </div>
            )}
          </div>
        </div>

        {/* chat sidebar (desktop) / drawer (mobile) */}
        <aside
          className={cx(
            'z-50 flex w-full flex-col border-l border-gold-500/10 bg-ink-950/95 p-3 backdrop-blur lg:static lg:flex lg:w-80',
            chatOpen ? 'fixed inset-x-0 bottom-0 top-14' : 'hidden',
          )}
        >
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-bold tracking-[0.08em] text-gold-300">{t('table.chat')}</h2>
            <button className="text-ink-300 lg:hidden" onClick={() => setChatOpen(false)} aria-label={t('common.close')}>
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <ChatPanel chat={sock.chat} onSend={(text) => sock.send({ t: 'chat', text })} canChat={canChat} />
          </div>
          {s && (
            <div className="mt-3 border-t border-white/5 pt-3 text-xs text-ink-400">
              {s.spectatorCount > 0 && <div>{t('lobby.spectators', { n: s.spectatorCount })}</div>}
              {s.waitlist.length > 0 && <div>{t('lobby.waitlist', { n: s.waitlist.length })}</div>}
              <Link to="/me" className="mt-1 inline-block text-gold-300 hover:underline">
                {t('table.history')} →
              </Link>
            </div>
          )}
        </aside>
      </div>

      {s && (
        <BuyInModal
          open={buySeat !== null}
          onClose={() => setBuySeat(null)}
          state={s as TableView}
          seatIndex={buySeat}
          wallet={me?.balance ?? 0}
          onConfirm={sit}
          busy={buyBusy}
          error={buyErr}
        />
      )}
      <SettingsModal open={settings} onClose={() => setSettings(false)} />
    </div>
  );
}
