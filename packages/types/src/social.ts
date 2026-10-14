import { z } from 'zod';

// ------------------------------------------------------------------ friends

/** A user as shown to other players: never email or other private fields. */
export interface PublicUserDto {
  id: string;
  nickname: string;
  avatarUrl: string | null;
}

export interface FriendDto extends PublicUserDto {
  since: number;
  /** Unread 1:1 messages from this friend. */
  unread: number;
  lastMessage: { body: string; fromMe: boolean; at: number; kind: DmKind } | null;
}

export interface FriendRequestDto extends PublicUserDto {
  at: number;
}

export interface FriendsDto {
  friends: FriendDto[];
  incoming: FriendRequestDto[];
  outgoing: FriendRequestDto[];
}

export const MAX_FRIENDS = 200;

/** Ask by nickname (friends page) or by user id (board, table seat). */
export const FriendRequestSchema = z
  .object({ nickname: z.string().trim().min(1).max(32).optional(), userId: z.string().min(1).max(64).optional() })
  .refine((v) => !!v.nickname !== !!v.userId, 'nickname or userId');
export type FriendRequestInput = z.infer<typeof FriendRequestSchema>;

/** 'accepted' when the other player had already asked, so the request completes at once. */
export interface FriendRequestResultDto {
  status: 'pending' | 'accepted';
  user: PublicUserDto;
}

/** How I stand with another player. 'blocked' means I blocked them; being blocked by them reads as 'none'. */
export type RelationKind = 'none' | 'friend' | 'outgoing' | 'incoming' | 'blocked';
export interface RelationDto {
  relation: RelationKind;
}

// ------------------------------------------------------------------ blocking & social settings

export const MAX_BLOCKS = 500;

export interface BlockedUserDto extends PublicUserDto {
  at: number;
}

export const FRIEND_REQUEST_POLICIES = ['everyone', 'nobody'] as const;
export type FriendRequestPolicy = (typeof FRIEND_REQUEST_POLICIES)[number];

export interface SocialSettingsDto {
  /** Who can send me friend requests. */
  friendRequests: FriendRequestPolicy;
  /** Count 1:1 messages in the header badge. */
  dmNotifications: boolean;
}

export const SocialSettingsSchema = z
  .object({ friendRequests: z.enum(FRIEND_REQUEST_POLICIES).optional(), dmNotifications: z.boolean().optional() })
  .refine((v) => v.friendRequests !== undefined || v.dmNotifications !== undefined, 'nothing to change');

// ------------------------------------------------------------------ 1:1 messages

export const DirectMessageSchema = z.object({ text: z.string().trim().min(1).max(500) });
/** POST /api/dm/:userId/read. upToSeq: the newest message the page has shown; without it, everything. */
export const DmReadSchema = z.object({ upToSeq: z.number().int().min(0).optional() });

/** 'invite' asks the friend to play at a table; its body is the table's name when it was sent. */
export type DmKind = 'text' | 'invite';
export const TableInviteSchema = z.object({ tableId: z.string().trim().min(1).max(64) });
/** Invite cards older than this show as expired. Joining is checked at the table either way. */
export const INVITE_FRESH_MS = 2 * 60 * 60_000;

export interface DirectMessageDto {
  id: string;
  /** Position in the conversation (1, 2, 3, …), in the order messages were saved. Pages and polls go by it. */
  seq: number;
  fromMe: boolean;
  body: string;
  kind: DmKind;
  /** The table an invite points to. */
  tableId: string | null;
  at: number;
  readAt: number | null;
}

export interface ConversationDto {
  user: PublicUserDto;
  /** Messages stay readable after unfriending, but only friends can send. */
  isFriend: boolean;
  /** I blocked this player. */
  blocked: boolean;
  /** Oldest first (by seq). */
  messages: DirectMessageDto[];
  /** With ?afterSeq: newer messages remain after this page. Otherwise: older messages remain before it. */
  hasMore: boolean;
  /** The other player has read my messages up to this seq; `at` is when the newest of them was read. */
  peerRead: { seq: number; at: number } | null;
}

/** Header badges: one poll covers the inbox, 1:1 messages and friend requests. */
export interface UnreadCountsDto {
  unread: number;
  dmUnread: number;
  friendRequests: number;
}

// ------------------------------------------------------------------ reports

export const REPORT_REASONS = ['spam', 'abuse', 'inappropriate', 'cheating', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_TARGETS = ['post', 'comment', 'player', 'dm'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];
export type ReportStatus = 'open' | 'resolved' | 'dismissed';
/** A player can still be reported this long after the two last sat at the same table. */
export const PLAYER_REPORT_WINDOW_MS = 24 * 60 * 60_000;

/** For a player report, targetId is the user id and tableId the table it happened at; for a 1:1 message, the message id. */
export const ReportCreateSchema = z
  .object({
    targetType: z.enum(REPORT_TARGETS),
    targetId: z.string().min(1).max(64),
    tableId: z.string().min(1).max(64).optional(),
    reason: z.enum(REPORT_REASONS),
    detail: z.string().trim().max(500).optional(),
  })
  .refine((v) => (v.targetType === 'player') === !!v.tableId, 'tableId is required for player reports only');
export type ReportCreateInput = z.infer<typeof ReportCreateSchema>;

/** Evidence the server captured when the report was filed. */
export type ReportContext =
  | { kind: 'post'; postId: string; title: string; body: string }
  | { kind: 'comment'; postId: string; commentId: string; body: string }
  | {
      kind: 'player';
      tableId: string;
      tableName: string;
      /** The hand in progress, or the last finished one. */
      handId: string | null;
      handNumber: number | null;
      /** The reported player's recent table chat lines. */
      chat: { text: string; at: number }[];
      /**
       * Why the server accepted it: both were at the table when reported ('present'), or both held seats there
       * in overlapping time within the report window ('history'). Reports filed before this field have neither.
       */
      basis?: 'present' | 'history';
      /** When both were seated together (history basis). */
      overlap?: { from: number; to: number } | null;
      /** Finished hands both were dealt into during that time, newest first (ids only, never cards). */
      sharedHands?: { id: string; number: number }[];
    }
  | {
      kind: 'dm';
      messageId: string;
      senderId: string;
      recipientId: string;
      /** The reported message as stored on the server. */
      body: string;
      at: number;
      /** Up to five earlier messages from the same sender in that conversation, oldest first. */
      earlier: { id: string; body: string; at: number }[];
    };

export interface ReportDto {
  id: string;
  targetType: ReportTarget;
  targetId: string;
  reason: ReportReason;
  detail: string | null;
  status: ReportStatus;
  createdAt: number;
  reporter: { id: string; nickname: string };
  target: { id: string; nickname: string; status: 'active' | 'suspended' | 'deleted' };
  context: ReportContext | null;
  /** Current visibility of the reported post or comment. */
  contentStatus: 'visible' | 'hidden' | 'deleted' | null;
  /** Other reports against the same member: all of them, and how many the staff upheld. */
  priorReports: { total: number; resolved: number };
  handledBy: { id: string; nickname: string } | null;
  handledAt: number | null;
  note: string | null;
}

export const ReportResolveSchema = z.object({
  status: z.enum(['resolved', 'dismissed']),
  note: z.string().trim().max(500).optional(),
  /** Hide the reported post or comment while resolving. */
  hideContent: z.boolean().optional(),
});
