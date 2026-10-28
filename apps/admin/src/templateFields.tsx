/**
 * The form pieces for the console's templates (adminTemplates.ts holds the wording): a reason field that offers ready
 * reasons and still takes anything typed, a picker that writes a title and body, the values a template asks for, and
 * a preview. They only write into the page's own fields; the page sends and checks them as it always has.
 */
import { Button, Field, Input } from '@jc/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CUSTOM,
  SEP,
  composeReason,
  fill,
  flatten,
  label as labelOf,
  overLimit,
  part,
  readReason,
  unfilled,
  varOf,
  type AdminTemplate,
  type Lang,
  type TemplateGroup,
  type TemplateVar,
} from './adminTemplates';
import { useT } from './i18n';

const selectCls = 'h-11 w-full rounded-lg border border-white/10 bg-ink-850 px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60';
const areaCls = 'w-full rounded-lg border border-white/10 bg-ink-850 p-3 text-sm';

function Options({ list, lang }: { list: AdminTemplate[] | TemplateGroup[]; lang: Lang }) {
  const opt = (x: AdminTemplate) => (
    <option key={x.id} value={x.id}>
      {labelOf(x, lang)}
    </option>
  );
  if (list.length && 'items' in list[0]!)
    return (
      <>
        {(list as TemplateGroup[]).map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.items.map(opt)}
          </optgroup>
        ))}
      </>
    );
  return <>{(list as AdminTemplate[]).map(opt)}</>;
}

/** The choice a reason reads as: the template it was written from, typed by hand, or nothing yet. */
function pickFor(list: AdminTemplate[], value: string, lang: Lang): string {
  if (!value) return '';
  return readReason(list, value, lang)?.tpl.id ?? CUSTOM;
}

/**
 * A reason: pick one from the list, add a detail if needed ("이벤트 보상 지급 - 10월 출석"), or type it all by hand.
 * The page keeps the plain text it always sent; `picked` names the template it came from. Nothing is chosen for the
 * admin. A required detail left empty gives '', which the page's own length check refuses. The text input keeps the
 * page's test id and label; the list beside it is named without "사유"/"Reason" so it is never taken for the field.
 */
