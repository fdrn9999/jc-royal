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

/**
 * An amount in big blinds, for reading only: 50 at a 20 big blind → "2.5 BB". Rounded to two decimals (a nonzero
 * amount below 0.01 BB keeps two significant digits), so anything sent stays the integer chips it came from.
 */
export function formatBB(n: number, bigBlind: number, compact = false): string {
  const bb = n / bigBlind;
  if (compact && Math.abs(bb) >= 10_000) return `${formatChips(bb, true)} BB`;
  const tiny = bb !== 0 && Math.abs(bb) < 0.01;
  return `${bb.toLocaleString('en-US', tiny ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 2 })} BB`;
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
