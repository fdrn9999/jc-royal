import { z } from 'zod';
import { DEFAULT_REACTION_RULES, type ReactionRules } from './protocol';
import type { VipColor } from './vip';

// ------------------------------------------------------------------ public role

/**
 * The staff role other players see next to a name (SUPER ADMIN, ADMIN). Taken from `users.role` on the server only;
 * ordinary members carry none, so the field is simply absent for them.
 */
export type PublicRole = 'admin' | 'super_admin';

/** The public role of a stored `users.role` value: staff roles only. */
export function publicRole(role: string | null | undefined): PublicRole | undefined {
  return role === 'admin' || role === 'super_admin' ? role : undefined;
}

/** The badge `role` carries under `policy` (see SocialSettings): none for a member, or for a staff role it hides. */
export function shownRole(role: string | null | undefined, policy: Pick<SocialSettings, 'showAdmin' | 'showSuperAdmin'> | null | undefined): PublicRole | undefined {
  const r = publicRole(role);
  const p = policy ?? SOCIAL_DEFAULTS;
  return r === 'super_admin' ? (p.showSuperAdmin ? r : undefined) : r === 'admin' ? (p.showAdmin ? r : undefined) : undefined;
}

// ------------------------------------------------------------------ social policy

/**
 * The service-wide social policy (social_policies, newest version; a super admin's). Quick reactions: on, and how fast
 * one seated player may send them (ReactionRules, applied by the room and mirrored by the client). Staff badges: which
 * roles carry theirs next to their name wherever other players see it (seats, table chat, the lobby's host, the board,
 * friends and blocks, hand replays). A hidden badge is left out of what the server sends; the role itself is unchanged.
 */
export interface SocialSettings extends ReactionRules {
  reactionsEnabled: boolean;
  showSuperAdmin: boolean;
  showAdmin: boolean;
}
export interface SocialPolicy extends SocialSettings {
  version: number;
}

/** What the service did before the policy existed, and what a reader uses when it cannot read one. */
export const SOCIAL_DEFAULTS: SocialSettings = { reactionsEnabled: true, ...DEFAULT_REACTION_RULES, showSuperAdmin: true, showAdmin: true };

export const SOCIAL_LIMITS = {
  cooldownMs: { min: 500, max: 30_000 },
  burstMax: { min: 1, max: 20 },
  burstWindowMs: { min: 5_000, max: 300_000 },
} as const;

/** A policy read with SOCIAL_POLICY_JSON (@jc/db): null for none, or for one this build cannot read (the defaults then). */
export function toSocialPolicy(raw: unknown): SocialPolicy | null {
  if (typeof raw !== 'string') return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const n = (k: keyof typeof SOCIAL_LIMITS) => {
      const v = p[k];
      return Number.isSafeInteger(v) && (v as number) >= SOCIAL_LIMITS[k].min && (v as number) <= SOCIAL_LIMITS[k].max ? (v as number) : null;
    };
    const [cooldownMs, burstMax, burstWindowMs] = [n('cooldownMs'), n('burstMax'), n('burstWindowMs')];
    if (!Number.isSafeInteger(p.version) || cooldownMs == null || burstMax == null || burstWindowMs == null) return null;
    return {
      version: p.version as number,
      reactionsEnabled: p.reactionsEnabled === 1,
      cooldownMs,
      burstMax,
      burstWindowMs,
      showSuperAdmin: p.showSuperAdmin === 1,
      showAdmin: p.showAdmin === 1,
    };
  } catch {
    return null;
  }
}

/** The reaction limits a table shows its players under `policy`: null when reactions are off. */
export function reactionRulesOf(policy: SocialSettings | null | undefined): ReactionRules | null {
  const p = policy ?? SOCIAL_DEFAULTS;
  return p.reactionsEnabled ? { cooldownMs: p.cooldownMs, burstMax: p.burstMax, burstWindowMs: p.burstWindowMs } : null;
}

// ------------------------------------------------------------------ friends

