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
    /**
     * A table bot's account (apps/game-worker/src/bots.ts): it cannot sign in, never appears among members, and its
     * chips come from the bot fund (chip_ledger type bot_fund), never from the signup grant.
     */
    isBot: integer('is_bot', { mode: 'boolean' }).notNull().default(false),
    /**
     * How the member shows to friends (packages/types/src/presence.ts): auto (online, away after a while without
     * activity), away (never online), invisible (always offline). Written only when the member changes it.
     */
    presenceMode: text('presence_mode', { enum: ['auto', 'away', 'invisible'] }).notNull().default('auto'),
    /**
     * VIP (packages/types/src/vip.ts): the name color an administrator chose, a VIP_COLORS key; null for a member who
     * is not VIP. A look only: no game, chip or permission code reads it. Changed only by PATCH /api/admin/users/:id/vip,
     * which raises vip_version each time (a second administrator's stale change is refused) and audits it.
     */
    vipColor: text('vip_color'),
    vipVersion: integer('vip_version').notNull().default(0),
    vipChangedAt: integer('vip_changed_at'),
    vipChangedBy: text('vip_changed_by'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    uniqueIndex('users_nickname_uq').on(sql`lower(${t.nickname})`),
    // Administrators only (the people a report can be assigned to), without reading every member.
    index('users_staff_idx').on(t.role, t.status).where(sql`role != 'user'`),
    // Bot accounts only, for a room picking an idle one.
    index('users_bot_idx').on(t.status).where(sql`is_bot = 1`),
    // VIP members only, for the console's VIP filter.
    index('users_vip_idx').on(t.status).where(sql`vip_color IS NOT NULL`),
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
      enum: ['signup_grant', 'buy_in', 'top_up', 'cash_out', 'admin_adjust', 'reconcile', 'free_refill', 'bot_fund', 'referral'],
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
    /** Of live_seated, the table bots. */
    liveBots: integer('live_bots').notNull().default(0),
    handsPlayed: integer('hands_played').notNull().default(0),
    lastIssue: text('last_issue'),
    liveUpdatedAt: integer('live_updated_at'),
    createdBy: text('created_by').references(() => users.id),
    /**
     * 'official' tables are opened by admins. A 'member' room is opened by a member (createdBy, the host), who can
     * rename it, change spectating and the join code, and close it; never touch chips, cards or results. A 'tournament'
     * table is opened by a tournament's start (tournaments.table_id) and plays tournament chips only (docs/TOURNAMENT.md).
     */
    roomType: text('room_type', { enum: ['official', 'member', 'tournament'] }).notNull().default('official'),
    /**
     * Table bots (official tables only, and only while the bot policy is on): once ot_min_humans members sit, bots
     * of ot_level join one at a time until ot_fill_to players sit, never more than ot_max bots. With
     * ot_yield a bot leaves after its hand for each member waiting for a seat.
     */
    botsEnabled: integer('bots_enabled', { mode: 'boolean' }).notNull().default(false),
    botLevel: text('bot_level', { enum: ['easy', 'normal', 'hard', 'expert'] }).notNull().default('normal'),
    botMinHumans: integer('bot_min_humans').notNull().default(1),
    botMax: integer('bot_max').notNull().default(1),
    botFillTo: integer('bot_fill_to').notNull().default(2),
    botYield: integer('bot_yield', { mode: 'boolean' }).notNull().default(true),
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
    // Seats closed in a period, for the daily statistics (only closed seats, which have a closing time).
    index('tsess_closed_idx').on(t.closedAt).where(sql`closed_at IS NOT NULL`),
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
    /** Table bots dealt in, so statistics can keep hands with bots apart from hands among members only. */
    bots: integer('bots').notNull().default(0),
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

/**
 * A member's own bookmark, tags and memo on a hand they were dealt into (apps/api/src/lib/handNotes.ts). Only the
 * member reads or writes it: no admin route returns it, and audit and logs carry ids and error codes, never the memo or
 * the tags. A row that is emptied stays (so `rev` keeps counting); it is removed when the member withdraws.
 */
export const handNotes = sqliteTable(
  'hand_notes',
  {
    userId: text('user_id').notNull(),
    handId: text('hand_id').notNull(),
    /** The hand's end, copied from hand_players so lists of bookmarked or tagged hands read in order from this table. */
    endedAt: integer('ended_at').notNull(),
    bookmarked: integer('bookmarked', { mode: 'boolean' }).notNull().default(false),
    /** HAND_TAGS as bits: review 1, bluff 2, hard call 4, big pot 8. */
    tags: integer('tags').notNull().default(0),
    memo: text('memo'),
    /** Memo revision, raised on every memo change; a memo save names the revision it started from. */
    rev: integer('rev').notNull().default(0),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.userId, t.handId] }), index('hand_notes_user_idx').on(t.userId, t.endedAt)],
);

