import { afterEach, describe, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTranscriptionCorpus, getCorpusConfig } from './transcription-corpus.cjs';

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(options = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'kookr-corpus-'));
  temporaryDirectories.push(directory);
  const corpusDirectory = path.join(directory, 'corpus');
  const logger = { warn: vi.fn() };
  const corpus = createTranscriptionCorpus({
    env: { KOOKR_STT_CORPUS: 'true', KOOKR_STT_CORPUS_DIR: corpusDirectory },
    logger,
    ...options,
  });
  return { corpus, directory, corpusDirectory, logger };
}

function record(overrides = {}) {
  return {
    audio: Buffer.from('original audio bytes'),
    format: 'ogg',
    metadata: {
      source: 'telegram',
      transcript: 'Ouvre Kookr.',
      status: 'success',
      model: { backend: 'qwen', id: 'Qwen/Qwen3-ASR-0.6B' },
      language: 'fr',
      startedAt: '2026-09-26T10:12:00.000Z',
      durationSeconds: 3.5,
      elapsedMs: 700,
    },
    ...overrides,
  };
}

describe('transcription corpus configuration', () => {
  test.each(['false', '1', 'TRUE', '', undefined])('requires explicit true rather than %s', (value) => {
    expect(getCorpusConfig({ KOOKR_STT_CORPUS: value }).enabled).toBe(false);
  });

  test('rejects relative paths only when enabled and fingerprints configuration', () => {
    expect(() => getCorpusConfig({ KOOKR_STT_CORPUS: 'true', KOOKR_STT_CORPUS_DIR: 'relative' })).toThrow('absolute path');
    expect(() => getCorpusConfig({ KOOKR_STT_CORPUS_DIR: 'relative' })).not.toThrow();
    const env = { KOOKR_STT_CORPUS: 'true', KOOKR_STT_CORPUS_DIR: path.join(tmpdir(), 'corpus') };
    const config = getCorpusConfig(env);
    expect(config.configId).toMatch(/^[a-f0-9]{64}$/);
    expect(getCorpusConfig(env)).toEqual(config);
    expect(getCorpusConfig({ ...env, KOOKR_STT_CORPUS: 'false' }).configId).not.toBe(config.configId);
    expect(getCorpusConfig({ ...env, KOOKR_STT_CORPUS_DIR: path.join(tmpdir(), 'other') }).configId).not.toBe(config.configId);
  });

  test('disabled capture performs no filesystem operations or logging', async () => {
    const io = Object.fromEntries(['mkdir', 'lstat', 'statfs', 'writeFile', 'rename', 'rm'].map((name) => [name, vi.fn()]));
    const { corpus, directory, logger } = await fixture({ env: { KOOKR_STT_CORPUS: 'false' }, fileSystem: io });
    expect(await corpus.write(record())).toBeNull();
    await corpus.flush();
    expect(await fs.readdir(directory)).toEqual([]);
    for (const method of Object.values(io)) expect(method).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(corpus.stats()).toEqual({ written: 0, skipped: 0, failed: 0 });
  });
});

