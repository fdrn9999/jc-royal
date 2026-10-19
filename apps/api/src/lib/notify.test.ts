// The push sender's decisions (notify.ts) without D1: the account checks in their order, Korean night at its
// boundaries, when a push is tried again, what an event's browsers' answers make of it, whether a claim still has room
// for a send, what an error leaves, and the words a push shows.
import { describe, expect, it } from 'vitest';
import { afterError, canSend, gate, MAX_ATTEMPTS, outcome, pushText, retryAt, type Recipient } from './notify';
import { SEND_TIMEOUT_MS } from './webpush';

/** A moment in Korean time (UTC+9, no daylight saving). */
const kst = (iso: string) => Date.parse(`${iso}+09:00`);
const open: Recipient = { status: 'active', service: true, night: false, typeOn: true };
const ev = (at: number, life = 3_600_000) => ({ createdAt: at, expiresAt: at + life });

describe('gate', () => {
  const day = kst('2026-10-19T12:00:00');

  it('passes an active member with consent and the type on, in the day', () => {
    expect(gate(ev(day), open, day)).toBeNull();
  });

  it('checks in order: expired, inactive, no consent, type off, night', () => {
    const night = kst('2026-10-19T23:00:00');
    const all = { status: 'suspended', service: false, night: false, typeOn: false };
    expect(gate({ createdAt: night, expiresAt: night }, all, night)).toBe('expired');
    expect(gate(ev(night), all, night)).toBe('inactive');
    expect(gate(ev(night), null, night)).toBe('inactive');
    expect(gate(ev(night), { ...all, status: 'active' }, night)).toBe('no_consent');
    expect(gate(ev(night), { ...all, status: 'active', service: true }, night)).toBe('type_off');
    expect(gate(ev(night), { ...all, status: 'active', service: true, typeOn: true }, night)).toBe('night');
  });

  it('an expiry is exact: the last millisecond still goes, the expiry itself does not', () => {
    const e = ev(day, 60_000);
    expect(gate(e, open, e.expiresAt - 1)).toBeNull();
    expect(gate(e, open, e.expiresAt)).toBe('expired');
  });

  it.each(['deleted', 'suspended', 'pending'])('a %s account gets nothing', (status) => {
    expect(gate(ev(day), { ...open, status }, day)).toBe('inactive');
  });

  it.each([
    ['2026-10-19T20:59:59', null],
    ['2026-10-19T21:00:00', 'night'],
    ['2026-10-20T00:00:00', 'night'],
    ['2026-10-20T07:59:59', 'night'],
    ['2026-10-20T08:00:00', null],
  ] as const)('Korean time %s without night consent: %s', (at, want) => {
    const t = kst(at);
    expect(gate(ev(t), open, t)).toBe(want);
  });

  it('night consent sends at any hour', () => {
    for (const at of ['2026-10-19T21:00:00', '2026-10-20T03:00:00', '2026-10-20T07:59:59']) {
      const t = kst(at);
      expect(gate(ev(t), { ...open, night: true }, t), at).toBeNull();
    }
  });

  it('a night event is not held for the morning; a day event is not sent once night has begun', () => {
    const lastNight = kst('2026-10-19T23:30:00');
    const morning = kst('2026-10-20T08:00:00');
    expect(gate({ createdAt: lastNight, expiresAt: morning + 3_600_000 }, open, morning)).toBe('night');
    const evening = kst('2026-10-19T20:59:30');
    expect(gate(ev(evening), open, kst('2026-10-19T21:00:00'))).toBe('night');
  });

  it('night is judged on Korean time, whatever the server’s own zone', () => {
    // 21:00 KST is 12:00 UTC: noon on a UTC clock is night in Korea.
    const t = Date.parse('2026-10-19T12:00:00Z');
    expect(gate(ev(t), open, t)).toBe('night');
    expect(gate(ev(t - 1000), open, t - 1000)).toBeNull();
  });
});

