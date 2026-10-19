import type { Db } from '@jc/db';
import type { Role } from '@jc/types';

export interface Env {
  DB: D1Database;
  /** TableRoom Durable Object namespace hosted by the game worker. */
  TABLES: DurableObjectNamespace;
  /** PresenceHub Durable Object namespace hosted by the game worker (friends' status, in memory only). */
  PRESENCE: DurableObjectNamespace;
  ASSETS?: Fetcher;
  ENVIRONMENT: 'development' | 'test' | 'production';
  /** Comma separated list of browser origins allowed to send state-changing requests. */
  ALLOWED_ORIGINS: string;
  /** Origin of the admin console; admin API requests must come from it. */
  ADMIN_ORIGIN: string;
  PBKDF2_ITERATIONS: string;
  SIGNUP_GRANT: string;
  /** Shared secret between api and game worker for internal calls. */
  INTERNAL_SECRET: string;
  /** Optional: one-time bootstrap token to promote the first super admin. */
  ADMIN_BOOTSTRAP_TOKEN?: string;
  /** Public origin of the player site, used for links and images in emails. */
  APP_ORIGIN?: string;
  /** Optional: Resend API key (secret). Mail is sent only together with MAIL_FROM. */
  RESEND_API_KEY?: string;
  /** Optional: sender, e.g. `JC ROYAL <no-reply@example.com>` on a domain verified in Resend. */
  MAIL_FROM?: string;
  /** Multiplier for IP-keyed rate limits (tests only; defaults to 1). */
  RATE_LIMIT_IP_SCALE?: string;
  /** Local tests only: members' empty rooms close after this many ms instead of MEMBER_IDLE_CLOSE_MS. */
  MEMBER_IDLE_CLOSE_MS?: string;
  /** Web Push (VAPID, RFC 8292) key pair, base64url: the 65-byte public point and the 32-byte private scalar (secrets). Without both, no push is sent. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** The contact the push services see (an https URL of the site). */
  VAPID_SUBJECT?: string;
  /** Local tests only: pushes go to this http://127.0.0.1 address instead of the push service (ignored in production). */
  PUSH_SINK_URL?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  nickname: string;
  role: Role;
  status: 'active' | 'suspended' | 'deleted';
  avatarUrl: string | null;
  locale: 'ko' | 'en';
  balance: number;
  createdAt: number;
  /** How the member shows to friends (packages/types/src/presence.ts). */
  presenceMode: 'auto' | 'away' | 'invisible';
}

export interface AuthSession {
  id: string;
  kind: 'user' | 'admin';
  reauthAt: number | null;
  createdAt: number;
  remember: boolean;
  /** When the sign-in runs out, as read (a request that slides it moves this later in D1, not here). */
  expiresAt: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    db: Db;
    user?: AuthUser;
    session?: AuthSession;
    /** An admin_audit_log row was written for this request (lib/audit.ts). */
    audited?: boolean;
    /** A plain administrator's features switched on, read once per request (lib/permissions.ts grantsOf). */
    grants?: import('./lib/permissions').Grant[];
  };
};
