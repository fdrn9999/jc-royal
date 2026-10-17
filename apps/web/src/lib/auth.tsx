import type { MeDto } from '@jc/types';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { useI18n } from './i18n';
import { flushSettings } from './prefs';

interface AuthCtx {
  me: MeDto | null;
  loading: boolean;
  refresh: () => Promise<void>;
  setMe: (me: MeDto | null) => void;
  logout: () => Promise<void>;
  /** Switches the UI language and, when signed in, saves it as the account language (mail and system messages use it). */
  chooseLocale: (locale: MeDto['locale']) => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeDto | null>(null);
  const [loading, setLoading] = useState(true);
  const { setLocale } = useI18n();
  const meId = me?.id;
  const meLocale = me?.locale;

  const refresh = useCallback(async () => {
    try {
      const next = await api<MeDto>('/api/auth/me');
      // Keep the same object when nothing changed so effects keyed on `me` stay quiet.
      setMe((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The balance can change while this tab is in the background (admin grants,
  // another tab), so re-read the account whenever the player comes back.
  useEffect(() => {
    let last = 0;
    const onReturn = () => {
      // Switching tabs fires both events; one request is enough.
      if (document.visibilityState !== 'visible' || Date.now() - last < 2000) return;
      last = Date.now();
      refresh().catch(() => {});
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [refresh]);

  useEffect(() => {
    if (me) setLocale(me.locale);
  }, [me?.locale]); // eslint-disable-line react-hooks/exhaustive-deps

  const logout = useCallback(async () => {
    // Settings changed here and not saved yet go first, while the session is still this account's (at most 2 s).
    await flushSettings(2_000).catch(() => {});
    await api('/api/auth/logout', { body: {} });
    setMe(null);
  }, []);

  const chooseLocale = useCallback(
    (l: MeDto['locale']) => {
      setLocale(l);
      if (!meId || meLocale === l) return;
      api<MeDto>('/api/auth/me', { method: 'PATCH', body: { locale: l } })
        .then(setMe)
        .catch(() => {});
    },
    [setLocale, meId, meLocale],
  );

  const value = useMemo(() => ({ me, loading, refresh, setMe, logout, chooseLocale }), [me, loading, refresh, logout, chooseLocale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider missing');
  return v;
}
