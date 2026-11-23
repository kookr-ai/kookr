// Smoke tests for the film kit's glue: build.sh, build-artifact.mjs, captions-to-srt.mjs,
// render.mjs and the Python audio tools audition.py and verify.py.
// The heavy tools (headless Chromium, ffmpeg, the speech model, the music synthesizer) are
// replaced by stubs that record how they were called, so this checks the wiring, not the
// rendering. The Python tests need python3 (and numpy + scipy for verify.py); without them
// they are skipped, and the skip reason is in the test name.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';

// The test lives beside kit/, not inside it: kit/ is copied whole into other repositories.
const KIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'kit');
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
    expect(ws.run(['audio'], { ...env, VOICE: 'bm_george' }).status).toBe(0);
    expect(narrations()).toEqual(['py audio/narrate.py script.json out/vo bm_george 1.08']);

    ws.reset();
    writeFileSync(join(ws.film, 'script.json'), JSON.stringify({ lines: [{ id: 'l01', text: 'Hello again.' }] }));
    expect(ws.run(['audio'], { ...env, VOICE: 'bm_george' }).status).toBe(0);
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
    expect(html).not.toContain('FILM_CSS');
  });

  test('film content that looks like a marker is left alone', () => {
    const film = filmFolder();
    writeFileSync(join(film, 'scenes-a.js'), "const prompt = 'Hello {{TASK}} {{IMG:nope.png}}';");
    writeFileSync(join(film, 'scenes-a.old.js'), '/* stale copy */');
    writeFileSync(join(film, 'note.txt'), 'see {{MP4_MB}}');
    const r = build(film, '<p>{{TEXT:note.txt}}</p><script>/*FILM_JS*/</script><style>/*FILM_CSS*/</style>');
    // The stale copy is left out, and the build says so instead of dropping it silently.
    expect(r.stderr).toMatch(/^left out of the page .*: scenes-a\.old\.js\n$/);
    expect(r.status).toBe(0);
    const html = readFileSync(join(film, 'out/page/film.html'), 'utf8');
    expect(html).toContain("'Hello {{TASK}} {{IMG:nope.png}}'");
    expect(html).toContain('<p>see {{MP4_MB}}</p>');
    expect(html).not.toContain('stale copy');
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
  });
});

