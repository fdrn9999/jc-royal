import { lazy, type ComponentType } from 'react';
import { reportWebError } from './webErrors';

/**
 * A part of a page that loads on demand. If its code will not load (after a deploy the files a page opened before it
 * named are gone, or the connection dropped), `failed` takes its place (nothing, unless given) and the page goes on: a
 * part that threw took the whole page with it, a table in the middle of a hand included.
 */
export function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>, failed: ComponentType<P> = () => null) {
  return lazy<ComponentType<P>>(() =>
    load().then(
      (C) => ({ default: C }),
      (e: unknown) => {
        console.error('[lazy] a part of the page did not load', e);
        reportWebError();
        return { default: failed };
      },
    ),
  );
}
