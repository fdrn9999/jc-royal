/*
 * JC ROYAL push service worker. It shows pushes and opens what they are about, and nothing else: it has no fetch
 * handler and caches nothing, so pages, sign-in, games, cards and the API always come from the network exactly as
 * without it. A push names the member it is for; the page tells this worker who is signed in here (jc-owner), and a
 * push for anyone else, or for nobody signed in, is never shown. Before showing one it also asks the site whether that
 * member is still signed in here (one request a push), and shows it only if nobody else was told meanwhile. A push is
 * kept by the push service no longer than its event lasts (the TTL the api sends), so this worker does not check expiry
 * itself: a device's clock may be wrong.
 */

const DB = 'jc-sw';
const STORE = 'kv';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Who is signed in here, as pages last told: `uid` (null: nobody) and `gen`, which goes up every time it changes, so
 * an answer about a push can be told from one that arrived after the account changed (or signed out and back in).
 */
function owner(v) {
  return v && typeof v === 'object' && typeof v.gen === 'number' ? { uid: typeof v.uid === 'string' ? v.uid : null, gen: v.gen } : { uid: null, gen: 0 };
}

async function getOwner() {
  try {
    const db = await idb();
    return await new Promise((resolve) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get('owner');
      r.onsuccess = () => resolve(owner(r.result));
      r.onerror = () => resolve({ uid: null, gen: -1 });
    });
  } catch {
    return { uid: null, gen: -1 };
  }
}

/**
 * Sets who is signed in here (nothing written when it is the same). With `ifGen`, only while it is still that `gen`:
 * read and written in one transaction, so no other change comes between, from this copy of the worker or another.
 */
async function setOwner(uid, ifGen) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let changed = false;
    const r = store.get('owner');
    r.onsuccess = () => {
      const cur = owner(r.result);
      if ((ifGen !== undefined && cur.gen !== ifGen) || cur.uid === uid) return;
      store.put({ uid, gen: cur.gen + 1 }, 'owner');
      changed = true;
    };
    tx.oncomplete = () => resolve(changed);
    tx.onerror = () => reject(tx.error);
  });
}

/** Closes what is shown for anyone but `uid` (everything when nobody is signed in). */
async function closeOthers(uid) {
  for (const n of await self.registration.getNotifications()) if (!uid || !n.data || n.data.to !== uid) n.close();
}

/** Changes of who is signed in and the pushes shown run one after another, never in between. */
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Whether `uid` is still signed in in this browser, asked of the site itself (same origin, this browser's cookie, never
 * cached, and without extending the sign-in): a push that waited at the push service while the sign-in ended elsewhere
 * (signed out of every device, suspended, withdrawn) must not show. true or false; null when the site did not answer.
 */
async function stillSignedIn(uid) {
  try {
    const res = await fetch('/api/me/notifications/recipient', { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401) return false;
    if (!res.ok) return null;
    const me = await res.json();
    return !!me && me.id === uid;
  } catch {
    return null;
  }
}

/** Only a path inside this site: anything else opens the home page. */
function internal(url) {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !url.includes('\\') ? url : '/';
}

async function updateBadge() {
  if (!('setAppBadge' in self.navigator)) return;
  try {
    const shown = await self.registration.getNotifications();
    if (shown.length) await self.navigator.setAppBadge(shown.length);
    else await self.navigator.clearAppBadge();
  } catch {
    /* badges are a nicety */
  }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** A tag of what a page may close once read here: a friend's messages or invites (the api's coalesce keys). */
const READ_TAG = /^(?:dm|invite):[A-Za-z0-9_-]{1,64}$/;

self.addEventListener('message', (event) => {
  const m = event.data;
  if (m && m.type === 'jc-read' && Array.isArray(m.tags)) {
    // A conversation read on this page: its pushes still shown go (closing one by hand tells nobody, so the badge too).
    const tags = m.tags.filter((t) => typeof t === 'string' && READ_TAG.test(t)).slice(0, 4);
    event.waitUntil(
      (async () => {
        for (const n of await self.registration.getNotifications()) if (tags.includes(n.tag)) n.close();
        await updateBadge();
      })(),
    );
    return;
  }
  if (!m || m.type !== 'jc-owner') return;
  const uid = typeof m.uid === 'string' && m.uid.length <= 64 ? m.uid : null;
  event.waitUntil(
    serial(async () => {
      // Signed out, or another account: what was shown for the one before goes (what is theirs stays). Also when it
      // is the same: anything left of someone else's goes all the same.
      await setOwner(uid);
      await closeOthers(uid);
      await updateBadge();
    }),
  );
});

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let p = null;
      try {
        p = event.data ? event.data.json() : null;
      } catch {
        p = null;
      }
      if (!p || typeof p.to !== 'string' || typeof p.title !== 'string') return;
      const asked = await getOwner();
      if (asked.uid !== p.to) return;
      const here = await stillSignedIn(p.to);
      await serial(async () => {
        // Who is signed in changed while the site was asked (another account, or signed out and in again): the answer
        // may be about the sign-in before, so nothing is shown or changed for it.
        const now = await getOwner();
        if (now.gen !== asked.gen || now.uid !== p.to) return;
        if (here === false) {
          // The sign-in ended since a page last told this worker: nothing of theirs shows, now or later, until a page
          // tells it who is signed in again.
          if (await setOwner(null, asked.gen).catch(() => false)) await closeOthers(null);
          return;
        }
        // The site did not answer: not shown (a push is best effort; showing one that may no longer be theirs is worse).
        if (here !== true) return;
        await self.registration.showNotification(p.title, {
          body: typeof p.body === 'string' ? p.body : '',
          tag: typeof p.tag === 'string' ? p.tag : undefined,
          icon: '/icon-192.png',
          lang: typeof p.lang === 'string' ? p.lang : undefined,
          timestamp: typeof p.ts === 'number' ? p.ts : Date.now(),
          data: { url: internal(p.url), to: p.to },
        });
      });
      // Told of another account meanwhile by another copy of this worker (an update taking over): it goes again.
      const after = await getOwner();
      if (after.uid !== p.to) await closeOthers(after.uid);
      await updateBadge();
    })(),
  );
});