describe('render.mjs', () => {
  // A stand-in for playwright-core: a "browser" whose page runs render.mjs's callbacks against a
  // fake window.film, records every seek and writes an empty file for every screenshot.
  const FAKE_PLAYWRIGHT = `
const fs = require('node:fs'), path = require('node:path');
const log = (line) => fs.appendFileSync(process.env.FAKE_PW_LOG, line + '\\n');
exports.chromium = { async launch(opts) {
  log('launch ' + JSON.stringify(opts.executablePath ?? null));
  return {
    async newPage(o) {
      log('viewport ' + o.viewport.width + 'x' + o.viewport.height + ' scale ' + o.deviceScaleFactor);
      globalThis.window = { film: { duration: Number(process.env.FAKE_DURATION), seek(t) { log('seek ' + t); } } };
      globalThis.document = { fonts: { ready: Promise.resolve() } };
      const handlers = {};
      return {
        on(event, fn) { handlers[event] = fn; },
        async goto(url) { log('goto ' + url); if (process.env.FAKE_PAGEERROR) handlers.pageerror(new Error(process.env.FAKE_PAGEERROR)); },
        async evaluate(fn, arg) { return fn(arg); },
        async waitForFunction(fn) { if (!fn()) throw new Error('film never became ready'); },
        async screenshot({ path: p }) { fs.writeFileSync(p, ''); log('shot ' + path.basename(p)); },
      };
    },
    async close() { log('close'); },
  };
} };
`;
  function renderer() {
    const ws = workspace();
    const pw = join(ws.root, 'fake-playwright');
    mkdirSync(pw);
    writeFileSync(join(pw, 'index.js'), FAKE_PLAYWRIGHT);
    const home = join(ws.root, 'home');            // no Playwright browser cache unless a test makes one
    mkdirSync(home);
    const log = join(ws.root, 'render.log');
    const out = join(ws.film, 'out', 'frames');
    const run = (args, env = {}) => {
      writeFileSync(log, '');
      const r = spawnSync(process.execPath, [join(ws.film, 'render.mjs'), join(ws.film, 'film.html'), out, ...args], {
        cwd: ws.root,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: home, PLAYWRIGHT_CORE: pw, FAKE_PW_LOG: log, FAKE_DURATION: '1', ...env },
      });
      return { ...r, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
    };
    const files = () => readdirSync(out).sort();
    return { ...ws, home, out, run, files };
  }

  test('renders the frames from..to at the given fps, one seek per frame, at full HD', () => {
    const r = renderer();
    const res = r.run(['10', '0.5', '0.8', '2']);
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect(r.files()).toEqual(['f00005.png', 'f00006.png', 'f00007.png']);
    expect(res.calls.filter((c) => c.startsWith('seek '))).toEqual(['seek 0.5', 'seek 0.6', 'seek 0.7']);
    expect(res.calls).toContain('viewport 1920x1080 scale 2');
    // the page is opened as a file URL (the space in the path is encoded) in render mode
    expect(res.calls.find((c) => c.startsWith('goto '))).toBe(`goto ${pathToFileURL(join(r.film, 'film.html')).href}?render=1`);
    expect(res.calls.at(-1)).toBe('close');
    expect(res.stdout).toMatch(/rendered 3 frames/);
  });

  test('defaults: 30 fps from 0 to the film duration', () => {
    const r = renderer();
    const res = r.run([], { FAKE_DURATION: '0.1' });
    expect(res.status).toBe(0);
    expect(r.files()).toEqual(['f00000.png', 'f00001.png', 'f00002.png']);
  });

  test('AT renders stills at exact times, named t<seconds>.png, and no frames', () => {
    const r = renderer();
    const res = r.run([], { AT: '0.9,2.1,22.05', FAKE_DURATION: '30' });
    expect(res.status).toBe(0);
    expect(r.files()).toEqual(['t00.90.png', 't02.10.png', 't22.05.png']);
    expect(res.calls.filter((c) => c.startsWith('seek '))).toEqual(['seek 0.9', 'seek 2.1', 'seek 22.05']);
    expect(res.stdout).toMatch(/rendered 3 stills/);
  });

  test('a page error fails the render', () => {
    const r = renderer();
    const res = r.run([], { FAKE_PAGEERROR: 'scene B threw' });
    expect(res.stderr).toMatch(/\[pageerror\] scene B threw/);
    expect(res.status).toBe(1);
  });

  test('browser: CHROME_BIN wins, else the newest headless shell in the Playwright cache, else the default', () => {
    const r = renderer();
    expect(r.run([], { CHROME_BIN: '/opt/chrome' }).calls[0]).toBe('launch "/opt/chrome"');
    expect(r.run([]).calls[0]).toBe('launch null');
    const cache = join(r.home, '.cache', 'ms-playwright');
    for (const build of ['900', '1200', '1100']) {
      const dir = join(cache, `chromium_headless_shell-${build}`, 'chrome-linux');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'chrome-headless-shell'), '');
    }
    const newest = join(cache, 'chromium_headless_shell-1200', 'chrome-linux', 'chrome-headless-shell');
    expect(r.run([]).calls[0]).toBe(`launch ${JSON.stringify(newest)}`);
  });

  test('says how to point at playwright-core when none can be found', () => {
    const r = renderer();
    const res = r.run([], { PLAYWRIGHT_CORE: join(r.root, 'no-such-playwright') });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/playwright-core not found\. Set PLAYWRIGHT_CORE/);
  });
});

