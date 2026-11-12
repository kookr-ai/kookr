// Parity between the rules Kookr's notebook scripts copy by hand and the
// installed `agent-notebook` package.
//
// The scripts plan moves before running them, so they re-implement a few of the
// package's rules: how a shelf file is split into lines, which line is a
// description, what a lesson's text and id are, which shelf names are valid and
// what the per-shelf cap is. Each copy is right only for the package version it
// was written against. agent-notebook 0.8.0 changed four of them (CRLF line
// ends, a leading byte-order mark, invisible characters dropped from a lesson,
// whole-integer `NB_MAX_LINES`) and every copy went silently wrong.
//
// This file compares each copy with the package itself on generated inputs, so
// the next version bump that changes a rule fails here instead of in a script
// run. The generator is seeded: a failure names an input that reproduces.
import { afterAll, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pkg from 'agent-notebook';
import { hasDescription } from '../apply-shelf-descriptions.mjs';
import { parseShelfText } from './nb-client.mjs';
import { dedupKey, entryId, maxLines, shelfNameProblem } from './nb-sim.mjs';

/**
 * A small deterministic generator, so a reported input can be reproduced.
 * `Math.imul` keeps the multiplication in 32 bits (a plain `*` overflows what a
 * double holds exactly and the sequence collapses), and the result is taken from
 * the high bits because the low bits of this kind of generator barely vary.
 */
function makeRandom(seed: number): (n: number) => number {
  let state = seed;
  return (n) => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return (state >>> 16) % n;
  };
}

