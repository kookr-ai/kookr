// Agent Notebook — a bounded, voted, plain-text memory per agent role.
//
// RFC: docs/rfc/rfc-self-improving-agent-fleet.md. The design in one breath:
// each role keeps a notebook file of one-line lessons, hard-capped so it can
// never rot. One entry = one line `<score>\t<lesson>`; at most MAX_LINES
// entries; each lesson at most MAX_CHARS characters. The agent votes +1/-1 at
// task end; when the file is full the LOWEST-scored line is evicted (ties →
// oldest), so harmful lines leave first. No embeddings, no decay curve, no
// scheduler — the cap and the vote are the whole mechanism.
//
// Everything here is plain fs over one small file under a mkdir spinlock, so a
// call is a millisecond, deterministic, and offline — faster and more reliable
// than the FAISS-backed `kb`, with no spool-degradation failure mode.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Hard caps, read at call time so they can be tuned by env without a code change (and set per-test). */
export function maxLines(): number {
  return clampInt(process.env.NB_MAX_LINES, 200, 1, 5000);
}
export function maxChars(): number {
  return clampInt(process.env.NB_MAX_CHARS, 120, 20, 2000);
}
/** The usage log is itself a bounded ring (monitoring can't grow unbounded either). */
export function usageRing(): number {
  return clampInt(process.env.NB_USAGE_RING, 5000, 100, 100000);
}

function clampInt(raw: string | undefined, dflt: number, lo: number, hi: number): number {
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

/** One notebook line. `score` is a running vote sum; `text` is a single ≤MAX_CHARS lesson. */
export interface Entry {
  score: number;
  text: string;
}

/** A role name is a path segment; reject anything that could escape the notebooks dir. */
const SAFE_ROLE = /^[A-Za-z0-9](?:[A-Za-z0-9._@-]*[A-Za-z0-9])?$/;

export function assertSafeRole(role: string): void {
  if (!SAFE_ROLE.test(role) || role.includes('..')) {
    throw new Error(`invalid role name: ${JSON.stringify(role)} (allowed: letters, digits, . _ @ -)`);
  }
}

/** The notebooks directory. `NB_DIR` overrides; default `~/.kookr/notebooks`. */
export function notebooksDir(): string {
  return process.env.NB_DIR && process.env.NB_DIR.trim() !== ''
    ? process.env.NB_DIR
    : join(homedir(), '.kookr', 'notebooks');
}

function roleFile(dir: string, role: string): string {
  assertSafeRole(role);
  return join(dir, `${role}.md`);
}

function usageFile(dir: string): string {
  return join(dir, '.nb-usage.log');
}

// ---------------------------------------------------------------------------
// line (de)serialisation
// ---------------------------------------------------------------------------

/** A lesson is always one line, never longer than MAX_CHARS, with no tab (our field separator). */
export function sanitizeLesson(raw: string): string {
  const oneLine = raw.replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return oneLine.slice(0, maxChars());
}

function parseLine(line: string): Entry | null {
  if (line.trim() === '') return null;
  const tab = line.indexOf('\t');
  if (tab === -1) {
    // Tolerate a hand-edited line with no score: treat it as score 0.
    return { score: 0, text: sanitizeLesson(line) };
  }
  const score = Number.parseInt(line.slice(0, tab), 10);
  return { score: Number.isFinite(score) ? score : 0, text: sanitizeLesson(line.slice(tab + 1)) };
}

function formatLine(e: Entry): string {
  const s = e.score >= 0 ? `+${e.score}` : `${e.score}`;
  return `${s}\t${e.text}`;
}

/** Dedup key: case/punctuation-insensitive, whitespace-collapsed. Conservative — equality only. */
export function dedupKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // punctuation → space, so "shell-safety" == "shell safety"
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// locking (tiny mkdir spinlock — single-host, serial CLI calls, rare contention)
// ---------------------------------------------------------------------------

async function withLock<T>(dir: string, fn: () => T): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, '.nb.lock');
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      mkdirSync(lock); // atomic: succeeds only if it did not exist
      break;
    } catch {
      // Stale-lock recovery: a crashed nb process can leave .nb.lock behind.
      // If the lock dir is older than the whole acquire budget, steal it.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) {
          rmdirSync(lock);
          continue;
        }
      } catch {
        /* lock vanished between mkdir and stat — just retry */
      }
      if (Date.now() > deadline) {
        throw new Error('notebook is locked (another nb process did not release within 2s)');
      }
      await sleep(20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* best-effort release */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// read / write
// ---------------------------------------------------------------------------

export function readEntries(dir: string, role: string): Entry[] {
  const file = roleFile(dir, role);
  if (!existsSync(file)) return [];
  const out: Entry[] = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const e = parseLine(line);
    if (e && e.text !== '') out.push(e);
  }
  return out;
}

