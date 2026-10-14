import type { Db } from '@jc/db';
import type { Role } from '@jc/types';

export interface Env {
  DB: D1Database;
  /** TableRoom Durable Object namespace hosted by the game worker. */
  TABLES: DurableObjectNamespace;
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
  /** Multiplier for IP-keyed rate limits (tests only; defaults to 1). */
  RATE_LIMIT_IP_SCALE?: string;
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
}

export interface AuthSession {
  id: string;
  kind: 'user' | 'admin';
  reauthAt: number | null;
  createdAt: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    db: Db;
    user?: AuthUser;
    session?: AuthSession;
  };
};
