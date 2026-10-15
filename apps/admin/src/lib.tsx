import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT, type Key } from './i18n';
import type { Tr } from './labels';
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

/** API messages that have their own wording; anything else is named by its error code. */
const BY_MESSAGE: Record<string, Key> = {
  'super admin only': 'errSuperOnly',
  'not an administrator': 'noAccess',
  'origin not allowed': 'errOrigin',
  'admin origin required': 'errOrigin',
  'cannot suspend yourself': 'errSelfSuspend',
  'cannot change your own role': 'errSelfRole',
  'use the change-password flow for your own account': 'errSelfReset',
  'invalid blind / buy-in combination': 'errBlinds',
  'private tables need a join code': 'errJoinCode',
  'some recipients do not exist': 'errRecipients',
  'only posts and comments can be hidden': 'errHideKind',
  'saved, but the table did not confirm; try again': 'errSavedUnconfirmed',
  'password is incorrect': 'errPassword',
};
const BY_CODE: Record<string, Key> = {
  forbidden: 'errForbidden',
  bad_request: 'errBadRequest',
  insufficient_balance: 'errNegative',
  room_unavailable: 'errRoom',
  report_closed: 'errReportClosed',
  not_found: 'errNotFound',
  conflict: 'errConflict',
  invalid_credentials: 'errLogin',
  unauthorized: 'errLoginRequired',
  reauth_required: 'errReauth',
  reauth_cancelled: 'errReauthCancelled',
  rate_limited: 'errRateLimited',
  internal: 'errServer',
};

/** A failed request in the console's language (the API's own messages are English). */
export function errText(e: unknown, t: Tr): string {
  if (e instanceof ApiError) {
    if (/^only a super admin can .+ administrators$/.test(e.message)) return t('errAdminTarget');
    const k = (Object.hasOwn(BY_MESSAGE, e.message) ? BY_MESSAGE[e.message] : undefined) ?? (Object.hasOwn(BY_CODE, e.code) ? BY_CODE[e.code] : undefined);
    return k ? t(k) : t('errUnknown', { code: e.code, msg: e.message });
  }
  if (e instanceof TypeError) return t('errNetwork');
  if (e instanceof SyntaxError) return t('errBadResponse');
  return e instanceof Error ? e.message : String(e);
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
  const { t } = useT();
  const [me, setMe] = useState<AdminMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [prompt, setPrompt] = useState<{ open: boolean; error: unknown }>({ open: false, error: null });
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
      open: prompt.open,
      error: prompt.error == null ? null : errText(prompt.error, t),
      confirm: async (password: string) => {
        try {
          await rawApi('/api/admin/auth/reauth', { body: { password } });
          setPrompt({ open: false, error: null });
          waiter.current?.resolve();
          void refresh();
        } catch (e) {
          setPrompt({ open: true, error: e });
        }
      },
      cancel: () => {
        setPrompt({ open: false, error: null });
        waiter.current?.reject(new ApiError(401, 'reauth_cancelled', 'cancelled'));
      },
    }),
    [prompt, refresh, t],
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
  const { t } = useT();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [api, path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  // Worded at render time, so it follows a language switch.
  return { data, error: error == null ? null : errText(error, t), reload, setData };
}