function writeEntries(dir: string, role: string, entries: Entry[]): void {
  const file = roleFile(dir, role);
  const body = entries.map(formatLine).join('\n');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, entries.length ? body + '\n' : '', 'utf-8');
  renameSync(tmp, file); // atomic replace
}

/** Evict down to MAX_LINES by removing the lowest-scored entries (ties → oldest/earliest). */
function trim(entries: Entry[]): Entry[] {
  const cap = maxLines();
  if (entries.length <= cap) return entries;
  // Tag with original index so we can break score ties by age (lower index = older).
  const tagged = entries.map((e, i) => ({ e, i }));
  tagged.sort((a, b) => (a.e.score - b.e.score) || (a.i - b.i)); // worst first
  const dropCount = entries.length - cap;
  const dropIdx = new Set(tagged.slice(0, dropCount).map((t) => t.i));
  return entries.filter((_, i) => !dropIdx.has(i));
}

// ---------------------------------------------------------------------------
// public operations
// ---------------------------------------------------------------------------

export interface AddResult {
  added: boolean;
  reason: 'added' | 'duplicate' | 'empty' | 'rejected-full';
  evicted: Entry | null;
  size: number;
}

export function addEntry(dir: string, role: string, lesson: string): Promise<AddResult> {
  return withLock(dir, () => {
    const text = sanitizeLesson(lesson);
    if (text === '') return { added: false, reason: 'empty', evicted: null, size: readEntries(dir, role).length };
    const entries = readEntries(dir, role);
    const key = dedupKey(text);
    if (entries.some((e) => dedupKey(e.text) === key)) {
      return { added: false, reason: 'duplicate', evicted: null, size: entries.length };
    }
    const newEntry: Entry = { score: 1, text };
    entries.push(newEntry);
    const before = entries.length;
    const kept = trim(entries);
    if (!kept.includes(newEntry)) {
      // Notebook full and every existing entry outranks this one — the new
      // lesson was the lowest-scored, so it is not stored. Report honestly so
      // the agent's retrospective doesn't believe it saved something.
      writeEntries(dir, role, kept); // === the prior set; no net change
      return { added: false, reason: 'rejected-full', evicted: null, size: kept.length };
    }
    let evicted: Entry | null = null;
    if (kept.length < before) {
      const keptSet = new Set(kept);
      evicted = entries.find((e) => !keptSet.has(e)) ?? null;
    }
    writeEntries(dir, role, kept);
    return { added: true, reason: 'added', evicted, size: kept.length };
  });
}

/** Entries in DISPLAY order (score desc, then file order), each tagged with its file-order index. */
function ordered(entries: Entry[]): { e: Entry; idx: number }[] {
  return entries.map((e, idx) => ({ e, idx })).sort((a, b) => b.e.score - a.e.score || a.idx - b.idx);
}

/**
 * Resolve a selector to a FILE-ORDER index. A numeric id is the 1-based row in
 * DISPLAY order — exactly what `nb show` prints and the SessionStart hook
 * injects — so `nb vote 1` always hits the entry shown as `1.` even after votes
 * reorder the file. A non-numeric selector is a case-insensitive substring.
 */
function selectIndex(entries: Entry[], selector: string): number {
  const asId = Number.parseInt(selector, 10);
  if (String(asId) === selector.trim() && asId >= 1 && asId <= entries.length) {
    return ordered(entries)[asId - 1].idx;
  }
  const q = selector.toLowerCase();
  const matches = entries
    .map((e, i) => ({ e, i }))
    .filter((x) => x.e.text.toLowerCase().includes(q));
  if (matches.length === 0) throw new Error(`no entry matches ${JSON.stringify(selector)}`);
  if (matches.length > 1) {
    throw new Error(`"${selector}" matches ${matches.length} entries — use the line id (see \`nb show\`)`);
  }
  return matches[0].i;
}

export interface VoteResult {
  text: string;
  score: number;
}

export function vote(dir: string, role: string, selector: string, delta: number): Promise<VoteResult> {
  return withLock(dir, () => {
    if (delta !== 1 && delta !== -1) throw new Error('vote delta must be +1 or -1');
    const entries = readEntries(dir, role);
    if (entries.length === 0) throw new Error(`notebook for role "${role}" is empty`);
    const idx = selectIndex(entries, selector);
    entries[idx].score += delta;
    writeEntries(dir, role, entries);
    return { text: entries[idx].text, score: entries[idx].score };
  });
}

