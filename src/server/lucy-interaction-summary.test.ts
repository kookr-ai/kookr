import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(s.ui.replays).toEqual({ count: 1, rate: 0.3333 });
    expect(s.ui.clipsEnded).toBe(4);
    expect(s.ui.earlyStops).toEqual({ count: 1, rate: 0.25 });
    expect(s.ui.unheard).toEqual({ count: 1, rate: 0.25, byReason: { muted: 1 } });
    expect(s.ui.panelActions).toEqual({ minimize: 2, move: 1 });
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