/**
 * A member's account settings (apps/api/src/lib/settings.ts): the table look and aids and the favourite tables, the
 * same on every device. Each value carries when it was changed (by the server's clock) and the revision that changed
 * it, so the newest change wins one setting or table at a time. An administrator may reset it (never edit it): the
 * values before are kept in `prev` for SETTINGS_RESTORE_MS, and `epoch` tells devices to drop what they had not saved.
 * Removed when the member withdraws.
 */
export const userSettings = sqliteTable('user_settings', {
  userId: text('user_id').primaryKey(),
  /** {setting: [value, changedAt, rev]}: only settings the account has a value for. */
  prefs: text('prefs').notNull().default('{}'),
  /** {tableId: [1 on | 0 off, changedAt, rev]}: tables taken off stay a while, so an older device can't add them back. */
  fav: text('fav').notNull().default('{}'),
  rev: integer('rev').notNull().default(0),
  epoch: integer('epoch').notNull().default(0),
  schemaVersion: integer('schema_version').notNull().default(1),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
  /** The member's devices last loaded or saved them (written at most every SETTINGS_SYNC_MARK_MS). */
  syncedAt: integer('synced_at'),
  resetAt: integer('reset_at'),
  resetBy: text('reset_by'),
  /** The revision the reset made: it can be undone only while `rev` is still this. */
  resetRev: integer('reset_rev'),
  /** {prefs, fav} before the reset, until it is undone or the member changes something. */
  prev: text('prev'),
  /** When the last reset was undone (null while it stands). */
  restoredAt: integer('restored_at'),
});

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
    /** 'failed': an attempt the API refused or that broke off (the action names it, e.g. `user.suspend.failed`). */
    outcome: text('outcome', { enum: ['ok', 'failed'] }).notNull().default('ok'),
  },
  (t) => [
    index('audit_created_idx').on(t.createdAt),
    // A member's (or table's) action history on its detail page.
    index('audit_target_idx').on(t.targetType, t.targetId, t.createdAt),
    // The audit log page: one administrator's actions, one kind of action, failed attempts.
    index('audit_actor_idx').on(t.actorId, t.createdAt),
    index('audit_action_idx').on(t.action, t.createdAt),
    index('audit_failed_idx').on(t.createdAt).where(sql`outcome = 'failed'`),
  ],
);

/**
 * What one plain administrator may use (apps/api/src/lib/permissions.ts GRANTS), set by a super admin. A feature not in
 * the list is off, and an administrator without a row has none: a new administrator starts with nothing. Super admins
 * hold every feature and need no row. `version` counts the saves, so two super admins editing at once are told of the
 * conflict. Removed when the account's role changes.
 */
export const adminPermissions = sqliteTable('admin_permissions', {
  userId: text('user_id').primaryKey(),
  /** JSON array of the features that are on. */
  grants: text('grants').notNull().default('[]'),
  version: integer('version').notNull().default(1),
  updatedBy: text('updated_by'),
  updatedAt: integer('updated_at').notNull().default(now),
});

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
  /**
   * How it was resolved: 'note' acknowledged with a note only (the mismatch stays, and is not reopened while the
   * difference is the same), 'record' the difference written to the ledger as it is, 'revert' the wallet put back to
   * the ledger. NULL on events resolved before the column existed, which were notes.
   */
  resolution: text('resolution', { enum: ['note', 'record', 'revert'] }),
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

/**
 * Advanced GTO Academy progress, kept apart from the beginner course's row: an older client reading academy_progress
 * would drop fields it does not know, so the two never share one JSON. Same shape and rules (versioned client JSON,
 * last write wins by updated_at); no badges, chips or ledger.
 */
