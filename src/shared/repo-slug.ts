// Single source of truth for `owner/repo` slug validation and normalization.
// Imported by both the server (POST /api/projects/track) and the frontend
// (GUI track form), and used internally by the recon-report parser after it
// strips any `https://github.com/` prefix.
//
// If you change the rules here, every caller changes together — that is the
// whole point of this module.

const SEGMENT_CHARSET = /^[A-Za-z0-9._-]+$/;

/**
 * Parse and normalize a bare `owner/repo` slug.
 *
 * Accepts only bare `owner/repo` form — URLs and path prefixes are rejected.
 * Enforces GitHub's own character rules (`[A-Za-z0-9._-]+`) in both segments.
 * Returns the lowercase canonical form, or `null` if the input is invalid.
 *
 * Accepts `unknown` so HTTP route handlers can pass untyped JSON body fields
 * without a separate type guard.
 */
export function parseOwnerRepoSlug(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Reject URLs and path prefixes — callers must strip these first.
  if (trimmed.includes('://')) return null;
  if (trimmed.startsWith('/') || trimmed.endsWith('/')) return null;
  const parts = trimmed.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  if (!SEGMENT_CHARSET.test(owner)) return null;
  if (!SEGMENT_CHARSET.test(repo)) return null;
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}
