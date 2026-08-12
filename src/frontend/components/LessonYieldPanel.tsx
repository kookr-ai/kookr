import React, { useState } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type { LessonYieldStatus } from '../store/store-types.js';

interface Props {
  defaultExpanded?: boolean;
  /** Optional override for tests; defaults to the ops-health store projection. */
  snapshot?: LessonYieldStatus | null;
}

/** Format a 0..1+ yield rate as a short fixed-decimal string (e.g. `0.75`). */
export function formatYieldRate(rate: number): string {
  if (!Number.isFinite(rate) || rate < 0) return '0';
  if (rate === 0) return '0';
  return rate.toFixed(2);
}

/**
 * Read-only Diagnostics card for lesson-authoring yield (issue #2395). Reuses
 * the `lessonYield` block already projected on `GET /api/health` and retained by
 * the ops-health poll — no dedicated API route, no mutations. Mirrors the
 * always-on `kookr status` gauge (issue #2305): yield rate, decided/completed
 * denominator, and decision buckets. Missing/malformed block soft-fails to a
 * muted empty state.
 */
export function LessonYieldPanel({ defaultExpanded = true, snapshot }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const storeSnapshot = useKookrStore((s) => s.lessonYield);
  const block = snapshot !== undefined ? snapshot : storeSnapshot;

  const belowTarget = block != null && block.completedInWindow > 0 && block.yieldRate < 1;

  return (
    <section className="lesson-yield-section" aria-label="Lesson Yield">
      <button
        type="button"
        className="section-header lesson-yield-header"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls="lesson-yield-body"
      >
        <span className="section-chevron" aria-hidden>{expanded ? '▾' : '▸'}</span>
        <span className="stats-label">
          Lesson Yield
          <span className="stats-summary">
            {block ? `rate ${formatYieldRate(block.yieldRate)}` : 'no data'}
          </span>
        </span>
        {belowTarget ? (
          <span className="finding-evidence-pill finding-evidence-pill--warn">below target</span>
        ) : null}
      </button>
      {expanded ? (
        <div id="lesson-yield-body" className="lesson-yield-body" aria-live="polite">
          {block == null ? (
            <div className="diagnostic-muted">No lesson yield data yet.</div>
          ) : (
            <>
              <div className="lesson-yield-row-main">
                <span className="lesson-yield-metric">
                  rate={formatYieldRate(block.yieldRate)}
                </span>
                <span className="lesson-yield-metric">
                  decided={block.decided}/{block.completedInWindow}
                </span>
                <span className="lesson-yield-metric diagnostic-muted">
                  {block.windowDays}d window
                </span>
              </div>
              <div className="lesson-yield-buckets">
                <span className="lesson-yield-metric">wrote={block.buckets.wroteLesson}</span>
                <span className="lesson-yield-metric">skip={block.buckets.explicitSkip}</span>
                <span className="lesson-yield-metric">
                  searchOnly={block.buckets.searchOnly}
                </span>
                <span className="lesson-yield-metric">noKb={block.buckets.noKbActivity}</span>
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