// ---- Python audio tools. They run the kit's real scripts with stub modules on PYTHONPATH
// (or beside the script) standing in for the speech model, soundfile and the synthesizer.
const python = (code) => spawnSync('python3', ['-c', code], { encoding: 'utf8' }).status === 0;
const HAS_PYTHON = python('pass');
const HAS_NUMPY_SCIPY = HAS_PYTHON && python('import numpy, scipy.signal');

describe.skipIf(!HAS_PYTHON)(`audio/audition.py${HAS_PYTHON ? '' : ' (skipped: python3 not found)'}`, () => {
  // A fake Kokoro: a voice style is a number, so a blend is a plain weighted sum the test can check.
  const KOKORO = `
import json, os
def _log(**kw):
    with open(os.environ["FAKE_LOG"], "a") as f: f.write(json.dumps(kw) + "\\n")
class Kokoro:
    def __init__(self, model, voices): _log(event="load", model=model, voices=voices)
    def get_voice_style(self, v): return {"af_heart": 1.0, "bm_george": 10.0}[v]
    def create(self, text, voice, speed, lang):
        _log(event="create", text=text, voice=voice, speed=speed, lang=lang)
        return [0.0] * 12000, 24000
`;
  const SOUNDFILE = `
def write(path, y, sr): open(path, "wb").close()
`;
  function audition(args, env = {}) {
    const ws = workspace();
    const stubs = join(ws.root, 'pystubs');
    mkdirSync(stubs);
    writeFileSync(join(stubs, 'kokoro_onnx.py'), KOKORO);
    writeFileSync(join(stubs, 'soundfile.py'), SOUNDFILE);
    const log = join(ws.root, 'kokoro.log');
    writeFileSync(log, '');
    writeFileSync(join(ws.film, 'script.json'), JSON.stringify({ lines: [
      { id: 'l01', text: 'One. Two.' }, { id: 'l02', text: 'Three.' }, { id: 'l03', text: 'Four.  Five' },
      { id: 'l04', text: 'Not auditioned.' }, { id: 'l05', text: 'Nor this.' },
    ] }));
    const out = join(ws.root, 'auditions');
    const r = spawnSync('python3', [join(ws.film, 'audio', 'audition.py'), out, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, PYTHONPATH: stubs, KOKORO_DIR: '/models', FAKE_LOG: log, ...env },
    });
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { ...r, out, calls, creates: calls.filter((c) => c.event === 'create') };
  }

  test('renders only the first three script lines, as <name>-<id>.wav', () => {
    const r = audition(['take1', '1.1', '0', 'af_heart']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(readdirSync(r.out).sort()).toEqual(['take1-l01.wav', 'take1-l02.wav', 'take1-l03.wav']);
    expect(r.creates.map((c) => c.text)).toEqual(['One. Two.', 'Three.', 'Four.  Five']);
    expect(r.creates.every((c) => c.speed === 1.1 && c.lang === 'en-us' && c.voice === 1)).toBe(true);
    expect(r.calls[0]).toEqual({ event: 'load', model: '/models/kokoro-v1.0.int8.onnx', voices: '/models/voices-v1.0.bin' });
    expect(r.stdout.split('\n').filter(Boolean)).toEqual(['take1 l01 0.5', 'take1 l02 0.5', 'take1 l03 0.5']);
  });

  test('soften lengthens sentence pauses, a blend is the weighted sum, and a British first voice reads en-gb', () => {
    const r = audition(['blend', '1', '1', 'bm_george:0.6', 'af_heart:0.4']);
    expect(r.status).toBe(0);
    expect(r.creates.map((c) => c.text)).toEqual(['One... Two.', 'Three.', 'Four... Five']);
    expect(r.creates.every((c) => c.lang === 'en-gb' && Math.abs(c.voice - 6.4) < 1e-9)).toBe(true);
  });

  test('stops with a hint when KOKORO_DIR is not set', () => {
    const r = audition(['x', '1', '0', 'af_heart'], { KOKORO_DIR: '' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Set KOKORO_DIR/);
    expect(r.creates).toEqual([]);
  });
});

describe.skipIf(!HAS_NUMPY_SCIPY)(`audio/verify.py${HAS_NUMPY_SCIPY ? '' : ' (skipped: python3 with numpy and scipy not found)'}`, () => {
  // The real synthesizer takes minutes to check, so verify.py runs beside a stub synth.py that
  // returns quiet noise and silent layers: the checks still run (some FAIL, which is fine here),
  // and the test is about what happens at the end, around the 46 s mix timing.
  const SYNTH = `
import numpy as np
SR = 48000
def bed(dur, bpm, secs, seed, **kw):  # 2 s whatever the duration asked: enough for every check, and fast
    return np.random.default_rng(seed).standard_normal((2 * SR, 2)) * 0.01
def bed_layers(dur, bpm, secs, seed, **kw):
    z = np.zeros((int(dur * SR), 2))
    return {k: z for k in ("bass", "kick", "pad", "pluck")}, {"notes": [("A4", 440.0)]}
SFX = {"click": lambda: np.zeros((100, 2))}
`;
  const SOUNDFILE = `
import numpy as np
def read(path):
    return np.random.default_rng(1).standard_normal((48000, 2)) * (0.3 if "voice" in path else 0.01), 48000
`;
  // A stub mix.py that only writes the report verify.py reads after timing it.
  const MIX = `
import json, sys
json.dump({"integrated_lufs": -16, "true_peak_dbtp": -2, "voice_to_music_db": 14, "clipped_samples": 0}, open(sys.argv[3] + ".report.json", "w"))
`;
  function verify(clips) {
    const root = mkdtempSync(join(tmpdir(), 'film verify '));
    made.push(root);
    const audio = join(root, 'audio');
    mkdirSync(audio);
    cpSync(join(KIT, 'audio', 'verify.py'), join(audio, 'verify.py'));
    writeFileSync(join(audio, 'synth.py'), SYNTH);
    writeFileSync(join(audio, 'mix.py'), MIX);
    const stubs = join(root, 'pystubs');
    mkdirSync(stubs);
    writeFileSync(join(stubs, 'soundfile.py'), SOUNDFILE);
    writeFileSync(join(root, 'mix.report.json'), JSON.stringify({ clipped_samples: 0, true_peak_dbtp: -2, integrated_lufs: -16, voice_to_music_db: 14 }));
    const vo = join(root, 'vo');
    mkdirSync(vo);
    for (const c of clips) writeFileSync(join(vo, c), '');
    return spawnSync('python3', [join(audio, 'verify.py'), join(root, 'mix'), vo], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, PYTHONPATH: stubs, PYTHONWARNINGS: 'ignore' },
    });
  }

  test('skips the 46 s mix timing, with the reason, when the two demo clips are missing', () => {
    for (const clips of [[], ['d01.wav']]) {
      const r = verify(clips);
      expect(r.stderr).not.toMatch(/Traceback/);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^PASS {2}no clipped samples: 0$/m);
      expect(r.stdout).toMatch(/^SKIP {2}46 s mix < 30 s: needs d01\.wav and d02\.wav in the narration folder/m);
      expect(r.stdout).not.toMatch(/46s mix:/);
    }
  }, 60_000);

  test('times the 46 s mix when both demo clips are there', () => {
    const r = verify(['d01.wav', 'd02.wav']);
    expect(r.stderr).not.toMatch(/Traceback/);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/^SKIP/m);
    expect(r.stdout).toMatch(/^46s mix: LUFS -16 TP -2 v\/m 14 clipped 0$/m);
    expect(r.stdout).toMatch(/^PASS {2}46 s mix < 30 s: wall /m);
  }, 60_000);
});
