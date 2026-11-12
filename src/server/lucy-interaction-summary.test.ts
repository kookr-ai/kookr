import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLucyInteractionLog } from './lucy-interaction-log.js';
import {
  summarizeLucyInteractionFiles,
  summarizeLucyInteractionLines,
} from './lucy-interaction-summary.js';

const NOW = new Date('2026-11-11T12:00:00.000Z');

function said(clipId: string, over: Record<string, unknown> = {}, ts = '2026-11-11T10:00:00.000Z'): string {
  return JSON.stringify({
    v: 1, ts, kind: 'said', clipId, source: 'task_summary', text: `text of ${clipId}`,
    usedFallback: false, cached: false, llmMs: 1, ttsMs: 1, durationMs: 1000, words: 10, ...over,
  });
}
function ui(event: Record<string, unknown>, ts = '2026-11-11T10:00:05.000Z'): string {
  return JSON.stringify({ v: 1, ts, kind: 'ui', sessionId: 's1', event: { timestamp: ts, sessionId: 's1', platform: 'linux', ...event } });
}

describe('summarizeLucyInteractionLines', () => {
  it('returns zeros for an empty log without dividing by zero', () => {
    const s = summarizeLucyInteractionLines([], { days: 7, now: NOW });
    expect(s.said.count).toBe(0);
    expect(s.said.meanWords).toBe(0);
    expect(s.said.fromFallback.share).toBe(0);
    expect(s.ui.replays.rate).toBe(0);
    expect(s.ui.unheard.rate).toBe(0);
    expect(s.topEarlyStopped).toEqual([]);
    expect(s.since).toBe('2026-11-04T12:00:00.000Z');
  });

  it('aggregates said records overall and per source', () => {
    const s = summarizeLucyInteractionLines([
      said('a', { words: 10 }),
      said('b', { words: 20, usedFallback: true }),
      said('c', { words: 40, cached: true, source: 'agent_speak' }),
      said('d', { words: 6, source: 'agent_speak', cached: true, usedFallback: true }),
    ], { days: 7, now: NOW });
    expect(s.said.count).toBe(4);
    expect(s.said.fromFallback).toEqual({ count: 2, share: 0.5 });
    expect(s.said.cacheHits).toEqual({ count: 2, share: 0.5 });
    expect(s.said.meanWords).toBe(19);
    expect(s.said.medianWords).toBe(15);
    expect(s.said.bySource.task_summary).toMatchObject({ count: 2, meanWords: 15, medianWords: 15 });
    expect(s.said.bySource.agent_speak).toMatchObject({ count: 2, meanWords: 23 });
    expect(s.said.bySource.agent_speak.cacheHits.share).toBe(1);
  });

  it('computes replay, early-stop, unheard and panel-action figures from ui events', () => {
    const s = summarizeLucyInteractionLines([
      said('a'), said('b'), said('c'), said('d'),
      ui({ type: 'lucy_clip_started', clipId: 'a', trigger: 'click' }),
      ui({ type: 'lucy_clip_started', clipId: 'a', trigger: 'replay' }),
      ui({ type: 'lucy_clip_started', clipId: 'b', trigger: 'click' }),
      ui({ type: 'lucy_clip_started', clipId: 'c', trigger: 'click' }),
      ui({ type: 'lucy_clip_ended', clipId: 'a', endedBy: 'finished', playedMs: 1000, totalMs: 1000 }),
      ui({ type: 'lucy_clip_ended', clipId: 'b', endedBy: 'user_stop', playedMs: 300, totalMs: 1000 }),
      ui({ type: 'lucy_clip_ended', clipId: 'c', endedBy: 'user_stop', playedMs: 800, totalMs: 1000 }),
      ui({ type: 'lucy_clip_ended', clipId: 'c', endedBy: 'superseded', playedMs: 100, totalMs: 1000 }),
      ui({ type: 'lucy_clip_unheard', clipId: 'd', reason: 'muted' }),
      ui({ type: 'lucy_panel_action', action: 'minimize' }),
      ui({ type: 'lucy_panel_action', action: 'minimize' }),
      ui({ type: 'lucy_panel_action', action: 'move' }),
    ], { days: 7, now: NOW });
    expect(s.ui.clipsStarted).toBe(3);
    expect(s.ui.replays).toEqual({ count: 1, clipsReplayed: 1, rate: 0.3333 });
    expect(s.ui.clipsEnded).toBe(4);
    expect(s.ui.earlyStops).toEqual({ count: 1, rate: 0.25 });
    expect(s.ui.unheard).toEqual({ count: 1, rate: 0.25, byReason: { muted: 1 } });
    expect(s.ui.panelActions).toEqual({ minimize: 2, move: 1 });
  });

  it('counts a question Lucy read out by herself as a started clip, and its replay as a replay', () => {
    const s = summarizeLucyInteractionLines([
      said('q', { source: 'operator_ask' }),
      ui({ type: 'lucy_clip_started', clipId: 'q', trigger: 'ask' }),
      ui({ type: 'lucy_clip_started', clipId: 'q', trigger: 'replay' }),
    ], { days: 7, now: NOW });
    expect(s.ui.clipsStarted).toBe(1);
    expect(s.ui.replays).toEqual({ count: 1, clipsReplayed: 1, rate: 1 });
    expect(s.said.bySource.operator_ask).toMatchObject({ count: 1 });
  });

  it('rates replays by distinct replayed clips, not by replay events, and ignores replays for clipsStarted', () => {
    const s = summarizeLucyInteractionLines([
      ui({ type: 'lucy_clip_started', clipId: 'a', trigger: 'click' }),
      ui({ type: 'lucy_clip_started', clipId: 'b', trigger: 'click' }),
      ui({ type: 'lucy_clip_started', clipId: 'a', trigger: 'replay' }),
      ui({ type: 'lucy_clip_started', clipId: 'a', trigger: 'replay' }),
      ui({ type: 'lucy_clip_started', clipId: 'a', trigger: 'replay' }),
      ui({ type: 'lucy_clip_started', clipId: 'zzz', trigger: 'replay' }),
    ], { days: 7, now: NOW });
    expect(s.ui.clipsStarted).toBe(2);
    expect(s.ui.replays).toEqual({ count: 4, clipsReplayed: 2, rate: 1 });
  });

  it('does not count a failed replay of an already-heard clip as unheard', () => {
    const s = summarizeLucyInteractionLines([
      ui({ type: 'lucy_clip_started', clipId: 'a', trigger: 'click' }),
      ui({ type: 'lucy_clip_unheard', clipId: 'a', reason: 'audio_suspended' }),
      ui({ type: 'lucy_clip_unheard', clipId: 'never', reason: 'muted' }),
      ui({ type: 'lucy_clip_unheard', clipId: 'never', reason: 'muted' }),
      ui({ type: 'lucy_clip_unheard', reason: 'dnd' }),
    ], { days: 7, now: NOW });
    expect(s.ui.unheard.count).toBe(2);
    expect(s.ui.unheard.byReason).toEqual({ muted: 1, dnd: 1 });
    expect(s.ui.unheard.rate).toBe(0.6667);
  });

  it('buckets client-controlled reasons and actions as "other" without prototype pollution', () => {
    const hostile = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'weird'];
    const lines = hostile.flatMap((name, i) => [
      ui({ type: 'lucy_clip_unheard', clipId: `u${i}`, reason: name }),
      ui({ type: 'lucy_panel_action', action: name }),
    ]);
    lines.push(ui({ type: 'lucy_clip_unheard', clipId: 'ok', reason: 'muted' }), ui({ type: 'lucy_clip_unheard', clipId: 'num', reason: 7 }));
    const s = summarizeLucyInteractionLines(lines, { days: 7, now: NOW });
    expect(s.ui.unheard.byReason).toEqual({ other: 6, muted: 1 });
    expect(Object.values(s.ui.unheard.byReason).reduce((a, b) => a + b, 0)).toBe(s.ui.unheard.count);
    expect(s.ui.panelActions).toEqual({ other: 5 });
    expect(Object.getPrototypeOf(s.ui.unheard.byReason)).toBe(Object.prototype);
    expect(Object.keys(s.ui.unheard.byReason)).not.toContain('__proto__');
  });

  it('treats exactly 50% played as NOT an early stop, and just under as one', () => {
    const s = summarizeLucyInteractionLines([
      ui({ type: 'lucy_clip_ended', clipId: 'a', endedBy: 'user_stop', playedMs: 500, totalMs: 1000 }),
      ui({ type: 'lucy_clip_ended', clipId: 'b', endedBy: 'user_stop', playedMs: 499, totalMs: 1000 }),
    ], { days: 7, now: NOW });
    expect(s.ui.earlyStops).toEqual({ count: 1, rate: 0.5 });
  });

  it('skips ui lines with a missing or invalid ts without calling them corrupt', () => {
    const noTs = JSON.stringify({ v: 1, kind: 'ui', sessionId: 's', event: { type: 'lucy_clip_unheard', clipId: 'x', reason: 'muted' } });
    const badTs = JSON.stringify({ v: 1, ts: 'yesterday-ish', kind: 'ui', sessionId: 's', event: { type: 'lucy_clip_unheard', clipId: 'y', reason: 'muted' } });
    const s = summarizeLucyInteractionLines([noTs, badTs, ui({ type: 'lucy_clip_unheard', clipId: 'z', reason: 'dnd' })], { days: 7, now: NOW });
    expect(s.corruptLines).toBe(0);
    expect(s.ui.unheard).toMatchObject({ count: 1, byReason: { dnd: 1 } });
  });

  it('includes a record exactly on the window boundary and excludes one millisecond before', () => {
    const s = summarizeLucyInteractionLines([
      said('on', {}, '2026-11-04T12:00:00.000Z'),
      said('before', {}, '2026-11-04T11:59:59.999Z'),
      ui({ type: 'lucy_clip_unheard', clipId: 'u-on', reason: 'muted' }, '2026-11-04T12:00:00.000Z'),
      ui({ type: 'lucy_clip_unheard', clipId: 'u-before', reason: 'muted' }, '2026-11-04T11:59:59.999Z'),
    ], { days: 7, now: NOW });
    expect(s.since).toBe('2026-11-04T12:00:00.000Z');
    expect(s.said.count).toBe(1);
    expect(s.ui.unheard.count).toBe(1);
  });

  it('does not count a user_stop with unknown total duration as an early stop', () => {
    const s = summarizeLucyInteractionLines([
      ui({ type: 'lucy_clip_ended', clipId: 'a', endedBy: 'user_stop', playedMs: 0, totalMs: 0 }),
    ], { days: 7, now: NOW });
    expect(s.ui.earlyStops.count).toBe(0);
  });

  it('ranks the phrasings that get cut off most, joined on clipId and truncated', () => {
    const long = 'word '.repeat(60);
    const lines: string[] = [said('a', { text: 'Fix login is done.' }), said('b', { text: 'Fix login is done.' }), said('c', { text: long }), said('d', { text: 'Other.' })];
    for (const id of ['a', 'b', 'c', 'c']) {
      lines.push(ui({ type: 'lucy_clip_ended', clipId: id, endedBy: 'user_stop', playedMs: 100, totalMs: 1000 }));
    }
    lines.push(ui({ type: 'lucy_clip_ended', clipId: 'ghost', endedBy: 'user_stop', playedMs: 100, totalMs: 1000 }));
    const s = summarizeLucyInteractionLines(lines, { days: 7, now: NOW });
    expect(s.topEarlyStopped[0]).toEqual({ text: 'Fix login is done.', earlyStops: 2 });
    expect(s.topEarlyStopped[1].earlyStops).toBe(2);
    expect(s.topEarlyStopped[1].text.length).toBeLessThanOrEqual(120);
    expect(s.topEarlyStopped[1].text.endsWith('…')).toBe(true);
    expect(s.earlyStopsWithoutText).toBe(1);
  });

  it('limits topEarlyStopped to ten entries', () => {
    const lines: string[] = [];
    for (let i = 0; i < 15; i++) {
      lines.push(said(`c${i}`, { text: `phrase ${i}` }));
      lines.push(ui({ type: 'lucy_clip_ended', clipId: `c${i}`, endedBy: 'user_stop', playedMs: 1, totalMs: 100 }));
    }
    expect(summarizeLucyInteractionLines(lines, { days: 7, now: NOW }).topEarlyStopped).toHaveLength(10);
  });

  it('honours the day window but still joins text from an older said line', () => {
    const s = summarizeLucyInteractionLines([
      said('old', { words: 99 }, '2026-10-01T00:00:00.000Z'),
      said('edge', { text: 'Edge phrase.' }, '2026-11-04T11:00:00.000Z'),
      ui({ type: 'lucy_clip_ended', clipId: 'edge', endedBy: 'user_stop', playedMs: 1, totalMs: 100 }, '2026-11-11T09:00:00.000Z'),
      ui({ type: 'lucy_clip_unheard', clipId: 'old', reason: 'dnd' }, '2026-10-01T00:00:01.000Z'),
    ], { days: 7, now: NOW });
    expect(s.said.count).toBe(0);
    expect(s.ui.unheard.count).toBe(0);
    expect(s.topEarlyStopped).toEqual([{ text: 'Edge phrase.', earlyStops: 1 }]);
  });

  it('tolerates corrupt, partial and unknown lines', () => {
    const s = summarizeLucyInteractionLines([
      '{"v":1,"ts":"2026-11-11T10:00:00.000Z","kind":"sa',
      'not json at all',
      '',
      '[1,2]',
      JSON.stringify({ kind: 'mystery', ts: '2026-11-11T10:00:00.000Z' }),
      said('ok'),
      JSON.stringify({ v: 1, ts: '2026-11-11T10:00:00.000Z', kind: 'ui', sessionId: 's', event: 'oops' }),
    ], { days: 7, now: NOW });
    expect(s.corruptLines).toBe(4);
    expect(s.said.count).toBe(1);
  });
});

