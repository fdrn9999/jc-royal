/**
 * A member's own bookmark, tags and memo on their hands (PUT /api/me/hands/:id/note): the hand rows of My Page and the
 * hand list, and the note panel of a hand's detail. Only the member ever sees these; the server keeps them per member.
 */
import { HAND_MEMO_MAX, HAND_TAGS, handLabelKey, type HandNoteDto, type HandSummaryDto, type HandTag } from '@jc/types';
import { BookmarkIcon, Button, cx, formatChips, formatDate, Panel, PencilIcon, PlayingCard } from '@jc/ui';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { api, ApiError } from '../lib/api';
import { useI18n, type MsgKey } from '../lib/i18n';

type Card = Parameters<typeof PlayingCard>[0]['card'];

export const saveNote = (handId: string, body: Record<string, unknown>) => api<HandNoteDto>(`/api/me/hands/${encodeURIComponent(handId)}/note`, { method: 'PUT', body });

export function BookmarkToggle({ on, busy, onToggle }: { on: boolean; busy?: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={t('hands.bookmark')}
      title={t('hands.bookmark')}
      disabled={busy}
      onClick={onToggle}
      className={cx('jc-tap grid size-10 shrink-0 place-items-center rounded-lg transition hover:bg-white/5 disabled:opacity-60', on ? 'text-gold-300' : 'text-ink-400 hover:text-ink-200')}
      data-testid="hand-bookmark"
    >
      <BookmarkIcon className={cx('size-5', on && 'fill-current')} />
    </button>
  );
}

export function TagChip({ tag, on, onToggle, disabled }: { tag: HandTag; on: boolean; onToggle?: () => void; disabled?: boolean }) {
  const { t } = useI18n();
  const label = t(`hands.tags.${tag}` as MsgKey);
  const cls = cx('rounded-full border font-semibold', on ? 'border-gold-400/70 bg-gold-500/15 text-gold-300' : 'border-white/10 text-ink-300');
  if (!onToggle) return <span className={cx(cls, 'px-2 py-0.5 text-[11px]')}>{label}</span>;
  return (
    <button type="button" aria-pressed={on} disabled={disabled} onClick={onToggle} className={cx(cls, 'jc-tap min-h-10 px-3.5 text-sm transition hover:border-gold-400/50 disabled:opacity-60')} data-tag={tag}>
      {label}
    </button>
  );
}

const signed = (n: number) => `${n > 0 ? '+' : ''}${formatChips(n)}`;

/** One of the member's hands: cards, table, result, their tags and memo mark, and a bookmark that saves on the spot. */
export function HandRow({ hand, onChange }: { hand: HandSummaryDto; onChange: (h: HandSummaryDto) => void }) {
  const { t, locale } = useI18n();
  const { pathname, search } = useLocation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function toggle() {
    const on = !hand.bookmarked;
    setBusy(true);
    setFailed(false);
    onChange({ ...hand, bookmarked: on });
    try {
      const n = await saveNote(hand.id, { bookmarked: on });
      onChange({ ...hand, bookmarked: n.bookmarked, tags: n.tags, hasMemo: n.memo !== null });
    } catch {
      onChange(hand);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="flex items-center gap-2 py-2.5 sm:gap-3" data-testid="hand-row" data-hand={hand.id}>
      <span className="flex shrink-0 gap-0.5">
        {hand.holeCards.map((c) => (
          <PlayingCard key={c} card={c as Card} size="1.6rem" />
        ))}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{hand.tableName}</div>
        <div className="text-xs text-ink-400">
          #{hand.handNumber} · {formatDate(hand.endedAt, locale)}
          {hand.position && ` · ${t(`me.pos.${hand.position}` as MsgKey)}`}
          {hand.rankClass && ` · ${t(`hand.${handLabelKey(hand.rankClass, [])}` as MsgKey)}`}
        </div>
        {(hand.tags.length > 0 || hand.hasMemo) && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {hand.tags.map((tg) => (
              <TagChip key={tg} tag={tg} on />
            ))}
            {hand.hasMemo && (
              <span className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-ink-300" data-testid="hand-memo-mark">
                <PencilIcon className="size-3" />
                {t('hands.memoMark')}
              </span>
            )}
          </div>
        )}
        {failed && (
          <p className="mt-1 text-xs text-danger" role="alert">
            {t('note.failed')}
          </p>
        )}
      </div>
      <span className={`shrink-0 font-mono text-sm font-semibold tabular-nums ${hand.net >= 0 ? 'text-[#9fd8b6]' : 'text-[#f0a0a2]'}`}>{signed(hand.net)}</span>
      <BookmarkToggle on={hand.bookmarked} busy={busy} onToggle={() => void toggle()} />
      {/* The hand's page goes back here: the list with its filters, where it was. */}
      <Link to={`/me/hands/${encodeURIComponent(hand.id)}`} state={{ from: pathname + search }} className="jc-tap shrink-0 py-2 text-xs text-gold-300 hover:underline">
        {t('me.viewHand')}
      </Link>
    </li>
  );
}

