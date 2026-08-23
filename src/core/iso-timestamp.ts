/** Accept only canonical UTC timestamps whose calendar values round-trip. */
export function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/);
  if (!match) return false;
  const normalizedFraction = (match[2] ?? '').padEnd(3, '0');
  return new Date(value).toISOString() === `${match[1]}.${normalizedFraction}Z`;
}