describe('summarizeLucyInteractionFiles', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('round-trips the real writer: said + ui joined on clipId, with denominators that differ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lucy-sum-'));
    dirs.push(dir);
    const base = join(dir, 'lucy-interactions.jsonl');
    const log = createLucyInteractionLog({ filePath: base, now: () => new Date('2026-11-11T10:00:00.000Z') });
    const sayClip = (clipId: string, text: string, words: number) => log.recordSaid({
      clipId, source: 'task_summary', text, usedFallback: false, cached: false, llmMs: 1, ttsMs: 1, durationMs: 1000, words,
    });
    sayClip('a', 'Fix login is done.', 4);
    sayClip('b', 'Deploy needs a review.', 4);
    sayClip('c', 'Tests pass.', 2);
    sayClip('d', 'Never played.', 2);
    sayClip('e', 'Also never played.', 3);
    const ev = (e: Record<string, unknown>) => log.recordUi('sess', { timestamp: 't', sessionId: 'sess', platform: 'linux', ...e });
    ev({ type: 'lucy_clip_started', clipId: 'a', trigger: 'click', panelState: 'open', tabVisible: true });
    ev({ type: 'lucy_clip_started', clipId: 'b', trigger: 'click', panelState: 'open', tabVisible: true });
    ev({ type: 'lucy_clip_started', clipId: 'c', trigger: 'click', panelState: 'open', tabVisible: true });
    ev({ type: 'lucy_clip_ended', clipId: 'a', endedBy: 'user_stop', playedMs: 100, totalMs: 1000 });
    ev({ type: 'lucy_clip_ended', clipId: 'b', endedBy: 'finished', playedMs: 1000, totalMs: 1000 });
    ev({ type: 'lucy_clip_unheard', clipId: 'd', reason: 'muted' });
    await log.flush();

    const s = await summarizeLucyInteractionFiles(base, { days: 7, now: NOW });
    expect(s.corruptLines).toBe(0);
    expect(s.said.count).toBe(5);
    expect(s.ui.clipsStarted).toBe(3);
    expect(s.ui.clipsEnded).toBe(2);
    expect(s.ui.earlyStops).toEqual({ count: 1, rate: 0.5 });
    expect(s.ui.unheard).toEqual({ count: 1, rate: 0.25, byReason: { muted: 1 } });
    expect(s.topEarlyStopped).toEqual([{ text: 'Fix login is done.', earlyStops: 1 }]);
    expect(s.earlyStopsWithoutText).toBe(0);
  });

  it('honours the rotatedGenerations option', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lucy-sum-'));
    dirs.push(dir);
    const base = join(dir, 'lucy-interactions.jsonl');
    writeFileSync(`${base}.2`, `${said('a')}\n`);
    writeFileSync(`${base}.1`, `${said('b')}\n`);
    writeFileSync(base, `${said('c')}\n`);
    const one = await summarizeLucyInteractionFiles(base, { days: 7, now: NOW, rotatedGenerations: 1 });
    expect(one.said.count).toBe(2);
    expect(one.filesRead).toBe(2);
    const two = await summarizeLucyInteractionFiles(base, { days: 7, now: NOW, rotatedGenerations: 2 });
    expect(two.said.count).toBe(3);
  });

  it('keeps going and warns when one generation cannot be read (non-ENOENT)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'lucy-sum-'));
    dirs.push(dir);
    const base = join(dir, 'lucy-interactions.jsonl');
    mkdirSync(`${base}.1`); // reading a directory fails with EISDIR
    writeFileSync(`${base}.2`, `${said('a')}\n`);
    writeFileSync(base, `${said('c')}\n`);
    const s = await summarizeLucyInteractionFiles(base, { days: 7, now: NOW });
    expect(s.said.count).toBe(2);
    expect(s.filesRead).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('could not read');
  });

  it('streams rotated generations plus the live file and skips missing ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lucy-sum-'));
    dirs.push(dir);
    const base = join(dir, 'lucy-interactions.jsonl');
    writeFileSync(`${base}.2`, `${said('a', { words: 4 })}\n`);
    writeFileSync(`${base}.1`, `${said('b', { words: 8 })}\ngarbage\n`);
    writeFileSync(base, `${said('c', { words: 12 })}\n`);
    const s = await summarizeLucyInteractionFiles(base, { days: 7, now: NOW });
    expect(s.filesRead).toBe(3);
    expect(s.said.count).toBe(3);
    expect(s.said.meanWords).toBe(8);
    expect(s.corruptLines).toBe(1);
  });

  it('returns an empty summary when no log exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lucy-sum-'));
    dirs.push(dir);
    const s = await summarizeLucyInteractionFiles(join(dir, 'nope.jsonl'), { days: 7, now: NOW });
    expect(s.filesRead).toBe(0);
    expect(s.said.count).toBe(0);
  });
});
