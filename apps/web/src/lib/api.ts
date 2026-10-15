export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let onMaintenance: (() => void) | null = null;
/** Called when a request is refused for maintenance, so the banner shows it without waiting for the next poll. */
export function setMaintenanceListener(f: () => void) {
  onMaintenance = f;
}

/** Same-origin JSON client; the session lives in an HttpOnly cookie. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    credentials: 'same-origin',
    signal: init.signal,
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    if (e?.code === 'maintenance') onMaintenance?.();
    throw new ApiError(res.status, e?.code ?? 'internal', e?.message ?? res.statusText, e?.details);
  }
  return data as T;
}
