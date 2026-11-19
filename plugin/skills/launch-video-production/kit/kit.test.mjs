// Smoke tests for the film kit's glue: build.sh, build-artifact.mjs and captions-to-srt.mjs.
// The heavy tools (headless Chromium, ffmpeg, the speech model) are replaced by stubs that
// record how they were called, so this checks the wiring, not the rendering.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';

const KIT = dirname(fileURLToPath(import.meta.url));
const made = [];

/** A copy of the kit in a folder whose name contains a space, plus a bin/ of recording stubs. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'film kit '));
  made.push(root);
  const film = join(root, 'my film');
  cpSync(KIT, film, { recursive: true });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  for (const tool of ['node', 'ffmpeg', 'ffprobe']) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${log}"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  // A stand-in for the narration/mix interpreter: records the call, and "records" narration.
  writeFileSync(join(bin, 'fakepy'),
    `#!/bin/sh\necho "py $*" >> "${log}"\ncase "$1" in *narrate.py) mkdir -p "$3" && echo '{}' > "$3/durations.json" ;; esac\n`);
  chmodSync(join(bin, 'fakepy'), 0o755);
  const run = (args, env = {}) => spawnSync('bash', [join(film, 'build.sh'), ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME ?? '', ...env },
  });
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const reset = () => writeFileSync(log, '');
  return { root, film, bin, run, calls, reset };
}

afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

describe('build.sh', () => {
  let ws;
  beforeEach(() => { ws = workspace(); });

  test('every default is set: no step dies on an unbound variable', () => {
    mkdirSync(join(ws.film, 'out/frames'), { recursive: true });
    writeFileSync(join(ws.film, 'out/frames/f00000.png'), '');
    for (const step of ['video', 'sheet']) {
      const r = ws.run([step]);
      expect(r.stderr).not.toMatch(/unbound variable/);
      expect(r.status).toBe(0);
    }
    expect(ws.calls().some((c) => c.startsWith('ffmpeg ') && c.includes('-framerate 30') && c.endsWith('out/film.mp4'))).toBe(true);
  });

  test('frames: splits the film into SHARDS ranges that cover it exactly', () => {
    mkdirSync(join(ws.film, 'audio'), { recursive: true });
    writeFileSync(join(ws.film, 'audio/timeline.json'), JSON.stringify({ duration: 2 }));
    const r = ws.run(['frames'], { SHARDS: '2' });
    expect(r.status).toBe(0);
    const renders = ws.calls().filter((c) => c.startsWith('node render.mjs')).sort();
    expect(renders).toEqual([
      'node render.mjs film.html out/frames 30 0.0 1.0',
      'node render.mjs film.html out/frames 30 1.0 2.0',
    ]);
  });

  test('sheet: one sheet per 24 seconds, so a 49 s film gets three and its end is not dropped', () => {
    mkdirSync(join(ws.film, 'out/frames'), { recursive: true });
    for (let f = 0; f < 49 * 30; f++) writeFileSync(join(ws.film, `out/frames/f${String(f).padStart(5, '0')}.png`), '');
    const r = ws.run(['sheet']);
    expect(r.status).toBe(0);
    const sheets = ws.calls().filter((c) => c.startsWith('ffmpeg ')).map((c) => c.split(' ').pop());
    expect(sheets).toEqual(['out/contact-sheet-01.png', 'out/contact-sheet-02.png', 'out/contact-sheet-03.png']);
    // the third sheet selects seconds 48 and later: frame 1440 onwards
    expect(ws.calls().filter((c) => c.startsWith('ffmpeg '))[2]).toContain('gte(n\\,1440)');
  });

  test('sheet: says what to do when there are no frames', () => {
    const r = ws.run(['sheet']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/run \.\/build\.sh frames first/);
  });

  test('audio: narration is recorded once, reused when nothing changed, and redone for a new voice', () => {
    writeFileSync(join(ws.film, 'script.json'), JSON.stringify({ lines: [{ id: 'l01', text: 'Hello.' }] }));
    const env = { PY: join(ws.bin, 'fakepy') };
    const narrations = () => ws.calls().filter((c) => c.includes('narrate.py'));

    expect(ws.run(['audio'], env).status).toBe(0);
    expect(narrations()).toEqual(['py audio/narrate.py script.json out/vo am_michael 1.08']);
    expect(ws.calls().some((c) => c === 'py audio/mix.py audio/timeline.json out/vo out/mix')).toBe(true);

    ws.reset();
    const again = ws.run(['audio'], env);
    expect(again.stdout).toMatch(/reusing out\/vo/);
    expect(narrations()).toEqual([]);

    ws.reset();
    ws.run(['audio'], { ...env, VOICE: 'bm_george' });
    expect(narrations()).toEqual(['py audio/narrate.py script.json out/vo bm_george 1.08']);

    ws.reset();
    writeFileSync(join(ws.film, 'script.json'), JSON.stringify({ lines: [{ id: 'l01', text: 'Hello again.' }] }));
    ws.run(['audio'], { ...env, VOICE: 'bm_george' });
    expect(narrations().length).toBe(1);
  });

  test('an unknown step is refused', () => {
    expect(ws.run(['publish']).status).toBe(2);
  });
});

describe('build-artifact.mjs', () => {
  /** The smallest film folder the page builder accepts, under a path with a space. */
  function filmFolder() {
    const { film } = workspace();
    writeFileSync(join(film, 'components.js'), '/* components */');
    writeFileSync(join(film, 'captions.js'), 'FILM.captions = [];');
    writeFileSync(join(film, 'scenes-a.js'), '/* scene A */');
    writeFileSync(join(film, 'scenes-a.css'), '.a-x { color: red }');
    writeFileSync(join(film, 'scenes-c.js'), '/* scene C says </script> */');
    writeFileSync(join(film, 'note.txt'), 'a < b');
    writeFileSync(join(film, 'still.png'), Buffer.from([1, 2, 3]));
    mkdirSync(join(film, 'out'), { recursive: true });
    writeFileSync(join(film, 'out/film.mp4'), Buffer.alloc(1048576 * 2));
    return film;
  }
  const build = (film, template) => {
    writeFileSync(join(film, 'page.html'), template);
    return spawnSync(process.execPath, [join(film, 'build-artifact.mjs'), join(film, 'page.html'), join(film, 'out/page/film.html')], { encoding: 'utf8' });
  };

  test('fills every marker, from a folder whose path has a space, with every scene file it finds', () => {
    const film = filmFolder();
    const r = build(film, '<style>/*FILM_CSS*/</style><p>{{TEXT:note.txt}} {{MP4_MB}} MB, {{MP4_MB}}</p><img src="{{IMG:still.png}}"><script>/*FILM_JS*/</script>');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const html = readFileSync(join(film, 'out/page/film.html'), 'utf8');
    expect(html).toContain('.a-x { color: red }');
    expect(html).toContain('/* scene A */');
    expect(html).toContain('scene C says <\\/script>');           // a closing tag inside inlined script is escaped
    expect(html.indexOf('scenes-a.js')).toBeLessThan(html.indexOf('scenes-c.js'));
    expect(html).toContain('a &lt; b');
    expect(html).toContain('2.0 MB, 2.0');
    expect(html).toContain('data:image/png;base64,AQID');
    expect(html).not.toMatch(/\{\{[A-Z_]+/);
  });

  test('stops on a marker it cannot fill, and on a file type it cannot embed', () => {
    const film = filmFolder();
    const unknown = build(film, '/*FILM_CSS*/ /*FILM_JS*/ {{VIDEO:out/film.mp4}}');
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/unresolved marker: \{\{VIDEO:/);
    const badType = build(film, '/*FILM_CSS*/ /*FILM_JS*/ {{IMG:note.txt}}');
    expect(badType.status).toBe(1);
    expect(badType.stderr).toMatch(/unsupported file type/);
  });

  test('refuses a folder with no scene file', () => {
    const { film } = workspace();
    writeFileSync(join(film, 'components.js'), '');
    const r = build(film, '/*FILM_CSS*/ /*FILM_JS*/');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no scenes-\*\.js/);
  });
});

describe('captions-to-srt.mjs', () => {
  test('writes numbered cues with comma-millisecond timestamps', () => {
    const { film } = workspace();
    const out = join(film, 'out/c.srt');
    const r = spawnSync(process.execPath, [join(film, 'captions-to-srt.mjs'), join(film, 'captions.example.js'), out], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const srt = readFileSync(out, 'utf8');
    expect(srt.startsWith('1\n00:00:00,250 --> 00:00:03,550\nMonday, your agent hit a trap. Tuesday. Same trap.\n\n2\n')).toBe(true);
    expect(existsSync(out)).toBe(true);
  });
});
