/**
 * The lobby as it was last left. Its tab, search and size/blind filters live in its address, so a table's way back
 * (the logo, leave, "lobby") opens it the same instead of a bare list.
 */
const KEY = 'jc.lobby';
let last: string | null = null;

/** The lobby's query string (`?tab=fav&seats=6`, or empty). */
export function rememberLobby(search: string) {
  last = search.startsWith('?') ? search : '';
  try {
    sessionStorage.setItem(KEY, last);
  } catch {
    /* storage off: this page still remembers it */
  }
}

export function lobbyHref() {
  if (last === null) {
    try {
      last = sessionStorage.getItem(KEY) ?? '';
    } catch {
      last = '';
    }
  }
  return last.startsWith('?') && last.length > 1 ? `/${last}` : '/';
}
