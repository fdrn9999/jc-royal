import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT, type Key } from './i18n';
import type { Tr } from './labels';
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** The error's `details`, when the API sent any. */
    public details?: unknown,
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
    const e = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'internal', e?.message ?? res.statusText, e?.details);
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
  'cannot disconnect yourself': 'errSelfDisconnect',
  'cannot change your own role': 'errSelfRole',
  'use the change-password flow for your own account': 'errSelfReset',
  'invalid blind / buy-in combination': 'errBlinds',
  'private tables need a join code': 'errJoinCode',
  'some recipients do not exist': 'errRecipients',
  'only posts and comments can be hidden': 'errHideKind',
  'saved, but the table did not confirm; try again': 'errSavedUnconfirmed',
  'password is incorrect': 'errPassword',
  'only the author or a super admin can delete a note': 'errNoteAuthor',
  'another maintenance window is planned or under way': 'errMaintTaken',
  'this maintenance is already over': 'errMaintOver',
  'maintenance under way keeps its start': 'errMaintStart',
  'the end must come after the start and after now': 'errMaintEnd',
  'maintenance lasts at most 48 hours': 'errMaint48h',
  'maintenance can be planned at most 90 days ahead': 'errMaint90d',
  'the end must come after the start': 'errNoticeEnd',
  'the end has already passed': 'errNoticeEnd',
  'this notice has already ended': 'errNoticeEnded',
  'assignee must be an active administrator': 'errAssignee',
  'the report is not about this member': 'errReportUser',
  'no permission rule for this action': 'errNoRule',
  "only a super admin can end other administrators' sessions": 'errAdminSessions',
  'session not found': 'errSessionGone',
};
const BY_CODE: Record<string, Key> = {
  forbidden: 'errForbidden',
  bad_request: 'errBadRequest',
  insufficient_balance: 'errNegative',
  room_unavailable: 'errRoom',
  report_closed: 'errReportClosed',
  report_taken: 'errReportTaken',
  not_found: 'errNotFound',
  conflict: 'errConflict',
  invalid_credentials: 'errLogin',
  unauthorized: 'errLoginRequired',
  reauth_required: 'errReauth',
  reauth_cancelled: 'errReauthCancelled',
  rate_limited: 'errRateLimited',
  internal: 'errServer',
  note_pii: 'errNotePii',
  large_adjustment: 'errLargeAdjustment',
  reconcile_stale: 'errReconcileStale',
  already_resolved: 'errAlreadyResolved',
  already_suspended: 'errAlreadySuspended',
  maintenance: 'errMaintenance',
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
  /** Super-admin abilities this administrator has (the API's permission table; absent from an older API). */
  permissions?: string[];
}

/** Whether the signed-in administrator has a super-admin ability (lib/permissions.ts in the API). */
export function canDo(me: AdminMe | null, capability: string): boolean {
  if (!me) return false;
  return me.permissions ? me.permissions.includes(capability) : me.user.role === 'super_admin';
}

interface AdminCtx {
  me: AdminMe | null;
  loading: boolean;
  refresh: () => Promise<void>;
  /** API call that asks for the admin password again when the server requires a fresh confirmation. */
  api: <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;
  reauthPrompt: { open: boolean; error: string | null; confirm: (password: string) => void; cancel: () => void };
  logout: () => Promise<void>;
  /** The browser reports no network; the last API request failed without an answer (cleared by the next answer). */
  net: { offline: boolean; unreachable: boolean };
}

const Ctx = createContext<AdminCtx | null>(null);

export function AdminProvider({ children }: { children: ReactNode }) {
  const { t } = useT();
  const [me, setMe] = useState<AdminMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [prompt, setPrompt] = useState<{ open: boolean; error: unknown }>({ open: false, error: null });
  const waiter = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false);
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

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
        const r = await rawApi<T>(path, init);
        setUnreachable(false);
        return r;
      } catch (e) {
        // fetch rejects with a TypeError only when no answer came back at all; any HTTP answer means the API is reachable.
        setUnreachable(e instanceof TypeError);
        if (e instanceof ApiError && e.code === 'reauth_required') {
          await askReauth();
          return rawApi<T>(path, init);
        }
        // A role or status changed elsewhere applies at once: signed out, or the console's own view of what it may do.
        if (e instanceof ApiError && (e.code === 'unauthorized' || e.message === 'not an administrator' || e.message === 'super admin only')) void refresh();
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

  const net = useMemo(() => ({ offline, unreachable }), [offline, unreachable]);
  return <Ctx.Provider value={{ me, loading, refresh, api, reauthPrompt, logout, net }}>{children}</Ctx.Provider>;
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
  const [loading, setLoading] = useState(false);
  // Only the newest request may change what is shown: an answer for an earlier path (a filter since changed) that
  // arrives late is dropped instead of replacing the newer list.
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return setLoading(false);
    const mine = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (mine !== seq.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(e);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [api, path]);
  useEffect(() => {
    void reload();
    // Leaving the page (or a null path) also drops whatever is still on its way.
    return () => void ++seq.current;
  }, [reload]);
  // Worded at render time, so it follows a language switch.
  // loading is true while a request is out (the previous data stays shown meanwhile).
  return { data, error: error == null ? null : errText(error, t), reload, setData, loading };
}