describe('transcription corpus persistence', () => {
  test('preserves audio and metadata in a private completed record with no invented reference', async () => {
    const { corpus, corpusDirectory } = await fixture();
    const input = record();
    const expectedAudio = Buffer.from(input.audio);
    const result = corpus.write(input);
    input.audio.fill(0);
    input.metadata.transcript = 'Changed after submission';
    const recordPath = await result;
    const saved = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    const recordDirectory = path.dirname(recordPath);
    expect(saved).toMatchObject({
      schemaVersion: 1,
      metadata: { source: 'telegram', transcript: 'Ouvre Kookr.', status: 'success' },
      audio: { filename: 'audio.ogg', bytes: expectedAudio.length, sha256: createHash('sha256').update(expectedAudio).digest('hex') },
      reference: null,
    });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(path.basename(recordDirectory)).toBe(saved.id);
    expect(path.basename(path.dirname(recordDirectory))).toBe(saved.recordedAt.slice(0, 10));
    expect(await fs.readFile(path.join(recordDirectory, saved.audio.filename))).toEqual(expectedAudio);
    for (const directory of [corpusDirectory, path.dirname(recordDirectory), recordDirectory]) {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    }
    for (const filename of ['record.json', saved.audio.filename]) {
      expect((await fs.stat(path.join(recordDirectory, filename))).mode & 0o777).toBe(0o600);
    }
    expect(corpus.stats()).toEqual({ written: 1, skipped: 0, failed: 0 });
  });

  test('parallel submissions have unique complete records and flush waits for all admitted writes', async () => {
    const { corpus } = await fixture();
    const results = Array.from({ length: 4 }, () => corpus.write(record()));
    await corpus.flush();
    const paths = await Promise.all(results);
    expect(new Set(paths).size).toBe(4);
    expect(paths.every(Boolean)).toBe(true);
    expect(corpus.stats()).toEqual({ written: 4, skipped: 0, failed: 0 });
  });

  test('retains failed browser attempts without treating an absent transcript as a reference', async () => {
    const { corpus } = await fixture();
    const input = record({ format: 'wav', metadata: {
      ...record().metadata,
      source: 'browser',
      status: 'error',
      transcript: null,
      durationSeconds: null,
      errorCode: 'inference_timeout',
    } });
    const saved = JSON.parse(await fs.readFile(await corpus.write(input), 'utf8'));
    expect(saved.metadata).toEqual(input.metadata);
    expect(saved.reference).toBeNull();
  });

  test('publishes the audio and metadata together only after both files are written', async () => {
    const rename = vi.fn(async (from, to) => {
      expect(path.basename(from)).toMatch(/^\.pending-/);
      expect((await fs.readdir(from)).sort()).toEqual(['audio.ogg', 'record.json']);
      await expect(fs.stat(to)).rejects.toMatchObject({ code: 'ENOENT' });
      return fs.rename(from, to);
    });
    const { corpus } = await fixture({ fileSystem: { rename } });
    expect(await corpus.write(record())).not.toBeNull();
    expect(rename).toHaveBeenCalledOnce();
  });

  test('a write failure removes temporary files, hides error details, and allows the next write', async () => {
    let fail = true;
    const writeFile = vi.fn(async (filename, data, options) => {
      if (fail && path.basename(filename) === 'record.json') {
        fail = false;
        throw new Error('private path and secret transcript');
      }
      return fs.writeFile(filename, data, options);
    });
    const { corpus, corpusDirectory, logger } = await fixture({ fileSystem: { writeFile } });
    const results = await Promise.all([corpus.write(record()), corpus.write(record())]);
    expect(results[0]).toBeNull();
    expect(results[1]).not.toBeNull();
    const dates = await fs.readdir(corpusDirectory);
    expect(await fs.readdir(path.join(corpusDirectory, dates[0]))).toEqual([path.basename(path.dirname(results[1]))]);
    expect(logger.warn.mock.calls).toEqual([['[stt-corpus] corpus_write_failed']]);
    expect(corpus.stats()).toEqual({ written: 1, skipped: 0, failed: 1 });
  });

  test('refuses a shared directory without changing its permissions', async () => {
    const { corpus, corpusDirectory } = await fixture();
    await fs.mkdir(corpusDirectory, { mode: 0o755 });
    await fs.chmod(corpusDirectory, 0o755);
    expect(await corpus.write(record())).toBeNull();
    expect((await fs.stat(corpusDirectory)).mode & 0o777).toBe(0o755);
    expect(await fs.readdir(corpusDirectory)).toEqual([]);
  });

  test('refuses a symlink used as the corpus directory', async () => {
    const { corpus, corpusDirectory, directory } = await fixture();
    const target = path.join(directory, 'target');
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, corpusDirectory);
    expect(await corpus.write(record())).toBeNull();
    expect(await fs.readdir(target)).toEqual([]);
  });

  test('refuses a directory owned by another user', async () => {
    const lstat = async (...args) => {
      const stat = await fs.lstat(...args);
      stat.uid = process.getuid() + 1;
      return stat;
    };
    const { corpus, corpusDirectory } = await fixture({ fileSystem: { lstat } });
    expect(await corpus.write(record())).toBeNull();
    expect(await fs.readdir(corpusDirectory)).toEqual([]);
  });
});

