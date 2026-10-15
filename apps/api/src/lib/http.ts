import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import type { AppEnv } from '../env';

export class HttpError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function fail(status: ContentfulStatusCode, code: string, message: string, details?: unknown): never {
  throw new HttpError(status, code, message, details);
}

export async function parseBody<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    fail(400, 'bad_request', 'invalid JSON body');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) fail(400, 'bad_request', 'validation failed', parsed.error.issues.map((i) => ({ path: i.path, message: i.message })));
  return parsed.data;
}

/** `preview: true` in the JSON body: the admin console asks what an action would do. Nothing is written. */
export async function isPreview(c: Context<AppEnv>): Promise<boolean> {
  try {
    const body: unknown = await c.req.json();
    return typeof body === 'object' && body !== null && (body as { preview?: unknown }).preview === true;
  } catch {
    return false;
  }
}

/**
 * CSRF defence for cookie-authenticated endpoints: state-changing requests must
 * carry an allowed Origin (browsers always send it on cross-site POSTs) and a
 * JSON content type (forces a CORS preflight for cross-origin scripts).
 */
export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const allowed = c.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  const origin = c.req.header('origin');
  const selfOrigin = new URL(c.req.url).origin;
  if (!origin || (origin !== selfOrigin && !allowed.includes(origin))) fail(403, 'forbidden', 'origin not allowed');
  const ct = c.req.header('content-type') ?? '';
  if (c.req.header('content-length') !== '0' && !ct.startsWith('application/json')) fail(415, 'bad_request', 'JSON required');
  return next();
};

/** Security headers for API and static responses. */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'DENY');
  if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store');
};
