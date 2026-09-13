import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createGzip, gunzipSync } from 'node:zlib';
import { createReadStream, createWriteStream, write } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  CRASH_CONSISTENCY_CONTRACT,
  MANIFEST_NAME,
  createMaintenanceBackup,
  type MaintenanceBackupManifest,
} from './maintenance-backup.js';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, createReadStream: vi.fn(fs.createReadStream), createWriteStream: vi.fn(fs.createWriteStream) };
});

vi.mock('node:zlib', async (importOriginal) => {
  const zlib = await importOriginal<typeof import('node:zlib')>();
  return { ...zlib, createGzip: vi.fn(zlib.createGzip) };
});

const NOW = new Date('2026-06-13T14:05:06.000Z');
const execFileAsync = promisify(execFile);

interface TarEntry {
  name: string;
  type: string;
  size: number;
  contents: Buffer;
}

function readTarString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? raw.length : nul).toString('utf8');
}

function readTarOctal(block: Buffer, offset: number, length: number): number {
  const raw = readTarString(block, offset, length).trim();
  return raw === '' ? 0 : Number.parseInt(raw, 8);
}

async function readTarGz(path: string): Promise<TarEntry[]> {
  const tar = gunzipSync(await readFile(path));
  const entries: TarEntry[] = [];
  for (let offset = 0; offset < tar.length; offset += 512) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const size = readTarOctal(header, 124, 12);
    const type = readTarString(header, 156, 1) || '0';
    const contentsStart = offset + 512;
    const contentsEnd = contentsStart + size;
    entries.push({
      name: prefix ? `${prefix}/${name}` : name,
      type,
      size,
      contents: tar.subarray(contentsStart, contentsEnd),
    });
    offset = contentsStart + Math.ceil(size / 512) * 512 - 512;
  }
  return entries;
}

