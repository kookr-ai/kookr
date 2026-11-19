/* Live playback shell. In render mode (?render=1) it does nothing: the frame grabber calls
 * film.seek(t) itself. Otherwise the audio element is the clock, so picture and sound cannot
 * drift apart; without audio it falls back to the performance clock. */
(function () {
  const render = /[?&]render=1/.test(location.search);
  document.documentElement.classList.toggle('render', render);
  const stage = document.getElementById('stage');
  const frame = document.getElementById('frame');

  function fit() {
    if (render) { stage.style.transform = 'none'; return; }
    const s = frame.clientWidth / FILM.W;
    stage.style.transform = 'scale(' + s + ')';
  }
  window.addEventListener('resize', fit);
  if (window.ResizeObserver) new ResizeObserver(fit).observe(frame);

  window.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
  let booted = false;
  function boot() {
    if (booted) return; booted = true;
    FILM.ready();
    fit();
    if (render) return;

    const audio = document.getElementById('audio');
    const btn = document.getElementById('play');
    const bar = document.getElementById('scrub');
    const clock = document.getElementById('clock');
    const cc = document.getElementById('cc');
    const hasAudio = () => audio && audio.src && !audio.error && audio.readyState > 0;
    let playing = false, t = 0, last = 0;

    const fmt = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    function paint() {
      FILM.seek(t);
      bar.value = String(Math.round((t / FILM.duration) * 1000));
      clock.textContent = fmt(t) + ' / ' + fmt(FILM.duration);
    }
    function loop(now) {
      if (!playing) return;
      if (hasAudio() && !audio.paused) t = audio.currentTime;
      else { t += (now - last) / 1000; }
      last = now;
      if (t >= FILM.duration) { t = FILM.duration; setPlaying(false); }
      paint();
      if (playing) requestAnimationFrame(loop);
    }
    function setPlaying(on) {
      playing = on;
      btn.textContent = on ? 'Pause' : (t >= FILM.duration ? 'Replay' : 'Play');
      btn.setAttribute('aria-pressed', String(on));
      document.documentElement.classList.toggle('playing', on);
      if (on) {
        if (t >= FILM.duration) t = 0;
        if (hasAudio()) { audio.currentTime = t; audio.play().catch(() => {}); }
        last = performance.now();
        requestAnimationFrame(loop);
      } else if (hasAudio()) audio.pause();
    }
    btn.addEventListener('click', () => setPlaying(!playing));
    frame.addEventListener('click', () => setPlaying(!playing));
    bar.addEventListener('input', () => {
      t = (Number(bar.value) / 1000) * FILM.duration;
      if (hasAudio()) audio.currentTime = t;
      paint();
    });
    if (cc) cc.addEventListener('change', () => document.documentElement.classList.toggle('nocc', !cc.checked));
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); setPlaying(!playing); }
    });
    // Poster frame: open on a representative still instead of an empty first frame.
    t = FILM.poster || 0; paint(); t = 0;
  }
})();
