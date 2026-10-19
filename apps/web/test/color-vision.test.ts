// The colour vision modes (styles.css, data-cv on <html>), read from the stylesheet itself: in every mode, with the
// four-colour deck on or off, text keeps its contrast (WCAG 2.2: 4.5:1, 7:1 in high contrast; 3:1 for status icons)
// and the colours that tell actions, suits and states apart stay apart for that kind of colour vision, as simulated
// (Machado, Oliveira & Fernandes 2009, full dichromacy) and measured in CIEDE2000. A simulation, not people: no claim
// here that a person with that colour vision has checked it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SETTINGS_COLOR_VISIONS, type ColorVision } from '@jc/types';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../../../packages/ui/src/styles.css', import.meta.url)), 'utf8');
const src = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const actionBar = src('../src/game/ActionBar.tsx');
const seat = src('../src/game/Seat.tsx');
const chips = src('../../../packages/ui/src/poker/cards.tsx');
const academyUi = src('../src/academy/ui.tsx');
const QUIZ_PAGES = ['ui.tsx', 'pages/PracticePage.tsx', 'pages/FreePracticePage.tsx', 'pages/ReviewPage.tsx', 'pages/ProgressPage.tsx'].map((f) => src(`../src/academy/${f}`));

const vars = (body: string) => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
const theme = vars(/@theme\s*\{([^{}]*)\}/.exec(css)![1]!);
const blocks = new Map([...css.matchAll(/(?:^|\n):root(?:\[data-cv='(\w+)'\])?\s*\{([^{}]*)\}/g)].map((m) => [m[1] ?? 'default', vars(m[2]!)]));

/** Every colour a mode ends up with: the theme's, the defaults, then the mode's own. */
function palette(mode: ColorVision): Record<string, string> {
  return { ...theme, ...blocks.get('default'), ...(blocks.get(mode) ?? {}) };
}

// ------------------------------------------------------------------ colour maths
type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255) as Rgb;
};
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map(toLinear) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG 2.2 contrast ratio. */
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** Machado et al. 2009, severity 1.0, on linear RGB. */
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
} as const;
type Vision = keyof typeof MACHADO | 'normal';
const simulate = (hex: string, vision: Vision): Rgb => {
  const l = rgb(hex).map(toLinear) as Rgb;
  if (vision === 'normal') return l;
  return MACHADO[vision].map((row) => Math.min(1, Math.max(0, row[0] * l[0] + row[1] * l[1] + row[2] * l[2]))) as Rgb;
};
const lab = ([r, g, b]: Rgb): Rgb => {
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};
/** CIEDE2000 between two CIELAB colours. */
function ciede2000([L1, a1, b1]: Rgb, [L2, a2, b2]: Rgb): number {
  const rad = Math.PI / 180;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1 = Math.hypot(a1p, b1);
  const C2 = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) => (b === 0 && a === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const h1 = hue(b1, a1p);
  const h2 = hue(b2, a2p);
  let dh = 0;
  if (C1 * C2 !== 0) dh = h2 - h1 > 180 ? h2 - h1 - 360 : h2 - h1 < -180 ? h2 - h1 + 360 : h2 - h1;
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh / 2) * rad);
  const Lm = (L1 + L2) / 2;
  const Cm = (C1 + C2) / 2;
  let hm = h1 + h2;
  if (C1 * C2 !== 0) hm = (Math.abs(h1 - h2) > 180 ? hm + (hm < 360 ? 360 : -360) : hm) / 2;
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const SL = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const SC = 1 + 0.045 * Cm;
  const SH = 1 + 0.015 * Cm * T;
  const RT = -Math.sin(2 * 30 * Math.exp(-(((hm - 275) / 25) ** 2)) * rad) * 2 * Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7));
  const l = (L2 - L1) / SL;
  const c = (C2 - C1) / SC;
  const h = dH / SH;
  return Math.sqrt(l * l + c * c + h * h + RT * c * h);
}
/** How far apart two colours look to someone with that colour vision. */
const apart = (a: string, b: string, vision: Vision) => ciede2000(lab(simulate(a, vision)), lab(simulate(b, vision)));

// ------------------------------------------------------------------ what is checked
/** The kind of colour vision each mode is for (high contrast: for low vision, not a colour vision kind). */
const VISION: Record<ColorVision, Vision> = { normal: 'normal', protan: 'protan', deutan: 'deutan', tritan: 'tritan', highContrast: 'normal' };
const TEXT = (mode: ColorVision) => (mode === 'highContrast' ? 7 : 4.5);
const NON_TEXT = 3;
/** CIEDE2000: about 2 is a just-noticeable difference; these are far past it. */
const MUST_DIFFER = 30;
const SHOULD_DIFFER = 15;
const SUITS_DIFFER = 20;

const ACTIONS = ['fold', 'check', 'call', 'raise', 'allin'] as const;
/** The chip denominations, 0 to 100K. */
const CHIP_TIERS = 9;
const CARD_FACE = ['#fffdf7', '#f3ecdc'];
const PANELS = ['--color-ink-950', '--color-ink-900', '--color-ink-850', '--color-ink-800', '--color-ink-700'];