export function AdminReasonField({
  label,
  templates,
  value,
  onChange,
  maxLength,
  testid,
  hint,
  disabled,
  placeholder,
  emptyText,
  lang,
}: {
  label: string;
  templates: AdminTemplate[] | TemplateGroup[];
  value: string;
  onChange: (value: string, picked: AdminTemplate | null) => void;
  maxLength: number;
  testid: string;
  hint?: ReactNode;
  disabled?: boolean;
  placeholder?: string;
  /** What the list says while it has nothing to offer (a chip memo before the amount is known). */
  emptyText?: string;
  /** The language the reason is written in, when someone other than the admin reads it (a chip memo, in the member's). */
  lang?: Lang;
}) {
  const { t, locale: consoleLocale } = useT();
  const locale = lang ?? consoleLocale;
  const items = flatten(templates);
  // What this field wrote last: a different value came from the page (cleared after a save, or written by another
  // action), and is read again.
  const emitted = useRef(value);
  const [own, setOwn] = useState(() => pickFor(items, value, locale));
  const pick = value === emitted.current ? own : pickFor(items, value, locale);
  const tpl = items.find((x) => x.id === pick) ?? null;
  // Read in the language it was written in: the console's can change while it is being written. More detail keeps
  // that language, unless the reason is for someone else to read (`lang`), whose language it is always in.
  const read = tpl ? readReason([tpl], value, locale) : null;
  const detail = read?.detail ?? '';
  const writeIn = lang ?? read?.lang ?? locale;

  const emit = (next: string, nextPick: string, picked: AdminTemplate | null) => {
    emitted.current = next;
    setOwn(nextPick);
    onChange(next, picked);
  };

  // The template picked is no longer offered (a chip amount changed sign): its reason no longer fits, so it goes.
  // Text typed by hand stays; the admin wrote it.
  const gone = pick !== '' && pick !== CUSTOM && !tpl;
  useEffect(() => {
    if (gone) emit('', '', null);
  });
  // The reader's language changed while this was being written (the member switched theirs): the template's part is
  // written again in it. The detail stays as the admin typed it, and text typed by hand is left alone.
  const relang = lang !== undefined && read !== null && read.lang !== lang;
  useEffect(() => {
    if (relang && tpl && lang) emit(composeReason(tpl, detail.slice(0, Math.max(0, maxLength - labelOf(tpl, lang).length - SEP.length)), lang), tpl.id, tpl);
  });

  const choose = (id: string) => {
    if (id === CUSTOM) return emit(value, CUSTOM, null); // the text so far stays, to edit freely
    const next = items.find((x) => x.id === id);
    if (!next) return;
    const room = Math.max(0, maxLength - labelOf(next, locale).length - SEP.length);
    emit(composeReason(next, (tpl ? detail : value).slice(0, room), locale), id, next);
  };
  const type = (text: string) => {
    if (tpl) return emit(composeReason(tpl, text, writeIn), tpl.id, tpl);
    emit(text, text || pick === CUSTOM ? CUSTOM : '', null);
  };

  const notes = [
    hint,
    tpl?.detailRequired && !detail.trim() ? (
      <span key="need" className="text-gold-300" data-testid={`${testid}-need-detail`}>
        {t('tplNeedDetail')}
      </span>
    ) : null,
    tpl && value ? (
      <span key="will" className="break-words text-ink-300" data-testid={`${testid}-final`}>
        {t('tplWillRecord', { v: value })}
      </span>
    ) : null,
  ].filter(Boolean);

  return (
    <Field label={label} hint={notes.length ? <span className="flex flex-col gap-0.5">{notes}</span> : undefined}>
      {(fid) => (
        <div className="flex flex-col gap-2">
          <select
            aria-label={t('tplChoose')}
            className={selectCls}
            value={pick}
            onChange={(e) => choose(e.target.value)}
            disabled={disabled || !items.length}
            data-testid={`${testid}-template`}
          >
            <option value="" disabled>
              {items.length ? t('tplReasonPick') : (emptyText ?? t('tplReasonPick'))}
            </option>
            <Options list={templates} lang={locale} />
            <option value={CUSTOM}>{t('tplCustom')}</option>
          </select>
          <Input
            id={fid}
            value={tpl ? detail : value}
            maxLength={tpl ? Math.max(0, maxLength - labelOf(tpl, writeIn).length - SEP.length) : maxLength}
            placeholder={tpl ? t(tpl.detailRequired ? 'tplDetailRequired' : 'tplDetailOptional') : (placeholder ?? t('tplCustomPh'))}
            onChange={(e) => type(e.target.value)}
            disabled={disabled}
            data-testid={testid}
          />
        </div>
      )}
    </Field>
  );
}

/** A content template's list: those that fit first when grouped, and "write your own". */
export function AdminTemplateSelect({
  templates,
  value,
  onChange,
  testid,
  disabled,
}: {
  templates: AdminTemplate[] | TemplateGroup[];
  value: string;
  onChange: (id: string) => void;
  testid: string;
  disabled?: boolean;
}) {
  const { t, locale } = useT();
  return (
    <Field label={t('tplLabel')}>
      {(fid) => (
        <select id={fid} className={selectCls} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} data-testid={testid}>
          <option value="" disabled>
            {t('tplPick')}
          </option>
          <Options list={templates} lang={locale} />
          <option value={CUSTOM}>{t('tplWrite')}</option>
        </select>
      )}
    </Field>
  );
}

/** The page's title and body fields: one language ('title', 'body') or both ('titleKo', … 'bodyEn'). */
export type SlotKey = 'title' | 'body' | 'titleKo' | 'titleEn' | 'bodyKo' | 'bodyEn';
type Slots = Partial<Record<SlotKey, string>>;

const slotOf = (k: SlotKey, lang: Lang): { which: 'title' | 'body'; lang: Lang } =>
  k === 'title' || k === 'body' ? { which: k, lang } : { which: k.startsWith('title') ? 'title' : 'body', lang: k.endsWith('En') ? 'en' : 'ko' };

/**
 * A title and body written from a template. Applying one fills every field the page has (both languages where it has
 * both). The values it asks for are written in as they are typed while a field still holds the template's text; a
 * field the admin has changed by hand is left alone except for the blanks still in braces, filled when the value is
 * done (on leaving its field). `auto` values (the maintenance times) follow the form in both cases, replacing the
 * old time wherever it is written.
 *
 * Changing template over text the admin wrote or changed asks first (`pending`); "write your own" keeps the text.
 * `missing` lists the blanks still in braces in what would be sent, and `tooLong` the fields past what the server takes
 * (a template's text with long values in it): the page refuses to save or send either (`blocked`).
 */
