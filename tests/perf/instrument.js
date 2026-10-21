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
    // The street reveals (reveal-probe.mjs): each state that brought a street, when it came and how long the page's
    // handler took with it; board cards put in the page and their turn starting and ending; sounds started. Times only.
    reveals: [],
    board: [],
    sounds: [],
    // Presses in the action bar (press-probe.mjs): when each came, and the browser's own timing of input events (Event
    // Timing: from the input to the frame that showed its result).
    presses: [],
    events: [],
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
      this.reveals = [];
      this.board = [];
      this.sounds = [];
      this.presses = [];
      this.events = [];
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
  addEventListener('click', (e) => e.target instanceof Element && e.target.closest('[data-testid=action-bar]') && P.presses.push(now()), true);
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        if (/^(pointerdown|pointerup|click|keydown)$/.test(e.name))
          P.events.push({ name: e.name, start: e.startTime, dur: e.duration, delay: e.processingStart - e.startTime, run: e.processingEnd - e.processingStart });
    }).observe({ type: 'event', durationThreshold: 16, buffered: true });
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
          // Which streets the state's cues bring (the stage names only, not the cards).
          const stages = [...s.matchAll(/"kind":"street","stage":"(\w+)"/g)].map((x) => x[1]);
          if (stages.length) {
            P.reveals.push({ at: now(), stages, bytes: s.length, cues: (s.match(/"kind":"/g) ?? []).length, handler: null });
            // Lines a browser trace up with these times (reveal-probe.mjs --trace).
            performance.mark('jc-reveal');
          }
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
    // The page's own handler, timed for the states that bring a street (its parse and the state it sets; React draws
    // later, in its own task, or in this one when the update is synchronous).
    set onmessage(fn) {
      super.onmessage = fn
        ? (ev) => {
            const r = P.reveals[P.reveals.length - 1];
            const mine = r && r.handler === null && now() - r.at < 50 ? r : null;
            const t = now();
            try {
              return fn.call(this, ev);
            } finally {
              if (mine) mine.handler = now() - t;
            }
          }
        : fn;
    }
    get onmessage() {
      return super.onmessage;
    }
  }
  window.WebSocket = Measured;

  // Board cards: put in the page (a face-up card under the board), and their turn (jc-flip-in) starting and ending.
  const onBoard = (el) => el instanceof Element && !!el.closest?.('[data-testid=board]');
  new MutationObserver((list) => {
    for (const m of list)
      for (const n of m.addedNodes)
        if (n instanceof Element && n.matches('.jc-card[data-card]') && onBoard(n)) P.board.push([now(), 'insert', n.classList.contains('jc-flip-in') ? 1 : 0]);
  }).observe(document, { childList: true, subtree: true });
  addEventListener('animationstart', (e) => e.animationName === 'jc-flip-in' && onBoard(e.target) && P.board.push([now(), 'start', 0]), true);
  addEventListener('animationend', (e) => e.animationName === 'jc-flip-in' && onBoard(e.target) && P.board.push([now(), 'end', 0]), true);

  // Sounds started (the audio package plays samples and synth voices through these). A buffer source has a start of its
  // own; the one-sample buffer started to unlock audio on a tap is no sound (as tests/e2e/sound-mute.spec.ts counts).
  try {
    for (const proto of [AudioScheduledSourceNode.prototype, AudioBufferSourceNode.prototype]) {
      if (!Object.prototype.hasOwnProperty.call(proto, 'start')) continue;
      const start = proto.start;
      proto.start = function (...a) {
        const buffer = this instanceof AudioBufferSourceNode;
        if (!(buffer && (this.buffer?.length ?? 0) <= 1)) P.sounds.push([now(), buffer ? 'buffer' : 'osc']);
        return start.apply(this, a);
      };
    }
  } catch {}

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
      if (out.by) out.by[l] = (out.by[l] ?? 0) + 1;
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
      // Near a street reveal or a press each commit keeps what it rendered, by component.
      const r = P.reveals[P.reveals.length - 1];
      const press = P.presses[P.presses.length - 1];
      const out = { n: 0, by: (r && t - r.at < 2_500) || (press != null && t - press < 300) ? {} : null };
      try {
        visit(root.current, out);
      } catch {}
      P.commits.push([t, out.n, P.phase, now() - t, out.by]);
      if (P.pending) {
        const at = P.pending;
        P.pending = 0;
        P.toCommit.push(t - at);
        requestAnimationFrame((f) => P.toFrame.push(f - at));
      }
    },
  };
})();