export function merge(dir: string, role: string, selA: string, selB: string, mergedLesson: string): Promise<AddResult> {
  return withLock(dir, () => {
    const entries = readEntries(dir, role);
    const ia = selectIndex(entries, selA);
    const ib = selectIndex(entries, selB);
    if (ia === ib) throw new Error('merge needs two different entries');
    const text = sanitizeLesson(mergedLesson);
    if (text === '') throw new Error('merged lesson is empty');
    // Keep the usefulness: the merged line inherits the higher of the two scores.
    const score = Math.max(entries[ia].score, entries[ib].score);
    const remaining = entries.filter((_, i) => i !== ia && i !== ib);
    // Drop an existing duplicate of the merged text so merge never creates one.
    const key = dedupKey(text);
    const deduped = remaining.filter((e) => dedupKey(e.text) !== key);
    deduped.push({ score, text });
    const kept = trim(deduped);
    writeEntries(dir, role, kept);
    return { added: true, reason: 'added', evicted: null, size: kept.length };
  });
}

export function remove(dir: string, role: string, selector: string): Promise<VoteResult> {
  return withLock(dir, () => {
    const entries = readEntries(dir, role);
    if (entries.length === 0) throw new Error(`notebook for role "${role}" is empty`);
    const idx = selectIndex(entries, selector);
    const [gone] = entries.splice(idx, 1);
    writeEntries(dir, role, entries);
    return { text: gone.text, score: gone.score };
  });
}