describe('createMaintenanceBackup', () => {
  let tempRoot: string;
  let dataDir: string;
  let outDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'kookr-maint-backup-'));
    dataDir = join(tempRoot, 'data');
    outDir = join(tempRoot, 'backups');
    await mkdir(join(dataDir, 'hooks'), { recursive: true });
    await writeFile(join(dataDir, 'tasks.json'), '{"version":2,"tasks":[]}\n', 'utf8');
    await writeFile(join(dataDir, 'hooks', 'kookr-one.jsonl'), '{"event":"Stop"}\n', 'utf8');
    await mkdir(join(dataDir, 'empty-dir'), { recursive: true });
    await utimes(join(dataDir, 'tasks.json'), NOW, NOW);
    await utimes(join(dataDir, 'hooks', 'kookr-one.jsonl'), NOW, NOW);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const exists = async (path: string): Promise<boolean> =>
    stat(path).then(() => true).catch(() => false);

  test('creates a timestamped tarball with manifest and data tree', async () => {
    const result = await createMaintenanceBackup({ dataDir, outDir, now: () => NOW });

    expect(basename(result.backupPath)).toBe('kookr-backup-20260613T140506Z.tar.gz');
    expect(result.archiveBytes).toBeGreaterThan(0);
    expect((await stat(result.backupPath)).mode & 0o777).toBe(0o600);
    await expect(stat(result.backupPath)).resolves.toMatchObject({ size: result.archiveBytes });
    expect(result.manifest).toMatchObject({
      schemaVersion: 'maintenance-backup.v1',
      createdAt: NOW.toISOString(),
      dataDir: resolve(dataDir),
      crashConsistency: CRASH_CONSISTENCY_CONTRACT,
      archiveLayout: { manifest: MANIFEST_NAME, dataRoot: 'data/' },
    });
    expect(result.manifest.entries.map((entry) => entry.path)).toEqual([
      'empty-dir',
      'hooks',
      'hooks/kookr-one.jsonl',
      'tasks.json',
    ]);

    const entries = await readTarGz(result.backupPath);
    expect(entries.map((entry) => entry.name)).toEqual([
      MANIFEST_NAME,
      'data/',
      'data/empty-dir/',
      'data/hooks/',
      'data/hooks/kookr-one.jsonl',
      'data/tasks.json',
    ]);
    expect(entries.find((entry) => entry.name === 'data/tasks.json')?.contents.toString('utf8')).toBe(
      '{"version":2,"tasks":[]}\n',
    );

    const manifestEntry = entries.find((entry) => entry.name === MANIFEST_NAME);
    expect(manifestEntry?.type).toBe('0');
    const manifest = JSON.parse(manifestEntry?.contents.toString('utf8') ?? '') as MaintenanceBackupManifest;
    expect(manifest.totalEntries).toBe(4);
    expect(manifest.totalFileBytes).toBe(42);
    expect(manifest.excluded).toEqual([]);

    const list = await execFileAsync('tar', ['-tzf', result.backupPath]);
    expect(list.stdout.trim().split('\n')).toEqual([
      MANIFEST_NAME,
      'data/',
      'data/empty-dir/',
      'data/hooks/',
      'data/hooks/kookr-one.jsonl',
      'data/tasks.json',
    ]);
    const restoreDir = join(tempRoot, 'restore');
    await mkdir(restoreDir);
    await execFileAsync('tar', ['-xzf', result.backupPath, '-C', restoreDir]);
    await expect(readFile(join(restoreDir, 'data', 'tasks.json'), 'utf8')).resolves.toBe(
      '{"version":2,"tasks":[]}\n',
    );
    await expect(readFile(join(restoreDir, MANIFEST_NAME), 'utf8')).resolves.toContain(CRASH_CONSISTENCY_CONTRACT);
  });

  test('excludes a nested output directory instead of backing up older backups', async () => {
    const nestedOutDir = join(dataDir, 'backups');
    await mkdir(nestedOutDir, { recursive: true });
    await writeFile(join(nestedOutDir, 'old.tar.gz'), 'old backup\n', 'utf8');

    const result = await createMaintenanceBackup({ dataDir, outDir: nestedOutDir, now: () => NOW });

    expect(result.manifest.excluded).toEqual([{ path: 'backups', reason: 'backup-output-directory' }]);
    expect(result.manifest.entries.map((entry) => entry.path)).not.toContain('backups/old.tar.gz');
    const entries = await readTarGz(result.backupPath);
    expect(entries.map((entry) => entry.name)).not.toContain('data/backups/old.tar.gz');
  });

  test('rejects using the data directory itself as the output directory', async () => {
    await expect(createMaintenanceBackup({ dataDir, outDir: dataDir, now: () => NOW })).rejects.toThrow(
      /must not be the same as the data directory/,
    );
  });

  test('rejects an existing timestamped archive without crashing', async () => {
    const first = await createMaintenanceBackup({ dataDir, outDir, now: () => NOW });

    await expect(createMaintenanceBackup({ dataDir, outDir, now: () => NOW })).rejects.toThrow(
      /backup archive already exists/,
    );
    await expect(stat(first.backupPath)).resolves.toMatchObject({ size: first.archiveBytes });
  });

  test('aborts and removes the partial archive when a file changes after planning', async () => {
    const backupPath = join(outDir, 'kookr-backup-20260613T140506Z.tar.gz');

    await expect(
      createMaintenanceBackup({
        dataDir,
        outDir,
        now: () => NOW,
        beforeArchiveEntry: async (entry) => {
          if (entry.path === 'tasks.json') {
            await writeFile(join(dataDir, 'tasks.json'), '{}\n', 'utf8');
          }
        },
      }),
    ).rejects.toThrow(/file changed while backing up/);
    await expect(exists(backupPath)).resolves.toBe(false);
  });

  test('rejects a destination write failure during backpressure and closes every stream', async () => {
    const contents = randomBytes(2 * 1024 * 1024);
    await writeFile(join(dataDir, 'large.bin'), contents);
    const previous = await createMaintenanceBackup({ dataDir, outDir, now: () => new Date(NOW.getTime() - 1000) });
    const previousBytes = await readFile(previous.backupPath);
    const extracted = await readTarGz(previous.backupPath);
    expect(extracted.find((entry) => entry.name === 'data/large.bin')?.contents.equals(contents)).toBe(true);
    vi.clearAllMocks();

    const failure = Object.assign(new Error('ENOSPC: injected archive write failure'), { code: 'ENOSPC' });
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    let pendingWrite: (() => void) | undefined;
    let failedDuringBackpressure = false;
    let successfulWrites = 0;
    function failWhenBlocked(): void {
      const gzip = vi.mocked(createGzip).mock.results[0]?.value as ReturnType<typeof createGzip> | undefined;
      if (pendingWrite && gzip?.writableNeedDrain) {
        failedDuringBackpressure = true;
        const fail = pendingWrite;
        pendingWrite = undefined;
        fail();
      }
    }
    vi.mocked(createWriteStream).mockImplementationOnce((path, options) => fs.createWriteStream(path, {
      ...(typeof options === 'object' ? options : {}),
      fs: {
        ...fs,
        write(fd, buffer, offset, length, position, callback) {
          if (successfulWrites === 0) {
            write(fd, buffer, offset, length, position, (error, bytesWritten, data) => {
              if (!error) successfulWrites++;
              callback(error, bytesWritten, data);
            });
          } else {
            pendingWrite = () => callback(failure, 0, buffer);
            failWhenBlocked();
          }
        },
      },
    }));
    const zlib = await vi.importActual<typeof import('node:zlib')>('node:zlib');
    vi.mocked(createGzip).mockImplementationOnce((options) => {
      const gzip = zlib.createGzip(options);
      const originalWrite = gzip.write.bind(gzip);
      vi.spyOn(gzip, 'write').mockImplementation((...args: Parameters<typeof gzip.write>) => {
        const accepted = originalWrite(...args);
        // Defer the error until the producer has installed its drain listener.
        if (!accepted) queueMicrotask(failWhenBlocked);
        return accepted;
      });
      return gzip;
    });

    await expect(createMaintenanceBackup({ dataDir, outDir, now: () => NOW })).rejects.toBe(failure);
    expect(successfulWrites).toBe(1);
    expect(failedDuringBackpressure).toBe(true);
    const inputs = vi.mocked(createReadStream).mock.results.map((result) => result.value as ReturnType<typeof createReadStream>);
    expect(inputs.length).toBeGreaterThan(0);
    for (const stream of [...inputs, vi.mocked(createGzip).mock.results[0].value, vi.mocked(createWriteStream).mock.results[0].value]) {
      expect(stream.destroyed).toBe(true);
      expect(stream.closed).toBe(true);
    }
    await expect(exists(join(outDir, 'kookr-backup-20260613T140506Z.tar.gz'))).resolves.toBe(false);
    expect((await readFile(previous.backupPath)).equals(previousBytes)).toBe(true);
  }, 2000);

  test('rejects a gzip failure while reading a source and closes the archive', async () => {
    await writeFile(join(dataDir, 'large.bin'), randomBytes(256 * 1024));
    const failure = new Error('injected gzip failure');
    const zlib = await vi.importActual<typeof import('node:zlib')>('node:zlib');
    vi.mocked(createGzip).mockImplementationOnce((options) => {
      const gzip = zlib.createGzip(options);
      const originalWrite = gzip.write.bind(gzip);
      vi.spyOn(gzip, 'write').mockImplementation((...args: Parameters<typeof gzip.write>) => {
        const accepted = originalWrite(...args);
        if (!accepted) queueMicrotask(() => gzip.destroy(failure));
        return accepted;
      });
      return gzip;
    });

    await expect(createMaintenanceBackup({ dataDir, outDir, now: () => NOW })).rejects.toBe(failure);
    const inputs = vi.mocked(createReadStream).mock.results.map((result) => result.value as ReturnType<typeof createReadStream>);
    expect(inputs.length).toBeGreaterThan(0);
    for (const stream of [...inputs, vi.mocked(createGzip).mock.results[0].value, vi.mocked(createWriteStream).mock.results[0].value]) {
      expect(stream.closed).toBe(true);
    }
    await expect(exists(join(outDir, 'kookr-backup-20260613T140506Z.tar.gz'))).resolves.toBe(false);
  }, 2000);

  test('rejects an early destination-open failure without removing a competing archive', async () => {
    const failure = Object.assign(new Error('EEXIST: injected exclusive-open race'), { code: 'EEXIST' });
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const backupPath = join(outDir, 'kookr-backup-20260613T140506Z.tar.gz');
    vi.mocked(createWriteStream).mockImplementationOnce((path, options) => fs.createWriteStream(path, {
      ...(typeof options === 'object' ? options : {}),
      fs: {
        ...fs,
        open(_path, _flags, _mode, callback) {
          // Another attempt wins the exclusive create after the initial stat.
          writeFile(backupPath, 'competing archive').then(
            () => callback(failure, -1),
            (error: Error) => callback(error, -1),
          );
        },
      },
    }));

    await expect(createMaintenanceBackup({ dataDir, outDir, now: () => NOW })).rejects.toBe(failure);
    expect(vi.mocked(createWriteStream).mock.results[0].value.closed).toBe(true);
    expect(vi.mocked(createGzip).mock.results[0].value.closed).toBe(true);
    await expect(readFile(backupPath, 'utf8')).resolves.toBe('competing archive');
  }, 2000);

  test('preserves symlink entries in the manifest and archive', async () => {
    await symlink('tasks.json', join(dataDir, 'tasks-link.json'));

    const result = await createMaintenanceBackup({ dataDir, outDir, now: () => NOW });

    const linkEntry = result.manifest.entries.find((entry) => entry.path === 'tasks-link.json');
    expect(linkEntry).toMatchObject({
      path: 'tasks-link.json',
      type: 'symlink',
      bytes: 0,
      linkTarget: 'tasks.json',
    });
    const entries = await readTarGz(result.backupPath);
    const archiveLink = entries.find((entry) => entry.name === 'data/tasks-link.json');
    expect(archiveLink).toMatchObject({ type: '2', size: 0 });
    const list = await execFileAsync('tar', ['-tvzf', result.backupPath]);
    expect(list.stdout).toContain('data/tasks-link.json -> tasks.json');
  });

  test('lists unsupported special files as exclusions', async () => {
    await execFileAsync('mkfifo', [join(dataDir, 'events.pipe')]);

    const result = await createMaintenanceBackup({ dataDir, outDir, now: () => NOW });

    expect(result.manifest.excluded).toEqual([{ path: 'events.pipe', reason: 'unsupported-file-type' }]);
    expect(result.manifest.entries.map((entry) => entry.path)).not.toContain('events.pipe');
    const entries = await readTarGz(result.backupPath);
    expect(entries.map((entry) => entry.name)).not.toContain('data/events.pipe');
  });

  test('rejects a missing data directory', async () => {
    await expect(
      createMaintenanceBackup({ dataDir: join(tempRoot, 'missing'), outDir, now: () => NOW }),
    ).rejects.toThrow(/data directory .* is not readable/);
  });
});