export const academyGtoProgress = sqliteTable('academy_gto_progress', {
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
    /** Staff rating while working the report; null = not rated yet. */
    severity: text('severity', { enum: ['low', 'medium', 'high', 'critical'] }),
    /** The administrator working on it, and since when. */
    assigneeId: text('assignee_id'),
    assignedAt: integer('assigned_at'),
    /** Set when closed: whether the reporter and the reported member were sent the outcome (null on older reports). */
    noticeReporter: integer('notice_reporter', { mode: 'boolean' }),
    noticeTarget: integer('notice_target', { mode: 'boolean' }),
  },
  (t) => [
    index('reports_status_idx').on(t.status, t.createdAt),
    index('reports_target_user_idx').on(t.targetUserId, t.createdAt),
    // What a member has reported, on their admin detail page.
    index('reports_reporter_idx').on(t.reporterId, t.createdAt),
    // One open report per reporter and target; a new one is possible after review.
    uniqueIndex('reports_open_uq').on(t.reporterId, t.targetType, t.targetId).where(sql`status = 'open'`),
    // "Mine" and "unassigned" in the queue.
    index('reports_assignee_idx').on(t.assigneeId, t.status),
    // Statistics by period.
    index('reports_created_idx').on(t.createdAt),
  ],
);

/**
 * What happened to a report, in order: notes administrators leave while working it, and every change of severity,
 * assignee and status, and a sanction given from it. Kept with the report (reports survive account deletion,
 * pseudonymous). Notes are not a place for personal data: the API refuses e-mail addresses and phone or ID numbers.
 */
export const reportEvents = sqliteTable(
  'report_events',
  {
    id: text('id').primaryKey(),
    reportId: text('report_id').notNull().references(() => reports.id),
    actorId: text('actor_id').notNull(),
    kind: text('kind', { enum: ['note', 'severity', 'assign', 'status', 'sanction'] }).notNull(),
    /** Before and after: a severity, an administrator id, a status, or the sanction's audit action. */
    fromValue: text('from_value'),
    toValue: text('to_value'),
    /** The note, the decision note, or the sanction's reason. */
    body: text('body'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('report_events_report_idx').on(t.reportId, t.createdAt)],
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

/**
 * Days on which a member used the service (see stats.ts): the day and the member, nothing else. Kept for
 * ACTIVE_DAYS_RETENTION days by the daily housekeeping; deleted with the account.
 */
export const activeDays = sqliteTable(
  'active_days',
  {
    day: integer('day').notNull(),
    userId: text('user_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.userId] })],
);

/** Daily operations statistics, one number per day and metric (see stats.ts). Day 0 holds markers. */
export const dailyStats = sqliteTable(
  'daily_stats',
  {
    day: integer('day').notNull(),
    metric: text('metric').notNull(),
    n: integer('n').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.metric] })],
);

/**
 * Service-wide notices shown as a banner on every page between starts_at and ends_at (open-ended when null), in the
 * reader's language. A notice can also be pinned on the board (post_id). Deleting is soft so the audit trail stays readable.
 */
export const serviceNotices = sqliteTable(
  'service_notices',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['general', 'urgent', 'maintenance'] }).notNull(),
    titleKo: text('title_ko').notNull(),
    titleEn: text('title_en').notNull(),
    bodyKo: text('body_ko'),
    bodyEn: text('body_en'),
    startsAt: integer('starts_at').notNull(),
    endsAt: integer('ends_at'),
    postId: text('post_id'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
    deletedAt: integer('deleted_at'),
  },
  (t) => [index('service_notices_live_idx').on(t.deletedAt, t.startsAt)],
);

/**
 * Scheduled maintenance. Between starts_at and ends_at no new seat is taken and no new hand is dealt anywhere (a hand
 * already running plays out); with block_login, players other than staff cannot sign in or sign up. It never touches
 * a table's own pause / entry block / close flags, so those stay as they were when it ends. ended_at is a manual early
 * end, cancelled_at a cancel before it began. At most one window is unfinished at a time.
 */
