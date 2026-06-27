import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, readlink, stat, unlink } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

/**
 * Crash-consistent whole-data-directory backup.
 *
 * The command does not stop or lock a running Kookr server. Each file is copied
 * at the moment it is read, so a live backup is equivalent to restoring after a
 * sudden process crash: individual stores must recover from their own atomic
 * write / boot-repair contracts, and there is no cross-file transaction point.
 */

const MANIFEST_NAME = 'kookr-backup-manifest.json';
const DEFAULT_BACKUP_PREFIX = 'kookr-backup';
const TAR_BLOCK_BYTES = 512;

export interface MaintenanceBackupOptions {
  /** Absolute or relative path to the Kookr data directory (e.g. `~/.kookr`). */
  dataDir: string;
  /** Directory that receives the timestamped `kookr-backup-*.tar.gz` file. */
  outDir: string;
  /** Injectable clock for deterministic tests. Defaults to `new Date()`. */
  now?: () => Date;
  /** Test hook invoked after planning and before an archive entry is read. */
  beforeArchiveEntry?: (entry: MaintenanceBackupEntry) => Promise<void> | void;
}

export interface MaintenanceBackupEntry {
  /** Relative path inside the Kookr data directory, using `/` separators. */
  path: string;
  type: 'directory' | 'file' | 'symlink';
  /** File byte length. Directories and symlinks report 0. */
  bytes: number;
  /** POSIX mode bits captured from the source entry. */
  mode: number;
  /** Source mtime as ISO-8601. */
  mtime: string;
  /** Symlink target for symlink entries. */
  linkTarget?: string;
}

export interface MaintenanceBackupExclusion {
  /** Relative path inside the data directory, or `.` for the root. */
  path: string;
  reason: 'backup-output-directory' | 'unsupported-file-type' | 'vanished-during-scan';
}

export interface MaintenanceBackupManifest {
  schemaVersion: 'maintenance-backup.v1';
  createdAt: string;
  dataDir: string;
  archiveLayout: {
    manifest: typeof MANIFEST_NAME;
    dataRoot: 'data/';
  };
  crashConsistency: string;
  totalEntries: number;
  totalFileBytes: number;
  entries: MaintenanceBackupEntry[];
  excluded: MaintenanceBackupExclusion[];
}

export interface MaintenanceBackupResult {
  dataDir: string;
  outDir: string;
  backupPath: string;
  createdAt: string;
  archiveBytes: number;
  manifest: MaintenanceBackupManifest;
}

const CRASH_CONSISTENCY_CONTRACT =
  'A live backup is crash-consistent, not a cross-store transaction: restoring it is equivalent to recovering after kill -9 while the server was writing.';

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function normalizeRelative(path: string): string {
  return path.split(sep).join('/');
}

function isWithinOrEqual(path: string, maybeParent: string): boolean {
  const rel = relative(maybeParent, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function outputFileName(createdAt: Date): string {
  return `${DEFAULT_BACKUP_PREFIX}-${timestampForFile(createdAt)}.tar.gz`;
}

async function collectEntries({
  dataDir,
  outDir,
}: {
  dataDir: string;
  outDir: string;
}): Promise<{ entries: MaintenanceBackupEntry[]; excluded: MaintenanceBackupExclusion[] }> {
  const root = resolve(dataDir);
  const outputRoot = resolve(outDir);
  const rootStat = await stat(root).catch((err: NodeJS.ErrnoException) => {
    throw new Error(`data directory ${root} is not readable: ${err.message}`);
  });
  if (!rootStat.isDirectory()) {
    throw new Error(`data directory ${root} is not a directory`);
  }
  if (outputRoot === root) {
    throw new Error('backup output directory must not be the same as the data directory');
  }

  const entries: MaintenanceBackupEntry[] = [];
  const excluded: MaintenanceBackupExclusion[] = [];

  async function walk(absPath: string, relPath: string): Promise<void> {
    if (isWithinOrEqual(absPath, outputRoot)) {
      excluded.push({ path: relPath === '' ? '.' : normalizeRelative(relPath), reason: 'backup-output-directory' });
      return;
    }

    let st;
    try {
      st = await lstat(absPath);
    } catch {
      excluded.push({ path: relPath === '' ? '.' : normalizeRelative(relPath), reason: 'vanished-during-scan' });
      return;
    }

    if (relPath !== '') {
      if (st.isDirectory()) {
        entries.push({
          path: normalizeRelative(relPath),
          type: 'directory',
          bytes: 0,
          mode: st.mode & 0o7777,
          mtime: st.mtime.toISOString(),
        });
      } else if (st.isFile()) {
        entries.push({
          path: normalizeRelative(relPath),
          type: 'file',
          bytes: st.size,
          mode: st.mode & 0o7777,
          mtime: st.mtime.toISOString(),
        });
      } else if (st.isSymbolicLink()) {
        entries.push({
          path: normalizeRelative(relPath),
          type: 'symlink',
          bytes: 0,
          mode: st.mode & 0o7777,
          mtime: st.mtime.toISOString(),
          linkTarget: await readlink(absPath),
        });
      } else {
        excluded.push({ path: normalizeRelative(relPath), reason: 'unsupported-file-type' });
        return;
      }
    }

    if (!st.isDirectory()) return;

    const childNames = (await readdir(absPath)).sort((a, b) => a.localeCompare(b));
    for (const childName of childNames) {
      await walk(join(absPath, childName), relPath === '' ? childName : join(relPath, childName));
    }
  }

  await walk(root, '');
  entries.sort((a, b) => a.path.localeCompare(b.path));
  excluded.sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason));
  return { entries, excluded };
}

