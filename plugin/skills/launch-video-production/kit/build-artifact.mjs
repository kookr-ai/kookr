// Packs the film into one self-contained review page: the same timeline that is rendered to
// video, played live with the audio mix as its clock.
// usage: node build-artifact.mjs <template.html> <out.html>
// Template markers:
//   /*FILM_CSS*/            film.css + scene styles
//   /*FILM_JS*/             engine, components, scenes, captions, player
//   {{AUDIO:path}}          data URI of an audio file (mp3)
//   {{IMG:path}}            data URI of an image (jpeg/png)
//   {{TEXT:path}}           HTML-escaped text file
//   {{MP4_MB}}              size of the rendered clip in MB
import fs from 'node:fs';
import path from 'node:path';

const [tplPath, outPath] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(here, p), 'utf8');
const mime = { '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.wav': 'audio/wav' };
const dataUri = (p) => `data:${mime[path.extname(p)]};base64,${fs.readFileSync(path.join(here, p)).toString('base64')}`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const css = ['film.css', 'scenes-a.css', 'scenes-b.css'].map(read).join('\n');
// A closing script tag inside inlined JavaScript would end the element early.
const js = ['engine.js', 'components.js', 'scenes-a.js', 'scenes-b.js', 'captions.js', 'player.js']
  .map((f) => `/* ---- ${f} ---- */\n${read(f)}`).join('\n').replace(/<\/script/gi, '<\\/script');

let html = fs.readFileSync(tplPath, 'utf8');
html = html.replace('/*FILM_CSS*/', () => css).replace('/*FILM_JS*/', () => js);
html = html.replace(/\{\{(AUDIO|IMG):([^}]+)\}\}/g, (_, kind, p) => dataUri(p.trim()));
html = html.replace('{{MP4_MB}}', () => (fs.statSync(path.join(here, `out/${process.env.OUT || 'film'}.mp4`)).size / 1048576).toFixed(1));
html = html.replace(/\{\{TEXT:([^}]+)\}\}/g, (_, p) => esc(read(p.trim())));
const left = html.match(/\{\{[A-Z]+:[^}]*\}\}|\/\*FILM_(CSS|JS)\*\//);
if (left) { console.error('unresolved marker: ' + left[0]); process.exit(1); }
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html);
console.log(`${outPath}  ${(html.length / 1048576).toFixed(2)} MB`);
