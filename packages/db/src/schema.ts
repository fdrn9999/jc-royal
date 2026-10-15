import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch('subsec') * 1000)`;

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    nickname: text('nickname').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['user', 'admin', 'super_admin'] }).notNull().default('user'),
    status: text('status', { enum: ['active', 'suspended', 'deleted'] }).notNull().default('active'),
    /** Wallet balance in virtual chips. Only changed together with a chip_ledger row. */
    balance: integer('balance').notNull().default(0),
    avatarUrl: text('avatar_url'),
    locale: text('locale', { enum: ['ko', 'en'] }).notNull().default('ko'),
    /** YYYY-MM-DD given at signup. Null for accounts created before it was collected. */
    birthDate: text('birth_date'),
    /** When the signup email code was confirmed. Null when verification was off or for older accounts. */
    emailVerifiedAt: integer('email_verified_at'),
    suspendedReason: text('suspended_reason'),
    /** Privacy notice version accepted at signup and when. Null for accounts created before consent was recorded. */
    privacyConsentVersion: text('privacy_consent_version'),
    privacyConsentAt: integer('privacy_consent_at'),
    /** Who may send this member friend requests. */
    friendRequests: text('friend_requests', { enum: ['everyone', 'nobody'] }).notNull().default('everyone'),
    /** Whether unread 1:1 messages count toward the header badge. */
    dmNotifications: integer('dm_notifications', { mode: 'boolean' }).notNull().default(true),
    /** Last member sign-in (signup or login), kept after the session itself ends. Null before it was recorded. */
    lastLoginAt: integer('last_login_at'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    uniqueIndex('users_nickname_uq').on(sql`lower(${t.nickname})`),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    /** SHA-256 of the cookie token; the raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    kind: text('kind', { enum: ['user', 'admin'] }).notNull(),
    /** Admin sessions: last password re-confirmation, required for sensitive actions. */
    reauthAt: integer('reauth_at'),
    createdAt: integer('created_at').notNull().default(now),
    lastSeenAt: integer('last_seen_at').notNull().default(now),
    expiresAt: integer('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** "자동 로그인": a 30-day cookie and session. Off: the cookie ends with the browser, the session after a day idle. */
    remember: integer('remember', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [uniqueIndex('sessions_token_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

export const passwordResets = sqliteTable('password_resets', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  createdAt: integer('created_at').notNull().default(now),
});

/**
 * Sign-up email codes, one row per address (a new request replaces the old one).
 * Rows are deleted on sign-up and swept a day after they expire.
 */
export const emailVerifications = sqliteTable('email_verifications', {
  email: text('email').primaryKey(),
  /** SHA-256 of `${email}:${code}`. */
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: integer('expires_at').notNull(),
  /** Set once the code is confirmed: SHA-256 of the one-time proof that /register consumes. */
  proofHash: text('proof_hash'),
  verifiedAt: integer('verified_at'),
  createdAt: integer('created_at').notNull().default(now),
});

export const chipLedger = sqliteTable(
  'chip_ledger',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    type: text('type', {
      enum: ['signup_grant', 'buy_in', 'top_up', 'cash_out', 'admin_adjust', 'reconcile'],
    }).notNull(),
    /** Signed delta applied to users.balance. */
    amount: integer('amount').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    tableId: text('table_id'),
    refId: text('ref_id'),
    /** Unique per logical operation; makes grants/buy-ins/cash-outs idempotent. */
    idempotencyKey: text('idempotency_key').notNull(),
    actorId: text('actor_id'),
    memo: text('memo'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('ledger_idem_uq').on(t.idempotencyKey), index('ledger_user_idx').on(t.userId, t.createdAt)],
);

export const tables = sqliteTable(
  'tables',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    maxSeats: integer('max_seats').notNull(),
    smallBlind: integer('small_blind').notNull(),
    bigBlind: integer('big_blind').notNull(),
    minBuyIn: integer('min_buy_in').notNull(),
    maxBuyIn: integer('max_buy_in').notNull(),
    turnSeconds: integer('turn_seconds').notNull().default(20),
    isPrivate: integer('is_private', { mode: 'boolean' }).notNull().default(false),
    joinCodeHash: text('join_code_hash'),
    allowSpectators: integer('allow_spectators', { mode: 'boolean' }).notNull().default(true),
    /** Shown in the lobby with an "입문 테이블" tag (low stakes for newcomers). */
    beginner: integer('beginner', { mode: 'boolean' }).notNull().default(false),
    entryBlocked: integer('entry_blocked', { mode: 'boolean' }).notNull().default(false),
    /** Emergency control: no new hand starts (the one running finishes normally) until an admin resumes the table. */
    handsPaused: integer('hands_paused', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: ['open', 'closing', 'closed'] }).notNull().default('open'),
    /** Live occupancy mirrored by the table room (informational, for lobby/admin). */
    liveSeated: integer('live_seated').notNull().default(0),
    livePlaying: integer('live_playing', { mode: 'boolean' }).notNull().default(false),
    liveWaitlist: integer('live_waitlist').notNull().default(0),
    liveSpectators: integer('live_spectators').notNull().default(0),
    liveConnections: integer('live_connections').notNull().default(0),
    handsPlayed: integer('hands_played').notNull().default(0),
    lastIssue: text('last_issue'),
    liveUpdatedAt: integer('live_updated_at'),
    createdBy: text('created_by').references(() => users.id),
    /**
     * 'official' tables are opened by admins. A 'member' room is opened by a member (createdBy, the host), who can
     * rename it, change spectating and the join code, and close it; never touch chips, cards or results.
     */
    roomType: text('room_type', { enum: ['official', 'member'] }).notNull().default('official'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('tables_status_idx').on(t.status), index('tables_creator_idx').on(t.createdBy, t.status)],
);

/** One row per buy-in → cash-out cycle of a user at a table. */
export const tableSessions = sqliteTable(
  'table_sessions',
  {
    id: text('id').primaryKey(),
    tableId: text('table_id').notNull().references(() => tables.id),
    userId: text('user_id').notNull().references(() => users.id),
    seatIndex: integer('seat_index').notNull(),
    buyIn: integer('buy_in').notNull(),
    cashOut: integer('cash_out'),
    status: text('status', { enum: ['seated', 'closed'] }).notNull().default('seated'),
    createdAt: integer('created_at').notNull().default(now),
    closedAt: integer('closed_at'),
  },
  (t) => [
    // A user can only hold one open seat per table at a time.
    uniqueIndex('tsess_open_user_uq').on(t.tableId, t.userId).where(sql`status = 'seated'`),
    index('tsess_user_idx').on(t.userId),
  ],
);

export const hands = sqliteTable(
  'hands',
  {
    id: text('id').primaryKey(),
    tableId: text('table_id').notNull().references(() => tables.id),
    handNumber: integer('hand_number').notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at').notNull(),
    board: text('board').notNull(),
    potTotal: integer('pot_total').notNull(),
    engineVersion: text('engine_version').notNull(),
    /** Full engine event log incl. hole cards. Restricted: audit only, finished hands only. */
    eventLog: text('event_log').notNull(),
  },
  (t) => [index('hands_table_idx').on(t.tableId, t.endedAt)],
);

export const handPlayers = sqliteTable(
  'hand_players',
  {
    handId: text('hand_id').notNull().references(() => hands.id),
    userId: text('user_id').notNull().references(() => users.id),
    seatIndex: integer('seat_index').notNull(),
    holeCards: text('hole_cards').notNull(),
    stackStart: integer('stack_start').notNull(),
    stackEnd: integer('stack_end').notNull(),
    net: integer('net').notNull(),
    won: integer('won').notNull(),
    rankClass: text('rank_class'),
    rankValue: integer('rank_value'),
    bestFive: text('best_five'),
    wentToShowdown: integer('went_to_showdown', { mode: 'boolean' }).notNull(),
    endedAt: integer('ended_at').notNull(),
    // Statistics derived from the hand's public action log by HAND_STATS_SQL (see handStats.ts). NULL until it ran;
    // vpip/pfr/saw_flop/position stay NULL when the log can't be read.
    position: text('position'),
    vpip: integer('vpip', { mode: 'boolean' }),
    pfr: integer('pfr', { mode: 'boolean' }),
    sawFlop: integer('saw_flop', { mode: 'boolean' }),
    /** Chips won from the pot, without the player's own uncalled chips handed back. */
    potWon: integer('pot_won'),
    /**
     * The hole cards were face up for the table at showdown; false for a mucked losing hand. NULL on rows recorded
     * before the column existed, which read as `went_to_showdown` (nobody could muck then).
     */
    shown: integer('shown', { mode: 'boolean' }),
  },
  (t) => [
    primaryKey({ columns: [t.handId, t.userId] }),
    index('hp_user_idx').on(t.userId, t.endedAt),
    // Rows HAND_STATS_SQL still has to fill.
    index('hp_stats_todo_idx').on(t.handId).where(sql`pot_won IS NULL`),
  ],
);

export const adminAuditLog = sqliteTable(
  'admin_audit_log',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    detail: text('detail'),
    ip: text('ip'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    index('audit_created_idx').on(t.createdAt),
    // A member's (or table's) action history on its detail page.
    index('audit_target_idx').on(t.targetType, t.targetId, t.createdAt),
  ],
);

/**
 * Internal notes administrators leave on a member for handover (why a sanction was given, what to watch). Never shown
 * to the member. Not a place for personal data: the API refuses e-mail addresses and phone or ID numbers. Deleted with
 * the account, and by their author or a super admin (the audit log keeps who deleted which note, not its text).
 */
export const adminNotes = sqliteTable(
  'admin_notes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    authorId: text('author_id').notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('admin_notes_user_idx').on(t.userId, t.createdAt)],
);

export const reconciliationEvents = sqliteTable('reconciliation_events', {
  id: text('id').primaryKey(),
  scope: text('scope', { enum: ['user_ledger', 'table'] }).notNull(),
  subjectId: text('subject_id').notNull(),
  expected: integer('expected').notNull(),
  actual: integer('actual').notNull(),
  detail: text('detail'),
  resolvedBy: text('resolved_by'),
  resolvedAt: integer('resolved_at'),
  createdAt: integer('created_at').notNull().default(now),
});

/** Fixed-window rate limit counters. */
export const rateLimits = sqliteTable('rate_limits', {
  key: text('key').primaryKey(),
  windowStart: integer('window_start').notNull(),
  count: integer('count').notNull(),
});


// ------------------------------------------------------------------ community

/** Board posts. Notices (is_notice) are written by admins and pinned above regular posts. */
export const posts = sqliteTable(
  'posts',
  {
    id: text('id').primaryKey(),
    authorId: text('author_id').notNull().references(() => users.id),
    title: text('title').notNull(),
    body: text('body').notNull(),
    isNotice: integer('is_notice', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: ['visible', 'hidden', 'deleted'] }).notNull().default('visible'),
    commentCount: integer('comment_count').notNull().default(0),
    viewCount: integer('view_count').notNull().default(0),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('posts_list_idx').on(t.status, t.isNotice, t.createdAt), index('posts_author_idx').on(t.authorId, t.createdAt)],
);

/** Hands attached to a post for hand review (author must have played them). */
export const postHands = sqliteTable(
  'post_hands',
  {
    postId: text('post_id').notNull().references(() => posts.id),
    handId: text('hand_id').notNull().references(() => hands.id),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.postId, t.handId] })],
);

export const comments = sqliteTable(
  'comments',
  {
    id: text('id').primaryKey(),
    postId: text('post_id').notNull().references(() => posts.id),
    authorId: text('author_id').notNull().references(() => users.id),
    /** Replies point at a top-level comment (two-level threads). */
    parentId: text('parent_id'),
    /** For replies to a reply: whom it answers (shown as @nickname). */
    replyToUserId: text('reply_to_user_id'),
    body: text('body').notNull(),
    status: text('status', { enum: ['visible', 'hidden', 'deleted'] }).notNull().default('visible'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('comments_post_idx').on(t.postId, t.createdAt), index('comments_author_idx').on(t.authorId, t.createdAt)],
);

/** One-way messages from administrators / the system to a user. */
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    category: text('category', { enum: ['system', 'event', 'sanction', 'notice', 'admin'] }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** Admin who sent it; null for automatic system messages. */
    senderId: text('sender_id'),
    /** Groups one manual send to several recipients. */
    batchId: text('batch_id'),
    readAt: integer('read_at'),
    deletedAt: integer('deleted_at'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('messages_user_idx').on(t.userId, t.createdAt), index('messages_batch_idx').on(t.batchId)],
);

/** Academy learning progress (client-side model, versioned JSON). One row per user. */
export const academyProgress = sqliteTable('academy_progress', {
  userId: text('user_id').primaryKey().references(() => users.id),
  data: text('data').notNull(),
  version: integer('version').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Cosmetic achievements. Never linked to chips or the ledger. */
export const userBadges = sqliteTable(
  'user_badges',
  {
    userId: text('user_id').notNull().references(() => users.id),
    badge: text('badge').notNull(),
    awardedAt: integer('awarded_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.userId, t.badge] })],
);

/** Anonymous aggregate counters for Academy content (no user id is stored). */
export const academyStats = sqliteTable(
  'academy_stats',
  {
    kind: text('kind', { enum: ['lesson', 'question', 'scenario'] }).notNull(),
    itemId: text('item_id').notNull(),
    starts: integer('starts').notNull().default(0),
    completes: integer('completes').notNull().default(0),
    correct: integer('correct').notNull().default(0),
    wrong: integer('wrong').notNull().default(0),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.kind, t.itemId] })],
);

// ------------------------------------------------------------------ social

/**
 * Friend links, one row per pair with user_a < user_b. A row is a pending request
 * until the other side accepts; declining, cancelling and unfriending delete it.
 */
export const friendships = sqliteTable(
  'friendships',
  {
    userA: text('user_a').notNull().references(() => users.id),
    userB: text('user_b').notNull().references(() => users.id),
    requesterId: text('requester_id').notNull(),
    status: text('status', { enum: ['pending', 'accepted'] }).notNull().default('pending'),
    createdAt: integer('created_at').notNull().default(now),
    acceptedAt: integer('accepted_at'),
  },
  (t) => [primaryKey({ columns: [t.userA, t.userB] }), index('friendships_b_idx').on(t.userB)],
);

/**
 * A member's personal block list. Blocking removes the friendship or pending requests between the two and stops
 * new requests and 1:1 messages both ways. It is private to the blocker and is not an admin sanction.
 */
export const userBlocks = sqliteTable(
  'user_blocks',
  {
    blockerId: text('blocker_id').notNull().references(() => users.id),
    blockedId: text('blocked_id').notNull().references(() => users.id),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] }), index('user_blocks_blocked_idx').on(t.blockedId)],
);

/** 1:1 messages between friends. pair_key is the two user ids sorted and joined with ':'. */
export const directMessages = sqliteTable(
  'direct_messages',
  {
    id: text('id').primaryKey(),
    pairKey: text('pair_key').notNull(),
    senderId: text('sender_id').notNull().references(() => users.id),
    recipientId: text('recipient_id').notNull().references(() => users.id),
    /** For an invite, the table's name when it was sent. */
    body: text('body').notNull(),
    /** 'invite' asks the friend to play at tableId. */
    kind: text('kind', { enum: ['text', 'invite'] }).notNull().default('text'),
    tableId: text('table_id').references(() => tables.id),
    readAt: integer('read_at'),
    createdAt: integer('created_at').notNull().default(now),
    /**
     * Position in the conversation (1, 2, 3, …), given out in the statement that saves the message, so it follows the
     * order messages were saved even where createdAt (the worker's clock) ties or runs backwards. Clients page and
     * poll by it.
     */
    seq: integer('seq').notNull().default(0),
  },
  (t) => [
    index('dm_pair_idx').on(t.pairKey, t.createdAt),
    uniqueIndex('dm_pair_seq_uq').on(t.pairKey, t.seq),
    index('dm_unread_idx').on(t.recipientId, t.readAt),
  ],
);

/** Reports of board content, of a player at a table, or of a 1:1 message, reviewed by admins. */
export const reports = sqliteTable(
  'reports',
  {
    id: text('id').primaryKey(),
    reporterId: text('reporter_id').notNull().references(() => users.id),
    targetType: text('target_type', { enum: ['post', 'comment', 'player', 'dm'] }).notNull(),
    /** Post, comment or 1:1 message id; the user id for player reports. */
    targetId: text('target_id').notNull(),
    /** Author of the content, or the reported player. */
    targetUserId: text('target_user_id').notNull().references(() => users.id),
    reason: text('reason', { enum: ['spam', 'abuse', 'inappropriate', 'cheating', 'other'] }).notNull(),
    detail: text('detail'),
    /** Evidence captured by the server at report time (content snapshot, table chat, hand), JSON. */
    context: text('context'),
    status: text('status', { enum: ['open', 'resolved', 'dismissed'] }).notNull().default('open'),
    handledBy: text('handled_by'),
    handledAt: integer('handled_at'),
    note: text('note'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    index('reports_status_idx').on(t.status, t.createdAt),
    index('reports_target_user_idx').on(t.targetUserId, t.createdAt),
    // What a member has reported, on their admin detail page.
    index('reports_reporter_idx').on(t.reporterId, t.createdAt),
    // One open report per reporter and target; a new one is possible after review.
    uniqueIndex('reports_open_uq').on(t.reporterId, t.targetType, t.targetId).where(sql`status = 'open'`),
  ],
);

// ------------------------------------------------------------------ operations

/**
 * Per-minute counters of rare events for the admin dashboard (see ops.ts): `bucket` is the minute (epoch ms) and
 * every room and request adds to the same row. Kept for OPS_RETENTION_MS by the daily housekeeping.
 */
export const opsMetrics = sqliteTable(
  'ops_metrics',
  {
    bucket: integer('bucket').notNull(),
    metric: text('metric').notNull(),
    n: integer('n').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.metric] })],
);