/** A user as shown to other players: never email or other private fields. */
export interface PublicUserDto {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  /** Staff only (see PublicRole). */
  role?: PublicRole;
  /** A VIP member's name color (see shownVip): never with a role. */
  vip?: VipColor;
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
  /** ServiceStatusDto.rev: a change means the banner should be fetched again. */
  serviceRev?: number;
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
  /** Other reports against the same member: all of them, how many the staff upheld, and how many different members filed them. */
  priorReports: { total: number; resolved: number; reporters: number };
  handledBy: { id: string; nickname: string } | null;
  handledAt: number | null;
  note: string | null;
  /** Set by staff while working the report; null = not rated yet. */
  severity: ReportSeverity | null;
  /** The administrator working on it. */
  assignee: { id: string; nickname: string } | null;
  assignedAt: number | null;
  /** Whether the reporter and the reported member were told the outcome; null while open. */
  notice: { reporter: boolean; target: boolean } | null;
  /** The reported member's last five suspensions, lifts and forced disconnects, newest first. */
  sanctions: ReportSanction[];
}

/** A sanction on the reported member, from the audit log. `reportId` is set when it was given from a report. */
export interface ReportSanction {
  action: 'user.suspend' | 'user.unsuspend' | 'user.disconnect';
  at: number;
  reason: string | null;
  reportId: string | null;
  actor: { id: string; nickname: string | null };
}

export const ReportResolveSchema = z
  .object({
    status: z.enum(['resolved', 'dismissed']),
    note: z.string().trim().max(500).optional(),
    /** Hide the reported post or comment while resolving. */
    hideContent: z.boolean().optional(),
    /** Tell each member who reported it how it ended (no names, no internal note). */
    notifyReporter: z.boolean().optional(),
    /** Tell the reported member the report was upheld (resolved only; never who reported it). */
    notifyTarget: z.boolean().optional(),
  })
  .refine((v) => !v.notifyTarget || v.status === 'resolved', 'notifyTarget applies to upheld reports only');

export const REPORT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type ReportSeverity = (typeof REPORT_SEVERITIES)[number];

/** PATCH /api/admin/reports/:id — one change at a time: severity, who works on it, or take it if nobody does. */
export const ReportPatchSchema = z
  .strictObject({
    severity: z.enum(REPORT_SEVERITIES).nullable().optional(),
    assigneeId: z.string().min(1).max(64).nullable().optional(),
    take: z.literal(true).optional(),
  })
  .refine((v) => Object.keys(v).length === 1, 'exactly one of severity, assigneeId or take');

export const ReportNoteSchema = z.object({ body: z.string().trim().min(2).max(500) });

export type ReportEventKind = 'note' | 'severity' | 'assign' | 'status' | 'sanction';

/** One entry of a report's history (GET /api/admin/reports/:id/events), oldest first. */
export interface ReportEventDto {
  id: string;
  kind: ReportEventKind;
  /** Before and after: a severity, an administrator id (assign), a status, or the sanction's audit action. */
  from: string | null;
  to: string | null;
  /** Nicknames for an assign event's administrators. */
  fromName: string | null;
  toName: string | null;
  /** A note's text, the decision note, or the sanction's reason. */
  body: string | null;
  actor: { id: string; nickname: string | null };
  createdAt: number;
}

/** GET /api/admin/reports */
export interface ReportListDto {
  items: ReportDto[];
  total: number;
  page: number;
  limit: number;
  /** Open reports overall, whatever the filters. */
  openCount: number;
}

export const REPORT_STATS_DAYS = [7, 30, 90] as const;

interface ReportOutcomes {
  total: number;
  open: number;
  resolved: number;
  dismissed: number;
  /** Average time from filing to decision of those closed; null if none. */
  avgHandleMs: number | null;
}

/** GET /api/admin/reports/stats?days= — reference figures for staff; nothing here acts on a member. */
export interface ReportStatsDto {
  days: number;
  since: number;
  /** Reports filed in the period. */
  byReason: (ReportOutcomes & { reason: ReportReason })[];
  byTarget: (ReportOutcomes & { targetType: ReportTarget })[];
  /** Every open report, whenever filed. */
  backlog: {
    open: number;
    unassigned: number;
    over24h: number;
    over72h: number;
    oldestOpenAt: number | null;
    bySeverity: Record<ReportSeverity | 'none', number>;
  };
  /** Reports decided in the period. */
  handled: { count: number; avgMs: number | null; maxMs: number | null };
  /** Members reported at least twice in the period, most reported first (top 20). */
  repeated: {
    user: { id: string; nickname: string; status: 'active' | 'suspended' | 'deleted' };
    reports: number;
    reporters: number;
    open: number;
    resolved: number;
    dismissed: number;
    lastAt: number;
    /** Suspensions ever given to the member. */
    suspensions: number;
  }[];
}