/** Render a notebook for injection / `show`: 1-based ids, highest score first (most useful on top). */
export function render(dir: string, role: string): string {
  const ord = ordered(readEntries(dir, role));
  if (ord.length === 0) return `(notebook for role "${role}" is empty)`;
  const width = String(ord.length).length;
  return ord
    .map((x, rank) => {
      const id = String(rank + 1).padStart(width, ' ');
      const s = x.e.score >= 0 ? `+${x.e.score}` : `${x.e.score}`;
      return `${id}. [${s}] ${x.e.text}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// usage log + monitoring
// ---------------------------------------------------------------------------

export interface UsageRow {
  ts: string;
  role: string;
  command: string;
  ok: boolean;
  ms: number;
}

export function logUsage(dir: string, role: string, command: string, ok: boolean, ms: number): void {
  try {
    mkdirSync(dir, { recursive: true });
    const file = usageFile(dir);
    const line = `${new Date().toISOString()}\t${role}\t${command}\t${ok ? 'ok' : 'err'}\t${Math.round(ms)}ms`;
    let lines: string[] = [];
    if (existsSync(file)) lines = readFileSync(file, 'utf-8').split('\n').filter((l) => l !== '');
    lines.push(line);
    const ring = usageRing();
    if (lines.length > ring) lines = lines.slice(lines.length - ring); // oldest dropped
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, lines.join('\n') + '\n', 'utf-8');
    renameSync(tmp, file);
  } catch {
    /* monitoring is best-effort; never fail a real operation because the log write failed */
  }
}

function parseUsage(dir: string): UsageRow[] {
  const file = usageFile(dir);
  if (!existsSync(file)) return [];
  const rows: UsageRow[] = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (line.trim() === '') continue;
    const [ts, role, command, status, msRaw] = line.split('\t');
    if (!ts || !command) continue;
    rows.push({
      ts,
      role: role ?? '',
      command: command ?? '',
      ok: status === 'ok',
      ms: Number.parseInt((msRaw ?? '0').replace(/ms$/, ''), 10) || 0,
    });
  }
  return rows;
}

export interface CommandStat {
  command: string;
  calls: number;
  errors: number;
  errorRate: number;
  p50ms: number;
  p95ms: number;
  lastUsed: string;
}

export interface Anomaly {
  kind: 'loop' | 'went-silent' | 'high-error-rate';
  command: string;
  role?: string;
  detail: string;
}

export interface StatsReport {
  window: string;
  totalCalls: number;
  perCommand: CommandStat[];
  anomalies: Anomaly[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** Parse a window like `7d`, `12h`, `30m` into milliseconds. Default 7 days. */
export function parseWindowMs(raw: string | undefined): number {
  if (!raw) return 7 * 24 * 3600_000;
  const m = /^(\d+)([dhm])$/.exec(raw.trim());
  if (!m) return 7 * 24 * 3600_000;
  const n = Number.parseInt(m[1], 10);
  return n * (m[2] === 'd' ? 86_400_000 : m[2] === 'h' ? 3_600_000 : 60_000);
}

/**
 * Monitoring without a monitoring system: read the usage ring, roll up per
 * command, and flag the three anomalies that matter — an agent looping on a
 * command (stuck), a command that went silent (it probably broke), and a
 * command erroring often (not behaving as expected).
 */
export function stats(
  dir: string,
  opts: { role?: string; windowMs?: number; now?: number } = {},
): StatsReport {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? 7 * 24 * 3600_000;
  const all = parseUsage(dir).filter((r) => (opts.role ? r.role === opts.role : true));
  const recent = all.filter((r) => now - Date.parse(r.ts) <= windowMs);

  const byCmd = new Map<string, UsageRow[]>();
  for (const r of recent) {
    const arr = byCmd.get(r.command) ?? [];
    arr.push(r);
    byCmd.set(r.command, arr);
  }
  const perCommand: CommandStat[] = [...byCmd.entries()]
    .map(([command, rows]) => {
      const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
      const errors = rows.filter((r) => !r.ok).length;
      const lastUsed = rows.map((r) => r.ts).sort().at(-1) ?? '';
      return {
        command,
        calls: rows.length,
        errors,
        errorRate: rows.length ? errors / rows.length : 0,
        p50ms: percentile(lat, 50),
        p95ms: percentile(lat, 95),
        lastUsed,
      };
    })
    .sort((a, b) => b.calls - a.calls);

  const anomalies: Anomaly[] = [];

  // (1) loop: same role+command ≥ LOOP_N times inside LOOP_WINDOW_MS.
  const LOOP_N = clampInt(process.env.NB_LOOP_N, 10, 2, 1000);
  const LOOP_WINDOW_MS = clampInt(process.env.NB_LOOP_WINDOW_S, 120, 5, 86_400) * 1000;
  const byRoleCmd = new Map<string, number[]>();
  for (const r of recent) {
    const k = `${r.role}\u0000${r.command}`;
    const arr = byRoleCmd.get(k) ?? [];
    arr.push(Date.parse(r.ts));
    byRoleCmd.set(k, arr);
  }
  for (const [k, tsList] of byRoleCmd) {
    const sortedTs = tsList.sort((a, b) => a - b);
    for (let i = 0; i + LOOP_N - 1 < sortedTs.length; i++) {
      if (sortedTs[i + LOOP_N - 1] - sortedTs[i] <= LOOP_WINDOW_MS) {
        const [role, command] = k.split('\u0000');
        anomalies.push({
          kind: 'loop',
          command,
          role,
          detail: `${LOOP_N}+ calls within ${Math.round(LOOP_WINDOW_MS / 1000)}s — the agent may be stuck/looping`,
        });
        break;
      }
    }
  }

  // (2) went-silent: a command used historically but not at all in the recent window.
  const SILENT_MS = clampInt(process.env.NB_SILENT_H, 48, 1, 24 * 365) * 3600_000;
  const lastSeen = new Map<string, number>();
  for (const r of all) {
    const t = Date.parse(r.ts);
    lastSeen.set(r.command, Math.max(lastSeen.get(r.command) ?? 0, t));
  }
  for (const [command, last] of lastSeen) {
    const age = now - last;
    if (age > SILENT_MS && !byCmd.has(command)) {
      anomalies.push({
        kind: 'went-silent',
        command,
        detail: `last used ${Math.round(age / 3600_000)}h ago, 0 calls in the window — it may have broken or been abandoned`,
      });
    }
  }

  // (3) high-error-rate: enough calls and a high failure fraction.
  const ERR_MIN = clampInt(process.env.NB_ERR_MIN, 5, 1, 10_000);
  const rawRate = Number(process.env.NB_ERR_RATE);
  const ERR_RATE = Number.isFinite(rawRate) ? Math.min(1, Math.max(0, rawRate)) : 0.3; // bad value → default, not NaN (which disables detection)
  for (const c of perCommand) {
    if (c.calls >= ERR_MIN && c.errorRate >= ERR_RATE) {
      anomalies.push({
        kind: 'high-error-rate',
        command: c.command,
        detail: `${Math.round(c.errorRate * 100)}% errors over ${c.calls} calls — broken or not behaving as expected`,
      });
    }
  }

  const window =
    windowMs % 86_400_000 === 0
      ? `${windowMs / 86_400_000}d`
      : windowMs % 3_600_000 === 0
        ? `${windowMs / 3_600_000}h`
        : `${Math.round(windowMs / 60_000)}m`;
  return { window, totalCalls: recent.length, perCommand, anomalies };
}