export const maintenanceWindows = sqliteTable(
  'maintenance_windows',
  {
    id: text('id').primaryKey(),
    startsAt: integer('starts_at').notNull(),
    endsAt: integer('ends_at').notNull(),
    blockLogin: integer('block_login', { mode: 'boolean' }).notNull().default(false),
    messageKo: text('message_ko'),
    messageEn: text('message_en'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
    endedAt: integer('ended_at'),
    cancelledAt: integer('cancelled_at'),
  },
  (t) => [index('maintenance_windows_ends_idx').on(t.endsAt)],
);

/**
 * Free chip refill policy (apps/api/src/lib/refill.ts), one row per version and never changed: the newest row is the
 * policy in force. A member whose wallet and table chips together are below `below` may claim `amount` chips once per
 * `cooldown_ms`. `paused` is the emergency stop (new claims only). No row at all means the refill is off.
 */
export const refillPolicies = sqliteTable('refill_policies', {
  version: integer('version').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
  below: integer('below').notNull(),
  amount: integer('amount').notNull(),
  cooldownMs: integer('cooldown_ms').notNull(),
  /** What made this version: the first policy, a policy edit, an emergency pause or a resume. */
  change: text('change', { enum: ['seed', 'policy', 'pause', 'resume'] }).notNull(),
  actorId: text('actor_id'),
  reason: text('reason'),
  createdAt: integer('created_at').notNull().default(now),
});

/**
 * Free chip refills paid, one row per chip_ledger row of type free_refill (same id), written in the same batch and
 * never changed or deleted: what the member held when it was decided, the policy version applied, and the earliest
 * next claim (fixed when paid, so a later policy change never shortens or lengthens a wait already running).
 */
export const refillClaims = sqliteTable(
  'refill_claims',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    /** 1, 2, … per member: the claim's idempotency key is `refill:<user>:<seq>`. */
    seq: integer('seq').notNull(),
    policyVersion: integer('policy_version').notNull(),
    amount: integer('amount').notNull(),
    /** Wallet and chips on tables when the claim was decided. */
    wallet: integer('wallet').notNull(),
    tableChips: integer('table_chips').notNull(),
    nextAt: integer('next_at').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('refill_claims_user_seq_uq').on(t.userId, t.seq), index('refill_claims_created_idx').on(t.createdAt)],
);
/**
 * Table bot policy (apps/game-worker/src/bots.ts), one row per version and never changed: the newest row is in force.
 * Off, no bot joins a table and seated bots leave after their hand. `fund_limit` caps the chips ever issued to bots
 * (bot_fund.issued); `max_bots` caps the bots seated across all tables at once.
 */
export const botPolicies = sqliteTable('bot_policies', {
  version: integer('version').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  fundLimit: integer('fund_limit').notNull(),
  maxBots: integer('max_bots').notNull(),
  change: text('change', { enum: ['seed', 'policy'] }).notNull(),
  actorId: text('actor_id'),
  reason: text('reason'),
  createdAt: integer('created_at').notNull().default(now),
});

/**
 * The bot fund's one row (id 1): chips issued to bot accounts so far, raised in the same batch as each chip_ledger row
 * of type bot_fund (and only when that row was written), so it always equals their sum.
 */
export const botFund = sqliteTable('bot_fund', {
  id: integer('id').primaryKey(),
  issued: integer('issued').notNull().default(0),
  updatedAt: integer('updated_at').notNull().default(now),
});