describe('the colour maths', () => {
  it('contrast and CIEDE2000 match their published values', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    // Sharma, Wu & Dalal (2005), test pairs 1, 7 and 17.
    expect(ciede2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4);
    expect(ciede2000([50, 0, 0], [50, -1, 2])).toBeCloseTo(2.3669, 4);
    expect(ciede2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 4);
  });

  it('the simulation loses what each kind of colour vision loses', () => {
    // The table's old fold red and call green: far apart to most eyes, nearly one colour without green cones.
    expect(apart('#c4474a', '#2f8f59', 'normal')).toBeGreaterThan(50);
    expect(apart('#c4474a', '#2f8f59', 'deutan')).toBeLessThan(10);
    // Blue against green is what blue-weak vision confuses; red against green it keeps.
    expect(apart('#1f5fbf', '#1d7a3e', 'tritan')).toBeLessThan(apart('#1f5fbf', '#1d7a3e', 'normal') / 2);
    expect(apart('#c4474a', '#2f8f59', 'tritan')).toBeGreaterThan(50);
  });
});

describe.each(SETTINGS_COLOR_VISIONS)('colour vision mode %s', (mode) => {
  const p = palette(mode);
  const vision = VISION[mode];
  const c = (name: string) => {
    const v = p[name];
    if (!v) throw new Error(`${mode}: no ${name}`);
    return v;
  };
  const panels = PANELS.map(c);

  it('every action button’s name reads on its whole gradient', () => {
    for (const k of ACTIONS) {
      for (const stop of ['from', 'to']) expect(contrast(c(`--act-${k}-${stop}`), c(`--act-${k}-fg`)), `${k} ${stop}`).toBeGreaterThanOrEqual(TEXT(mode));
    }
  });

  it('fold and call far apart; every other pair of actions apart', () => {
    // Both ends of each gradient, the nearer of the two.
    const gap = (a: string, b: string) => Math.min(apart(c(`--act-${a}-from`), c(`--act-${b}-from`), vision), apart(c(`--act-${a}-to`), c(`--act-${b}-to`), vision));
    expect(gap('fold', 'call')).toBeGreaterThanOrEqual(MUST_DIFFER);
    for (const [a, b] of [['fold', 'check'], ['call', 'check'], ['raise', 'allin'], ['fold', 'allin'], ['call', 'allin'], ['call', 'raise'], ['fold', 'raise']] as const)
      expect(gap(a, b), `${a}/${b}`).toBeGreaterThanOrEqual(SHOULD_DIFFER);
  });

  it.each([false, true])('cards (four-colour deck %s): every suit reads on the face, and the suits stay apart', (four) => {
    const suits = four ? ['--suit-red', '--suit-diamond', '--suit-club', '--suit-black'] : ['--suit-red', '--suit-black'];
    for (const s of suits) for (const face of CARD_FACE) expect(contrast(c(s), face), `${s} on ${face}`).toBeGreaterThanOrEqual(TEXT(mode));
    expect(apart(c('--suit-red'), c('--suit-black'), vision)).toBeGreaterThanOrEqual(MUST_DIFFER);
    for (let i = 0; i < suits.length; i++)
      for (let j = i + 1; j < suits.length; j++) expect(apart(c(suits[i]!), c(suits[j]!), vision), `${suits[i]}/${suits[j]}`).toBeGreaterThanOrEqual(SUITS_DIFFER);
  });

  it('success, danger, warning and info text read on every panel; success and danger far apart', () => {
    for (const k of ['--color-success', '--color-danger', '--color-warning', '--color-info'])
      for (const bg of panels) expect(contrast(c(k), bg), `${k} on ${bg}`).toBeGreaterThanOrEqual(TEXT(mode));
    expect(apart(c('--color-success'), c('--color-danger'), vision)).toBeGreaterThanOrEqual(MUST_DIFFER);
  });

  it('a count badge: its white number reads on the strong danger colour', () => {
    // The number is the badge's information (text contrast); the fill's edge carries none of its own.
    expect(contrast(c('--color-danger-strong'), '#ffffff')).toBeGreaterThanOrEqual(TEXT(mode));
  });

  it('friends’ status icons seen on the panels and apart from each other (each also has its shape and word)', () => {
    const states = ['--color-presence-online', '--color-presence-away', '--color-presence-offline'];
    for (const s of states) for (const bg of panels) expect(contrast(c(s), bg), `${s} on ${bg}`).toBeGreaterThanOrEqual(NON_TEXT);
    for (let i = 0; i < states.length; i++)
      for (let j = i + 1; j < states.length; j++) expect(apart(c(states[i]!), c(states[j]!), vision), `${states[i]}/${states[j]}`).toBeGreaterThanOrEqual(SUITS_DIFFER);
  });

  it('a seat’s last action reads on the panels; fold and call far apart, every other pair apart (the word is there too)', () => {
    const tone = { fold: c('--act-fold-text'), call: c('--act-call-text'), allin: c('--act-allin-text'), raise: c('--color-gold-300') };
    for (const [k, v] of Object.entries(tone)) for (const bg of panels) expect(contrast(v, bg), `${k} on ${bg}`).toBeGreaterThanOrEqual(TEXT(mode));
    expect(apart(tone.fold, tone.call, vision)).toBeGreaterThanOrEqual(MUST_DIFFER);
    const keys = Object.keys(tone) as (keyof typeof tone)[];
    for (let i = 0; i < keys.length; i++)
      for (let j = i + 1; j < keys.length; j++) expect(apart(tone[keys[i]!], tone[keys[j]!], vision), `${keys[i]}/${keys[j]}`).toBeGreaterThanOrEqual(SHOULD_DIFFER);
  });

  it('neighbouring chip denominations stay apart, rim and face (the amount is written beside every stack)', () => {
    for (let n = 0; n + 1 < CHIP_TIERS; n++)
      for (const part of ['base', 'face']) expect(apart(c(`--chip-t${n}-${part}`), c(`--chip-t${n + 1}-${part}`), vision), `t${n}/t${n + 1} ${part}`).toBeGreaterThanOrEqual(SHOULD_DIFFER);
  });

  it('a quiz answer: its light right and wrong text reads on the panels, and the two stay apart (with ✓ and ✗)', () => {
    for (const k of ['--color-success-soft', '--color-danger-soft']) for (const bg of panels) expect(contrast(c(k), bg), `${k} on ${bg}`).toBeGreaterThanOrEqual(TEXT(mode));
    expect(apart(c('--color-success-soft'), c('--color-danger-soft'), vision)).toBeGreaterThanOrEqual(SHOULD_DIFFER);
    // The ✓ or ✗ disc: a dark mark on the success or danger fill.
    for (const k of ['--color-success', '--color-danger']) expect(contrast(c(k), c('--color-ink-950')), k).toBeGreaterThanOrEqual(TEXT(mode));
  });

  it('secondary text reads on the panels', () => {
    for (const bg of panels) expect(contrast(c('--color-ink-300'), bg), bg).toBeGreaterThanOrEqual(mode === 'highContrast' ? 7 : 4.5);
    if (mode === 'highContrast') for (const bg of panels) expect(contrast(c('--color-ink-400'), bg), bg).toBeGreaterThanOrEqual(7);
  });
});

