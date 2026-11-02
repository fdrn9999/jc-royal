/**
 * The order of the account's reads (src/lib/auth.tsx): numbered as they are asked, and the last whose answer shows.
 * An answer to a read asked before that one, or before the account was set here (signed in, out, saved), is older than
 * what shows. Older than a later read's answer, or than a sign-out or another account's sign-in, it changes nothing (a
 * read begun before signing out, answered late, would sign the page back in). Older than a save of the same account,
 * which of the two the server did last is unknown (a grant may have come between): the account is read again.
 */
export class AccountReads {
  private asks = 0;
  private showing = 0;
  private saved = 0;
  private shownId: string | null = null;

  /** A read is asked: its number. */
  ask(): number {
    return ++this.asks;
  }

  /** The account was set here: what shows now (null: signed out). */
  set(id: string | null): void {
    this.showing = this.saved = ++this.asks;
    this.shownId = id;
  }

  /** A read's answer (the account's id, or null for a sign-in that is gone): show it, drop it, or read again. */
  answer(ask: number, id: string | null): 'show' | 'drop' | 'again' {
    if (ask >= this.showing) {
      this.showing = ask;
      this.shownId = id;
      return 'show';
    }
    const behindSave = this.showing === this.saved && this.shownId !== null;
    return behindSave && (id === null || id === this.shownId) ? 'again' : 'drop';
  }
}
