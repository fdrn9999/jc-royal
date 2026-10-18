import { Fragment, useEffect, useId, useRef, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from 'react';
import logo128 from '../../assets/logo-128.webp';
import logo192 from '../../assets/logo-192.webp';
import { cx } from '../util';

export const LOGO_SRC = { small: logo128, medium: logo192 };

export function Logo({ size = 40, withWordmark = false, className }: { size?: number; withWordmark?: boolean; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2.5 select-none', className)}>
      <img src={size > 96 ? logo192 : logo128} width={size} height={size} alt="JC ROYAL" className="drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]" />
      {withWordmark && (
        <span className="font-display font-bold tracking-[0.22em] jc-gold-text" style={{ fontSize: size * 0.42 }}>
          JC ROYAL
        </span>
      )}
    </span>
  );
}

type Variant = 'gold' | 'ghost' | 'outline' | 'danger' | 'subtle';
type Size = 'icon' | 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  gold: 'bg-gradient-to-b from-gold-400 to-gold-600 text-ink-950 shadow-[0_6px_18px_-8px_rgba(212,175,55,0.8)] hover:from-gold-300 hover:to-gold-500',
  outline: 'border border-gold-500/50 text-gold-300 hover:bg-gold-500/10',
  ghost: 'text-ink-100 hover:bg-white/5',
  subtle: 'bg-ink-700 text-ink-100 hover:bg-ink-600 border border-white/5',
  danger: 'bg-danger/90 text-white hover:bg-danger',
};
// Padding is set here, not by className: cx() only joins classes, so a px-* passed in loses to the size's own.
const sizes: Record<Size, string> = {
  /** sm on wide screens; a tight 32px square on phones, for icon-only buttons in a crowded bar. */
  icon: 'h-8 min-w-8 px-1.5 text-sm sm:px-3',
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-base',
};

export function Button({
  variant = 'gold',
  size = 'md',
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold tracking-wide transition-all duration-150',
        'disabled:opacity-45 disabled:cursor-not-allowed active:translate-y-px',
        variants[variant],
        sizes[size],
        className,
      )}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
}

/**
 * With a `label`, it stands for something loading: an indeterminate progress bar that screen readers name (not a live
 * status, which the notes beside it use). Without one it only decorates, as in a busy button.
 */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  const spin = cx('inline-block animate-spin rounded-full border-2 border-current border-r-transparent size-5', className);
  return label ? <span role="progressbar" aria-label={label} className={spin} /> : <span aria-hidden className={spin} />;
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-300">
        {label}
      </label>
      {children(id)}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs text-ink-400">{hint}</p> : null}
    </div>
  );
}

/** A text field; `ref` passes through to the input (a picker places the caret). */
export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return (
    <input
      {...rest}
      className={cx(
        'h-11 w-full rounded-lg border border-white/10 bg-ink-850 px-3 text-ivory placeholder:text-ink-400',
        'focus:border-gold-500/70 focus:outline-none focus:ring-2 focus:ring-gold-500/20 transition disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
    />
  );
}

export function Badge({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'gold' | 'green' | 'red' | 'blue'; children: ReactNode; className?: string }) {
  const tones = {
    neutral: 'bg-white/5 text-ink-200 border-white/10',
    gold: 'bg-gold-500/12 text-gold-300 border-gold-500/35',
    green: 'bg-success/15 text-[#7fd3a3] border-success/40',
    red: 'bg-danger/15 text-[#f0a0a2] border-danger/40',
    blue: 'bg-info/15 text-[#a9c8ee] border-info/40',
  };
  return <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide', tones[tone], className)}>{children}</span>;
}

export function Panel({ className, children, title, actions }: { className?: string; children: ReactNode; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cx('jc-panel p-5', className)}>
      {(title || actions) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-bold tracking-[0.06em] text-gold-300">{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

/** Accessible modal: Escape closes, focus moves into the dialog and back. `closeLabel` names the ✕ button in the page's language. */
export function Modal({ open, onClose, title, children, footer, wide, closeLabel = 'close' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; closeLabel?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // Callers pass inline onClose functions; reading it through a ref keeps the
  // focus effect from re-running (and stealing focus) on every parent render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input,button,select,textarea,[tabindex]');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div ref={ref} className={cx('jc-panel relative w-full animate-rise rounded-b-none sm:rounded-b-[var(--radius-card)] max-h-[92dvh] overflow-auto', wide ? 'sm:max-w-2xl' : 'sm:max-w-md')}>
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
          <h3 className="text-base font-bold tracking-[0.04em] text-gold-300">{title}</h3>
          <button onClick={onClose} className="rounded p-1 text-ink-300 hover:text-ivory" aria-label={closeLabel}>
            ✕
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-white/5 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * A figure ("9,876,543,210") that may wrap after a comma and nowhere else: in a box too narrow for it, a long amount
 * goes on to a second line a whole digit group at a time instead of running out of the box. It reads the same.
 */
export function Figure({ children }: { children: string }) {
  return (
    <>
      {children.split(',').map((part, i) =>
        i ? (
          <Fragment key={i}>
            ,<wbr />
            {part}
          </Fragment>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function Stat({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-xl border border-white/5 bg-ink-850/80 px-4 py-3">
      <div className="text-[11px] font-semibold tracking-[0.04em] text-ink-400">{label}</div>
      <div className="mt-1 font-mono text-xl font-semibold text-ivory tabular-nums">{typeof value === 'string' ? <Figure>{value}</Figure> : value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-400">{sub}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-sm text-ink-400">{children}</div>;
}
