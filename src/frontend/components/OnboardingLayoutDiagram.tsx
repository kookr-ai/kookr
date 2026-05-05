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
export function OnboardingLayoutDiagram() {
  return (
    <svg
      className="onboarding-layout-diagram"
      viewBox="0 0 600 320"
      role="img"
      aria-label="Diagram of Kookr's four-pane dashboard: top bar across the top, project sidebar on the left, findings panel in the middle, detail panel on the right"
    >
      {/* Background */}
      <rect x="0" y="0" width="600" height="320" rx="8" fill="var(--bg-bg)" stroke="var(--border)" />

      {/* Top bar */}
      <rect x="8" y="8" width="584" height="32" rx="4" fill="var(--bg-panel)" stroke="var(--border-dim)" />
      <text x="20" y="29" fontSize="12" fill="var(--text-bright)" fontWeight="600">KOOKR</text>
      <text x="568" y="29" fontSize="11" fill="var(--accent)" textAnchor="end">+ Launch</text>

      {/* Sidebar */}
      <rect x="8" y="48" width="120" height="264" rx="4" fill="var(--bg-panel)" stroke="var(--border-dim)" />
      <text x="68" y="68" fontSize="11" fill="var(--text-muted)" textAnchor="middle">Sidebar</text>
      <text x="68" y="84" fontSize="9" fill="var(--text-secondary)" textAnchor="middle">projects + tasks</text>
      <rect x="20" y="100" width="96" height="14" rx="2" fill="var(--bg-card)" />
      <rect x="20" y="120" width="96" height="14" rx="2" fill="var(--bg-card)" />
      <rect x="20" y="140" width="96" height="14" rx="2" fill="var(--bg-card)" />

      {/* Findings panel (middle) */}
      <rect x="136" y="48" width="220" height="264" rx="4" fill="var(--bg-panel)" stroke="var(--border-dim)" />
      <text x="246" y="68" fontSize="11" fill="var(--text-muted)" textAnchor="middle">Findings</text>
      <text x="246" y="84" fontSize="9" fill="var(--text-secondary)" textAnchor="middle">supervisor anomalies</text>
      <rect x="148" y="100" width="196" height="40" rx="3" fill="var(--bg-card)" stroke="#dc6464" />
      <rect x="148" y="148" width="196" height="40" rx="3" fill="var(--bg-card)" stroke="#dca364" />
      <rect x="148" y="196" width="196" height="40" rx="3" fill="var(--bg-card)" />

      {/* Detail panel */}
      <rect x="364" y="48" width="228" height="264" rx="4" fill="var(--bg-panel)" stroke="var(--border-dim)" />
      <text x="478" y="68" fontSize="11" fill="var(--text-muted)" textAnchor="middle">Detail</text>
      <text x="478" y="84" fontSize="9" fill="var(--text-secondary)" textAnchor="middle">terminal + reply</text>
      <rect x="376" y="100" width="204" height="140" rx="3" fill="#0a0c14" />
      <text x="386" y="118" fontSize="9" fill="var(--accent)" fontFamily="monospace">$ claude</text>
      <text x="386" y="132" fontSize="9" fill="var(--text-secondary)" fontFamily="monospace">running tests…</text>
      <rect x="376" y="252" width="204" height="48" rx="3" fill="var(--bg-card)" />
      <text x="386" y="282" fontSize="9" fill="var(--text-muted)">reply…</text>
    </svg>
  );
}
