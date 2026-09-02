import { describe, expect, test } from 'vitest';
import {
  canonicalizeIssueRefinementBody,
  didIssueRevisionChange,
  issueRefinementBodyDigest,
  isCurrentIssueRefinement,
  parseIssueRefinementMarker,
  stampIssueRefinementBody,
} from './issue-refinement-marker.js';

describe('issue refinement body markers', () => {
  test('stamps the canonical body with its SHA-256 digest and disposition', () => {
    const stamped = stampIssueRefinementBody('## Outcome\n\nShip the smallest useful slice.\n', 'refine', 'task-42');
    const marker = parseIssueRefinementMarker(stamped);

    expect(marker).toEqual({
      version: 1,
      bodySha256: issueRefinementBodyDigest('## Outcome\n\nShip the smallest useful slice.'),
      disposition: 'refine',
      taskId: 'task-42',
    });
    expect(isCurrentIssueRefinement(stamped)).toBe(true);
  });

  test('excludes old markers from the canonical digest and replaces them idempotently', () => {
    const first = stampIssueRefinementBody('Proposal', 'keep', 'task-1');
    const second = stampIssueRefinementBody(first, 'blocked', 'task-2');

    expect(canonicalizeIssueRefinementBody(second)).toBe('Proposal');
    expect(second.match(/kookr:issue-refinement:v1/g)).toHaveLength(1);
    expect(parseIssueRefinementMarker(second)?.disposition).toBe('blocked');
  });

  test('treats an unchanged matching marker as complete', () => {
    const stamped = stampIssueRefinementBody('Original proposal', 'keep', 'task-1');
    expect(isCurrentIssueRefinement(stamped)).toBe(true);
  });

  test('makes a later human body edit eligible again', () => {
    const stamped = stampIssueRefinementBody('Original proposal', 'keep', 'task-1');
    const edited = stamped.replace('Original proposal', 'Human changed the proposal');
    expect(isCurrentIssueRefinement(edited)).toBe(false);
  });

  test('a keep outcome still writes a matching marker', () => {
    const stamped = stampIssueRefinementBody('Already accurate proposal', 'keep', 'task-keep');
    expect(parseIssueRefinementMarker(stamped)?.disposition).toBe('keep');
    expect(isCurrentIssueRefinement(stamped)).toBe(true);
  });

  test('normalizes GitHub line endings but preserves meaningful body edits', () => {
    const lf = 'Line one\nLine two';
    const crlf = 'Line one\r\nLine two\r\n';
    expect(issueRefinementBodyDigest(crlf)).toBe(issueRefinementBodyDigest(lf));
    expect(issueRefinementBodyDigest(`${lf}!`)).not.toBe(issueRefinementBodyDigest(lf));
  });

  test('does not treat a marker-shaped substring as a complete marker line', () => {
    const digest = 'a'.repeat(64);
    const malformed = `<!-- kookr:issue-refinement:v1 body-sha256=${digest} disposition=keep task=task-1 --> trailing text`;

    expect(canonicalizeIssueRefinementBody(malformed)).toBe(malformed);
    expect(parseIssueRefinementMarker(malformed)).toBeNull();
  });

  test('rejects task ids that could corrupt the HTML comment', () => {
    expect(() => stampIssueRefinementBody('Proposal', 'keep', 'task-->oops')).toThrow(
      /unsupported characters/,
    );
  });

  test('detects stale title or body analysis before an update', () => {
    const before = { title: 'Proposal', body: 'Body' };
    expect(didIssueRevisionChange(before, before)).toBe(false);
    expect(didIssueRevisionChange(before, { title: 'Renamed', body: 'Body' })).toBe(true);
    expect(didIssueRevisionChange(before, { title: 'Proposal', body: 'Edited' })).toBe(true);
  });
});