describe('retryAt', () => {
  const now = 1_000_000;
  it('a minute after the first try, five after the second, none after the third', () => {
    expect(retryAt(1, now, now + 3_600_000)).toBe(now + 60_000);
    expect(retryAt(2, now, now + 3_600_000)).toBe(now + 5 * 60_000);
    expect(retryAt(MAX_ATTEMPTS, now, now + 3_600_000)).toBeNull();
    expect(retryAt(MAX_ATTEMPTS + 1, now, now + 3_600_000)).toBeNull();
  });
  it('never past the event’s expiry', () => {
    expect(retryAt(1, now, now + 60_000)).toBeNull();
    expect(retryAt(1, now, now + 60_001)).toBe(now + 60_000);
  });
});

describe('outcome', () => {
  const ok = { ok: true, status: 201 } as const;
  const gone = { ok: false, status: 410, gone: true, retry: false } as const;
  const busy = { ok: false, status: 503, gone: false, retry: true } as const;
  const bad = { ok: false, status: 400, gone: false, retry: false } as const;
  it('reaching any browser is sent', () => {
    expect(outcome([gone, ok])).toBe('sent');
    expect(outcome([bad, busy, ok])).toBe('sent');
  });
  it('otherwise a busy service is tried again; all gone is gone; anything else refused', () => {
    expect(outcome([gone, busy])).toBe('retry');
    expect(outcome([gone, gone])).toBe('gone');
    expect(outcome([gone, bad])).toBe('refused');
    expect(outcome([bad])).toBe('refused');
  });
  it('run out right before it went: over, not tried again (unless a browser got it)', () => {
    const late = { ok: false, status: 0, gone: false, retry: false, expired: true } as const;
    expect(outcome([busy, late])).toBe('expired');
    expect(outcome([late, ok])).toBe('sent');
  });
});

describe('canSend', () => {
  const lease = 1_000_000;
  it('sends only while the slowest answer and the save after it fit in the claim', () => {
    expect(canSend(lease - 60_000, lease)).toBe(true);
    expect(canSend(lease - SEND_TIMEOUT_MS - 15_000, lease)).toBe(true);
    expect(canSend(lease - SEND_TIMEOUT_MS - 15_000 + 1, lease)).toBe(false);
    expect(canSend(lease, lease)).toBe(false);
  });
});

describe('afterError', () => {
  const now = 1_000_000;
  const life = now + 3_600_000;
  const ok = { ok: true as const, status: 201 };
  const busy = { ok: false as const, status: 503, gone: false, retry: true };
  it('a push some browser already got is sent (the error came after)', () => {
    expect(afterError([busy, ok], 1, now, life)).toEqual({ status: 'sent' });
  });
  it('otherwise tried again after the usual wait, and failed once the tries or the time are used up', () => {
    expect(afterError(null, 1, now, life)).toEqual({ status: 'pending', at: now + 60_000 });
    expect(afterError([busy], 2, now, life)).toEqual({ status: 'pending', at: now + 300_000 });
    expect(afterError(null, MAX_ATTEMPTS, now, life)).toEqual({ status: 'failed' });
    expect(afterError(null, 1, now, now + 60_000)).toEqual({ status: 'failed' });
  });
});

describe('pushText', () => {
  const types = ['dm', 'invite', 'friend_request', 'friend_accepted', 'tournament_start', 'tournament_cancel', 'tournament_result'] as const;
  it('Korean unless the member chose English', () => {
    expect(pushText('dm', 'en')).toMatchObject({ lang: 'en', title: 'New message' });
    expect(pushText('dm', 'ko')).toMatchObject({ lang: 'ko', title: '새 메시지' });
    expect(pushText('dm', null).lang).toBe('ko');
    expect(pushText('dm', 'fr').lang).toBe('ko');
  });
  it.each(types)('%s: words in both languages, nothing taken from the event', (type) => {
    for (const lang of ['ko', 'en'] as const) {
      const t = pushText(type, lang);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.body.length).toBeGreaterThan(0);
      // Fixed strings: no placeholders to fill with a name, an amount or a message.
      expect(`${t.title}${t.body}`).not.toMatch(/[{}$%<>]/);
    }
  });
});
