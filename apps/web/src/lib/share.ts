/**
 * Sharing a link: the system share sheet where the browser has one (Web Share API, mostly phones), otherwise the
 * link is copied. Links carry no join code, ticket or token: a table link is /table/<id>, a referral link only the
 * member's public code.
 */
export type ShareResult = 'shared' | 'copied' | 'cancelled' | 'failed';

export interface ShareData {
  title: string;
  text?: string;
  url: string;
}

/** Copies text, with the old selection-based copy where the Clipboard API is missing or refused (http, old WebViews). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the selection copy */
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    el.remove();
    return ok;
  } catch {
    return false;
  }
}

export async function shareLink(d: ShareData): Promise<ShareResult> {
  const data = { title: d.title, text: d.text, url: d.url };
  if (typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare(data))) {
    try {
      await navigator.share(data);
      return 'shared';
    } catch (e) {
      // Closing the sheet is not a failure; anything else (not allowed here, no gesture) falls back to a copy.
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
    }
  }
  return (await copyText(d.url)) ? 'copied' : 'failed';
}

/** An address on this site, for links members share. */
export function siteUrl(path: string): string {
  return `${window.location.origin}${path}`;
}
