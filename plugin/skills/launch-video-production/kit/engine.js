/* Film engine: one paused GSAP master timeline, rendered as a pure function of time.
 *
 * Why this shape: the same page is (1) stepped frame by frame in headless Chromium to make
 * the video, and (2) played live in a browser with the audio track as its clock. Both call
 * FILM.seek(t), so nothing may depend on wall-clock time, CSS animations or timers.
 *
 * A scene file calls FILM.scene(id, start, end, build). `build(root, tl, h)` receives the
 * scene's root element, a timeline whose time 0 is the scene's start, and the helpers below.
 */
(function () {
  const FILM = (window.FILM = {
    W: 1920, H: 1080, fps: 30,
    duration: 0,
    scenes: [],
    captions: [],   // [{t0, t1, text}] in film seconds; drawn by seek(), not by GSAP
    hooks: [],      // extra pure functions of t, e.g. canvas drawing: fn(t)
    master: gsap.timeline({ paused: true, defaults: { ease: 'power3.out', duration: 0.6 } }),
  });

  FILM.scene = function (id, start, end, build) {
    const root = document.createElement('section');
    root.className = 'scene';
    root.id = 'scene-' + id;
    document.getElementById('stage').appendChild(root);
    const tl = gsap.timeline({ defaults: { ease: 'power3.out', duration: 0.6 } });
    build(root, tl, FILM.h, { start, end, duration: end - start });
    FILM.master.add(tl, start);
    FILM.scenes.push({ id, start, end, root });
    FILM.duration = Math.max(FILM.duration, end);
  };

  /* ---------- helpers handed to every scene ---------- */
  const h = (FILM.h = {});

  /** Create an element. h.el('div', 'cls other', parent, 'inner <b>html</b>') */
  h.el = function (tag, cls, parent, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    if (parent) parent.appendChild(e);
    return e;
  };

  /** Split an element's text into inline-block spans (by 'chars' or 'words'); returns the spans.
   *  Words keep their spaces; each span is wrapped so it can be clipped from below. */
  h.split = function (el, by) {
    const text = el.textContent;
    el.textContent = '';
    const parts = by === 'chars' ? Array.from(text) : text.split(/(\s+)/);
    const out = [];
    for (const p of parts) {
      if (/^\s+$/.test(p)) { el.appendChild(document.createTextNode(p)); continue; }
      if (p === '') continue;
      const mask = h.el('span', 'split-mask', el);
      const inner = h.el('span', 'split-part', mask);
      inner.textContent = p;
      out.push(inner);
    }
    return out;
  };

  /** Type `text` into `el` starting at `at` (scene seconds) at `cps` characters per second.
   *  Seek-safe: the visible text is a function of the tween's progress. Returns the end time. */
  h.type = function (tl, el, text, at, cps) {
    cps = cps || 30;
    const state = { n: 0 };
    const dur = Math.max(text.length / cps, 0.05);
    const draw = () => { el.textContent = text.slice(0, Math.round(state.n)); };
    tl.fromTo(state, { n: 0 }, { n: text.length, duration: dur, ease: 'none', onUpdate: draw, immediateRender: false }, at);
    return at + dur;
  };

  /** Count an integer in `el` from a to b. `fmt(n)` formats it. Returns the end time. */
  h.count = function (tl, el, a, b, at, dur, fmt) {
    const state = { v: a };
    fmt = fmt || ((n) => String(n));
    const draw = () => { el.textContent = fmt(Math.round(state.v)); };
    tl.fromTo(state, { v: a }, { v: b, duration: dur, ease: 'power2.out', onUpdate: draw, immediateRender: false }, at);
    return at + dur;
  };

  /** Swap an element's text at a given time (seek-safe both directions). */
  h.swapText = function (tl, el, before, after, at) {
    const state = { k: 0 };
    tl.fromTo(state, { k: 0 }, { k: 1, duration: 0.001, ease: 'none', immediateRender: false,
      onUpdate: () => { el.textContent = state.k >= 0.5 ? after : before; } }, at);
  };

  /** Toggle a class at a given time (seek-safe both directions). */
  h.classAt = function (tl, el, cls, at, on) {
    on = on !== false;
    const state = { k: 0 };
    tl.fromTo(state, { k: 0 }, { k: 1, duration: 0.001, ease: 'none', immediateRender: false,
      onUpdate: () => { el.classList.toggle(cls, state.k >= 0.5 ? on : !on); } }, at);
  };

  /* ---------- seek: the only way time advances ---------- */
  let capEl = null;
  FILM.seek = function (t) {
    t = Math.max(0, Math.min(t, FILM.duration - 1e-4)); // the last scene stays up at t = duration
    FILM.t = t;
    FILM.master.time(t, false);
    for (const s of FILM.scenes) s.root.style.visibility = t >= s.start && t < s.end ? 'visible' : 'hidden';
    if (capEl === null) capEl = document.getElementById('caption');
    if (capEl) {
      const c = FILM.captions.find((c) => t >= c.t0 && t < c.t1);
      const text = c ? c.text : '';
      if (capEl.dataset.text !== text) { capEl.dataset.text = text; capEl.textContent = text; }
    }
    for (const fn of FILM.hooks) fn(t);
    // never return the timeline: a caller across the automation bridge would try to serialize it
  };

  /** Call once after all scene files have run. */
  FILM.ready = function () {
    FILM.master.to({}, { duration: FILM.duration }, 0); // pad the master to the film's length
    FILM.seek(0);
    window.film = { duration: FILM.duration, fps: FILM.fps, seek: (t) => { FILM.seek(t); } };
  };
})();
