import { Logo } from '@jc/ui';
import { Link, NavLink } from 'react-router';
import { LangToggle } from '../components/AppShell';
import { LEGAL_DRAFT, PRIVACY_POLICY, TERMS } from '../legal/policies';
import { useI18n } from '../lib/i18n';

/** Public /privacy and /terms: readable signed in or out, so sign-up can link here. */
export function LegalPage({ kind }: { kind: 'privacy' | 'terms' }) {
  const { t, locale } = useI18n();
  const doc = (kind === 'privacy' ? PRIVACY_POLICY : TERMS)[locale];
  const tab = ({ isActive }: { isActive: boolean }) => `rounded-md px-2 py-1.5 font-semibold ${isActive ? 'text-gold-300' : 'text-ink-300 hover:text-ivory'}`;
  return (
    <div className="min-h-dvh" style={{ background: 'var(--t-bg)' }}>
      <header className="border-b border-gold-500/10 bg-ink-950/80">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-2 px-4">
          <Link to="/" className="shrink-0" aria-label={t('legal.home')}>
            <Logo size={32} withWordmark className="[&>span]:hidden sm:[&>span]:inline" />
          </Link>
          <nav className="ml-auto flex items-center text-xs sm:text-sm" aria-label={`${t('legal.privacy')} / ${t('legal.terms')}`}>
            <NavLink to="/privacy" className={tab}>
              {t('legal.privacy')}
            </NavLink>
            <NavLink to="/terms" className={tab}>
              {t('legal.terms')}
            </NavLink>
          </nav>
          <LangToggle />
        </div>
      </header>
      <main className="mx-auto max-w-3xl break-keep px-4 pb-16 pt-8" data-testid={`legal-${kind}`}>
        <h1 className="font-display text-2xl font-bold text-ivory">{doc.title}</h1>
        <p role="note" className="mt-4 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm leading-relaxed text-ink-100" data-testid="legal-draft">
          {LEGAL_DRAFT[locale]}
        </p>
        <p className="mt-5 text-sm leading-relaxed text-ink-200">{doc.intro}</p>
        {doc.sections.map((s) => (
          <section key={s.heading} className="mt-8">
            <h2 className="text-base font-semibold text-ink-100">{s.heading}</h2>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-300">
              {s.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
            {s.review && (
              <p className="mt-3 rounded-md border-l-2 border-warning bg-warning/5 px-3 py-2 text-xs leading-relaxed text-ink-200" data-testid="legal-review">
                <span className="mr-1.5 font-semibold text-warning">[{t('legal.review')}]</span>
                {s.review}
              </p>
            )}
          </section>
        ))}
        <p className="mt-10 text-xs text-ink-400">{doc.effective}</p>
        <p className="mt-2 text-xs text-ink-400">{t('app.virtual')}</p>
      </main>
    </div>
  );
}
