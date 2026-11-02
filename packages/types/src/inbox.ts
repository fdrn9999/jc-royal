import { z } from 'zod';
import type { VipColor } from './vip';

// ------------------------------------------------------------------ notification inbox (GET /api/notifications)
//
// The bell in the header: what happened to the member, kept in D1 (schema `notifications`) and written in the batch of
// the change it reports, so it is there exactly when the change is. It points at the screen that holds the thing (a
// friend request, a conversation, a tournament); that screen stays the truth, and an item about something already
// answered or gone says so (`state`). Notices and maintenance are everyone's: they are read from service_notices and
// maintenance_windows as they are now, and only the member's having read one is kept. Web Push (notifications.ts) is a
// separate channel with its own switches; the inbox needs none of them.

export const INBOX_KINDS = [
  'friend_request',
  'friend_accepted',
  'dm',
  'invite',
  'friend_table',
  'message',
  'tournament_start',
  'tournament_cancel',
  'tournament_result',
  'vip',
  'security',
  'notice',
  'maintenance',
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/** The filters of the list, each a set of kinds. */
export const INBOX_FILTERS = {
  social: ['friend_request', 'friend_accepted', 'dm', 'invite', 'friend_table'],
  game: ['tournament_start', 'tournament_cancel', 'tournament_result'],
  account: ['message', 'vip', 'security'],
  service: ['notice', 'maintenance'],
} as const satisfies Record<string, readonly InboxKind[]>;
export type InboxFilter = keyof typeof INBOX_FILTERS;
export const INBOX_FILTER_NAMES = Object.keys(INBOX_FILTERS) as InboxFilter[];

/** Items one page of the list holds. */
export const INBOX_PAGE = 30;
/** A table invite can be answered this long (the push of one is dropped after the same time). */
export const INBOX_INVITE_TTL_MS = 30 * 60_000;

/**
 * Where the thing an item is about stands now, read with the list: `open` it can still be acted on (a request not
 * answered yet, a table still open, a tournament running), `done` answered or over, `expired` gone or past its time.
 * Null: the kind has no state (a message, a VIP change).
 */
export type InboxState = 'open' | 'done' | 'expired';

export interface InboxActorDto {
  id: string;
  nickname: string;
  vip?: VipColor | null;
}

export interface InboxItemDto {
  /** A personal item's id, or `notice:<id>` / `maintenance:<id>` for everyone's. */
  id: string;
  kind: InboxKind;
  /** The same thing again before it was read (three messages from one friend): one item, counted. */
  count: number;
  /** When it last happened (the list is newest first by this). */
  at: number;
  readAt: number | null;
  actor: InboxActorDto | null;
  /** Small facts of the kind, never a message's text or anything private: a table's or tournament's name, a place, a color, a device. */
  params: Record<string, string | number | boolean | null>;
  state: InboxState | null;
  /** The screen it opens (a path of the member site), or null. */
  href: string | null;
}

export interface InboxPageDto {
  items: InboxItemDto[];
  /** Pass as `?before=` for the next page; null: no more. */
  next: string | null;
  /** Unread items in total (all filters). */
  unread: number;
}

export const InboxListQuerySchema = z.object({
  filter: z.enum(INBOX_FILTER_NAMES as [InboxFilter, ...InboxFilter[]]).optional(),
  unread: z.enum(['1']).optional(),
  before: z
    .string()
    .regex(/^\d{1,15}:[A-Za-z0-9:_-]{1,120}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(INBOX_PAGE).optional(),
});

/** POST /api/notifications/read: these items (ids as the list gives them), or every one (of a filter). */
export const InboxReadSchema = z.union([
  z.object({ ids: z.array(z.string().min(1).max(120)).min(1).max(INBOX_PAGE) }).strict(),
  z.object({ all: z.literal(true), filter: z.enum(INBOX_FILTER_NAMES as [InboxFilter, ...InboxFilter[]]).optional() }).strict(),
]);
export type InboxReadBody = z.infer<typeof InboxReadSchema>;
