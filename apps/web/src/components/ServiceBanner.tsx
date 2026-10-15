import { lazy, Suspense } from 'react';
import { useService } from '../lib/service';

/** Most visits have no notice to show, so the banner itself loads only when there is one (the entry bundle is near its limit). */
const ServiceNotices = lazy(() => import('./ServiceNotices').then((m) => ({ default: m.ServiceNotices })));

/** Service notices across the top of the page; see ServiceNotices. Renders nothing while there are none. */
export function ServiceBanner(props: { compact?: boolean; boardLinks?: boolean }) {
  const st = useService();
  if (!st || (!st.maintenance && !st.notices.length)) return null;
  return (
    <Suspense fallback={null}>
      <ServiceNotices {...props} />
    </Suspense>
  );
}