/** What table bots did that an operator may need to see: joins, leaves, an empty fund, a failed decision or write. */
export const botEvents = sqliteTable(
  'bot_events',
  {
    id: text('id').primaryKey(),
    tableId: text('table_id').notNull(),
    botId: text('bot_id'),
    kind: text('kind', { enum: ['join', 'leave', 'fund_exhausted', 'join_failed', 'action_failed'] }).notNull(),
    /** An error code or reason, never cards. */
    code: text('code'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('bot_events_created_idx').on(t.createdAt), index('bot_events_table_idx').on(t.tableId, t.createdAt)],
);

/**
 * Time bank policy (packages/types/src/timebank.ts), one row per version and never changed: the newest row is in force.
 * A room reads it with the table and applies it from its next hand; members' banks live in the room, never here (no
 * one edits a member's time). Times in ms, whole seconds. No row at all means the time bank is off.
 */
export const timeBankPolicies = sqliteTable('time_bank_policies', {
  version: integer('version').primaryKey(),
  /** On at official tables; `member_rooms` also turns it on in member rooms. */
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  memberRooms: integer('member_rooms', { mode: 'boolean' }).notNull(),
  initialMs: integer('initial_ms').notNull(),
  maxMs: integer('max_ms').notNull(),
  unitMs: integer('unit_ms').notNull(),
  refillHands: integer('refill_hands').notNull(),
  refillMs: integer('refill_ms').notNull(),
  change: text('change', { enum: ['seed', 'policy'] }).notNull(),
  actorId: text('actor_id'),
  reason: text('reason'),
  createdAt: integer('created_at').notNull().default(now),
});

/**
 * Social policy (packages/types/src/social.ts SocialSettings), one row per version and never changed: the newest row is
 * in force. Quick reactions (on, and how fast one seated player may send them) and which staff roles carry their badge
 * next to their name. Rooms read it with the table; the api reads it when a reply would show a staff role. No row at
 * all means what the service did before it existed (SOCIAL_DEFAULTS: reactions on at the old limits, both badges shown).
 */
export const socialPolicies = sqliteTable('social_policies', {
  version: integer('version').primaryKey(),
  reactionsEnabled: integer('reactions_enabled', { mode: 'boolean' }).notNull(),
  reactionCooldownMs: integer('reaction_cooldown_ms').notNull(),
  reactionBurstMax: integer('reaction_burst_max').notNull(),
  reactionBurstWindowMs: integer('reaction_burst_window_ms').notNull(),
  showSuperAdmin: integer('show_super_admin', { mode: 'boolean' }).notNull(),
  showAdmin: integer('show_admin', { mode: 'boolean' }).notNull(),
  change: text('change', { enum: ['seed', 'policy'] }).notNull(),
  actorId: text('actor_id'),
  reason: text('reason'),
  createdAt: integer('created_at').notNull().default(now),
});

/**
 * Referral rewards policy (apps/api/src/lib/referral.ts), one row per version and never changed: the newest row is in
 * force. A signup with a code is accepted under the version in force then (its amounts and conditions are copied onto
 * the referral); `paused` holds payouts without closing anything; the caps are read when a referrer side is paid.
 */
export const referralPolicies = sqliteTable('referral_policies', {
  version: integer('version').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
  /** Chips for the member who shared the code, and for the new member who used it. */
  referrerAmount: integer('referrer_amount').notNull(),
  inviteeAmount: integer('invitee_amount').notNull(),
  /** Referrer rewards one member may receive per KST day, and in total. */
  dailyCap: integer('daily_cap').notNull(),
  totalCap: integer('total_cap').notNull(),
  /** Hands the new member must finish before either side is paid (0: paid at signup). */
  minHands: integer('min_hands').notNull(),
  /** Signups for one referrer from one network within 24 hours from which new ones wait for review. */
  burstLimit: integer('burst_limit').notNull(),
  change: text('change', { enum: ['seed', 'policy', 'pause', 'resume'] }).notNull(),
  actorId: text('actor_id'),
  reason: text('reason'),
  createdAt: integer('created_at').notNull().default(now),
});

/** A member's own referral code, made the first time they open it; removed when the member withdraws. */
export const referralCodes = sqliteTable('referral_codes', {
  userId: text('user_id').primaryKey(),
  code: text('code').notNull().unique(),
  createdAt: integer('created_at').notNull().default(now),
});

/**
 * One signup made with a referral code (at most one per new member). Each side is paid at most once through
 * chip_ledger type 'referral' with the key `referral:<id>:invitee` / `referral:<id>:referrer`; the side's status and
 * ledger id are written in the same batch, and only when that ledger row was written. Kept when either member
 * withdraws, under the tombstoned account, so a rejoin with the same email is recognised (docs/PRIVACY_OPERATIONS.md).
 */
export const referrals = sqliteTable(
  'referrals',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    referrerId: text('referrer_id').notNull(),
    inviteeId: text('invitee_id').notNull().unique(),
    /** pending: waiting to pay; review: held for an operator; settled: both sides final; unpaid: closed without pay. */
    status: text('status', { enum: ['pending', 'review', 'settled', 'unpaid'] }).notNull(),
    referrerStatus: text('referrer_status', { enum: ['pending', 'paid', 'capped', 'skipped', 'unpaid'] }).notNull(),
    inviteeStatus: text('invitee_status', { enum: ['pending', 'paid', 'capped', 'skipped', 'unpaid'] }).notNull(),
    /** The policy in force at signup and what it promised. */
    policyVersion: integer('policy_version').notNull(),
    referrerAmount: integer('referrer_amount').notNull(),
    inviteeAmount: integer('invitee_amount').notNull(),
    minHands: integer('min_hands').notNull(),
    referrerLedgerId: text('referrer_ledger_id'),
    inviteeLedgerId: text('invitee_ledger_id'),
    referrerPaidAt: integer('referrer_paid_at'),
    inviteePaidAt: integer('invitee_paid_at'),
    /** SHA-256 of the normalised email (lower case, no +tag, no Gmail dots): the same inbox signing up again. */
    emailHash: text('email_hash').notNull(),
    /** Keyed hash of the signup network, cleared after 30 days; only ever a signal, never a verdict on its own. */
    ipHash: text('ip_hash'),
    sameIp: integer('same_ip', { mode: 'boolean' }).notNull().default(false),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    /** Why it is waiting or was not paid (lib/referral.ts REFERRAL_FAILURES). */
    failureCode: text('failure_code'),
    reviewedBy: text('reviewed_by'),
    reviewReason: text('review_reason'),
    reviewedAt: integer('reviewed_at'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    index('referrals_referrer_idx').on(t.referrerId, t.createdAt),
    index('referrals_status_idx').on(t.status, t.createdAt),
    index('referrals_email_idx').on(t.emailHash),
  ],
);

/**
 * A tournament template (docs/TOURNAMENT.md): the structure a super admin sets, from which operators open tournaments.
 * A tournament copies it when it is opened, so a template edited or archived later changes no tournament already open.
 * `levels` is a JSON array of {sb, bb}; times in ms. `version` counts edits (two editors: the second is told).
 */
export const tournamentTemplates = sqliteTable(
  'tournament_templates',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    capacity: integer('capacity').notNull(),
    /** The fewest eligible players an operator's start needs (2 to capacity). */
    minPlayers: integer('min_players').notNull(),
    startStack: integer('start_stack').notNull(),
    levels: text('levels').notNull(),
    levelMs: integer('level_ms').notNull(),
    turnSeconds: integer('turn_seconds').notNull(),
    tbEnabled: integer('tb_enabled', { mode: 'boolean' }).notNull(),
    tbInitialMs: integer('tb_initial_ms').notNull(),
    tbMaxMs: integer('tb_max_ms').notNull(),
    tbUnitMs: integer('tb_unit_ms').notNull(),
    tbRefillHands: integer('tb_refill_hands').notNull(),
    tbRefillMs: integer('tb_refill_ms').notNull(),
    /** Registration conditions: hands played (any table) and a verified email. */
    minHands: integer('min_hands').notNull().default(0),
    requireVerified: integer('require_verified', { mode: 'boolean' }).notNull().default(false),
    /** Starts by itself when the last seat is taken. */
    autoStart: integer('auto_start', { mode: 'boolean' }).notNull().default(true),
    status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('tournament_templates_status_idx').on(t.status, t.updatedAt)],
);

