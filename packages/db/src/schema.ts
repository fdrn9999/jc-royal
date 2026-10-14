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
    suspendedReason: text('suspended_reason'),
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

export const chipLedger = sqliteTable(
  'chip_ledger',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    type: text('type', {
      enum: ['signup_grant', 'buy_in', 'cash_out', 'admin_adjust', 'reconcile'],
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

export const tables = sqliteTable('tables', {
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
  entryBlocked: integer('entry_blocked', { mode: 'boolean' }).notNull().default(false),
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
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
});

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
  },
  (t) => [primaryKey({ columns: [t.handId, t.userId] }), index('hp_user_idx').on(t.userId, t.endedAt)],
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
  (t) => [index('audit_created_idx').on(t.createdAt)],
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
