'use strict';

/**
 * Save opt-in audio/transcript pairs for later evaluation. Each completed record
 * becomes visible in one rename; capture failures never interrupt dictation.
 * Human reference text is deliberately separate from the model's transcript.
 */
const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const { homedir } = require('node:os');
const path = require('node:path');

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_PENDING_WRITES = 4;
const DISK_RESERVE_BYTES = 1024n * 1024n * 1024n; // Leave one GiB free for the application.
const FORMATS = new Set(['wav', 'ogg', 'mp3', 'mp4', 'm4a', 'webm', 'flac', 'aac', 'bin']);

function getCorpusConfig(env = process.env) {
  const enabled = env.KOOKR_STT_CORPUS === 'true';
  const directory = env.KOOKR_STT_CORPUS_DIR || path.join(homedir(), '.kookr', 'stt-corpus');
  if (enabled && !path.isAbsolute(directory)) {
    throw new Error('KOOKR_STT_CORPUS_DIR must be an absolute path');
  }
  const configId = createHash('sha256').update(JSON.stringify({ enabled, directory })).digest('hex');
  return { enabled, directory, configId };
}

function plainObject(value) {
  return value !== null && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validMetadata(metadata) {
  return plainObject(metadata)
    && (metadata.source === 'browser' || metadata.source === 'telegram')
    && (metadata.transcript === null || typeof metadata.transcript === 'string')
    && (metadata.status === 'success' || metadata.status === 'error')
    && plainObject(metadata.model)
    && typeof metadata.language === 'string'
    && typeof metadata.startedAt === 'string'
    && Number.isFinite(Date.parse(metadata.startedAt))
    && (metadata.durationSeconds === null || (Number.isFinite(metadata.durationSeconds) && metadata.durationSeconds >= 0))
    && Number.isFinite(metadata.elapsedMs) && metadata.elapsedMs >= 0;
}

/** Create a private corpus directory, or reject an unsafe existing location. */
async function ensureCorpusDirectory(directory, options = {}) {
  const io = { ...fs, ...options.fileSystem };
  await io.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await io.lstat(directory);
  const wrongOwner = typeof process.getuid === 'function' && stat.uid !== process.getuid();
  // Do not change permissions on an arbitrary existing configured directory.
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || wrongOwner) {
    throw new Error('corpus_directory_not_private');
  }
}

function createTranscriptionCorpus(options = {}) {
  const config = getCorpusConfig(options.env);
  const io = { ...fs, ...options.fileSystem };
  const logger = options.logger ?? console;
  const counts = { written: 0, skipped: 0, failed: 0 };
  let pending = 0;
  let tail = Promise.resolve();

  function diagnostic(code) {
    // Filesystem errors can contain paths or input data. Log only fixed codes.
    try { logger.warn(`[stt-corpus] ${code}`); } catch { /* Logging must not affect transcription. */ }
  }

  function skip(code) {
    counts.skipped++;
    diagnostic(code);
    return Promise.resolve(null);
  }

  async function persist(record) {
    let temporary;
    try {
      const id = randomUUID();
      const recordedAt = new Date().toISOString();
      const dateDirectory = path.join(config.directory, recordedAt.slice(0, 10));
      const destination = path.join(dateDirectory, id);
      const filename = `audio.${record.format}`;
      const document = JSON.stringify({
        schemaVersion: 1,
        id,
        recordedAt,
        metadata: record.metadata,
        audio: {
          filename,
          bytes: record.audio.length,
          sha256: createHash('sha256').update(record.audio).digest('hex'),
        },
        reference: null,
      }, null, 2) + '\n';

      await ensureCorpusDirectory(config.directory, { fileSystem: io });
      const disk = await io.statfs(config.directory, { bigint: true });
      const requiredBytes = BigInt(record.audio.length + Buffer.byteLength(document));
      if (BigInt(disk.bavail) * BigInt(disk.bsize) - requiredBytes < DISK_RESERVE_BYTES) {
        return await skip('corpus_disk_reserve');
      }
      await ensureCorpusDirectory(dateDirectory, { fileSystem: io });
      const pendingDirectory = path.join(dateDirectory, `.pending-${id}`);
      await io.mkdir(pendingDirectory, { mode: 0o700 });
      temporary = pendingDirectory;
      await io.writeFile(path.join(temporary, filename), record.audio, { mode: 0o600, flag: 'wx' });
      await io.writeFile(path.join(temporary, 'record.json'), document, { mode: 0o600, flag: 'wx' });
      await io.rename(temporary, destination);
      temporary = undefined;
      counts.written++;
      return path.join(destination, 'record.json');
    } catch {
      counts.failed++;
      diagnostic('corpus_write_failed');
      return null;
    } finally {
      if (temporary) {
        try { await io.rm(temporary, { recursive: true, force: true }); }
        catch { diagnostic('corpus_cleanup_failed'); }
      }
    }
  }

  function write(record) {
    if (!config.enabled) return Promise.resolve(null);
    if (pending >= MAX_PENDING_WRITES) return skip('corpus_queue_full');
    let snapshot;
    try {
      if (!record || !Buffer.isBuffer(record.audio) || !FORMATS.has(record.format) || !validMetadata(record.metadata)) {
        return skip('corpus_invalid_record');
      }
      if (record.audio.length > MAX_AUDIO_BYTES) return skip('corpus_audio_too_large');
      const metadata = JSON.stringify(record.metadata);
      if (Buffer.byteLength(metadata) > MAX_METADATA_BYTES) return skip('corpus_metadata_too_large');
      const storedMetadata = JSON.parse(metadata);
      if (!validMetadata(storedMetadata)) return skip('corpus_invalid_record');
      // Callers may release or reuse their buffers immediately after submission.
      snapshot = { audio: Buffer.from(record.audio), format: record.format, metadata: storedMetadata };
    } catch {
      return skip('corpus_invalid_record');
    }
    pending++;
    const result = tail.then(() => persist(snapshot)).finally(() => { pending--; });
    tail = result.then(() => undefined);
    return result;
  }

  return { ...config, write, flush: () => tail, stats: () => ({ ...counts }) };
}

module.exports = { getCorpusConfig, ensureCorpusDirectory, createTranscriptionCorpus };