/**
 * One tournament (docs/TOURNAMENT.md "대회 상태"): the template's structure as copied when it was opened, its state, and
 * the progress its table's room writes back after each hand (level, clock, hands, players left: a mirror for the lists
 * and the admin; the room's own storage is the authority while it runs). `version` rises with every change an admin
 * sees (status, pause request); `roster` with every registration change. Never deleted.
 */
export const tournaments = sqliteTable(
  'tournaments',
  {
    id: text('id').primaryKey(),
    templateId: text('template_id'),
    name: text('name').notNull(),
    status: text('status', { enum: ['registering', 'closed', 'running', 'finished', 'cancelled', 'aborted'] }).notNull(),
    capacity: integer('capacity').notNull(),
    minPlayers: integer('min_players').notNull(),
    startStack: integer('start_stack').notNull(),
    levels: text('levels').notNull(),
    levelMs: integer('level_ms').notNull(),
    turnSeconds: integer('turn_seconds').notNull(),
    tbEnabled: integer('tb_enabled', { mode: 'boolean' }).notNull(),
    tbInitialMs: integer('tb_initial_ms').notNull(),
    tbMaxMs: integer('tb_max_ms').notNull(),
    tbUnitMs: integer('tb_unit_ms').notNull(),
    tbRefillHands: integer('tb_refill_hands').notNull(),
    tbRefillMs: integer('tb_refill_ms').notNull(),
    minHands: integer('min_hands').notNull(),
    requireVerified: integer('require_verified', { mode: 'boolean' }).notNull(),
    autoStart: integer('auto_start', { mode: 'boolean' }).notNull(),
    version: integer('version').notNull().default(1),
    roster: integer('roster').notNull().default(0),
    /** The table opened at the start (tables.room_type 'tournament'). */
    tableId: text('table_id'),
    /** Progress as the room last wrote it: level index, when it ends (running clock) or what was left (stopped clock). */
    level: integer('level').notNull().default(0),
    levelEndsAt: integer('level_ends_at'),
    levelLeftMs: integer('level_left_ms'),
    /** An admin asked for a pause from the next hand (and when that request last changed); `paused_at`: the clock stopped. */
    pauseRequested: integer('pause_requested', { mode: 'boolean' }).notNull().default(false),
    pauseChangedAt: integer('pause_changed_at'),
    pausedAt: integer('paused_at'),
    playersLeft: integer('players_left'),
    hands: integer('hands').notNull().default(0),
    /** When the room last wrote its progress (a silent room is shown as needing recovery). */
    roomSeenAt: integer('room_seen_at'),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    cancelledAt: integer('cancelled_at'),
    abortedAt: integer('aborted_at'),
    winnerId: text('winner_id'),
    /** completed (one player left), cancelled, aborted. */
    endReason: text('end_reason', { enum: ['completed', 'cancelled', 'aborted'] }),
    /** The operator's reason for a cancel or an abort (staff only). */
    endNote: text('end_note'),
    endedBy: text('ended_by'),
    createdBy: text('created_by'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('tournaments_status_idx').on(t.status, t.createdAt), uniqueIndex('tournaments_table_idx').on(t.tableId)],
);

/**
 * A member's entry in a tournament (docs/TOURNAMENT.md "참가자 상태"). `stack` mirrors the room's after each hand
 * (tournament chips, never wallet chips); `place` is final once set.
 */
export const tournamentEntries = sqliteTable(
  'tournament_entries',
  {
    tournamentId: text('tournament_id').notNull(),
    userId: text('user_id').notNull(),
    status: text('status', { enum: ['registered', 'unregistered', 'dropped', 'playing', 'eliminated', 'won', 'stopped'] }).notNull(),
    seatIndex: integer('seat_index'),
    stack: integer('stack'),
    place: integer('place'),
    registeredAt: integer('registered_at').notNull(),
    eliminatedAt: integer('eliminated_at'),
    /** The room's hand number in which the player busted. */
    eliminatedHand: integer('eliminated_hand'),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.tournamentId, t.userId] }), index('tournament_entries_user_idx').on(t.userId, t.status)],
);

