/**
 * Making a share image of a replay step: the template, the ratio and a few more options (folded away), a preview that is
 * the image itself (the canvas shown, scaled down, is the one saved), then saving it as PNG or WebP, or handing it to the
 * share sheet where a phone will not save a download. The step is the one the dialog opened on (`snap`): moving the
 * replay meanwhile changes nothing in it. Loaded only when it opens.
 */
import { Button, ChevronDownIcon, cx, Modal, Spinner } from '@jc/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n, type MsgKey } from '../lib/i18n';
import { canShareFiles, downloadShare, encodeShare, paintShare, renderShare, shareArt, shareFile, type ShareArt } from './shareDraw';
import { SHARE_FORMATS, SHARE_RATIOS, SHARE_SIZES, SHARE_TEMPLATES, shareFileName, type ShareFormat, type ShareOptions, type ShareRatio, type SnapAt } from './shareSnap';

type Made = { blob: Blob; format: ShareFormat };
type Status = { kind: 'idle' } | { kind: 'making' } | { kind: 'saved'; name: string; fallback: boolean } | { kind: 'shared' } | { kind: 'failed' };

const RATIO_KEY: Record<ShareRatio, MsgKey> = { '1:1': 'shareImg.ratio.square', '4:5': 'shareImg.ratio.portrait', '9:16': 'shareImg.ratio.story', '16:9': 'shareImg.ratio.wide' };

/** Whether this browser's canvas makes WebP files (Safari's makes PNG instead). */
function webpEncodes() {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    return c.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    return false;
  }
}