/** How long an open page has to answer that it went to a tapped push's page, before this worker takes it there itself. */
const ANSWER_MS = 3000;

/** A window at a game table, which a tapped push never takes away from it (the member may be in a hand). */
function atTable(win) {
  try {
    return new URL(win.url).pathname.startsWith('/table/');
  } catch {
    return false;
  }
}

/** Whether the window is at this path of the site already. */
function samePage(win, url) {
  try {
    const u = new URL(win.url);
    return u.pathname + u.search === url;
  } catch {
    return false;
  }
}

/** The window as it is now (its page may have moved on since it was listed); undefined once it is gone. */
function lookAgain(win) {
  return Promise.resolve()
    .then(() => self.clients.get(win.id))
    .catch(() => undefined);
}

/**
 * Asks the page in `win` to go to `url` itself (no reload: the app keeps its state). 'went'; 'stays' (it is at a table
 * by now); or null, no answer in time (the app has not started there yet, or the page is from before this worker).
 */
function askToGo(win, url) {
  return new Promise((resolve) => {
    let ch = null;
    const done = (v) => {
      clearTimeout(timer);
      if (ch) ch.port1.close();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), ANSWER_MS);
    try {
      ch = new MessageChannel();
      ch.port1.onmessage = (e) => done(e.data && e.data.ok === true ? 'went' : 'stays');
      win.postMessage({ type: 'jc-navigate', url }, [ch.port2]);
    } catch {
      done(null);
    }
  });
}

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const url = internal(n.data && n.data.url);
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const here = wins.filter((w) => new URL(w.url).origin === self.location.origin);
      // An open window of the site goes there, the one on screen first (the page checks the sign-in and access as for
      // any link); none: a new one. A window at a game table is never taken there, and no window is opened beside one
      // either: an installed app on Android may open it in that same window. With only tables open, one comes forward
      // and the push stays shown, to be opened after the hand.
      const free = here.filter((w) => !atTable(w));
      const win = free.find((w) => w.visibilityState === 'visible') || free[0];
      if (win) {
        await win.focus().catch(() => undefined);
        // Looked at again once it has come forward, before it is asked: it may have gone to a game table meanwhile,
        // and a page from before this worker follows the question without looking where it is.
        let said = atTable((await lookAgain(win)) || win) ? 'stays' : await askToGo(win, url);
        if (said === null) {
          // No answer, so the window is looked at again as it is now: it may have gone to a game table meanwhile (it
          // stays, as above), or a page from before this worker may have gone there itself (not loaded a second time).
          const now = await lookAgain(win);
          if (now && atTable(now)) said = 'stays';
          else if (now && samePage(now, url)) said = 'went';
        }
        if (said !== 'stays') n.close();
        // No answer: the worker takes the window there (a window it does not control cannot be: a new one instead).
        if (said === null && !(await Promise.resolve().then(() => win.navigate(url)).catch(() => null))) await self.clients.openWindow(url).catch(() => null);
      } else if (here.length) {
        const table = here.find((w) => w.visibilityState === 'visible') || here[0];
        await table.focus().catch(() => undefined);
      } else {
        n.close();
        await self.clients.openWindow(url);
      }
      await updateBadge();
    })(),
  );
});

self.addEventListener('notificationclose', (event) => event.waitUntil(updateBadge()));

// The push service replaced the subscription: the new one is registered for whoever is signed in here.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      if (!(await getOwner()).uid) return;
      const old = event.oldSubscription;
      let sub = event.newSubscription;
      if (!sub && old && old.options && old.options.applicationServerKey)
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: old.options.applicationServerKey });
      if (!sub) return;
      const json = sub.toJSON();
      await fetch('/api/me/notifications/subscriptions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, ...(old && old.endpoint !== json.endpoint ? { oldEndpoint: old.endpoint } : {}) }),
      }).catch(() => undefined);
    })(),
  );
});
