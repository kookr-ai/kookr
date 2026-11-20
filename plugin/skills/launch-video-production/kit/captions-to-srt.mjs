// Writes a .srt subtitle file from captions.js, for players and sites that take one.
// usage: node captions-to-srt.mjs [captions.js] [out/captions.srt]
import fs from 'node:fs';
import path from 'node:path';

const [src = 'captions.js', out = 'out/captions.srt'] = process.argv.slice(2);
const FILM = {};
// captions.js is a plain assignment to FILM.captions; evaluate it against a local object.
new Function('FILM', fs.readFileSync(src, 'utf8'))(FILM);
if (!Array.isArray(FILM.captions) || FILM.captions.length === 0) {
  console.error(`${src} does not set FILM.captions to a non-empty list`);
  process.exit(1);
}
const stamp = (seconds) => {
  const ms = Math.round(seconds * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
const srt = FILM.captions.map((c, i) => `${i + 1}\n${stamp(c.t0)} --> ${stamp(c.t1)}\n${c.text}\n`).join('\n');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, srt);
console.log(`${out}  ${FILM.captions.length} captions`);
