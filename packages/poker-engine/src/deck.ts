import { RANKS, SUITS, type Card } from '@jc/types';

export function standardDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(`${r}${s}`);
  return deck;
}

/** Uniform integer in [0, n) from the CSPRNG, without modulo bias (rejection sampling). */
function secureIndex(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
}

/**
 * Fisher–Yates shuffle driven by crypto.getRandomValues. This is the only deck
 * source used in production; fixed decks are accepted by the adapter only when
 * the caller explicitly opts into test mode.
 */
export function secureShuffledDeck(): Card[] {
  const deck = standardDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = secureIndex(i + 1);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}

export function assertValidDeck(deck: readonly string[]): void {
  if (deck.length !== 52) throw new Error('deck must contain 52 cards');
  const set = new Set(deck);
  if (set.size !== 52) throw new Error('deck contains duplicate cards');
  for (const c of standardDeck()) if (!set.has(c)) throw new Error(`deck is missing ${c}`);
}