export function useContentTemplate({
  templates,
  values,
  apply,
  auto,
  limits,
  lang: initialLang = 'ko',
}: {
  templates: AdminTemplate[] | TemplateGroup[];
  values: Slots;
  apply: (patch: Slots) => void;
  auto?: Record<string, string>;
  /** The most each field may hold, as the server counts it. */
  limits: Partial<Record<SlotKey, number>>;
  /** The language of a one-language form, to start with. */
  lang?: Lang;
}) {
  const items = flatten(templates);
  const keys = Object.keys(values) as SlotKey[];
  const bilingual = keys.some((k) => k !== 'title' && k !== 'body');
  const [choice, setChoice] = useState('');
  const [lang, setLangState] = useState<Lang>(initialLang);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<{ id: string; lang: Lang } | null>(null);
  // The text each field got from the template last: a field that still holds it was not changed by hand.
  const gen = useRef<Slots>({});
  const tpl = items.find((x) => x.id === choice) ?? null;
  // A template no longer offered (the message category changed): the choice goes, the text stays as it is, now the admin's.
  const gone = choice !== '' && choice !== CUSTOM && !tpl;
  useEffect(() => {
    if (!gone) return;
    gen.current = {};
    setChoice('');
  }, [gone]);

  const render = (x: AdminTemplate, k: SlotKey, l: Lang, vs: Record<string, string>) => {
    const s = slotOf(k, l);
    return fill(part(x, s.which, s.lang), { ...vs, ...auto });
  };
  const pristine = (k: SlotKey) => (values[k] ?? '') === gen.current[k];

  const use = (x: AdminTemplate, l: Lang) => {
    const patch: Slots = {};
    for (const k of keys) patch[k] = render(x, k, l, vars);
    gen.current = { ...patch };
    setChoice(x.id);
    setLangState(l);
    setPending(null);
    apply(patch);
  };

  const choose = (id: string, l: Lang = lang) => {
    if (id === CUSTOM) {
      gen.current = {};
      setChoice(CUSTOM);
      setPending(null);
      return;
    }
    const x = items.find((y) => y.id === id);
    if (!x) return;
    const loses = keys.some((k) => (values[k] ?? '').trim() !== '' && !pristine(k) && render(x, k, l, vars) !== values[k]);
    if (loses) setPending({ id, lang: l });
    else use(x, l);
  };

  const setLang = (l: Lang) => {
    if (tpl) choose(tpl.id, l);
    else setLangState(l);
  };

  const setVar = (key: string, val: string) => {
    const next = { ...vars, [key]: val };
    setVars(next);
    if (!tpl) return;
    const patch: Slots = {};
    for (const k of keys)
      if (pristine(k)) {
        patch[k] = render(tpl, k, lang, next);
        gen.current[k] = patch[k];
      }
    if (Object.keys(patch).length) apply(patch);
  };

  /** A value is done: the blank it fills is filled in the fields changed by hand too. */
  const commitVar = (key: string) => {
    const val = vars[key]?.trim();
    if (!val) return;
    const patch: Slots = {};
    for (const k of keys) {
      const cur = values[k] ?? '';
      if (!pristine(k) && cur.includes(`{${key}}`)) patch[k] = cur.replaceAll(`{${key}}`, val);
    }
    if (Object.keys(patch).length) apply(patch);
  };

  // The maintenance times follow the form. The last time written is remembered even while the form has none (an end
  // before the start), so the text can still be found when the times are right again.
  const autoKey = JSON.stringify(auto ?? {});
  const lastAuto = useRef<Record<string, string>>({ ...auto });
  useEffect(() => {
    const now = auto ?? {};
    const was = lastAuto.current;
    const patch: Slots = {};
    for (const k of keys) {
      const cur = values[k] ?? '';
      if (tpl && pristine(k)) {
        const next = render(tpl, k, lang, vars);
        if (next !== cur) {
          patch[k] = next;
          gen.current[k] = next;
        }
        continue;
      }
      let s = cur;
      for (const [key, val] of Object.entries(now)) {
        if (!val) continue;
        if (was[key] && was[key] !== val) s = s.replaceAll(was[key]!, val);
        s = s.replaceAll(`{${key}}`, val);
      }
      if (s !== cur) patch[k] = s;
    }
    for (const [key, val] of Object.entries(now)) if (val) lastAuto.current[key] = val;
    if (Object.keys(patch).length) apply(patch);
    // Only a change of the times does this; the text and values are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoKey]);

  const sent = keys.map((k) => values[k] ?? '');
  const missing = unfilled(sent);
  const tooLong = overLimit(values, limits);
  const asked = tpl ? unfilled(keys.map((k) => part(tpl, slotOf(k, lang).which, slotOf(k, lang).lang))) : [];
  // A time the form writes is not asked for; a form without times (a notice) asks for it like any other value.
  const needed = [...asked, ...missing.filter((k) => !asked.includes(k))]
    .map((k) => varOf(k))
    .filter((x): x is TemplateVar => !!x && !(x.auto && auto && x.key in auto));

  return {
    templates,
    choice,
    choose,
    template: tpl,
    lang,
    setLang,
    bilingual,
    vars,
    setVar,
    commitVar,
    needed,
    missing,
    tooLong,
    blocked: missing.length > 0 || tooLong.length > 0,
    pending: pending ? (items.find((x) => x.id === pending.id) ?? null) : null,
    confirm: () => {
      const x = pending && items.find((y) => y.id === pending.id);
      if (x) use(x, pending.lang);
    },
    cancel: () => setPending(null),
    /** For a form opened afresh: no template, no values. */
    reset: () => {
      gen.current = {};
      lastAuto.current = {};
      setChoice('');
      setVars({});
      setPending(null);
      setLangState(initialLang);
    },
  };
}
export type ContentTemplate = ReturnType<typeof useContentTemplate>;

/** A value's name in the console's language, with the language of the text it goes into when the form has both. */
function varName(x: TemplateVar, locale: Lang, bilingual: boolean, t: ReturnType<typeof useT>['t']) {
  const name = locale === 'en' ? x.en : x.ko;
  return bilingual && x.lang ? `${name} · ${t(x.lang === 'en' ? 'langEn' : 'langKo')}` : name;
}

/** The names of the blanks not filled yet, for the page's message. */
export function missingNames(tpl: ContentTemplate, locale: Lang, t: ReturnType<typeof useT>['t']) {
  return tpl.missing.map((k) => {
    const x = varOf(k);
    return x ? varName(x, locale, tpl.bilingual, t) : k;
  });
}

/** The values the template asks for. */
export function TemplateVariableFields({ tpl, testid }: { tpl: ContentTemplate; testid: string }) {
  const { t, locale } = useT();
  if (!tpl.needed.length) return null;
  return (
    <div className="flex flex-col gap-3" data-testid={`${testid}-vars`}>
      <p className="text-xs text-ink-400">{t('tplVarsHint')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {tpl.needed.map((x) => (
          <div key={x.key} className={x.multiline ? 'sm:col-span-2' : undefined}>
            <Field label={varName(x, locale, tpl.bilingual, t)} hint={locale === 'en' ? x.hintEn : x.hintKo}>
              {(fid) =>
                x.multiline ? (
                  <textarea
                    id={fid}
                    rows={3}
                    maxLength={1000}
                    value={tpl.vars[x.key] ?? ''}
                    onChange={(e) => tpl.setVar(x.key, e.target.value)}
                    onBlur={() => tpl.commitVar(x.key)}
                    className={areaCls}
                    data-testid={`${testid}-var-${x.key}`}
                  />
                ) : (
                  <Input
                    id={fid}
                    maxLength={200}
                    value={tpl.vars[x.key] ?? ''}
                    onChange={(e) => tpl.setVar(x.key, e.target.value)}
                    onBlur={() => tpl.commitVar(x.key)}
                    data-testid={`${testid}-var-${x.key}`}
                  />
                )
              }
            </Field>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The template list (and the language of a one-language form), the question before text is replaced, and the values
 * to fill: everything a form puts above its title and body.
 */
export function ContentTemplateFields({ tpl, testid, templates }: { tpl: ContentTemplate; testid: string; templates?: AdminTemplate[] | TemplateGroup[] }) {
  const { t, locale } = useT();
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-ink-900/40 p-3" data-testid={testid}>
      <div className={tpl.bilingual ? undefined : 'grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]'}>
        <AdminTemplateSelect templates={templates ?? tpl.templates} value={tpl.choice} onChange={(id) => tpl.choose(id)} testid={`${testid}-select`} />
        {!tpl.bilingual && (
          <Field label={t('tplLang')}>
            {(fid) => (
              <select id={fid} className={selectCls} value={tpl.lang} onChange={(e) => tpl.setLang(e.target.value as Lang)} data-testid={`${testid}-lang`}>
                <option value="ko">{t('langKo')}</option>
                <option value="en">{t('langEn')}</option>
              </select>
            )}
          </Field>
        )}
      </div>
      {tpl.pending && (
        <div role="group" aria-label={t('tplReplaceTitle')} className="flex flex-col gap-2 rounded-lg border border-gold-500/40 bg-gold-500/10 p-3 text-sm" data-testid={`${testid}-replace`}>
          <p>{t('tplReplaceAsk', { v: labelOf(tpl.pending, locale) })}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={tpl.confirm} data-testid={`${testid}-replace-yes`}>
              {t('tplReplace')}
            </Button>
            <Button size="sm" variant="ghost" onClick={tpl.cancel} data-testid={`${testid}-replace-no`}>
              {t('tplKeep')}
            </Button>
          </div>
        </div>
      )}
      <TemplateVariableFields tpl={tpl} testid={testid} />
    </div>
  );
}

/** Text with the blanks still in braces marked. */
function Marked({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) {
    if (!varOf(m[1]!)) continue;
    out.push(text.slice(at, m.index));
    out.push(
      <mark key={m.index} className="rounded bg-danger/20 px-0.5 text-danger">
        {m[0]}
      </mark>,
    );
    at = m.index! + m[0].length;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

/** How the text will read, each language on its own; blanks still to fill are marked. Folded until opened. */
export function TemplatePreview({ items, testid }: { items: { label?: string; title?: string; body: string }[]; testid: string }) {
  const { t } = useT();
  return (
    <details className="rounded-lg border border-white/10 bg-ink-900/40 p-3 text-sm" data-testid={testid}>
      <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-[0.12em] text-ink-300">{t('tplPreview')}</summary>
      <div className="mt-3 flex flex-col gap-4">
        {items.map((x, i) => (
          <section key={i} className="flex min-w-0 flex-col gap-1">
            {x.label && <p className="text-xs text-ink-400">{x.label}</p>}
            {x.title !== undefined && <p className="break-words font-semibold text-ivory">{x.title ? <Marked text={x.title} /> : <span className="text-ink-400">{t('tplPreviewEmpty')}</span>}</p>}
            <p className="whitespace-pre-wrap break-words text-ink-100">{x.body ? <Marked text={x.body} /> : <span className="text-ink-400">{t('tplPreviewEmpty')}</span>}</p>
          </section>
        ))}
      </div>
    </details>
  );
}

/** The blanks not filled yet, said where the save button is. */
export function TemplateMissing({ tpl, testid }: { tpl: ContentTemplate; testid: string }) {
  const { t, locale } = useT();
  if (!tpl.missing.length) return null;
  return (
    <p role="alert" className="text-xs text-danger" data-testid={testid}>
      {t('tplMissing', { v: missingNames(tpl, locale, t).join(', ') })}
    </p>
  );
}

/** The fields too long to send, each with how far over it is, said where the save button is. `names` are the page's own field labels. */
export function TemplateTooLong({ tpl, testid, names }: { tpl: ContentTemplate; testid: string; names?: Partial<Record<SlotKey, string>> }) {
  const { t, locale } = useT();
  if (!tpl.tooLong.length) return null;
  const n = (x: number) => x.toLocaleString(locale === 'en' ? 'en-US' : 'ko-KR');
  const name = (k: SlotKey) => {
    if (names?.[k]) return names[k];
    const s = slotOf(k, 'ko');
    const base = t(s.which === 'title' ? 'titleLabel' : 'bodyLabel');
    return k === 'title' || k === 'body' ? base : `${base} · ${t(s.lang === 'en' ? 'langEn' : 'langKo')}`;
  };
  return (
    <div role="alert" className="flex flex-col gap-0.5 text-xs text-danger" data-testid={testid}>
      {tpl.tooLong.map((x) => (
        <p key={x.key} data-testid={`${testid}-${x.key}`}>
          {t('tplTooLong', { v: name(x.key), max: n(x.max), n: n(x.length) })}
        </p>
      ))}
    </div>
  );
}