type Status = 'idle' | 'saving' | 'saved' | 'failed' | 'conflict';

/**
 * The note on a hand's detail: bookmark and tags save as they are pressed; the memo saves over the revision it was
 * opened at, so a save from another tab or device in between is reported (and the draft kept) instead of overwritten.
 */
export function HandNotePanel({ handId, initial }: { handId: string; initial: HandNoteDto }) {
  const { t, err } = useI18n();
  const [note, setNote] = useState(initial);
  // The memo the draft was written over, and its revision.
  const [base, setBase] = useState({ memo: initial.memo ?? '', rev: initial.rev });
  const [draft, setDraft] = useState(initial.memo ?? '');
  const [busy, setBusy] = useState(false);
  const [toggleErr, setToggleErr] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [saved, setSaved] = useState<HandNoteDto | null>(null);
  const dirty = draft.trim() !== base.memo;
  // Read when a response lands: what is being written then, not when the request went out.
  const memoRef = useRef({ draft, dirty, rev: base.rev });
  memoRef.current = { draft, dirty, rev: base.rev };

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  /**
   * A toggle's answer: the bookmark and tags follow it, and so does the memo unless something is being written now or
   * the answer is older than the memo shown (a memo save that went out later and came back first).
   */
  function took(n: HandNoteDto) {
    setNote((cur) => ({ ...cur, bookmarked: n.bookmarked, tags: n.tags }));
    if (memoRef.current.dirty || n.rev < memoRef.current.rev) return;
    setBase({ memo: n.memo ?? '', rev: n.rev });
    setDraft(n.memo ?? '');
  }

  async function toggle(body: Record<string, unknown>, optimistic: HandNoteDto) {
    const before = note;
    setNote(optimistic);
    setBusy(true);
    setToggleErr(null);
    try {
      took(await saveNote(handId, body));
    } catch (x) {
      setNote((cur) => ({ ...cur, bookmarked: before.bookmarked, tags: before.tags }));
      setToggleErr(x instanceof ApiError && x.code !== 'internal' ? err(x.code) : t('note.failed'));
    } finally {
      setBusy(false);
    }
  }
  const toggleTag = (tag: HandTag) => {
    const on = !note.tags.includes(tag);
    void toggle({ tags: { [tag]: on } }, { ...note, tags: HAND_TAGS.filter((x) => (x === tag ? on : note.tags.includes(x))) });
  };

  async function saveMemo() {
    const sent = draft;
    setStatus('saving');
    try {
      // The bookmark and tags stay as the toggles left them; this answer may be older than a toggle's.
      const n = await saveNote(handId, { memo: sent, rev: base.rev });
      setNote((cur) => ({ ...cur, memo: n.memo, rev: n.rev, updatedAt: n.updatedAt }));
      setBase({ memo: n.memo ?? '', rev: n.rev });
      // Typing that went on while saving stays, as unsaved.
      const later = memoRef.current.draft !== sent;
      if (!later) setDraft(n.memo ?? '');
      setSaved(null);
      setStatus(later ? 'idle' : 'saved');
    } catch (x) {
      const server = x instanceof ApiError && x.code === 'note_conflict' ? (x.details as { note?: HandNoteDto } | undefined)?.note : undefined;
      if (server) {
        // Keep the draft; saving again now writes it over what was saved (the member has seen that it changed).
        setNote((cur) => ({ ...cur, memo: server.memo, rev: server.rev, updatedAt: server.updatedAt }));
        setBase({ memo: base.memo, rev: server.rev });
        setSaved(server);
        setStatus('conflict');
      } else {
        setToggleErr(x instanceof ApiError && x.code !== 'internal' ? err(x.code) : null);
        setStatus('failed');
      }
    }
  }
  function loadSaved() {
    if (!saved) return;
    setBase({ memo: saved.memo ?? '', rev: saved.rev });
    setDraft(saved.memo ?? '');
    setSaved(null);
    setStatus('idle');
  }

  return (
    <Panel title={t('note.title')} actions={<BookmarkToggle on={note.bookmarked} busy={busy} onToggle={() => void toggle({ bookmarked: !note.bookmarked }, { ...note, bookmarked: !note.bookmarked })} />}>
      <div className="flex flex-col gap-3" data-testid="hand-note">
        <p className="text-xs text-ink-400">{t('note.private')}</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('hands.tag')}>
          {HAND_TAGS.map((tg) => (
            <TagChip key={tg} tag={tg} on={note.tags.includes(tg)} disabled={busy} onToggle={() => toggleTag(tg)} />
          ))}
        </div>
        {toggleErr && status !== 'failed' && (
          <p className="text-xs text-danger" role="alert">
            {toggleErr}
          </p>
        )}
        <label htmlFor="hand-memo" className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-300">
          {t('note.memo')}
        </label>
        <textarea
          id="hand-memo"
          value={draft}
          maxLength={HAND_MEMO_MAX}
          rows={4}
          placeholder={t('note.memoPlaceholder')}
          onChange={(e) => {
            setDraft(e.target.value);
            if (status === 'saved' || status === 'failed') setStatus('idle');
          }}
          className="w-full rounded-lg border border-white/10 bg-ink-850 px-3 py-2 text-base text-ivory placeholder:text-ink-400 focus:border-gold-500/70 focus:outline-none focus:ring-2 focus:ring-gold-500/20 sm:text-sm"
          data-testid="hand-memo"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={() => void saveMemo()} loading={status === 'saving'} disabled={!dirty && status !== 'conflict'} data-testid="hand-memo-save">
            {status === 'saving' ? t('note.saving') : t('note.save')}
          </Button>
          <span className="font-mono text-xs text-ink-400 tabular-nums" aria-live="polite">
            {draft.length} / {HAND_MEMO_MAX}
          </span>
          <span className="text-xs" aria-live="polite" data-testid="hand-memo-status">
            {status === 'saved' && <span className="text-[#9fd8b6]">{t('me.saved')}</span>}
            {status === 'failed' && <span className="text-danger">{toggleErr ?? t('note.failed')}</span>}
            {status !== 'saved' && status !== 'failed' && status !== 'conflict' && dirty && <span className="text-ink-300">{t('note.unsaved')}</span>}
          </span>
        </div>
        {status === 'conflict' && saved && (
          <div className="rounded-lg border border-gold-500/30 bg-gold-500/5 p-3 text-sm" role="alert" data-testid="hand-memo-conflict">
            <p className="text-gold-300">{t('note.conflict')}</p>
            <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-black/25 px-3 py-2 text-ink-200">{saved.memo ?? '—'}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={loadSaved} data-testid="hand-memo-load">
              {t('note.loadServer')}
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}
