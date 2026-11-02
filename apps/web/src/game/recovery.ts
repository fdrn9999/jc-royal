/**
 * The step the table shows while its connection recovers (useTableSocket's `recovery`). Until the room's first state on
 * a new connection is in, the view shown is the one from before the drop, and actions on it are locked (useTableSocket's
 * `synced`). The words are in recoveryText.ts: useTableSocket reaches the entry chunk (the settings modal imports it), so
 * this module holds no text.
 */
import type { ConnStatus } from './useTableSocket';

export type Recovery = 'offline' | 'reconnecting' | 'syncing' | 'restoring' | 'restored' | 'failed';

/** Failed tries in a row after which the table says it could not recover (it keeps trying): about 30 seconds. */
export const RECOVERY_FAIL_AFTER = 6;
/** How long "back in the game" shows. */
export const RESTORED_MS = 2_500;

export interface RecoveryInput {
  status: ConnStatus;
  /** A view from an earlier connection is shown: this is a recovery, not the first connection. */
  shown: boolean;
  /** That view had me seated in a hand in progress. */
  inHand: boolean;
  /** The current connection delivered the room's state. */
  synced: boolean;
  /** The browser says it is online. */
  online: boolean;
  /** Connections that failed since the last one that opened. */
  failures: number;
  /** The first state after a drop came less than RESTORED_MS ago. */
  back: boolean;
}

/** The recovery step to show, or null (the first connection, or one of the endings with banners of their own). */
export function recoveryOf(i: RecoveryInput): Recovery | null {
  if (!i.shown) return null;
  if (i.status === 'reconnecting' || i.status === 'connecting') {
    if (!i.online) return 'offline';
    return i.failures >= RECOVERY_FAIL_AFTER ? 'failed' : 'reconnecting';
  }
  if (i.status !== 'open') return null;
  if (!i.synced) return i.inHand ? 'restoring' : 'syncing';
  return i.back ? 'restored' : null;
}
