export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** 1250 → "1,250"; compact: 12500 → "12.5K". Integers only (virtual chips). */
export function formatChips(n: number, compact = false): string {
  if (!compact || Math.abs(n) < 10_000) return Math.trunc(n).toLocaleString('en-US');
  const abs = Math.abs(n);
  const fmt = (v: number, s: string) => `${n < 0 ? '-' : ''}${(Math.floor(v * 10) / 10).toString().replace(/\.0$/, '')}${s}`;
  if (abs >= 1_000_000) return fmt(abs / 1_000_000, 'M');
  return fmt(abs / 1_000, 'K');
}

export function formatDate(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
}

/** Simple flat-dictionary i18n with `{name}` interpolation. */
export function createTranslator<D extends Record<string, string>>(dicts: Record<'ko' | 'en', D>) {
  return (locale: 'ko' | 'en') =>
    (key: keyof D, vars?: Record<string, string | number>): string => {
      const raw = (dicts[locale][key] ?? dicts.ko[key] ?? String(key)) as string;
      return vars ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : raw;
    };
}
