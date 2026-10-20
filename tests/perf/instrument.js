// Loaded before the app (Playwright addInitScript) by table-perf.mjs. Counts frames, long tasks, long animation frames,
// React commits and the components each one rendered, and WebSocket traffic, as numbers only: no message body, card,
// nickname or text is kept (a component is named by its first element's data-testid or tag).
(() => {
  const now = () => performance.now();
  const P = {
    phase: 0, // 0 in a hand, 1 between hands (the next deal counting down)
    frames: [],
    longtasks: [],
    loaf: [],
    commits: [],
    labels: {},
    ws: { in: 0, inBytes: 0, out: 0, outBytes: 0, states: 0, stateBytes: 0, kinds: {}, outKinds: {} },
    sent: {},
    acks: [],
    pending: 0,
    toCommit: [],
    toFrame: [],
    reset() {
      this.frames = [];
      this.longtasks = [];
      this.loaf = [];
      this.commits = [];
      this.labels = {};
      this.ws = { in: 0, inBytes: 0, out: 0, outBytes: 0, states: 0, stateBytes: 0, kinds: {}, outKinds: {} };
      this.acks = [];
      this.toCommit = [];
      this.toFrame = [];
      this.pending = 0;
      this.t0 = now();
    },
    t0: 0,
  };
  window.__jcPerf = P;

  let last = 0;
  const loop = (t) => {
    if (last) P.frames.push([t, t - last, P.phase]);
    last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) P.longtasks.push([e.startTime, e.duration, P.phase]);
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        const end = e.startTime + e.duration;
        P.loaf.push({
          start: e.startTime,
          dur: e.duration,
          blocking: e.blockingDuration,
          style: e.styleAndLayoutStart ? end - e.styleAndLayoutStart : 0,
          phase: P.phase,
          scripts: [...e.scripts]
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 3)
            .map((s) => ({ invoker: s.invokerType + ':' + s.invoker, dur: Math.round(s.duration), forced: Math.round(s.forcedStyleAndLayoutDuration ?? 0) })),
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch {}

  const W = window.WebSocket;
  class Measured extends W {
    constructor(...a) {
      super(...a);
      this.addEventListener('message', (ev) => {
        const s = typeof ev.data === 'string' ? ev.data : '';
        P.ws.in++;
        P.ws.inBytes += s.length;
        const kind = (/"t":"(\w+)"/.exec(s.slice(0, 64)) ?? [])[1] ?? '?';
        P.ws.kinds[kind] = (P.ws.kinds[kind] ?? 0) + 1;
        if (kind === 'state') {
          P.ws.states++;
          P.ws.stateBytes += s.length;
          P.phase = /"nextHandAt":\d/.test(s) ? 1 : 0;
          if (!P.pending) P.pending = now();
        } else if (kind === 'ack' && s.length < 200) {
          try {
            const m = JSON.parse(s);
            const o = P.sent[m.reqId];
            if (o) {
              P.acks.push([o.kind, now() - o.at]);
              delete P.sent[m.reqId];
            }
          } catch {}
        }
      });
    }
    send(d) {
      const s = String(d);
      P.ws.out++;
      P.ws.outBytes += s.length;
      try {
        const m = JSON.parse(s);
        P.ws.outKinds[m.t] = (P.ws.outKinds[m.t] ?? 0) + 1;
        // An action carries its id as intentId; the ack answers it as reqId.
        const id = m.reqId ?? m.intentId;
        if (id) P.sent[id] = { kind: m.t + (m.t === 'action' ? ':' + m.type : ''), at: now() };
      } catch {}
      return super.send(d);
    }
  }
  window.WebSocket = Measured;

  // React DevTools' hook: React (production builds too) reports every commit to it.
  const FN = new Set([0, 1, 11, 14, 15]); // function, class, forwardRef, memo, simple memo
  const label = (f) => {
    let c = f;
    for (let d = 0; c && d < 14; d++, c = c.child) {
      if (c.tag === 5) {
        const p = c.memoizedProps ?? {};
        const id = p['data-testid'];
        return id ? `#${String(id).replace(/\d+$/, 'N')}` : `${c.type}.${String(p.className ?? '').split(' ')[0]}`;
      }
    }
    return '?';
  };
  const visit = (f, out) => {
    if (FN.has(f.tag) && f.flags & 1) {
      out.n++;
      const l = label(f);
      P.labels[l] = (P.labels[l] ?? 0) + 1;
    }
    const alt = f.alternate;
    // Children not cloned in this render were not visited by it (their flags are from an earlier one).
    if (f.child && (!alt || f.child !== alt.child)) for (let c = f.child; c; c = c.sibling) visit(c, out);
  };
  let renderers = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject() {
      return ++renderers;
    },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      const t = now();
      const out = { n: 0 };
      try {
        visit(root.current, out);
      } catch {}
      P.commits.push([t, out.n, P.phase, now() - t]);
      if (P.pending) {
        const at = P.pending;
        P.pending = 0;
        P.toCommit.push(t - at);
        requestAnimationFrame((f) => P.toFrame.push(f - at));
      }
    },
  };
})();
