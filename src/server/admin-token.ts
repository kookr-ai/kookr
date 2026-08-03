import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time token comparison for admin / finding-review gates.
 *
 * Digests both sides with SHA-256 so `crypto.timingSafeEqual` always runs
 * over equal-length buffers, then also checks the raw lengths so a
 * length-mismatched presentation cannot pass. Shared by admin-routes and
 * diagnostics-routes (issue #1941).
 */
export function timingSafeTokenEqual(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const presentedBytes = Buffer.from(presented, 'utf8');
  const expectedDigest = createHash('sha256').update(expectedBytes).digest();
  const presentedDigest = createHash('sha256').update(presentedBytes).digest();
  const equalLength = expectedBytes.length === presentedBytes.length;
  const equalDigest = timingSafeEqual(expectedDigest, presentedDigest);
  return equalLength && equalDigest;
}
