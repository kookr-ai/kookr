#!/usr/bin/env node
// memory-writer: the ONLY process that writes the nb notebook store (single writer).
//   POST /v1/lesson  {lesson}            Authorization: Bearer <worker token>
//   GET  /v1/health
// A token maps to one project; a worker can append a lesson to `<role>@<project>` for its own project only.
// Every request is serialised through one in-process queue (no multi-writer race on top of nb's own lock),
// appended to an audit log, and republished to a per-project read-only VIEW directory by atomic per-file rename.
// Env: NB_DIR (store, rw), VIEWS_DIR (rw), AUDIT_LOG, TOKENS_FILE ({token:{actor,project,role}}), PORT, NB_BIN.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, timingSafeEqual } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const run = promisify(execFile);
const { NB_DIR, VIEWS_DIR, AUDIT_LOG, TOKENS_FILE } = process.env;
const PORT = Number(process.env.PORT ?? 8787);
const NB = process.env.NB_BIN ?? 'nb';
const MAX_BODY = 4096;
for (const [k, v] of Object.entries({ NB_DIR, VIEWS_DIR, AUDIT_LOG, TOKENS_FILE })) if (!v) throw new Error(`${k} required`);
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // role / project ids: no '@', '/', '..'
const tokens = JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
let seq = 0;
let queue = Promise.resolve();

const audit = (rec) => appendFileSync(AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), seq: ++seq, ...rec }) + '\n');
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const lookup = (tok) => { for (const [t, v] of Object.entries(tokens)) if (same(t, tok)) return v; return null; };

/** Atomically republish what `project` may read: its own `*@project` shelves + role-wide (no '@') shelves. */
function publishView(project) {
  const dir = join(VIEWS_DIR, project);
  mkdirSync(dir, { recursive: true });
  const want = readdirSync(NB_DIR).filter((f) => f.endsWith('.md') && (!f.includes('@') || f.endsWith(`@${project}.md`)));
  for (const f of want) {
    const tmp = join(dir, `.${f}.tmp`);
    copyFileSync(join(NB_DIR, f), tmp);
    renameSync(tmp, join(dir, f));
  }
  for (const f of readdirSync(dir)) if (f.endsWith('.md') && !want.includes(f)) rmSync(join(dir, f)); // shelf removed upstream
}

function handleLesson(who, lesson) {
  const shelf = `${who.role}@${who.project}`;
  return (queue = queue.then(async () => {
    const sha = createHash('sha256').update(lesson).digest('hex').slice(0, 12);
    try {
      const { stdout } = await run(NB, ['add', shelf, lesson], { env: { ...process.env, NB_DIR, NB_GIT_AUTOCOMMIT: '0' }, timeout: 10_000 });
      publishView(who.project);
      audit({ actor: who.actor, project: who.project, shelf, sha, outcome: 'ok', detail: stdout.trim() });
      return { status: 200, body: { ok: true, shelf, detail: stdout.trim() } };
    } catch (err) {
      const msg = String(err.stderr || err.message).trim().slice(0, 300);
      audit({ actor: who.actor, project: who.project, shelf, sha, outcome: 'rejected', detail: msg });
      return { status: 422, body: { ok: false, error: msg } };
    }
  }));
}

http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && req.url === '/v1/health') return send(200, { ok: true, seq });
  if (req.method !== 'POST' || req.url !== '/v1/lesson') return send(404, { error: 'not found' });
  const who = lookup((req.headers.authorization ?? '').replace(/^Bearer /, ''));
  if (!who) return send(401, { error: 'bad token' });
  if (!SAFE.test(who.role) || !SAFE.test(who.project)) return send(500, { error: 'bad token mapping' });
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > MAX_BODY) req.destroy(); });
  req.on('end', async () => {
    let lesson;
    try { lesson = JSON.parse(body).lesson; } catch { return send(400, { error: 'bad json' }); }
    if (typeof lesson !== 'string' || !lesson.trim() || lesson.includes('\n')) return send(400, { error: 'lesson must be one non-empty line' });
    const r = await handleLesson(who, lesson.trim());
    send(r.status, r.body);
  });
}).listen(PORT, process.env.HOST ?? '0.0.0.0', () => console.log(`memory-writer up :${PORT}`));