/**
 * A member's push notification choices (apps/api/src/lib/notify.ts, packages/types/src/notifications.ts), the account's
 * and never a device's. No row: nothing agreed (service and night off, every type on once service is). `version` goes up
 * with every change and a change must name the version it was made from, so a device that has not seen a withdrawal
 * cannot turn it back on. Removed when the member withdraws.
 */
export const notificationSettings = sqliteTable('notification_settings', {
  userId: text('user_id').primaryKey(),
  /** "[선택] 서비스 푸시 알림 수신 동의". */
  service: integer('service', { mode: 'boolean' }).notNull().default(false),
  /** "[선택] 야간 서비스 푸시 알림 수신 동의": 21:00–08:00 Korean time as well. */
  night: integer('night', { mode: 'boolean' }).notNull().default(false),
  dm: integer('dm', { mode: 'boolean' }).notNull().default(true),
  invite: integer('invite', { mode: 'boolean' }).notNull().default(true),
  friendRequest: integer('friend_request', { mode: 'boolean' }).notNull().default(true),
  friendAccepted: integer('friend_accepted', { mode: 'boolean' }).notNull().default(true),
  tournamentStart: integer('tournament_start', { mode: 'boolean' }).notNull().default(true),
  tournamentCancel: integer('tournament_cancel', { mode: 'boolean' }).notNull().default(true),
  tournamentResult: integer('tournament_result', { mode: 'boolean' }).notNull().default(true),
  version: integer('version').notNull().default(0),
  /** When service and night consent were last changed (server clock). */
  serviceAt: integer('service_at'),
  nightAt: integer('night_at'),
  updatedAt: integer('updated_at').notNull().default(now),
});

