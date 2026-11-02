import { describe, expect, it } from 'vitest';
import { RECOVERY_FAIL_AFTER, recoveryOf, type RecoveryInput } from '../src/game/recovery';
import { recoveryText } from '../src/game/recoveryText';

const base: RecoveryInput = { status: 'open', shown: true, inHand: false, synced: true, online: true, failures: 0, back: false };
const at = (over: Partial<RecoveryInput>) => recoveryOf({ ...base, ...over });

describe('what the table says while its connection recovers', () => {
  it('says nothing on the first connection, with no view from before', () => {
    expect(at({ shown: false, status: 'connecting', synced: false })).toBeNull();
    expect(at({ shown: false, status: 'open', synced: false })).toBeNull();
    expect(at({ shown: false, status: 'reconnecting', synced: false })).toBeNull();
  });

  it('goes from the drop to the room again: reconnecting, syncing (or restoring my hand), back, then nothing', () => {
    expect(at({ status: 'reconnecting', synced: false })).toBe('reconnecting');
    expect(at({ status: 'open', synced: false })).toBe('syncing');
    expect(at({ status: 'open', synced: false, inHand: true })).toBe('restoring');
    expect(at({ status: 'open', synced: true, back: true })).toBe('restored');
    expect(at({ status: 'open', synced: true })).toBeNull();
  });

  it('says the network is down while the browser is offline, and that it could not recover after a run of failures', () => {
    expect(at({ status: 'reconnecting', synced: false, online: false })).toBe('offline');
    expect(at({ status: 'reconnecting', synced: false, failures: RECOVERY_FAIL_AFTER - 1 })).toBe('reconnecting');
    expect(at({ status: 'reconnecting', synced: false, failures: RECOVERY_FAIL_AFTER })).toBe('failed');
    // Offline is the reason worth saying, however many tries failed.
    expect(at({ status: 'reconnecting', synced: false, online: false, failures: RECOVERY_FAIL_AFTER })).toBe('offline');
  });

  it('leaves the endings with banners of their own to them', () => {
    for (const status of ['replaced', 'closed', 'unauthorized', 'locked', 'kicked'] as const) {
      expect(at({ status, synced: false })).toBeNull();
    }
  });

  it('has its text in both languages, the lock said while unsynced', () => {
    for (const locale of ['ko', 'en'] as const) {
      const tr = recoveryText(locale);
      for (const k of ['offline', 'reconnecting', 'syncing', 'restoring', 'restored', 'failed'] as const) expect(tr(k)).not.toBe(k);
    }
    // The banner of a dropped connection still reads as before (tests and players look for it).
    expect(recoveryText('ko')('reconnecting')).toMatch(/연결이 끊겼습니다/);
    expect(recoveryText('en')('reconnecting')).toMatch(/Connection lost/);
    expect(recoveryText('ko')('syncing')).toMatch(/게임 상태 동기화 중/);
    expect(recoveryText('ko')('restoring')).toMatch(/현재 핸드 복구 중/);
  });
});
