import type { MeDto } from '@jc/types';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { useI18n } from './i18n';

interface AuthCtx {
  me: MeDto | null;
  loading: boolean;
  refresh: () => Promise<void>;
  setMe: (me: MeDto | null) => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeDto | null>(null);
  const [loading, setLoading] = useState(true);
  const { setLocale } = useI18n();

  const refresh = useCallback(async () => {
    try {
      setMe(await api<MeDto>('/api/auth/me'));
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

  useEffect(() => {
    if (me) setLocale(me.locale);
  }, [me?.locale]); // eslint-disable-line react-hooks/exhaustive-deps

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { body: {} });
    setMe(null);
  }, []);

  const value = useMemo(() => ({ me, loading, refresh, setMe, logout }), [me, loading, refresh, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider missing');
  return v;
}