/**
 * Every change of the two push consents, as the record of what was agreed when (server clock): never an IP address,
 * device or browser. Kept under the pseudonymous id when the member withdraws (docs/PRIVACY_OPERATIONS.md).
 */
export const notificationConsents = sqliteTable(
  'notification_consents',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    kind: text('kind', { enum: ['service', 'night'] }).notNull(),
    agreed: integer('agreed', { mode: 'boolean' }).notNull(),
    /** NOTIFICATION_CONSENT_VERSION of the wording shown. */
    policyVersion: text('policy_version').notNull(),
    source: text('source', { enum: ['signup', 'settings'] }).notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('notification_consents_user_idx').on(t.userId, t.createdAt)],
);

/**
 * A browser's Web Push subscription, for the member signed in there and that sign-in only: a push goes out only while
 * `session_id` is a live session of `user_id` (so signing out, signing out everywhere, a password change, a suspension or
 * a withdrawal stop it at once). The endpoint is a secret of the push service: it is never logged or sent back, and
 * `endpoint_hash` (SHA-256) is what finds it again; the same browser signing in to another account takes the row over.
 */
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    sessionId: text('session_id').notNull(),
    endpoint: text('endpoint').notNull(),
    endpointHash: text('endpoint_hash').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    /** Coarse device name for the member's list ("Chrome · Android"), from the browser's own description. */
    label: text('label'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
    lastSuccessAt: integer('last_success_at'),
    lastFailureAt: integer('last_failure_at'),
    /** Failed sends in a row (a success resets it). */
    failures: integer('failures').notNull().default(0),
    /** The push service said it is gone (404/410), or it failed too often: never used again. */
    disabledAt: integer('disabled_at'),
  },
  (t) => [
    uniqueIndex('push_subscriptions_endpoint_uq').on(t.endpointHash),
    index('push_subscriptions_user_idx').on(t.userId),
    index('push_subscriptions_session_idx').on(t.sessionId),
  ],
);

/**
 * The push outbox: one row per notification a member should get (written after the action it reports, never in its
 * way). `dedupe_key` makes it once per event. Sent at once by the api, or by the minute cron (retries, and events the
 * game worker wrote); whether it may go is decided again when it is sent (consent, the type, the night, a live session).
 * Kept NOTIFY_EVENT_RETENTION_MS.
 */
export const notificationEvents = sqliteTable(
  'notification_events',
  {
    id: text('id').primaryKey(),
    dedupeKey: text('dedupe_key').notNull(),
    userId: text('user_id').notNull(),
    type: text('type', { enum: ['dm', 'invite', 'friend_request', 'friend_accepted', 'tournament_start', 'tournament_cancel', 'tournament_result'] }).notNull(),
    /** Where a click goes: an internal path only. */
    url: text('url').notNull(),
    /** Events with the same key replace each other on the device and share a cooldown ("dm:<sender>"). */
    coalesceKey: text('coalesce_key'),
    status: text('status', { enum: ['pending', 'sending', 'sent', 'skipped', 'failed', 'expired'] }).notNull().default('pending'),
    /** Why it was skipped or failed (night, consent, type_off, read, viewing, cooldown, no_device, …). */
    reason: text('reason'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull(),
    /** While one sender holds it (status sending). */
    leaseUntil: integer('lease_until'),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull().default(now),
    sentAt: integer('sent_at'),
  },
  (t) => [
    uniqueIndex('notification_events_dedupe_uq').on(t.dedupeKey),
    index('notification_events_due_idx').on(t.status, t.nextAttemptAt),
    index('notification_events_user_idx').on(t.userId, t.createdAt),
    // A member's pushes of the last hour, by when they went out (the hourly cap and the cooldown).
    index('notification_events_sent_idx').on(t.userId, t.status, t.sentAt),
  ],
);
