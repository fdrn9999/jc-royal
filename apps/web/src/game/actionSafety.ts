/**
 * Decisions behind the action bar, kept free of React and the DOM so they can be unit tested: which key presses
 * count as table shortcuts, which actions need a second press, and what a raise panel commit may send.
 */
import type { ActionType, LegalOption } from '@jc/types';

export type ArmKey = 'fold' | 'call' | 'allin' | 'commit';
export type Shortcut = 'fold' | 'checkCall' | 'raisePanel';

/** A first press on a risky action. It confirms only the same action at the same amount, before `until`. */
export interface Armed {
  key: ArmKey;
  sig: string;
  until: number;
}

/** Shortcuts never fire from these: typing, choosing, a dialog, or anything marked (the table chat). */
const NO_SHORTCUTS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [data-no-shortcuts]';
/** Physical keys, for keyboards whose layout or IME mode (Korean 한글) does not give Latin letters. */
const BY_CODE: Record<string, string> = { KeyF: 'f', KeyC: 'c', KeyR: 'r' };

export interface KeyLike {
  key: string;
  code?: string;
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  target: unknown;
}

/** The shortcut a key press asks for, or null when it is held down, modified, typed into a field, or a modal is open. */
export function shortcutFor(e: KeyLike, modalOpen: boolean): Shortcut | null {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || modalOpen) return null;
  const el = e.target as { closest?: (selector: string) => unknown } | null;
  if (typeof el?.closest === 'function' && el.closest(NO_SHORTCUTS)) return null;
  const k = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : BY_CODE[e.code ?? ''];
  return k === 'f' ? 'fold' : k === 'c' ? 'checkCall' : k === 'r' ? 'raisePanel' : null;
}

/**
 * Risky actions need a second press when confirmation is on: folding while a check is free, and putting half the
 * stack or more in with a call, an all-in, or a bet or raise. `myStack` is the chips behind, `streetBet` what is
 * already in front of the player this street.
 */
export function isRisky(key: ArmKey, legal: LegalOption[], myStack: number, streetBet = 0, commitTo = 0): boolean {
  const call = legal.find((o) => o.type === 'call');
  switch (key) {
    case 'fold':
      return legal.some((o) => o.type === 'check');
    case 'call':
      return !!call && call.amount * 2 >= myStack;
    case 'allin':
      return true;
    case 'commit':
      return (commitTo - streetBet) * 2 >= myStack;
  }
}

/** What a press confirms: the same action at the same amount in the same betting turn. */
export function armSig(seq: number | undefined, amount: number | undefined) {
  return `${seq ?? '-'}:${amount ?? ''}`;
}

export type TapDecision = 'ignore' | 'arm' | 'run';

/** Whether a press runs the action, arms it for a second press, or is ignored (in flight, or too soon after the bar appeared). */
export function decideTap(p: { key: ArmKey; sig: string; risky: boolean; confirmRisky: boolean; armed: Armed | null; busy: boolean; now: number; readyAt: number }): TapDecision {
  if (p.busy || p.now < p.readyAt) return 'ignore';
  const confirmed = !!p.armed && p.armed.key === p.key && p.armed.sig === p.sig && p.now < p.armed.until;
  return p.risky && p.confirmRisky && !confirmed ? 'arm' : 'run';
}

/** What the raise panel sends for `to`, or null when the server would refuse it (outside its window, not a whole chip count). */
export function commitAction(legal: LegalOption[], to: number): { type: Extract<ActionType, 'bet' | 'raise' | 'allin'>; amount: number } | null {
  const window_ = legal.find((o): o is Extract<LegalOption, { type: 'bet' | 'raise' }> => o.type === 'bet' || o.type === 'raise');
  if (!window_ || !Number.isSafeInteger(to) || to < window_.min || to > window_.max) return null;
  const allin = legal.find((o) => o.type === 'allin');
  return { type: allin && allin.amount === to ? 'allin' : window_.type, amount: to };
}
