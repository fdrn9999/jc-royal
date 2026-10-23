/**
 * Brand status (the API's routes/admin-brand.ts, lib/brand.ts): what this deployment gives a link-preview crawler and a
 * browser offering to install the site, checked inside the server — the shareable pages' tags (a private table showing
 * only the default preview), the preview image itself, the manifest and its icons — and the outside debuggers that
 * refresh what KakaoTalk and Facebook have cached. Read only: the image and copy are changed in code and deployed.
 */
import { Badge, Button, ChevronRightIcon, Empty, formatDate, Panel, Stat } from '@jc/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import { useT, type Key } from '../i18n';
import type { Tr } from '../labels';
import { useData } from '../lib';
import { LoadError, PageState } from '../ui';

type Status = 'ok' | 'warn' | 'fail' | 'info';
interface Check { id: string; status: Status; value?: string | number | boolean | null; expected?: string | number | boolean | null }
interface Page { kind: string; path: string; status: Status; title: string | null; description: string | null; url: string | null; checks: Check[] }
interface Icon { src: string; sizes: string; status: number; contentType: string | null; bytes: number; size: string | null; check: Status }
interface Tool { id: 'kakao' | 'facebook'; url: string }
type Summary = { ok: number; warn: number; fail: number };
type Report =
  | { checkedAt: number; site: string; assets: false; summary: Summary; tools: Tool[] }
  | {
      checkedAt: number;
      site: string;
      assets: true;
      summary: Summary;
      index: { status: number; checks: Check[] };
      pages: Page[];
      image: { url: string; path: string; status: number; contentType: string | null; bytes: number; width: number | null; height: number | null; cacheControl: string | null; checks: Check[] };
      pwa: { manifest: Record<'name' | 'shortName' | 'startUrl' | 'display' | 'themeColor' | 'lang', unknown> | null; icons: Icon[]; checks: Check[] };
      tools: Tool[];
    };

const TONE = { ok: 'green', warn: 'gold', fail: 'red', info: 'blue' } as const;
const STATUS: Record<Status, Key> = { ok: 'brStOk', warn: 'brStWarn', fail: 'brStFail', info: 'brStInfo' };
const KIND: Record<string, Key> = { home: 'brKindHome', homeEn: 'brKindHomeEn', register: 'brKindRegister', table: 'brKindTable', privateTable: 'brKindPrivateTable', post: 'brKindPost' };
const CHECK: Record<string, Key> = {
  status: 'brCkStatus', tags: 'brCkTags', duplicates: 'brCkDuplicates', url: 'brCkUrl', canonical: 'brCkCanonical', image: 'brCkImage',
  imageSize: 'brCkImageSize', twitterCard: 'brCkTwitterCard', lang: 'brCkLang', private: 'brCkPrivate', markers: 'brCkMarkers',
  defaultBlock: 'brCkDefaultBlock', imageStatus: 'brCkImageStatus', imageType: 'brCkImageType', imagePixels: 'brCkImagePixels',
  imageBytes: 'brCkImageBytes', imageSameSite: 'brCkImageSameSite', manifestStatus: 'brCkManifestStatus', manifestType: 'brCkManifestType',
  manifestJson: 'brCkManifestJson', manifestFields: 'brCkManifestFields', display: 'brCkDisplay', icons: 'brCkIcons', maskable: 'brCkMaskable',
  themeColor: 'brCkThemeColor', manifestLink: 'brCkManifestLink', appleIcon: 'brCkAppleIcon', https: 'brCkHttps',
  serviceWorker: 'brCkServiceWorker', iconFiles: 'brCkIconFiles',
};
/** Checks that are a deliberate choice rather than a finding: said in words beside them. */
const NOTE: Record<string, Key> = { maskable: 'brNoteMaskable', serviceWorker: 'brNoteServiceWorker' };
const TOOL: Record<Tool['id'], Key> = { kakao: 'brToolKakao', facebook: 'brToolFacebook' };
const kb = (n: number) => Number((n / 1024).toFixed(1));
const shown = (c: Check, v: Check['value']) => (v === null || v === undefined || typeof v === 'boolean' ? null : c.id === 'imageBytes' && typeof v === 'number' ? `${kb(v)} KB` : String(v));

function StatusBadge({ s }: { s: Status }) {
  const { t } = useT();
  return <Badge tone={TONE[s]}>{t(STATUS[s])}</Badge>;
}

