import { createHash } from 'node:crypto';

function canonicalJson(value: unknown): string {
  if (value === undefined) return '"__kookr_undefined__"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
