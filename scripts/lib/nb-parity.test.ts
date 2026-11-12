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

/** A small deterministic generator, so a reported input can be reproduced. */
function makeRandom(seed: number): (n: number) => number {
  let state = seed;
  return (n) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state % n;
  };
}

// Text fragments chosen to hit the rules that have changed or could: case,
// punctuation, non-ASCII letters, emoji joined by U+200D (which nb keeps), and
// the invisible characters nb drops (soft hyphen, zero-width space, word joiner,
// byte-order mark, bidi controls, C0/C1 controls, a Unicode Tag character).
const TEXT_ATOMS = [
  'a', 'B', 'z', '0', '9', ' ', '  ', '\t', '.', ',', '-', '_', '@', '!', '?', '(', ')', '"', "'", '/', '\\',
  'é', 'É', 'ß', '中', '😀', '👨‍👩‍👧', '­', '​', '‍', '⁠', '﻿', '‮', '⁦',
  '\u0001', '\u001b', '\u007f', '\u009b', '\u000b', '\u000c', ' ', ' ', '\u{E0041}', '#', '+', '1',
  'desc:', 'key:', 'foo', 'bar', 'Lesson', '́',
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
    for (let i = 0; i < 5000; i++) {
      const t = text(random, 8);
      expect(dedupKey(t), JSON.stringify(t)).toBe(pkg.dedupKey(t));
      expect(entryId(t), JSON.stringify(t)).toBe(pkg.entryId(t));
    }
  });

  test('shelf-name validity', () => {
    const random = makeRandom(2);
    const atoms = ['a', 'Z', '0', '.', '..', '_', '@', '-', 'con', 'nul', 'readme', 'README', 'com1', 'x'.repeat(60), ' ', '/', 'é', ''];
    for (let i = 0; i < 5000; i++) {
      let name = '';
      const count = random(5) + 1;
      for (let j = 0; j < count; j++) name += atoms[random(atoms.length)];
      expect(shelfNameProblem(name) === null, JSON.stringify(name)).toBe(pkg.isValidShelfName(name));
    }
  });

  test('per-shelf cap from NB_MAX_LINES', () => {
    const values = ['60', '60.5', '1e3', '60abc', ' 12 ', '+7', '-3', '0', '007', '999999', '', '  ', '6 0', '٣', '0x10', '1_000', '+', '-', '+-3', '9'.repeat(400)];
    for (const raw of values) {
      expect(maxLines({ NB_MAX_LINES: raw }), JSON.stringify(raw)).toBe(pkg.resolveIntEnv(raw, 50, 1, 5000).value);
    }
    expect(maxLines({})).toBe(pkg.resolveIntEnv(undefined, 50, 1, 5000).value);
  });

  test('a shelf file: its lessons (id and score, in file order) and whether it is described', () => {
    const random = makeRandom(3);
    const lineEnds = ['\n', '\r\n', '\r', '\n\n'];
    let compared = 0;
    let described = 0;
    for (let i = 0; i < 1500; i++) {
      // A byte-order mark at the start of some files, and a second one in a few.
      let body = random(6) === 0 ? '﻿' : '';
      if (random(40) === 0) body += '﻿';
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
      expect(ours, JSON.stringify(body)).toEqual(nbLessons);
      compared++;

      // The description seeder must never take a shelf nb reads as described for an
      // undescribed one: that is the case where it would overwrite the description.
      const row = pkg.listNotebooks(dir).rows.find((r) => r.shelf === 's');
      if (row && typeof row.desc === 'string' && row.desc.trim() !== '') {
        described++;
        expect(hasDescription(join(dir, 's.md')), JSON.stringify(body)).toBe(true);
      }
    }
    // The generator must really produce both kinds of file, or the checks above prove nothing.
    expect(compared).toBe(1500);
    expect(described).toBeGreaterThan(100);
  });
});
