import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = process.argv[2];
if (!mod) {
  console.error('usage: remote-load-purity-probe.ts <module-path>');
  process.exit(2);
}

const require = createRequire(join(process.cwd(), 'remote-load-purity-probe.cjs'));
const fs = require('node:fs') as typeof import('node:fs');
const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
const net = require('node:net') as typeof import('node:net');
const beforeCache = new Set(Object.keys(require.cache));
const violations: string[] = [];

function record(kind: string): void {
  violations.push(kind);
}

function patchMethod<T extends object, K extends keyof T>(target: T, key: K, kind: string): void {
  const original = target[key];
  if (typeof original !== 'function') return;
  Object.defineProperty(target, key, {
    configurable: true,
    value: (...args: unknown[]) => {
      record(kind);
      return (original as (...inner: unknown[]) => unknown).apply(target, args);
    },
  });
}

for (const key of [
  'appendFile',
  'appendFileSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'mkdir',
  'mkdirSync',
  'open',
  'openSync',
  'rm',
  'rmSync',
  'rename',
  'renameSync',
  'truncate',
  'truncateSync',
  'unlink',
  'unlinkSync',
  'write',
  'writeFile',
  'writeFileSync',
] as const) {
  patchMethod(fs, key, `fs.${key}`);
}

for (const key of ['appendFile', 'copyFile', 'cp', 'mkdir', 'open', 'rm', 'rename', 'truncate', 'unlink', 'writeFile'] as const) {
  patchMethod(fsp, key, `fs.promises.${key}`);
}

patchMethod(net, 'connect', 'net.connect');
patchMethod(net, 'createConnection', 'net.createConnection');
patchMethod(net.Server.prototype, 'listen', 'net.Server.listen');
patchMethod(net.Socket.prototype, 'connect', 'net.Socket.connect');
patchMethod(process, 'on', 'process.on');
patchMethod(process, 'addListener', 'process.addListener');
patchMethod(process, 'prependListener', 'process.prependListener');

const originalSetTimeout = globalThis.setTimeout;
const originalSetInterval = globalThis.setInterval;
globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
  record('setTimeout');
  return originalSetTimeout(...args);
}) as typeof setTimeout;
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
  record('setInterval');
  return originalSetInterval(...args);
}) as typeof setInterval;

async function main(): Promise<void> {
  await import(pathToFileURL(mod).href);

  const afterCache = Object.keys(require.cache);
  const newCacheEntries = afterCache.filter((entry) => !beforeCache.has(entry) && entry !== mod);
  if (newCacheEntries.length > 0) {
    violations.push(`require.cache:${newCacheEntries.join(',')}`);
  }

  if (violations.length > 0) {
    console.error(JSON.stringify({ module: mod, violations }, null, 2));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
