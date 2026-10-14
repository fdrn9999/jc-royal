/** Minimal cookie-aware HTTP client for integration tests (acts like a browser on the user site). */
export const BASE = () => process.env.TEST_BASE_URL ?? 'http://127.0.0.1:8799';
export const WEB_ORIGIN = 'http://localhost:5173';

/** Meets the password policy (upper, lower, digit, symbol, 8+). */
export const PASSWORD = 'Password123!';
export const BIRTH_DATE = '1990-01-01';

export class Client {
  cookies = new Map<string, string>();
  constructor(
    public origin = WEB_ORIGIN,
    public base?: string,
  ) {}

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private store(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const [k, ...rest] = pair!.split('=');
      const v = rest.join('=');
      if (/Max-Age=0/i.test(sc) || v === '') this.cookies.delete(k!.trim());
      else this.cookies.set(k!.trim(), v);
    }
  }

  async req<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { Origin: this.origin };
    if (this.cookies.size) headers.Cookie = this.cookieHeader();
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch((this.base ?? BASE()) + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    this.store(res);
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    return { status: res.status, body: parsed as T };
  }
  get<T = any>(p: string) {
    return this.req<T>('GET', p);
  }
  post<T = any>(p: string, b: unknown = {}) {
    return this.req<T>('POST', p, b);
  }
  patch<T = any>(p: string, b: unknown) {
    return this.req<T>('PATCH', p, b);
  }
}

/** Admin client reusing the session global-setup opened (no extra login attempts). */
export function sharedAdmin(): Client {
  const c = new Client('http://localhost:5174');
  for (const pair of JSON.parse(process.env.TEST_ADMIN_COOKIES ?? '[]') as string[]) {
    const [k, ...v] = pair.split('=');
    c.cookies.set(k!.trim(), v.join('='));
  }
  return c;
}

let seq = 0;
export function uniq(prefix = 'u') {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}${Math.floor(Math.random() * 1e4)}`;
}

/** Email step of sign-up: request a code (returned as devCode outside production) and confirm it. */
export async function verifyEmail(c: Client, email: string): Promise<string> {
  const r = await c.post('/api/auth/email-verification/request', { email });
  if (r.status !== 200 || !r.body.devCode) throw new Error(`verification request failed ${r.status} ${JSON.stringify(r.body)}`);
  const v = await c.post('/api/auth/email-verification/confirm', { email, code: r.body.devCode });
  if (v.status !== 200) throw new Error(`verification confirm failed ${v.status} ${JSON.stringify(v.body)}`);
  return v.body.verificationToken as string;
}

/** A complete /register body with a verified email; fields override the defaults. */
export async function signupBody(c: Client, fields: { email: string; nickname: string; [k: string]: unknown }) {
  return { password: PASSWORD, birthDate: BIRTH_DATE, agreements: { age14: true, privacy: true }, emailVerificationToken: await verifyEmail(c, fields.email), ...fields };
}

export async function newUser(nickname = uniq('p').slice(0, 14), extra: Record<string, unknown> = {}) {
  const c = new Client();
  const email = `${uniq('e')}@test.dev`;
  const r = await c.post('/api/auth/register', await signupBody(c, { email, nickname, ...extra }));
  if (r.status !== 201) throw new Error(`register failed ${r.status} ${JSON.stringify(r.body)}`);
  return { client: c, me: r.body as { id: string; nickname: string; balance: number; locale: string }, email };
}