describe('where the colours are used', () => {
  it('a mode changes colours only: no filter over the page', () => {
    expect(css).not.toMatch(/\[data-cv[^\]]*\][^{]*\{[^}]*filter\s*:/);
  });

  it('the action buttons take their colours from the tokens, the cards their suits', () => {
    for (const k of ACTIONS) {
      expect(actionBar).toContain(`var(--act-${k}-from),var(--act-${k}-to)`);
      expect(actionBar).toContain(`color: 'var(--act-${k}-fg)'`);
    }
    expect(actionBar).not.toMatch(/linear-gradient\(180deg,#/);
    expect(css).toMatch(/\.jc-card \.suit-red \{ color: var\(--suit-red\); \}/);
    expect(css).toMatch(/\.jc-card \.suit-black \{ color: var\(--suit-black\); \}/);
    expect(css).toMatch(/\[data-four-color='1'\] \.jc-card\[data-card\$='d'\] \.jc-card-face \{ color: var\(--suit-diamond\); \}/);
  });

  it('seat labels, chips and quiz answers take their colours from the tokens; a quiz answer also has its ✓ or ✗', () => {
    for (const k of ['fold', 'call', 'allin']) expect(seat).toContain(`text-[color:var(--act-${k}-text)]`);
    expect(/const actionTone =[^;]*;/.exec(seat)![0]).not.toContain('#');
    expect(chips).toContain('base: `var(--chip-t${n}-base)`, face: `var(--chip-t${n}-face)`');
    expect(chips).not.toMatch(/base: '#/);
    for (const page of QUIZ_PAGES) expect(page).not.toMatch(/text-\[#(bfe9d0|f3c3c4)\]/);
    // The picked card, choice and comparison each show the mark (the practice table's options too).
    expect(academyUi.match(/<ResultMark /g)).toHaveLength(3);
    expect(QUIZ_PAGES[1]).toContain('<ResultMark ok={o.id === asked.answer} />');
  });

  it('high contrast outlines every action button, with a focus ring of its own', () => {
    expect(css).toMatch(/:root\[data-cv='highContrast'\] \.jc-act \{[^}]*outline: 2px solid/);
    expect(css).toMatch(/:root\[data-cv='highContrast'\] \.jc-act:focus-visible \{[^}]*outline: 3px solid/);
    expect(actionBar.match(/'jc-tap jc-act /g)).toHaveLength(4);
  });

  it('every mode has its own block; no stray mode', () => {
    const modes = [...blocks.keys()].filter((k) => k !== 'default').sort();
    expect(modes).toEqual(SETTINGS_COLOR_VISIONS.filter((m) => m !== 'normal').sort());
  });
});