describe('transcription corpus resource limits', () => {
  test('caps pending and active writes at four and accepts new writes after draining', async () => {
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const statfs = vi.fn(async (...args) => { await barrier; return fs.statfs(...args); });
    const { corpus, logger } = await fixture({ fileSystem: { statfs } });
    const accepted = Array.from({ length: 4 }, () => corpus.write(record()));
    expect(await corpus.write(record())).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith('[stt-corpus] corpus_queue_full');
    release();
    expect((await Promise.all(accepted)).every(Boolean)).toBe(true);
    expect(await corpus.write(record())).not.toBeNull();
    expect(corpus.stats()).toEqual({ written: 5, skipped: 1, failed: 0 });
  });

  test('rejects oversized audio before touching the filesystem', async () => {
    const { corpus, directory, logger } = await fixture();
    expect(await corpus.write(record({ audio: Buffer.alloc(25 * 1024 * 1024 + 1) }))).toBeNull();
    expect(await fs.readdir(directory)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith('[stt-corpus] corpus_audio_too_large');
  });

  test('preserves one GiB free including the incoming record size', async () => {
    const statfs = vi.fn(async () => ({ bavail: 1024n * 1024n * 1024n, bsize: 1n }));
    const { corpus, corpusDirectory, logger } = await fixture({ fileSystem: { statfs } });
    expect(await corpus.write(record())).toBeNull();
    expect(await fs.readdir(corpusDirectory)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith('[stt-corpus] corpus_disk_reserve');
    expect(corpus.stats()).toEqual({ written: 0, skipped: 1, failed: 0 });
  });

  test('filesystem availability failures remain isolated even if the logger throws', async () => {
    const { corpus } = await fixture({
      fileSystem: { statfs: async () => { throw new Error('private filesystem details'); } },
      logger: { warn: () => { throw new Error('logger unavailable'); } },
    });
    await expect(corpus.write(record())).resolves.toBeNull();
    await expect(corpus.flush()).resolves.toBeUndefined();
    expect(corpus.stats().failed).toBe(1);
  });

  test.each([
    { format: '../record.json' },
    { audio: 'not a buffer' },
    { metadata: { source: 'unknown' } },
    { metadata: { ...record().metadata, elapsedMs: Infinity } },
  ])('rejects invalid inputs without creating artifacts: %j', async (override) => {
    const { corpus, directory } = await fixture();
    expect(await corpus.write(record(override))).toBeNull();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  test('rejects non-JSON and oversized metadata without propagating serialization failures', async () => {
    const { corpus, directory, logger } = await fixture();
    const circular = record();
    circular.metadata.loop = circular.metadata;
    expect(await corpus.write(circular)).toBeNull();
    const changedBySerialization = record();
    changedBySerialization.metadata.toJSON = () => ({ unrelated: true });
    expect(await corpus.write(changedBySerialization)).toBeNull();
    expect(await corpus.write(record({ metadata: { ...record().metadata, context: 'x'.repeat(256 * 1024) } }))).toBeNull();
    expect(await fs.readdir(directory)).toEqual([]);
    expect(logger.warn.mock.calls).toEqual([
      ['[stt-corpus] corpus_invalid_record'], ['[stt-corpus] corpus_invalid_record'], ['[stt-corpus] corpus_metadata_too_large'],
    ]);
  });
});