/**
 * Findings and notes in full; the checks that passed folded under their count, so a healthy report stays short on a phone
 * (still in the page, for anyone who opens them).
 */
function Checks({ checks, testid }: { checks: Check[]; testid?: string }) {
  const { t } = useT();
  const passed = checks.filter((c) => c.status === 'ok');
  const rest = checks.filter((c) => c.status !== 'ok');
  const row = (c: Check) => {
    const value = shown(c, c.value);
    // The expected value is worth showing only beside a finding.
    const expected = c.status === 'warn' || c.status === 'fail' ? shown(c, c.expected) : null;
    return (
      <li key={c.id} className="flex items-start gap-3 py-2" data-check={c.id} data-status={c.status}>
        <span className="w-16 shrink-0"><StatusBadge s={c.status} /></span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-semibold">{CHECK[c.id] ? t(CHECK[c.id]!) : c.id}</span>
          {value && <span className="break-all font-mono text-xs text-ink-300">{t('brValue', { v: value })}</span>}
          {expected && expected !== value &&<span className="break-all font-mono text-xs text-ink-400">{t('brExpected', { v: expected })}</span>}
          {NOTE[c.id] && <span className="text-xs text-ink-400">{t(NOTE[c.id]!)}</span>}
        </span>
      </li>
    );
  };
  return (
    <div className="flex flex-col text-sm" data-testid={testid}>
      {rest.length > 0 && <ul className="flex flex-col divide-y divide-white/5">{rest.map(row)}</ul>}
      {passed.length > 0 && (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-2 py-2 text-xs text-ink-300 hover:text-ivory [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon className="size-3.5 text-ink-400 transition-transform group-open:rotate-90" />
            {t('brPassed', { n: passed.length })}
          </summary>
          <ul className="flex flex-col divide-y divide-white/5 border-t border-white/5">{passed.map(row)}</ul>
        </details>
      )}
    </div>
  );
}

export function BrandPage() {
  const { t, locale } = useT();
  const report = useData<Report>('/api/admin/brand');
  const header = (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-xl font-extrabold">{t('brTitle')}</h1>
      <Link to="/service" className="text-sm text-gold-300 hover:underline">{t('service')} →</Link>
      <Button className="ml-auto" size="sm" variant="subtle" onClick={() => void report.reload()} loading={report.loading} data-testid="br-reload">{t('refresh')}</Button>
    </div>
  );
  if (!report.data) return <div className="flex flex-col gap-4">{header}<PageState error={report.error} onRetry={report.reload} /></div>;
  const r = report.data;
  return (
    <div className="flex flex-col gap-6">
      {header}
      <p className="text-sm text-ink-300">{t('brIntro')}</p>
      {report.error && <LoadError error={report.error} onRetry={report.reload} />}
      <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="br-summary">
        <Badge tone={r.summary.fail ? 'red' : r.summary.warn ? 'gold' : 'green'}>{t('brSummary', r.summary)}</Badge>
        <span className="text-xs text-ink-400">{t('brCheckedAt', { at: formatDate(r.checkedAt, locale) })} · <span className="font-mono">{r.site}</span></span>
      </div>
      {!r.assets ? (
        <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm" role="alert" data-testid="br-no-assets">{t('brNoAssets')}</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Panel title={t('brImage')}>
              <ImageView image={r.image} />
            </Panel>
            <Panel title={t('brPwa')}>
              <PwaView pwa={r.pwa} />
            </Panel>
          </div>
          <Panel title={t('brPages')}>
            <PagesView pages={r.pages} />
          </Panel>
          <Panel title={t('brIndex')}>
            <Checks checks={r.index.checks} testid="br-index" />
          </Panel>
        </>
      )}
      <Panel title={t('brTools')}>
        <ToolsView tools={r.tools} t={t} />
      </Panel>
    </div>
  );
}

function ImageView({ image }: { image: Extract<Report, { assets: true }>['image'] }) {
  const { t } = useT();
  const [broken, setBroken] = useState(false);
  return (
    <div className="flex flex-col gap-3" data-testid="br-image">
      {broken ? (
        <Empty>{t('brImageMissing')}</Empty>
      ) : (
        // The console loads images only from its own origin, so the API hands over the bytes this deployment serves.
        <img
          src="/api/admin/brand/og-image"
          alt={t('brImageAlt')}
          className="aspect-[1200/630] w-full rounded-lg border border-white/10 bg-ink-950 object-contain"
          onError={() => setBroken(true)}
          data-testid="br-image-preview"
        />
      )}
      <p className="break-all font-mono text-xs text-ink-300">{image.url}</p>
      <p className="text-xs text-ink-400">
        {t('brImageInfo', { type: image.contentType ?? '?', w: image.width ?? '?', h: image.height ?? '?', kb: kb(image.bytes) })}
        {image.cacheControl ? ` · ${t('brImageCache', { v: image.cacheControl })}` : ''}
      </p>
      <Checks checks={image.checks} />
    </div>
  );
}

function PagesView({ pages }: { pages: Page[] }) {
  const { t } = useT();
  const sampled = new Set(pages.map((p) => p.kind));
  return (
    <div className="flex flex-col gap-4" data-testid="br-pages">
      <p className="text-xs text-ink-400">{t('brPagesHint')}</p>
      {!(sampled.has('table') && sampled.has('post')) && <p className="text-xs text-ink-400">{t('brPagesNone')}</p>}
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        {pages.map((p) => (
          <section key={p.kind} className="flex min-w-0 flex-col gap-2 rounded-xl border border-white/10 bg-ink-950/40 p-4" data-testid={`br-page-${p.kind}`} data-status={p.status}>
            <header className="flex flex-wrap items-center gap-2">
              <StatusBadge s={p.status} />
              <span className="font-semibold">{KIND[p.kind] ? t(KIND[p.kind]!) : p.kind}</span>
              <span className="break-all font-mono text-xs text-ink-400">{p.path}</span>
            </header>
            {p.title && <p className="text-sm font-semibold text-ivory">{p.title}</p>}
            {p.description && <p className="text-xs text-ink-300">{p.description}</p>}
            <Checks checks={p.checks} />
          </section>
        ))}
      </div>
    </div>
  );
}

function PwaView({ pwa }: { pwa: Extract<Report, { assets: true }>['pwa'] }) {
  const { t } = useT();
  const m = pwa.manifest;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : '—');
  return (
    <div className="flex flex-col gap-4" data-testid="br-pwa">
      {m && (
        <div className="grid grid-cols-2 gap-3">
          <Stat label="name" value={<span className="text-sm break-keep">{str(m.name)}</span>} />
          <Stat label="short_name" value={<span className="text-sm">{str(m.shortName)}</span>} />
          <Stat label="display" value={<span className="text-sm">{str(m.display)}</span>} />
          <Stat
            label="theme_color"
            value={
              <span className="flex items-center gap-2 text-sm">
                {typeof m.themeColor === 'string' && <span className="inline-block size-4 rounded border border-white/20" style={{ background: m.themeColor }} />}
                {str(m.themeColor)}
              </span>
            }
          />
        </div>
      )}
      <h3 className="text-sm font-semibold">{t('brManifest')}</h3>
      <Checks checks={pwa.checks} testid="br-pwa-checks" />
      <h3 className="text-sm font-semibold">{t('brIcons')}</h3>
      {pwa.icons.length === 0 ? (
        <Empty>{t('noneFound')}</Empty>
      ) : (
        // A short list rather than the console table: it sits in a half-width panel on a wide screen, narrower than a table's minimum.
        <ul className="flex flex-col divide-y divide-white/5 text-xs">
          {pwa.icons.map((i) => (
            <li key={i.src} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 py-2" data-testid="br-icon" data-status={i.check}>
              <span className="break-all font-mono text-sm">{i.src}</span>
              <span className="justify-self-end"><StatusBadge s={i.check} /></span>
              <span className="font-mono text-ink-300">{i.sizes}{i.size && i.size !== i.sizes ? ` (${i.size})` : ''}</span>
              <span className="justify-self-end font-mono text-ink-300">{t('brIconAnswer', { status: i.status, kb: kb(i.bytes) })}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ToolsView({ tools, t }: { tools: Tool[]; t: Tr }) {
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="br-tools">
      <p className="text-xs text-ink-400">{t('brToolsHint')}</p>
      <ul className="flex flex-wrap gap-3">
        {tools.map((x) => (
          <li key={x.id}>
            <a href={x.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-2 text-gold-300 hover:bg-white/5" data-testid={`br-tool-${x.id}`}>
              {t(TOOL[x.id])} ↗
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