/** A choice of one of a few, as a row of buttons. */
function Choice<T extends string | number>({ label, value, options, onChange, id, cols }: { label: string; value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; id: string; cols: string }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-xs font-semibold tracking-[0.06em] text-ink-300">{label}</legend>
      <div className={cx('grid gap-1', cols)}>
        {options.map((o) => (
          <button
            key={o.v}
            type="button"
            className={cx(
              'min-h-9 rounded-md px-1.5 py-1 text-[11px] leading-tight font-semibold break-keep transition-colors',
              o.v === value ? 'bg-gold-500/25 text-gold-300 ring-1 ring-gold-400/60' : 'bg-white/[0.05] text-ink-200 hover:bg-white/10',
            )}
            onClick={() => onChange(o.v)}
            aria-pressed={o.v === value}
            data-testid={`share-${id}-${o.v}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Check({ label, checked, onChange, id }: { label: string; checked: boolean; onChange: (v: boolean) => void; id: string }) {
  return (
    <label className="flex min-h-9 items-center justify-between gap-3 text-sm text-ink-100">
      {label}
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 shrink-0 accent-[var(--color-gold-500)]" data-testid={`share-${id}`} />
    </label>
  );
}

export default function ShareDialog({
  snapAt,
  bigBlind,
  fourColor,
  opt,
  onOpt,
  onClose,
  failed = false,
}: {
  /** The step as it was when the image was asked for, or the whole hand, in the unit chosen. */
  snapAt: SnapAt;
  /** The hand's big blind: amounts in big blinds only where the record has it. */
  bigBlind: number | null;
  fourColor: boolean;
  opt: ShareOptions;
  onOpt: (o: ShareOptions) => void;
  onClose: () => void;
  /** Opened after a quick save failed: it says so, with a retry. */
  failed?: boolean;
}) {
  const { t } = useI18n();
  const snap = useMemo(() => snapAt({ span: opt.span, unit: opt.unit }), [snapAt, opt.span, opt.unit]);
  const inBB = !!bigBlind && bigBlind > 0;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [art, setArt] = useState<ShareArt | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [drawn, setDrawn] = useState(false);
  const [status, setStatus] = useState<Status>(failed ? { kind: 'failed' } : { kind: 'idle' });
  const [canShare] = useState(canShareFiles);
  const [webp] = useState(webpEncodes);
  // The file for what the preview shows, made ahead where it can be shared: the share sheet opens only straight from a
  // tap, not after waiting for a file to be made.
  const ready = useRef<Promise<Made> | null>(null);
  const { w, h } = SHARE_SIZES[opt.ratio];
  // The preview at the standard resolution whatever is chosen (a phone keeps one image's pixels, not four), the high
  // one drawn the same way on a canvas of its own when saved.
  const shown = { ...opt, scale: 1 as const };

  // The fonts, the logo and the colours: once, and again on a retry.
  useEffect(() => {
    let live = true;
    setArt(null);
    shareArt(snap, fourColor).then(
      (a) => live && setArt(a),
      () => live && setStatus({ kind: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [snap, fourColor, attempt]);

  // The file for the options as they are: the preview's own pixels at the standard resolution.
  const make = (): Promise<Made> => {
    const c = canvasRef.current;
    if (!c || !art) return Promise.reject(new Error('not drawn'));
    return opt.scale === 1 ? encodeShare(c, opt.format) : renderShare(snap, opt, art);
  };

  // The preview, drawn again as an option changes.
  useEffect(() => {
    const c = canvasRef.current;
    ready.current = null;
    setDrawn(false);
    if (!c || !art) return;
    const id = requestAnimationFrame(() => {
      try {
        paintShare(c, snap, shown, art);
        setDrawn(true);
        if (canShare) {
          const made = make();
          made.catch(() => {});
          ready.current = made;
        }
      } catch {
        setStatus({ kind: 'failed' });
      }
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `shown` and `make` follow `opt`
  }, [art, snap, opt, canShare]);

  const set = (p: Partial<ShareOptions>) => {
    setStatus({ kind: 'idle' });
    onOpt({ ...opt, ...p });
  };
  const file = async (made: Promise<Made> | null) => {
    if (!drawn) throw new Error('not drawn');
    const out = await (made ?? make());
    return { ...out, name: shareFileName(snap, out.format) };
  };
  const save = async () => {
    setStatus({ kind: 'making' });
    try {
      const f = await file(null);
      downloadShare(f.blob, f.name);
      setStatus({ kind: 'saved', name: f.name, fallback: opt.format === 'webp' && f.format !== 'webp' });
    } catch {
      setStatus({ kind: 'failed' });
    }
  };
  const share = async () => {
    const made = ready.current;
    setStatus({ kind: 'making' });
    try {
      const f = await file(made);
      setStatus((await shareFile(f.blob, f.name)) ? { kind: 'shared' } : { kind: 'idle' });
    } catch {
      setStatus({ kind: 'failed' });
    }
  };
  const retry = () => {
    setStatus({ kind: 'idle' });
    setAttempt((n) => n + 1);
  };
  const busy = status.kind === 'making';
  const fmt = opt.format === 'webp' && webp ? 'WebP' : 'PNG';

  return (
    <Modal
      open
      onClose={onClose}
      title={t('shareImg.title')}
      wide
      closeLabel={t('replay.captureClose')}
      footer={
        <>
          {canShare && (
            <Button variant="outline" onClick={share} disabled={!drawn || busy} data-testid="share-share">
              {t('shareImg.share')}
            </Button>
          )}
          <Button onClick={save} disabled={!drawn} loading={busy} data-testid="share-save">
            {t('shareImg.save', { format: fmt })}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_15rem]" data-testid="share-dialog">
        <figure className="flex min-w-0 flex-col gap-2">
          <div className="relative flex h-[min(32dvh,22rem)] items-center justify-center rounded-lg bg-black/40 p-2 sm:h-[min(58dvh,28rem)]">
            <canvas
              ref={canvasRef}
              width={w}
              height={h}
              className={cx('max-h-full max-w-full rounded shadow-[0_8px_24px_rgba(0,0,0,0.5)] transition-opacity', !drawn && 'opacity-30')}
              role="img"
              aria-label={`${t('shareImg.preview')} · ${t(`shareImg.template.${opt.template}` as MsgKey)} · ${opt.ratio}`}
              data-testid="share-preview"
              data-ready={drawn ? '1' : '0'}
            />
            {!drawn && status.kind !== 'failed' && <Spinner className="absolute size-8 text-gold-300" label={t('shareImg.making')} />}
          </div>
          <figcaption className="text-xs text-ink-400" data-testid="share-step">
            {opt.span === 'hand' ? t('shareImg.handNote') : t('shareImg.stepNote', { phase: snap.phaseLabel })}
          </figcaption>
        </figure>
        <div className="flex min-w-0 flex-col gap-3">
          <Choice label={t('shareImg.template')} value={opt.template} id="template" cols="grid-cols-3 sm:grid-cols-2" onChange={(v) => set({ template: v })} options={SHARE_TEMPLATES.map((v) => ({ v, label: t(`shareImg.template.${v}` as MsgKey) }))} />
          <Choice label={t('shareImg.ratio')} value={opt.ratio} id="ratio" cols="grid-cols-4 sm:grid-cols-2" onChange={(v) => set({ ratio: v })} options={SHARE_RATIOS.map((v) => ({ v, label: t(RATIO_KEY[v]) }))} />
          <Choice label={t('shareImg.span')} value={opt.span} id="span" cols="grid-cols-2" onChange={(v) => set({ span: v })} options={(['step', 'hand'] as const).map((v) => ({ v, label: t(`shareImg.span.${v}`) }))} />
          <details className="group rounded-lg border border-white/10 px-3 py-1" data-testid="share-more">
            <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between text-sm font-semibold text-ink-200 [&::-webkit-details-marker]:hidden">
              {t('shareImg.moreOptions')}
              <ChevronDownIcon className="size-4 text-ink-400 transition-transform group-open:rotate-180" />
            </summary>
            <div className="flex flex-col gap-3 pt-1 pb-2">
              {inBB && <Choice label={t('shareImg.unit')} value={opt.unit} id="unit" cols="grid-cols-2" onChange={(v) => set({ unit: v })} options={(['chips', 'bb'] as const).map((v) => ({ v, label: t(`shareImg.unit.${v}`) }))} />}
              <Choice label={t('shareImg.resolution')} value={opt.scale} id="res" cols="grid-cols-2" onChange={(v) => set({ scale: v })} options={([1, 2] as const).map((v) => ({ v, label: t(`shareImg.res.${v}`, { w: w * v, h: h * v }) }))} />
              <Choice label={t('shareImg.format')} value={opt.format} id="format" cols="grid-cols-2" onChange={(v) => set({ format: v })} options={SHARE_FORMATS.map((v) => ({ v, label: v === 'png' ? 'PNG' : 'WebP' }))} />
              {opt.format === 'webp' && !webp && <p className="text-xs text-ink-400" data-testid="share-webp-note">{t('shareImg.webpFallback')}</p>}
              <Choice label={t('shareImg.background')} value={opt.background} id="bg" cols="grid-cols-2" onChange={(v) => set({ background: v })} options={(['felt', 'plain'] as const).map((v) => ({ v, label: t(`shareImg.bg.${v}`) }))} />
              <div className="flex flex-col">
                <Check label={t('shareImg.names')} checked={opt.names} id="names" onChange={(v) => set({ names: v })} />
                <Check label={t('shareImg.log')} checked={opt.log} id="log" onChange={(v) => set({ log: v })} />
                <Check label={t('shareImg.winAmount')} checked={opt.winAmount} id="win" onChange={(v) => set({ winAmount: v })} />
              </div>
            </div>
          </details>
          <div className="min-h-5 text-xs" role="status" data-testid="share-status" data-state={status.kind}>
            {status.kind === 'making' && <span className="text-ink-300">{t('shareImg.making')}</span>}
            {status.kind === 'saved' && (
              <span className="break-all text-[#9fd8b6]">
                {t('shareImg.saved', { name: status.name })}
                {status.fallback && <span className="block text-ink-400">{t('shareImg.webpFallback')}</span>}
              </span>
            )}
            {status.kind === 'shared' && <span className="text-[#9fd8b6]">{t('share.shared')}</span>}
            {status.kind === 'failed' && (
              <span className="flex flex-wrap items-center gap-2 text-danger">
                {t('shareImg.failed')}
                <Button variant="outline" size="sm" onClick={retry} data-testid="share-retry">
                  {t('shareImg.retry')}
                </Button>
              </span>
            )}
            {status.kind === 'idle' && canShare && <span className="text-ink-400">{t('shareImg.shareHint')}</span>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