/** A generated input with every non-ASCII or control character spelled out, for a readable failure message. */
function show(input: string): string {
  return JSON.stringify(input).replace(/[^\x20-\x7e]/gu, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

// Text fragments chosen to hit the rules that have changed or could: case,
// punctuation, non-ASCII letters, emoji joined by U+200D (which nb keeps), and
// the invisible characters nb drops (soft hyphen, zero-width space, word joiner,
// byte-order mark, bidi controls, C0/C1 controls, a Unicode Tag character).
const TEXT_ATOMS = [
  'a', 'B', 'z', '0', '9', ' ', '  ', '\t', '.', ',', '-', '_', '@', '!', '?', '(', ')', '"', "'", '/', '\\',
  'é', 'É', 'ß', '中', '😀', '👨\u200d👩\u200d👧', '\u00ad', '\u200b', '\u200d', '\u2060', '\ufeff', '\u202e', '\u2066',
  '\u0001', '\u001b', '\u007f', '\u009b', '\u000b', '\u000c', '\u00a0', '\u2028', '\u{E0041}', '#', '+', '1',
  'desc:', 'key:', 'foo', 'bar', 'Lesson', '\u0301',
];

function text(random: (n: number) => number, maxAtoms: number): string {
  let out = '';
  const count = random(maxAtoms) + 1;
  for (let i = 0; i < count; i++) out += TEXT_ATOMS[random(TEXT_ATOMS.length)];
  return out;
}

describe('hand-copied nb rules agree with the installed agent-notebook', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nb-parity-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('duplicate key and lesson id', () => {
    const random = makeRandom(1);
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const t = text(random, 8);
      seen.add(t);
      expect(dedupKey(t), show(t)).toBe(pkg.dedupKey(t));
      expect(entryId(t), show(t)).toBe(pkg.entryId(t));
    }
    expect(seen.size).toBeGreaterThan(3000); // the generator really varies
  });

  test('shelf-name validity', () => {
    const random = makeRandom(2);
    const atoms = ['a', 'Z', '0', '.', '..', '_', '@', '-', 'con', 'nul', 'readme', 'README', 'com1', 'x'.repeat(60), ' ', '/', 'é', ''];
    let valid = 0;
    for (let i = 0; i < 5000; i++) {
      let name = '';
      const count = random(5) + 1;
      for (let j = 0; j < count; j++) name += atoms[random(atoms.length)];
      expect(shelfNameProblem(name) === null, show(name)).toBe(pkg.isValidShelfName(name));
      if (pkg.isValidShelfName(name)) valid++;
    }
    // Both outcomes must occur, or the comparison proves nothing.
    expect(valid).toBeGreaterThan(200);
    expect(valid).toBeLessThan(4800);
  });

  test('per-shelf cap from NB_MAX_LINES', () => {
    // The package's own default and bounds for the cap, so a change to them is caught too.
    const { dflt, lo, hi } = pkg.MAX_LINES;
    const values = ['60', '60.5', '1e3', '60abc', ' 12 ', '+7', '-3', '0', '007', '999999', '', '  ', '6 0', '٣', '0x10', '1_000', '+', '-', '+-3', '9'.repeat(400)];
    for (const raw of values) {
      expect(maxLines({ NB_MAX_LINES: raw }), show(raw)).toBe(pkg.resolveIntEnv(raw, dflt, lo, hi).value);
    }
    expect(maxLines({})).toBe(pkg.resolveIntEnv(undefined, dflt, lo, hi).value);
  });

  test('a shelf file: its lessons (id and score, in file order) and whether it is described', () => {
    const random = makeRandom(3);
    const lineEnds = ['\n', '\r\n', '\r', '\n\n'];
    // What the generator produced, so a generator that stops covering a case fails
    // the test instead of passing with nothing checked.
    const produced = { crlf: 0, byteOrderMark: 0, severalLessons: 0, invisibleInWord: 0, described: 0 };
    for (let i = 0; i < 1500; i++) {
      // A byte-order mark at the start of some files, and a second one in a few.
      let body = random(6) === 0 ? '\ufeff' : '';
      if (random(40) === 0) body += '\ufeff';
      const lines = random(8) + 1;
      for (let j = 0; j < lines; j++) {
        const kind = random(10);
        let line: string;
        if (kind === 0) line = `# desc: ${text(random, 4)}`;
        else if (kind === 1) line = `#${['', ' ', '  ', '\t'][random(4)]}${['desc', 'role', 'x1'][random(3)]}:${['', ' '][random(2)]}${text(random, 3)}`;
        else if (kind === 2) line = '';
        else if (kind === 3) line = text(random, 5); // a hand-edited line with no score
        else if (kind === 4) line = `# ${text(random, 3)}`;
        else line = `${['+', '-', ''][random(3)]}${random(12)}\t${text(random, 6)}`;
        const last = j === lines - 1;
        body += line + (last && random(3) === 0 ? '' : lineEnds[random(10) < 7 ? 0 : random(lineEnds.length)]);
      }
      writeFileSync(join(dir, 's.md'), body);

      const fromNb = pkg.readShelf(dir, 's');
      const nbLessons = fromNb.entries.map((e) => `${pkg.entryId(e.text)}:${e.score}`);
      const ours = parseShelfText(body).map((e) => `${e.id}:${e.score}`);
      expect(ours, show(body)).toEqual(nbLessons);
      if (body.includes('\r\n')) produced.crlf++;
      if (body.startsWith('\ufeff')) produced.byteOrderMark++;
      if (nbLessons.length >= 2) produced.severalLessons++;
      if (/[a-z0-9][\u00ad\u200b\u2060\u202e\u2066\u0001\u001b\u007f\u009b][a-z0-9]/i.test(body)) produced.invisibleInWord++;

      // The description seeder must never take a shelf nb reads as described for an
      // undescribed one: that is the case where it would overwrite the description.
      // Only that direction is checked. The seeder may call a shelf described when nb
      // does not (a description made only of characters nb drops, for example); it
      // then leaves the shelf alone, which loses nothing.
      const row = pkg.listNotebooks(dir).rows.find((r) => r.shelf === 's');
      if (row && typeof row.desc === 'string' && row.desc.trim() !== '') {
        produced.described++;
        expect(hasDescription(join(dir, 's.md')), show(body)).toBe(true);
      }
    }
    expect(produced.crlf).toBeGreaterThan(100);
    expect(produced.byteOrderMark).toBeGreaterThan(100);
    expect(produced.severalLessons).toBeGreaterThan(300);
    expect(produced.invisibleInWord).toBeGreaterThan(20);
    expect(produced.described).toBeGreaterThan(100);
  });
});
