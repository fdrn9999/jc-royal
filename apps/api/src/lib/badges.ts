/**
 * Staff badges in what other players see (packages/types/src/social.ts shownRole): the social policy says which staff
 * roles carry theirs. The rooms apply it to seats and table chat; the api to the lobby's host, the board, friends and
 * hand replays, here. Read from D1 only when a reply has a staff member in it, once per request.
 */
import { SOCIAL_POLICY_JSON } from '@jc/db';
import { publicRole, shownRole, toSocialPolicy, type PublicRole, type SocialPolicy } from '@jc/types';
import type { Context } from 'hono';
import type { AppEnv } from '../env';

const read = new WeakMap<Context<AppEnv>, Promise<SocialPolicy | null>>();

/** The social policy in force (null: no version, or one this build cannot read; SOCIAL_DEFAULTS then). */
export function socialPolicy(c: Context<AppEnv>): Promise<SocialPolicy | null> {
  let p = read.get(c);
  if (!p) {
    p = c.env.DB.prepare(`SELECT (${SOCIAL_POLICY_JSON}) AS p`)
      .first<{ p: unknown }>()
      .then((r) => toSocialPolicy(r?.p));
    read.set(c, p);
  }
  return p;
}

export type Badge = (role: string | null | undefined) => PublicRole | undefined;

/** The badge each of `roles` (stored `users.role` values) shows in this reply. Members only: no read at all. */
export async function badgesFor(c: Context<AppEnv>, roles: Iterable<string | null | undefined>): Promise<Badge> {
  for (const r of roles) {
    if (!publicRole(r)) continue;
    const policy = await socialPolicy(c);
    return (role) => shownRole(role, policy);
  }
  return publicRole;
}
