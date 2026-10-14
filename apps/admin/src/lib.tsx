import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function rawApi<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'internal', e?.message ?? res.statusText);
  }
  return data as T;
}

export interface AdminMe {
  user: { id: string; email: string; nickname: string; role: 'admin' | 'super_admin' | 'user' };
  reauthValidUntil: number | null;
  sessionStartedAt: number;
}

interface AdminCtx {
  me: AdminMe | null;
  loading: boolean;
  refresh: () => Promise<void>;
  /** API call that asks for the admin password again when the server requires a fresh confirmation. */
  api: <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;
  reauthPrompt: { open: boolean; error: string | null; confirm: (password: string) => void; cancel: () => void };
  logout: () => Promise<void>;
}

const Ctx = createContext<AdminCtx | null>(null);

export function AdminProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<AdminMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [prompt, setPrompt] = useState<{ open: boolean; error: string | null }>({ open: false, error: null });
  const waiter = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await rawApi<AdminMe>('/api/admin/auth/me'));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const askReauth = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        waiter.current = { resolve, reject };
        setPrompt({ open: true, error: null });
      }),
    [],
  );

  const api = useCallback(
    async <T,>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
      try {
        return await rawApi<T>(path, init);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'reauth_required') {
          await askReauth();
          return rawApi<T>(path, init);
        }
        if (e instanceof ApiError && e.code === 'unauthorized') void refresh();
        throw e;
      }
    },
    [askReauth, refresh],
  );

  const reauthPrompt = useMemo(
    () => ({
      ...prompt,
      confirm: async (password: string) => {
        try {
          await rawApi('/api/admin/auth/reauth', { body: { password } });
          setPrompt({ open: false, error: null });
          waiter.current?.resolve();
          void refresh();
        } catch (e) {
          setPrompt({ open: true, error: e instanceof Error ? e.message : String(e) });
        }
      },
      cancel: () => {
        setPrompt({ open: false, error: null });
        waiter.current?.reject(new ApiError(401, 'reauth_cancelled', 'cancelled'));
      },
    }),
    [prompt, refresh],
  );

  const logout = useCallback(async () => {
    await rawApi('/api/admin/auth/logout', { body: {} }).catch(() => undefined);
    setMe(null);
  }, []);

  return <Ctx.Provider value={{ me, loading, refresh, api, reauthPrompt, logout }}>{children}</Ctx.Provider>;
}

export function useAdmin() {
  const v = useContext(Ctx);
  if (!v) throw new Error('AdminProvider missing');
  return v;
}

export { rawApi };

export function useData<T>(path: string | null) {
  const { api } = useAdmin();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload, setData };
}
