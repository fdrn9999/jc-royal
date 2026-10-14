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
  lastMessage: { body: string; fromMe: boolean; at: number } | null;
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

// ------------------------------------------------------------------ 1:1 messages

export const DirectMessageSchema = z.object({ text: z.string().trim().min(1).max(500) });

export interface DirectMessageDto {
  id: string;
  fromMe: boolean;
  body: string;
  at: number;
  readAt: number | null;
}

export interface ConversationDto {
  user: PublicUserDto;
  /** Messages stay readable after unfriending, but only friends can send. */
  isFriend: boolean;
  /** Oldest first. */
  messages: DirectMessageDto[];
  hasMore: boolean;
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
export const REPORT_TARGETS = ['post', 'comment', 'player'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];
export type ReportStatus = 'open' | 'resolved' | 'dismissed';

/** For a player report, targetId is the user id and tableId the table it happened at. */
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
