import { sound } from '@jc/audio';
import type { ActionType, TableView } from '@jc/types';
import { Button, cx, formatChips, Logo, Modal } from '@jc/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { HandRankingChart } from '../academy/HandChart';
import { ActionBar } from '../game/ActionBar';
import { ActionHelp, CurrentHandPill, StageNote } from '../game/BeginnerAids';
import { BuyInModal, ChatPanel, SettingsModal } from '../game/Panels';
import { TableScene, useBoxSize, useTableLayout } from '../game/TableScene';
import { RequestError, useTableSocket } from '../game/useTableSocket';
import { useAuth } from '../lib/auth';
import { useI18n, type MsgKey } from '../lib/i18n';
import { usePrefs } from '../lib/prefs';

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
  const [chart, setChart] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [areaRef, area] = useBoxSize<HTMLDivElement>();
  const reducedMotion = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);

  useEffect(() => sound.installAutoUnlock(), []);
  // iOS Safari ignores user-scalable=no; block pinch zoom on the game screen except in the chat panel.
  useEffect(() => {
    const block = (e: Event) => {
      if (!(e.target as Element | null)?.closest?.('[data-allow-zoom]')) e.preventDefault();
    };
    document.addEventListener('gesturestart', block);
    return () => document.removeEventListener('gesturestart', block);
  }, []);
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

  const anchor = s?.you.seatIndex ?? 0;
  const layout = useTableLayout(area, s?.table.maxSeats, anchor);

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

  const mySeat = s?.you.seatIndex ?? null;
  const seated = mySeat !== null;
  const canChat = !!s && (seated || s.table.allowSpectators);

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden" style={{ background: 'var(--t-bg)' }}>
      {/* top bar */}
      <header className="jc-game-surface z-40 flex h-14 shrink-0 items-center gap-2 border-b border-gold-500/10 bg-ink-950/70 px-3 backdrop-blur-md">
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
          <Button size="sm" variant="ghost" className="lg:hidden" onClick={() => setChatOpen((o) => !o)} aria-label={t('table.chat')} aria-expanded={chatOpen}>
            💬
          </Button>
          <Button size="sm" variant="ghost" className="px-2 sm:px-3" onClick={() => setChart(true)} aria-label={t('table.handChart')} data-testid="hand-chart-open">
            <span aria-hidden className="sm:hidden">♠≡</span>
            <span className="hidden sm:inline">{t('table.handChart')}</span>
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

      {banner && (
        <div className="z-40 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-gold-500/15 px-4 py-2 text-center text-sm text-gold-300" role="status">
          {banner}
          {sock.status === 'reconnecting' && (
            <button className="jc-tap rounded-full border border-gold-500/40 px-3 py-1 text-xs font-semibold hover:bg-gold-500/15" onClick={sock.reconnect}>
              {t('table.reconnectNow')}
            </button>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* table area */}
        <div className="jc-game-surface relative flex min-w-0 flex-1 flex-col">
          <div ref={areaRef} className="relative mx-2 mb-[6.75rem] mt-1 flex min-h-0 flex-1 items-center justify-center sm:mx-6 sm:mb-24 sm:mt-6">
            {s && (
              <TableScene
                s={s}
                layout={layout}
                mySeat={mySeat}
                canSit={!seated && s.you.canSit}
                onSit={setBuySeat}
                nextIn={nextIn}
                cues={sock.cues}
                consumeCues={sock.consumeCues}
                reducedMotion={reducedMotion}
              />
            )}
          </div>

          {/* bottom: action bar / status */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:items-end sm:px-6 sm:pb-6">
            {toast && <div className="pointer-events-auto rounded-lg border border-danger/40 bg-ink-950/90 px-3 py-2 text-sm text-[#f3b0b2]" role="alert">{toast}</div>}
            {s && prefs.beginner && hand && (
              <div className="flex flex-col items-center gap-1.5 sm:items-end">
                <StageNote s={s} />
                {seated && <CurrentHandPill s={s} />}
              </div>
            )}
            {s && myTurn && (
              <>
                {prefs.beginner ? (
                  <ActionHelp s={s} />
                ) : (
                  <div className="hidden rounded-full bg-gold-500/15 px-3 py-1 text-xs font-bold tracking-wider text-gold-300 jc-pulse-gold sm:block sm:self-end">{t('table.yourTurn')}</div>
                )}
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
          data-allow-zoom
          className={cx(
            'jc-tap z-50 flex w-full flex-col border-l border-gold-500/10 bg-ink-950/95 p-3 backdrop-blur lg:static lg:flex lg:w-80',
            chatOpen ? 'fixed inset-x-0 bottom-0 top-14' : 'hidden',
          )}
        >
          {chatOpen && myTurn && (
            <button className="jc-pulse-gold mb-2 rounded-xl border border-gold-400/60 bg-gold-500/20 px-3 py-2.5 text-sm font-bold text-gold-300 lg:hidden" onClick={() => setChatOpen(false)} data-testid="chat-your-turn">
              {t('table.yourTurn')} · {t('table.backToTable')} ↓
            </button>
          )}
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-bold tracking-[0.08em] text-gold-300">{t('table.chat')}</h2>
            <button className="grid size-10 place-items-center text-ink-300 lg:hidden" onClick={() => setChatOpen(false)} aria-label={t('common.close')}>
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
      <Modal open={chart} onClose={() => setChart(false)} title={t('table.handChart')}>
        <HandRankingChart compact />
        <Link to="/academy/hands" className="mt-3 inline-block text-sm text-gold-300 hover:underline">
          {t('table.toAcademy')} →
        </Link>
      </Modal>
    </div>
  );
}
