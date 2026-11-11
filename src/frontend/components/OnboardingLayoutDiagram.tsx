import React from 'react';

/**
 * Static labelled diagram of Kookr's four-pane dashboard layout. Used by
 * Card 2 of the onboarding tour. Inlined as a React component (not an
 * `<img src>`) so jsdom and Playwright tests render it without needing a
 * static-asset pipeline.
 *
 * Color tokens come from styles.css :root variables. No hex fallbacks —
 * they are guaranteed to load (matches the rest of the frontend).
 */
/**
 * Drawn at 1:1 (issue #3619): the viewBox is 480 user units wide and the CSS
 * caps the rendered width at 480 px, so a 12-unit label renders at 12 px in
 * the tour card. Labels use the type scale (12 px minimum), like UI text.
 */
const ONBOARDING_DIAGRAM_WIDTH = 480;

export function OnboardingLayoutDiagram() {
  return (
    <svg
      className="onboarding-layout-diagram"
      viewBox={`0 0 ${ONBOARDING_DIAGRAM_WIDTH} 256`}
      role="img"
      aria-label="Diagram of Kookr's four-pane dashboard: top bar across the top, project sidebar on the left, findings panel in the middle, and a detail panel on the right split into Activity and a Terminal/Diff toggle, with a reply input below."
    >
      {/* Background */}
      <rect x="0" y="0" width="480" height="256" rx="8" fill="var(--bg-bg)" stroke="var(--border)" />

      {/* Top bar */}
      <rect x="8" y="8" width="464" height="28" rx="4" fill="var(--bg-panel)" stroke="var(--border-dim)" />
      <text x="18" y="27" fontSize="13" fill="var(--text-bright)" fontWeight="600">KOOKR</text>
      <text x="462" y="27" fontSize="12" fill="var(--accent)" textAnchor="end">+ Launch</text>

      {/* Sidebar */}
      <rect x="8" y="44" width="100" height="204" rx="4" fill="var(--bg-panel)" stroke="var(--border-dim)" />
      <text x="58" y="64" fontSize="13" fill="var(--text-muted)" textAnchor="middle">Sidebar</text>
      <text x="58" y="80" fontSize="12" fill="var(--text-secondary)" textAnchor="middle">projects</text>
      <text x="58" y="94" fontSize="12" fill="var(--text-secondary)" textAnchor="middle">+ tasks</text>
      <rect x="18" y="106" width="80" height="12" rx="2" fill="var(--bg-card)" />
      <rect x="18" y="124" width="80" height="12" rx="2" fill="var(--bg-card)" />
      <rect x="18" y="142" width="80" height="12" rx="2" fill="var(--bg-card)" />

      {/* Findings panel (middle) */}
      <rect x="116" y="44" width="160" height="204" rx="4" fill="var(--bg-panel)" stroke="var(--border-dim)" />
      <text x="196" y="64" fontSize="13" fill="var(--text-muted)" textAnchor="middle">Findings</text>
      <text x="196" y="80" fontSize="12" fill="var(--text-secondary)" textAnchor="middle">supervisor anomalies</text>
      <rect x="126" y="92" width="140" height="34" rx="3" fill="var(--bg-card)" stroke="#dc6464" />
      <rect x="126" y="134" width="140" height="34" rx="3" fill="var(--bg-card)" stroke="#dca364" />
      <rect x="126" y="176" width="140" height="34" rx="3" fill="var(--bg-card)" />

      {/* Detail panel — split into Activity (left) + Terminal/Diff (right),
          with a reply input below. Mirrors DetailPanel.tsx's .detail-split. */}
      <rect x="284" y="44" width="188" height="204" rx="4" fill="var(--bg-panel)" stroke="var(--border-dim)" />

      {/* Activity sub-zone */}
      <rect x="292" y="56" width="70" height="128" rx="3" fill="var(--bg-card)" />
      <text x="327" y="73" fontSize="12" fill="var(--text-bright)" textAnchor="middle" fontWeight="600">Activity</text>
      <rect x="298" y="84" width="58" height="7" rx="1.5" fill="var(--bg-panel)" />
      <rect x="298" y="98" width="58" height="7" rx="1.5" fill="var(--bg-panel)" />
      <rect x="298" y="112" width="58" height="7" rx="1.5" fill="var(--bg-panel)" />
      <rect x="298" y="126" width="58" height="7" rx="1.5" fill="var(--bg-panel)" />
      <rect x="298" y="140" width="58" height="7" rx="1.5" fill="var(--bg-panel)" />

      {/* Terminal/Diff sub-zone — tab toggle at top, terminal content below */}
      <rect x="370" y="56" width="94" height="128" rx="3" fill="#0a0c14" />
      <rect x="373" y="59" width="58" height="18" rx="2" fill="var(--bg-card)" />
      <text x="402" y="72" fontSize="12" fill="var(--text-bright)" textAnchor="middle" fontWeight="600">Terminal</text>
      <text x="447" y="72" fontSize="12" fill="var(--text-muted)" textAnchor="middle">Diff</text>
      <text x="376" y="100" fontSize="12" fill="var(--accent)" fontFamily="monospace">$ claude</text>
      <text x="376" y="116" fontSize="12" fill="var(--text-secondary)" fontFamily="monospace">running…</text>

      {/* Reply input — spans the full detail panel below the split */}
      <rect x="292" y="192" width="172" height="48" rx="3" fill="var(--bg-card)" />
      <text x="302" y="220" fontSize="12" fill="var(--text-muted)">reply…</text>
    </svg>
  );
}
