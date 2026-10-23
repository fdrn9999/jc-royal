/**
 * How the amounts on Bet/Raise (and the line under it) are sized to it: each line takes its own face where it fits, a
 * smaller one where it is longer than the button is wide, never one under `MIN_FACE`. A line still too long for the
 * button at that face wraps where it may (between the blinds and the chips, after a comma between thousands) and the
 * buttons' row grows with it, so no amount is cut or set too small to read. Shared with the tests that measure it.
 */

/** The smallest face, in px, of an amount on Bet/Raise or of the line under it. */
export const MIN_FACE = 9;

/**
 * About how wide a line of the amounts' text is, in its own font size: a figure, letter or space of the monospace face
 * is 0.6 of it, a Hangul (or other wide) glyph, set in the fallback face, at most 1.
 */
export const ems = (text: string) => Array.from(text).reduce((n, c) => n + (/[ᄀ-ᇿ⺀-꓏가-힯豈-﫿＀-￯]/.test(c) ? 1 : 0.6), 0);

/** A line of Bet/Raise's amount: at most `max`px, across 96% of the button's inside (its container), at least `MIN_FACE`. */
export const lineFace = (text: string, max: number) => `max(${MIN_FACE}px, min(${max}px, ${(96 / ems(text)).toFixed(2)}cqi))`;

/** The line under Bet/Raise: at most 11px, across its box (2px in from each side of the button) less 2px, at least `MIN_FACE`. */
export const captionFace = (text: string) => `max(${MIN_FACE}px, min(11px, calc((100cqi - 6px) / ${ems(text).toFixed(2)})))`;

/** A line of an amount cut where it may wrap besides its spaces: after each comma between thousands. */
export const wrapPoints = (text: string) => text.split(/(?<=,)/);