function buildManifest({
  createdAt,
  dataDir,
  entries,
  excluded,
}: {
  createdAt: string;
  dataDir: string;
  entries: MaintenanceBackupEntry[];
  excluded: MaintenanceBackupExclusion[];
}): MaintenanceBackupManifest {
  return {
    schemaVersion: 'maintenance-backup.v1',
    createdAt,
    dataDir,
    archiveLayout: {
      manifest: MANIFEST_NAME,
      dataRoot: 'data/',
    },
    crashConsistency: CRASH_CONSISTENCY_CONTRACT,
    totalEntries: entries.length,
    totalFileBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    entries,
    excluded,
  };
}

function writeString(buffer: Buffer, value: string, offset: number, length: number): void {
  const raw = Buffer.from(value);
  if (raw.length > length) {
    throw new Error(`tar header field is too long for ${value}`);
  }
  raw.copy(buffer, offset);
}

function writeOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  const raw = value.toString(8).padStart(length - 1, '0');
  writeString(buffer, `${raw}\0`, offset, length);
}

function splitTarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  const parts = path.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join('/');
    const name = parts.slice(i).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`tar path is too long: ${path}`);
}

function tarHeader({
  path,
  mode,
  size,
  mtime,
  type,
  linkTarget,
}: {
  path: string;
  mode: number;
  size: number;
  mtime: number;
  type: 'directory' | 'file' | 'symlink';
  linkTarget?: string;
}): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  const { name, prefix } = splitTarPath(path);
  writeString(header, name, 0, 100);
  writeOctal(header, mode, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, type === 'file' ? size : 0, 124, 12);
  writeOctal(header, Math.floor(mtime), 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = type === 'directory' ? 0x35 : type === 'symlink' ? 0x32 : 0x30;
  if (linkTarget) writeString(header, linkTarget, 157, 100);
  writeString(header, 'ustar\0', 257, 6);
  writeString(header, '00', 263, 2);
  writeString(header, 'kookr', 265, 32);
  writeString(header, 'kookr', 297, 32);
  writeString(header, prefix, 345, 155);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, '0');
  writeString(header, `${checksumText}\0 `, 148, 8);
  return header;
}

