import type { BlockedUserDto } from '@jc/types';
import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';

/**
 * Personal safety tools shared by the table, the player card and the friends pages.
 *
 * - Blocks live on the server (they also stop friend requests and 1:1 messages); this keeps the ids I blocked in
 *   memory so the table chat can hide those players too.
 * - Table-chat mutes are kept on this device only, per account. A mute hides that player's table chat for me and
 *   nothing else: it keeps nobody off a table and is unrelated to staff sanctions.
 */
const EMPTY: ReadonlySet<string> = new Set();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (cb: () => void) => {
  subs.add(cb);
  return () => subs.delete(cb);
};

let blocked: ReadonlySet<string> = EMPTY;
let blockedOwner: string | null = null;

export async function loadBlocks(me: string): Promise<BlockedUserDto[]> {
  const list = await api<BlockedUserDto[]>('/api/blocks');
  blocked = new Set(list.map((b) => b.id));
  blockedOwner = me;
  emit();
  return list;
}

export async function blockUser(userId: string) {
  await api(`/api/blocks/${userId}`, { method: 'PUT' });
  blocked = new Set([...blocked, userId]);
  emit();
}

export async function unblockUser(userId: string) {
  await api(`/api/blocks/${userId}`, { method: 'DELETE' });
  const next = new Set(blocked);
  next.delete(userId);
  blocked = next;
  emit();
}

const muteKey = (me: string) => `jc.mute:${me}`;
let muted: { me: string; ids: ReadonlySet<string> } | null = null;

function readMuted(me: string): ReadonlySet<string> {
  if (muted?.me === me) return muted.ids;
  let ids: string[] = [];
  try {
    const v: unknown = JSON.parse(localStorage.getItem(muteKey(me)) ?? '[]');
    if (Array.isArray(v)) ids = v.filter((x): x is string => typeof x === 'string').slice(0, 500);
  } catch {
    /* storage blocked or corrupt: nobody muted */
  }
  muted = { me, ids: new Set(ids) };
  return muted.ids;
}

export function setMuted(me: string, userId: string, on: boolean) {
  const next = new Set(readMuted(me));
  if (on) next.add(userId);
  else next.delete(userId);
  muted = { me, ids: next };
  try {
    localStorage.setItem(muteKey(me), JSON.stringify([...next]));
  } catch {
    /* kept for this session only */
  }
  emit();
}

export function useMuted(me: string | undefined): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => (me ? readMuted(me) : EMPTY));
}

/** Players whose table chat I don't see: the ones I muted here and the ones I blocked. */
export function useHiddenChat(me: string | undefined): ReadonlySet<string> {
  useEffect(() => {
    if (me && blockedOwner !== me) void loadBlocks(me).catch(() => undefined);
  }, [me]);
  const mutedIds = useMuted(me);
  const blockedIds = useSyncExternalStore(subscribe, () => (me && blockedOwner === me ? blocked : EMPTY));
  return unionOf(mutedIds, blockedIds);
}

let union: { a: ReadonlySet<string>; b: ReadonlySet<string>; out: ReadonlySet<string> } | null = null;
function unionOf(a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> {
  if (union?.a !== a || union.b !== b) union = { a, b, out: b.size === 0 ? a : a.size === 0 ? b : new Set([...a, ...b]) };
  return union.out;
}
