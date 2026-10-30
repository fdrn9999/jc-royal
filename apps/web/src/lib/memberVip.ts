import type { VipColor } from '@jc/types';
import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { onRealtime } from './realtime';

/**
 * Other members' VIP colors on the screens open now (realtime `member.vip.changed`). An administrator's change reaches
 * every page as the member's id and the color others see; a screen that shows that member (a friend, a conversation, a
 * post's author, a room's host) lays it over what it read, and asks the server for nothing. A screen that does not show
 * them does nothing. The event changes a look only; the next read of the screen is the truth again.
 */

type Heard = { vip: VipColor | undefined; rev: number; at: number };
/** Each member's newest change heard (by their VIP version), and when: a read that started before it may be older. */
const heard = new Map<string, Heard>();
/** Long past any read still out; older changes are in every read since. */
const HEARD_MS = 5 * 60_000;
const subs = new Set<(id: string, vip: VipColor | undefined) => void>();
let listening: (() => void) | null = null;

function listen() {
  listening ??= onRealtime('member.vip.changed', ({ resourceId: id, revision: rev, payload }) => {
    const now = Date.now();
    for (const [k, h] of heard) if (now - h.at > HEARD_MS) heard.delete(k);
    // A repeat, or one that arrives after a newer one (two hubs): already shown, or older than what is.
    if ((heard.get(id)?.rev ?? -1) >= rev) return;
    const vip = payload.vip ?? undefined;
    heard.set(id, { vip, rev, at: now });
    for (const f of [...subs]) f(id, vip);
  });
}

/**
 * `data` with member `id`'s VIP color set to `vip` (none when undefined) wherever it holds that member: any object with
 * that `id` and a `nickname` (PublicUserDto, FriendDto, AuthorDto, a lobby host). The same object when it holds none,
 * so a screen that does not show them does not redraw.
 */
export function withMemberVip<T>(data: T, id: string, vip: VipColor | undefined): T {
  if (Array.isArray(data)) {
    let changed = false;
    const out = data.map((x: unknown) => {
      const y = withMemberVip(x, id, vip);
      if (y !== x) changed = true;
      return y;
    });
    return (changed ? out : data) as T;
  }
  if (!data || typeof data !== 'object') return data;
  const o = data as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  if (o.id === id && typeof o.nickname === 'string' && o.vip !== vip) {
    next = { ...o };
    if (vip) next.vip = vip;
    else delete next.vip;
  }
  for (const [k, v] of Object.entries(o)) {
    if (!v || typeof v !== 'object') continue;
    const w = withMemberVip(v, id, vip);
    if (w !== v) (next ??= { ...o })[k] = w;
  }
  return (next ?? data) as T;
}

/** A read that started at `startedAt` (Date.now()) with the changes heard since laid over it: it may predate them. */
export function withHeardVip<T>(data: T, startedAt: number): T {
  let out = data;
  for (const [id, h] of heard) if (h.at >= startedAt) out = withMemberVip(out, id, h.vip);
  return out;
}

/** Runs `f` for each change heard while the caller is mounted. */
export function onMemberVip(f: (id: string, vip: VipColor | undefined) => void): () => void {
  listen();
  subs.add(f);
  return () => subs.delete(f);
}

/** Keeps the members a screen's state holds in their current VIP color. */
export function useMemberVip<T>(set: Dispatch<SetStateAction<T>>) {
  useEffect(() => onMemberVip((id, vip) => set((d) => withMemberVip(d, id, vip))), [set]);
}