async function writeGzipTar({
  backupPath,
  dataDir,
  manifest,
  createdAt,
  beforeArchiveEntry,
}: {
  backupPath: string;
  dataDir: string;
  manifest: MaintenanceBackupManifest;
  createdAt: Date;
  beforeArchiveEntry?: (entry: MaintenanceBackupEntry) => Promise<void> | void;
}): Promise<void> {
  const output = createWriteStream(backupPath, { flags: 'wx', mode: 0o600 });
  const gzip = createGzip({ level: 6 });
  gzip.pipe(output);
  const done = finished(output);

  async function write(chunk: Buffer): Promise<void> {
    if (!gzip.write(chunk)) await once(gzip, 'drain');
  }

  async function writeEntryHeader(entryPath: string, type: 'directory' | 'file' | 'symlink', size: number, mode: number, mtimeMs: number, linkTarget?: string): Promise<void> {
    const normalizedPath = type === 'directory' && !entryPath.endsWith('/') ? `${entryPath}/` : entryPath;
    await write(tarHeader({
      path: normalizedPath,
      mode,
      size,
      mtime: Math.floor(mtimeMs / 1000),
      type,
      linkTarget,
    }));
  }

  async function writeFileEntry(entryPath: string, sourcePath: string, size: number, mode: number, mtimeMs: number): Promise<void> {
    const current = await lstat(sourcePath);
    if (!current.isFile() || current.size !== size) {
      throw new Error(
        `file changed while backing up ${sourcePath}: expected ${size} bytes, found ${current.isFile() ? current.size : 'non-file'}`,
      );
    }
    await writeEntryHeader(entryPath, 'file', size, mode, mtimeMs);
    let bytesWritten = 0;
    if (size > 0) {
      const input = createReadStream(sourcePath, { start: 0, end: size - 1 });
      for await (const chunk of input) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesWritten += buffer.length;
        await write(buffer);
      }
    }
    if (bytesWritten !== size) {
      throw new Error(
        `file changed while backing up ${sourcePath}: expected ${size} bytes, read ${bytesWritten}`,
      );
    }
    const padding = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    if (padding > 0) await write(Buffer.alloc(padding));
  }

  async function writeBufferEntry(entryPath: string, contents: Buffer, mode: number, mtimeMs: number): Promise<void> {
    await writeEntryHeader(entryPath, 'file', contents.length, mode, mtimeMs);
    await write(contents);
    const padding = (TAR_BLOCK_BYTES - (contents.length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    if (padding > 0) await write(Buffer.alloc(padding));
  }

  try {
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await writeBufferEntry(MANIFEST_NAME, manifestBytes, 0o600, createdAt.getTime());

    await writeEntryHeader('data/', 'directory', 0, 0o700, createdAt.getTime());
    for (const entry of manifest.entries) {
      const archivePath = `data/${entry.path}`;
      const sourcePath = join(dataDir, entry.path);
      const mtimeMs = Date.parse(entry.mtime);
      if (entry.type === 'directory') {
        await writeEntryHeader(archivePath, 'directory', 0, entry.mode, mtimeMs);
      } else if (entry.type === 'symlink') {
        await writeEntryHeader(archivePath, 'symlink', 0, entry.mode, mtimeMs, entry.linkTarget);
      } else {
        await beforeArchiveEntry?.(entry);
        await writeFileEntry(archivePath, sourcePath, entry.bytes, entry.mode, mtimeMs);
      }
    }
    await write(Buffer.alloc(TAR_BLOCK_BYTES * 2));
    gzip.end();
    await done;
  } catch (err) {
    gzip.destroy();
    output.destroy();
    await done.catch(() => undefined);
    throw err;
  }
}

export async function createMaintenanceBackup(options: MaintenanceBackupOptions): Promise<MaintenanceBackupResult> {
  const createdAtDate = options.now?.() ?? new Date();
  const createdAt = createdAtDate.toISOString();
  const dataDir = resolve(options.dataDir);
  const outDir = resolve(options.outDir);
  const backupPath = join(outDir, outputFileName(createdAtDate));

  const dataDirStat = await stat(dataDir).catch((err: NodeJS.ErrnoException) => {
    throw new Error(`data directory ${dataDir} is not readable: ${err.message}`);
  });
  if (!dataDirStat.isDirectory()) {
    throw new Error(`data directory ${dataDir} is not a directory`);
  }
  await mkdir(outDir, { recursive: true });
  const { entries, excluded } = await collectEntries({ dataDir, outDir });
  const manifest = buildManifest({ createdAt, dataDir, entries, excluded });

  const existing = await stat(backupPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  });
  if (existing !== undefined) {
    throw new Error(`backup archive already exists: ${backupPath}`);
  }

  try {
    await writeGzipTar({
      backupPath,
      dataDir,
      manifest,
      createdAt: createdAtDate,
      beforeArchiveEntry: options.beforeArchiveEntry,
    });
  } catch (err) {
    await unlink(backupPath).catch(() => undefined);
    throw err;
  }

  const archiveBytes = (await stat(backupPath)).size;
  return {
    dataDir,
    outDir,
    backupPath,
    createdAt,
    archiveBytes,
    manifest,
  };
}

export function defaultMaintenanceBackupOutDir(home: string): string {
  return join(home, 'kookr-backups');
}

export { CRASH_CONSISTENCY_CONTRACT, MANIFEST_NAME };
