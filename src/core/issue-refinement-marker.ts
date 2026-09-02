/**
 * GitHub issue proposal-refinement markers.
 *
 * Updating an issue does not close it, so open/closed state cannot stop a
 * refinement loop from selecting the same proposal forever. The marker records
 * a digest of the reviewed canonical body. A matching digest means this
 * revision is done; a later human edit changes the digest and makes the issue
 * eligible again.
 */

import { createHash } from 'node:crypto';

export const ISSUE_REFINEMENT_MARKER_VERSION = 1;

export type IssueRefinementDisposition = 'keep' | 'refine' | 'close' | 'blocked';

export interface IssueRefinementMarker {
  version: 1;
  bodySha256: string;
  disposition: IssueRefinementDisposition;
  taskId: string;
}

export interface IssueRevision {
  title: string;
  body: string;
}

const MARKER_PATTERN =
  /^<!-- kookr:issue-refinement:v1 body-sha256=([a-f0-9]{64}) disposition=(keep|refine|close|blocked) task=([A-Za-z0-9._:-]+) -->[ \t]*(?:\n|$)/gm;

/** Canonical body bytes: LF line endings, no refinement markers, no trailing whitespace. */
export function canonicalizeIssueRefinementBody(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(MARKER_PATTERN, '').trimEnd();
}

export function issueRefinementBodyDigest(body: string): string {
  return createHash('sha256').update(canonicalizeIssueRefinementBody(body), 'utf8').digest('hex');
}

export function parseIssueRefinementMarker(body: string): IssueRefinementMarker | null {
  const normalized = body.replace(/\r\n/g, '\n');
  const matches = [...normalized.matchAll(MARKER_PATTERN)];
  const match = matches.at(-1);
  if (!match) return null;
  return {
    version: ISSUE_REFINEMENT_MARKER_VERSION,
    bodySha256: match[1]!,
    disposition: match[2]! as IssueRefinementDisposition,
    taskId: match[3]!,
  };
}

/** True when the body already carries a marker whose digest matches the current canonical body. */
export function isCurrentIssueRefinement(body: string): boolean {
  const marker = parseIssueRefinementMarker(body);
  return marker !== null && marker.bodySha256 === issueRefinementBodyDigest(body);
}

export function stampIssueRefinementBody(
  body: string,
  disposition: IssueRefinementDisposition,
  taskId: string,
): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(taskId)) {
    throw new Error('issue refinement marker taskId contains unsupported characters');
  }
  const canonicalBody = canonicalizeIssueRefinementBody(body);
  const digest = issueRefinementBodyDigest(canonicalBody);
  const marker = `<!-- kookr:issue-refinement:v1 body-sha256=${digest} disposition=${disposition} task=${taskId} -->`;
  return canonicalBody === '' ? marker : `${canonicalBody}\n\n${marker}`;
}

/** True when title or body moved after analysis and a write must be rejected. */
export function didIssueRevisionChange(analyzed: IssueRevision, current: IssueRevision): boolean {
  return analyzed.title !== current.title || analyzed.body !== current.body;
}
