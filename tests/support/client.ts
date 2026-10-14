/** Minimal cookie-aware HTTP client for integration tests (acts like a browser on the user site). */
export const BASE = () => process.env.TEST_BASE_URL ?? 'http://127.0.0.1:8799';
export const WEB_ORIGIN = 'http://localhost:5173';

export class Client {
  cookies = new Map<string, string>();
  constructor(public origin = WEB_ORIGIN) {}

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
    const res = await fetch(BASE() + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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

let seq = 0;
export function uniq(prefix = 'u') {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}${Math.floor(Math.random() * 1e4)}`;
}

export async function newUser(nickname = uniq('p').slice(0, 14)) {
  const c = new Client();
  const email = `${uniq('e')}@test.dev`;
  const r = await c.post('/api/auth/register', { email, password: 'password123', nickname });
  if (r.status !== 201) throw new Error(`register failed ${r.status} ${JSON.stringify(r.body)}`);
  return { client: c, me: r.body as { id: string; nickname: string; balance: number }, email };
}
