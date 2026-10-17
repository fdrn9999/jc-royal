import { cx } from '@jc/ui';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { insertAt, PICKER_EMOJI } from '../lib/emoji';
import { useI18n } from '../lib/i18n';

/** Keeps focus (and a phone's keyboard) on the text field while a picker button is pressed. */
const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

/**
 * Emoji button for a one-line text field (table chat, direct messages): the pick goes in at the caret, or in place of
 * the selection, and the rest of the text stays. The panel opens above, against the right edge of the nearest positioned
 * ancestor (the form: a phone's width has no room to the left of a button beside the send button), and closes on a tap
 * outside, Escape or when the form is sent.
 */
export function EmojiPicker({
  inputRef,
  value,
  onChange,
  maxLength,
  small,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  /** From the sm breakpoint the button matches a 2.25rem field (the table chat's); a phone keeps the 2.75rem target. */
  small?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  /** Where the caret goes once the new text is in the field (React sets the value, which moves the caret to its end). */
  const caret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (caret.current === null || !el) return;
    // Only a field that has focus: placing the caret in one that does not would bring up a phone's keyboard.
    if (document.activeElement === el) el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value, inputRef]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      e.stopPropagation();
    };
    const form = inputRef.current?.form;
    const sent = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', esc);
    form?.addEventListener('submit', sent);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', esc);
      form?.removeEventListener('submit', sent);
    };
  }, [open, inputRef]);

  const pick = (emoji: string) => {
    const el = inputRef.current;
    const next = insertAt(value, el?.selectionStart ?? value.length, el?.selectionEnd ?? value.length, emoji, maxLength);
    if (!next) return;
    caret.current = next.caret;
    onChange(next.value);
  };

  return (
    <div ref={box} className="shrink-0">
      <button
        type="button"
        onPointerDown={keepFocus}
        onClick={() => setOpen((o) => !o)}
        className={cx('jc-tap grid size-11 place-items-center rounded-lg border text-lg', small && 'sm:size-9', open ? 'border-gold-500/60 bg-gold-500/15' : 'border-white/10 bg-ink-850 hover:bg-white/5')}
        aria-label={t('emoji.open')}
        aria-expanded={open}
        data-testid="emoji-open"
      >
        <span aria-hidden>😊</span>
      </button>
      {open && (
        <div
          role="group"
          aria-label={t('emoji.open')}
          className="absolute bottom-full right-0 z-50 mb-2 grid w-max grid-cols-8 rounded-xl border border-gold-500/25 bg-ink-950/95 p-1 shadow-2xl backdrop-blur"
          data-testid="emoji-panel"
        >
          {PICKER_EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              onPointerDown={keepFocus}
              onClick={() => pick(e)}
              disabled={value.length + e.length > maxLength}
              className="jc-tap grid size-9 place-items-center rounded-lg text-xl hover:bg-white/10 disabled:opacity-35"
              data-testid="emoji-option"
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
