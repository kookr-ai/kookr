import { describe, expect, it } from 'vitest';
import { redactTranscriptLine, redactTranscriptText } from './redact-transcript-line.js';

const blob = (n: number) =>
  Array.from({ length: n }, (_, i) => 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+'[(i * 7 + (i >> 3)) % 38]).join('');

describe('redactTranscriptLine: leaks now redacted', () => {
  it('URL userinfo in DATABASE_URL', () => {
    const out = redactTranscriptLine('DATABASE_URL=postgres://user:pass@host/db');
    expect(out).not.toContain('pass');
    expect(out).toContain('[REDACTED]');
  });
  it('URL userinfo keeps scheme and host', () => {
    expect(redactTranscriptLine('see postgres://user:pass@host/db now')).toBe(
      'see postgres://[REDACTED]@host/db now',
    );
  });
  it('empty-user redis URL', () => {
    const out = redactTranscriptLine('redis://:hunter2@cache:6379/0');
    expect(out).toBe('redis://[REDACTED]@cache:6379/0');
  });
  it('AWS_SECRET_ACCESS_KEY assignment', () => {
    const out = redactTranscriptLine('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI');
    expect(out).toBe('AWS_SECRET_ACCESS_KEY=[REDACTED]');
  });
  it('quoted export DB_PASSWORD', () => {
    const out = redactTranscriptLine('export DB_PASSWORD="hunter2"');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('[REDACTED]');
  });
  it('colon-style assignment', () => {
    expect(redactTranscriptLine('MY_SECRET_VALUE: abc123xyz')).not.toContain('abc123xyz');
  });
  it('curl -u and --user', () => {
    expect(redactTranscriptLine('curl -u admin:s3cretpw https://x')).toBe('curl -u [REDACTED] https://x');
    expect(redactTranscriptLine('curl --user admin:s3cretpw https://x')).not.toContain('s3cretpw');
    expect(redactTranscriptLine("curl -u 'admin:s3 cret' https://x")).not.toContain('cret');
  });
  it('long base64 blob', () => {
    const b = blob(120);
    const out = redactTranscriptLine(`data: ${b}==`);
    expect(out).toBe('data: [REDACTED]');
  });
});

describe('redactTranscriptLine: benign text preserved', () => {
  const benign = [
    'the KEY takeaway is',
    'hello',
    'The quick brown fox jumps over the lazy dog.',
    '550e8400-e29b-41d4-a716-446655440000',
    'https://example.com/path?q=1',
    'ls -u foo:bar',
    'sha 9fceb02d0ae598e95dc970b74767f19372d61af8a1b2c3d4e5f60718293a4b5c',
    '/usr/local/lib/node_modules/some-package/dist/very/long/nested/path/to/a/file/index/main/x',
  ];
  for (const b of benign) {
    it(`keeps: ${b.slice(0, 40)}`, () => expect(redactTranscriptLine(b)).toBe(b));
  }
});

describe('redactTranscriptLine: performance', () => {
  const cases: Record<string, string> = {
    'plain a': 'a'.repeat(200_000),
    'dotted': 'a.'.repeat(100_000),
    'keywords': 'key'.repeat(70_000),
    'colons after scheme': 'x://' + ':'.repeat(200_000),
    'repeated scheme': 'a://'.repeat(50_000),
    'spaces': 'token' + ' '.repeat(200_000),
    'base64': blob(200_000),
  };
  for (const [name, line] of Object.entries(cases)) {
    it(`200k ${name} in well under 200ms`, () => {
      const t = performance.now();
      redactTranscriptLine(line);
      const ms = performance.now() - t;
      console.log(`perf ${name}: ${ms.toFixed(1)}ms`);
      expect(ms).toBeLessThan(200);
    });
  }
  it('caps overlong line', () => {
    expect(redactTranscriptLine('a '.repeat(150_000)).length).toBeLessThan(100_100);
  });
});

describe('redactTranscriptText', () => {
  it('redacts per line', () => {
    expect(redactTranscriptText('ok\nAPI_TOKEN=abc\nfine')).toBe('ok\n[REDACTED]\nfine');
  });
});
